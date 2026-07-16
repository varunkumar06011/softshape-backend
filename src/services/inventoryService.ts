import { Prisma } from "@prisma/client";
import { getKolkataDateString } from "../utils/date";
import { isBeerItem } from "../utils/itemHelpers";
import { resolveKitchenRestaurantId } from "../lib/tenantContext";
import { getIo } from "../socket";
import prisma from "../lib/prisma";
import logger from "../lib/logger";

const BAR_UNIT_ML = 30;

export interface InventoryDeductionResult {
  inventoryUpdates: Array<{
    id: string;
    name: string;
    currentStock: number;
    reorderLevel: number;
    unitOfMeasure: string;
    isLowStock: boolean;
  }>;
  barDeductionErrors: string[];
  kitchenDeductionErrors: string[];
  missingRecipeItems: string[];
}

/**
 * Deduct bar + kitchen inventory for a settled order.
 *
 * This is idempotent — it checks `barInventoryDeducted` and `inventoryDeducted`
 * flags on the order and skips deduction if already done. Safe to call multiple
 * times (e.g., on re-sync from edge).
 *
 * Must be called inside a Prisma transaction (tx) with the order row locked
 * (FOR UPDATE) by the caller.
 */
export async function deductInventoryForOrder(
  orderId: string,
  restaurantId: string,
  tx: any,
  userId?: string | null,
): Promise<InventoryDeductionResult> {
  const inventoryUpdates: InventoryDeductionResult["inventoryUpdates"] = [];
  const barDeductionErrors: string[] = [];
  const kitchenDeductionErrors: string[] = [];
  const missingRecipeItems: string[] = [];

  // Re-fetch the order inside the transaction to get current flags
  const lockedRows = await tx.$queryRaw<Array<{
    id: string;
    inventoryDeducted: boolean;
    barInventoryDeducted: boolean;
  }>>`
    SELECT "id", "inventoryDeducted", "barInventoryDeducted"
    FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
  `;
  const lockedRow = lockedRows[0];
  if (!lockedRow) {
    throw new Error(`Order ${orderId} not found inside deduction transaction`);
  }

  // If both flags are already true, nothing to do
  if (lockedRow.barInventoryDeducted && lockedRow.inventoryDeducted) {
    return { inventoryUpdates, barDeductionErrors, kitchenDeductionErrors, missingRecipeItems };
  }

  // Load order with items for deduction
  const lockedOrder = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: true },
      },
    },
  });
  if (!lockedOrder) {
    throw new Error(`Order ${orderId} not found (post-lock)`);
  }

  const liquorItems = lockedOrder.items.filter((item: any) => {
    const mt = item.menuItem?.menuType as string;
    return mt === "LIQUOR" || mt === "BAR";
  });

  // ── Bar inventory deduction ──────────────────────────────────────────────────
  if (!lockedRow.barInventoryDeducted) {
    const allInventoryItems = await tx.inventoryItem.findMany({
      where: { restaurantId },
      include: { menuItem: { include: { variants: true, category: { select: { name: true } } } } },
    });

    if (allInventoryItems.length > 0) {
      const allInvIds = allInventoryItems.map((i: any) => i.id);
      await tx.$queryRaw`
        SELECT "id" FROM "inventory_items"
        WHERE "id" IN (${Prisma.join(allInvIds)})
        ORDER BY "id" FOR UPDATE
      `;
    }

    const inventoryByName = new Map<string, any>();
    for (const inv of allInventoryItems) {
      const name = (inv.menuItem?.name || '').toLowerCase().trim();
      if (name) {
        inventoryByName.set(name, inv);
      }
    }

    const dualVariantMap = new Map<string, { inv750: any; inv180: any }>();
    for (const [invName, inv] of inventoryByName.entries()) {
      const match750 = invName.match(/^(.+)\s+750ml$/);
      const match180 = invName.match(/^(.+)\s+180ml$/);
      if (match750) {
        const base = match750[1];
        const inv180 = inventoryByName.get(`${base} 180ml`);
        if (inv180) dualVariantMap.set(base, { inv750: inv, inv180 });
      } else if (match180) {
        const base = match180[1];
        const inv750 = inventoryByName.get(`${base} 750ml`);
        if (inv750 && !dualVariantMap.has(base)) dualVariantMap.set(base, { inv750, inv180: inv });
      }
    }

    function findInventoryForOrderedItem(orderedName: string): { primary: any | null; secondary: any | null } {
      const normalized = orderedName.toLowerCase().trim();
      const direct = inventoryByName.get(normalized);
      if (direct) return { primary: direct, secondary: null };

      for (const [baseName, { inv750, inv180 }] of dualVariantMap.entries()) {
        if (normalized === baseName || normalized.startsWith(baseName)) {
          return { primary: inv750 ?? null, secondary: inv180 ?? null };
        }
      }

      const stripped = normalized.replace(/\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i, '').trim();
      if (stripped !== normalized) {
        const partialMatch = inventoryByName.get(stripped);
        if (partialMatch) return { primary: partialMatch, secondary: null };
      }

      for (const [invName, inv] of inventoryByName.entries()) {
        if (invName === normalized) continue;
        if (invName.startsWith(normalized + ' ') || normalized.startsWith(invName + ' ')) {
          logger.warn(`[Inventory] Fuzzy prefix match: "${orderedName}" → "${inv.menuItem?.name}"`);
          return { primary: inv, secondary: null };
        }
      }

      return { primary: null, secondary: null };
    }

    const aggregatedLiquorItems = new Map<string, { menuItemId: string; menuItemName: string; quantity: number; price: number }>();
    for (const item of liquorItems) {
      const key = `${item.menuItemId}:${Number(item.price)}`;
      const existing = aggregatedLiquorItems.get(key);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        aggregatedLiquorItems.set(key, {
          menuItemId: item.menuItemId,
          menuItemName: item.menuItem.name,
          quantity: item.quantity,
          price: Number(item.price),
        });
      }
    }

    for (const [, { menuItemId, menuItemName, quantity: totalQuantity, price: itemPrice }] of aggregatedLiquorItems.entries()) {
      const { primary: primaryInv, secondary: secondaryInv } = findInventoryForOrderedItem(menuItemName);
      if (!primaryInv) {
        logger.warn(`[Inventory] Liquor item "${menuItemName}" (menuItemId: ${menuItemId}) has no matching bar inventory. Skipping.`);
        barDeductionErrors.push(`Liquor item "${menuItemName}" has no matching bar inventory item.`);
        continue;
      }

      try {
        const isBeer = isBeerItem(primaryInv.menuItem);
        const isSpirit = !isBeer && primaryInv.menuItem.variants.some(
          (v: { name: string }) => v.name.trim().toLowerCase() === '30ml'
        );

        let mlPerUnit: number;
        let variantLabel: string;
        if (isBeer) {
          const variants = primaryInv.menuItem.variants as Array<{ name: string; price: any }>;
          const matchedVariant = variants.find(v => Number(v.price) === itemPrice);
          if (matchedVariant) {
            const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
            mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? 650 : parsedMl;
            variantLabel = `${mlPerUnit}ml`;
          } else {
            mlPerUnit = 650;
            variantLabel = '650ml bottle';
          }
        } else if (isSpirit) {
          const variants = primaryInv.menuItem.variants as Array<{ name: string; price: any }>;
          const matchedVariant = variants.find(v => Number(v.price) === itemPrice);
          if (matchedVariant) {
            const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
            mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? BAR_UNIT_ML : parsedMl;
            variantLabel = `${mlPerUnit}ml`;
          } else {
            mlPerUnit = BAR_UNIT_ML;
            variantLabel = `${BAR_UNIT_ML}ml (unmatched price ₹${itemPrice})`;
            logger.warn(`[Inventory] No variant price match for ${primaryInv.menuItem.name} at ₹${itemPrice}, defaulting to ${BAR_UNIT_ML}ml`);
          }
        } else {
          mlPerUnit = Number(primaryInv.bottleSize);
          variantLabel = 'bottle';
        }
        const totalMl = mlPerUnit * totalQuantity;

        const isDualVariant = secondaryInv !== null;

        if (isDualVariant) {
          const stock750 = Number(primaryInv.currentStock);
          let deductFrom750: number;
          let deductFrom180: number;

          if (stock750 >= totalMl) {
            deductFrom750 = totalMl;
            deductFrom180 = 0;
          } else if (stock750 > 0) {
            deductFrom750 = stock750;
            deductFrom180 = totalMl - stock750;
          } else {
            deductFrom750 = 0;
            deductFrom180 = totalMl;
          }

          const totalAvailable = stock750 + Number(secondaryInv.currentStock);
          if (totalAvailable < totalMl) {
            throw Object.assign(
              new Error(`Insufficient stock for ${menuItemName}: available ${totalAvailable}ml (750ml: ${stock750}ml, 180ml: ${secondaryInv.currentStock}ml), required ${totalMl}ml`),
              { statusCode: 409 }
            );
          }

          if (deductFrom750 > 0) {
            const updated750 = await tx.inventoryItem.update({
              where: { id: primaryInv.id },
              data: { currentStock: { decrement: deductFrom750 } },
            });

            await tx.inventoryTransaction.create({
              data: {
                restaurantId,
                itemId: primaryInv.id,
                orderId: lockedOrder.id,
                type: 'SALE',
                quantityChange: -deductFrom750,
                stockBefore: new Prisma.Decimal(Number(updated750.currentStock) + deductFrom750),
                stockAfter: updated750.currentStock,
                notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel} (750ml stock)`,
                transactionDate: new Date(),
                createdBy: userId || null,
              },
            });

            const snapshotDate = getKolkataDateString();
            await tx.dailyInventorySnapshot.upsert({
              where: {
                restaurantId_snapshotDate_itemId: {
                  restaurantId, snapshotDate, itemId: primaryInv.id,
                }
              },
              create: {
                restaurantId,
                itemId: primaryInv.id,
                snapshotDate,
                itemName: primaryInv.menuItem.name,
                purchased: 0,
                sold: deductFrom750,
                wastage: 0,
                adjusted: 0,
                openingStock: primaryInv.currentStock,
                closingStock: updated750.currentStock,
              },
              update: {
                sold: { increment: deductFrom750 },
                closingStock: updated750.currentStock,
              }
            });

            const isLowStock = Number(updated750.currentStock) <= Number(updated750.reorderLevel);
            inventoryUpdates.push({
              id: updated750.id,
              name: primaryInv.menuItem.name,
              currentStock: Number(updated750.currentStock),
              reorderLevel: Number(updated750.reorderLevel),
              unitOfMeasure: updated750.unitOfMeasure,
              isLowStock
            });
          }

          if (deductFrom180 > 0) {
            const updated180 = await tx.inventoryItem.update({
              where: { id: secondaryInv.id },
              data: { currentStock: { decrement: deductFrom180 } },
            });

            await tx.inventoryTransaction.create({
              data: {
                restaurantId,
                itemId: secondaryInv.id,
                orderId: lockedOrder.id,
                type: 'SALE',
                quantityChange: -deductFrom180,
                stockBefore: new Prisma.Decimal(Number(updated180.currentStock) + deductFrom180),
                stockAfter: updated180.currentStock,
                notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel} (180ml stock)`,
                transactionDate: new Date(),
                createdBy: userId || null,
              },
            });

            const snapshotDate = getKolkataDateString();
            await tx.dailyInventorySnapshot.upsert({
              where: {
                restaurantId_snapshotDate_itemId: {
                  restaurantId, snapshotDate, itemId: secondaryInv.id,
                }
              },
              create: {
                restaurantId,
                itemId: secondaryInv.id,
                snapshotDate,
                itemName: secondaryInv.menuItem.name,
                purchased: 0,
                sold: deductFrom180,
                wastage: 0,
                adjusted: 0,
                openingStock: secondaryInv.currentStock,
                closingStock: updated180.currentStock,
              },
              update: {
                sold: { increment: deductFrom180 },
                closingStock: updated180.currentStock,
              }
            });

            const isLowStock = Number(updated180.currentStock) <= Number(updated180.reorderLevel);
            inventoryUpdates.push({
              id: updated180.id,
              name: secondaryInv.menuItem.name,
              currentStock: Number(updated180.currentStock),
              reorderLevel: Number(updated180.reorderLevel),
              unitOfMeasure: updated180.unitOfMeasure,
              isLowStock
            });
          }
        } else {
          if (Number(primaryInv.currentStock) < totalMl) {
            throw Object.assign(
              new Error(`Insufficient stock for ${primaryInv.menuItem?.name ?? 'Unknown Item'}: available ${primaryInv.currentStock}ml, required ${totalMl}ml`),
              { statusCode: 409 }
            );
          }

          const updatedItem = await tx.inventoryItem.update({
            where: { id: primaryInv.id },
            data: { currentStock: { decrement: totalMl } },
          });

          await tx.inventoryTransaction.create({
            data: {
              restaurantId,
              itemId: primaryInv.id,
              orderId: lockedOrder.id,
              type: 'SALE',
              quantityChange: -totalMl,
              stockBefore: new Prisma.Decimal(Number(updatedItem.currentStock) + totalMl),
              stockAfter: updatedItem.currentStock,
              notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel}`,
              transactionDate: new Date(),
              createdBy: userId || null,
            },
          });

          const snapshotDate = getKolkataDateString();
          await tx.dailyInventorySnapshot.upsert({
            where: {
              restaurantId_snapshotDate_itemId: {
                restaurantId,
                snapshotDate,
                itemId: primaryInv.id,
              }
            },
            create: {
              restaurantId,
              itemId: primaryInv.id,
              snapshotDate,
              itemName: primaryInv.menuItem.name,
              purchased: 0,
              sold: totalMl,
              wastage: 0,
              adjusted: 0,
              openingStock: primaryInv.currentStock,
              closingStock: updatedItem.currentStock,
            },
            update: {
              sold: { increment: totalMl },
              closingStock: updatedItem.currentStock,
            }
          });

          const isLowStock = Number(updatedItem.currentStock) <= Number(updatedItem.reorderLevel);
          inventoryUpdates.push({
            id: updatedItem.id,
            name: primaryInv.menuItem.name,
            currentStock: Number(updatedItem.currentStock),
            reorderLevel: Number(updatedItem.reorderLevel),
            unitOfMeasure: updatedItem.unitOfMeasure,
            isLowStock
          });
        }
      } catch (err: any) {
        const errMsg = `Bar item "${menuItemName}": ${err.message}`;
        logger.error(`[Inventory] Bar deduction failed: ${errMsg}`);
        barDeductionErrors.push(errMsg);
      }
    }
  }

  // ── Kitchen inventory deduction ──────────────────────────────────────────────
  if (!lockedRow.inventoryDeducted) {
    const foodItems = lockedOrder.items.filter((item: any) => item.menuItem?.menuType === "FOOD");
    if (foodItems.length > 0) {
      const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
      const foodMenuItemIds = foodItems.map((i: any) => i.menuItemId);
      const recipes = await tx.menuItemRecipe.findMany({
        where: { menuItemId: { in: foodMenuItemIds }, restaurantId },
        include: { ingredient: true },
      });

      const recipeMenuItemIds = new Set(recipes.map((r: any) => r.menuItemId));
      for (const item of foodItems) {
        if (!recipeMenuItemIds.has(item.menuItemId)) {
          if (!missingRecipeItems.includes(item.menuItem.name)) {
            missingRecipeItems.push(item.menuItem.name);
          }
        }
      }

      const ingredientDeductions = new Map<string, { totalQty: number; menuItemIds: string[] }>();
      for (const item of foodItems) {
        for (const recipe of recipes.filter((r: any) => r.menuItemId === item.menuItemId)) {
          const existing = ingredientDeductions.get(recipe.ingredientId);
          if (existing) {
            existing.totalQty += Number(recipe.quantity) * item.quantity;
            if (!existing.menuItemIds.includes(item.menuItemId)) {
              existing.menuItemIds.push(item.menuItemId);
            }
          } else {
            ingredientDeductions.set(recipe.ingredientId, {
              totalQty: Number(recipe.quantity) * item.quantity,
              menuItemIds: [item.menuItemId],
            });
          }
        }
      }

      const existingLogs = await tx.orderDeductionLog.findMany({
        where: { orderId: lockedOrder.id },
      });
      const successLogIds = new Set(existingLogs.filter((l: any) => l.status === 'SUCCESS').map((l: any) => l.ingredientId));

      const today = getKolkataDateString();
      for (const [ingredientId, { totalQty, menuItemIds }] of ingredientDeductions.entries()) {
        if (successLogIds.has(ingredientId)) {
          logger.info(`[Kitchen] Skipping ingredient ${ingredientId} — already deducted successfully in a prior attempt.`);
          continue;
        }

        try {
          const updatedIngredient = await tx.kitchenInventoryItem.update({
            where: { id: ingredientId },
            data: { currentStock: { decrement: new Prisma.Decimal(totalQty) } },
          });

          const existingEntry = await tx.inventoryDailyEntry.findUnique({
            where: {
              restaurantId_itemId_entryDate: { restaurantId: kitchenRestaurantId, itemId: ingredientId, entryDate: today },
            },
          });

          if (existingEntry) {
            await tx.inventoryDailyEntry.update({
              where: { id: existingEntry.id },
              data: {
                consumedStock: { increment: new Prisma.Decimal(totalQty) },
                closingStock: updatedIngredient.currentStock,
              },
            });
          } else {
            const priorEntry = await tx.inventoryDailyEntry.findFirst({
              where: { restaurantId: kitchenRestaurantId, itemId: ingredientId, entryDate: { lt: today } },
              orderBy: { entryDate: 'desc' },
            });
            const openingForToday = priorEntry
              ? priorEntry.closingStock
              : updatedIngredient.currentStock.add(new Prisma.Decimal(totalQty));

            await tx.inventoryDailyEntry.create({
              data: {
                restaurantId: kitchenRestaurantId,
                itemId: ingredientId,
                entryDate: today,
                openingStock: openingForToday,
                consumedStock: new Prisma.Decimal(totalQty),
                closingStock: updatedIngredient.currentStock,
              },
            });
          }

          await tx.orderDeductionLog.upsert({
            where: { orderId_ingredientId: { orderId: lockedOrder.id, ingredientId } },
            create: {
              orderId: lockedOrder.id,
              restaurantId,
              ingredientId,
              menuItemId: menuItemIds[0] || null,
              quantity: new Prisma.Decimal(totalQty),
              status: 'SUCCESS',
            },
            update: {
              quantity: new Prisma.Decimal(totalQty),
              status: 'SUCCESS',
              error: null,
            },
          });

          if (Number(updatedIngredient.currentStock) <= Number(updatedIngredient.reorderLevel)) {
            logger.warn(`[Kitchen] Low stock: ${updatedIngredient.name} (${updatedIngredient.currentStock} ${updatedIngredient.unit}, reorder at ${updatedIngredient.reorderLevel})`);
            try {
              const io = getIo();
              if (io) {
                io.to(`kitchen:${kitchenRestaurantId}`).emit("kitchen:low-stock", {
                  ingredientId: updatedIngredient.id,
                  name: updatedIngredient.name,
                  currentStock: Number(updatedIngredient.currentStock),
                  reorderLevel: Number(updatedIngredient.reorderLevel),
                  unit: updatedIngredient.unit,
                });
              }
            } catch (socketErr) { /* non-critical */ }
          }
        } catch (err: any) {
          const errMsg = `Ingredient ${ingredientId}: ${err.message}`;
          logger.error(`[Kitchen] Deduction failed for ${errMsg}`);
          kitchenDeductionErrors.push(errMsg);

          await tx.orderDeductionLog.upsert({
            where: { orderId_ingredientId: { orderId: lockedOrder.id, ingredientId } },
            create: {
              orderId: lockedOrder.id,
              restaurantId,
              ingredientId,
              menuItemId: menuItemIds[0] || null,
              quantity: new Prisma.Decimal(totalQty),
              status: 'FAILED',
              error: err.message,
            },
            update: {
              status: 'FAILED',
              error: err.message,
            },
          });

          try {
            const io = getIo();
            if (io) {
              io.to(`kitchen:${kitchenRestaurantId}`).emit("kitchen:deduction-failed", {
                ingredientId,
                restaurantId: kitchenRestaurantId,
                orderId: lockedOrder.id,
                quantity: totalQty,
                error: err.message,
              });
            }
          } catch (socketErr) { /* non-critical */ }
        }
      }
    }
  }

  // Update order flags
  await tx.order.update({
    where: { id: orderId },
    data: {
      inventoryDeducted: kitchenDeductionErrors.length === 0,
      barInventoryDeducted: barDeductionErrors.length === 0,
    },
  });

  return { inventoryUpdates, barDeductionErrors, kitchenDeductionErrors, missingRecipeItems };
}
