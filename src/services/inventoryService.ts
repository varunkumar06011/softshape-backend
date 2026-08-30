import { Prisma } from "@prisma/client";

import { getKolkataDateString } from "../utils/date";

import { resolveKitchenRestaurantId } from "../lib/tenantContext";

import { getIo } from "../socket";

import prisma from "../lib/prisma";

import logger from "../lib/logger";

import {

  buildInventoryByName,

  buildDualVariantMap,

  findInventoryForOrderedItem,

  computeMlPerUnit,

  resolveMenuToInventory,

} from "../utils/barMatching";



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

// ─────────────────────────────────────────────────────────────────────────────
// restoreInventoryForOrder — reverses stock deductions when a settled bill is
// voided/deleted. Called inside the soft-void transaction in
// transactionDeleteService. Idempotent via Order.inventoryReversed flag and
// deduction log status='REVERSED'.
// ─────────────────────────────────────────────────────────────────────────────

export async function restoreInventoryForOrder(
  orderId: string,
  restaurantId: string,
  tx: any,
  userId: string,
  reason: string,
): Promise<{ barRestored: number; kitchenRestored: number; missingItems: string[] }> {
  // Lock the order FOR UPDATE — tenant-scoped for defense-in-depth
  const lockedOrderRows = await tx.$queryRaw<Array<{ id: string; inventoryReversed: boolean }>>`
    SELECT "id", "inventoryReversed" FROM "Order" WHERE "id" = ${orderId} AND "restaurantId" = ${restaurantId} FOR UPDATE
  `;
  const lockedOrder = lockedOrderRows[0];
  if (!lockedOrder) {
    throw Object.assign(new Error("Order not found for inventory restore"), { statusCode: 404 });
  }

  // Idempotency: if already reversed, no-op
  if (lockedOrder.inventoryReversed) {
    return { barRestored: 0, kitchenRestored: 0, missingItems: [] };
  }

  const missingItems: string[] = [];
  let barRestored = 0;
  let kitchenRestored = 0;
  const snapshotDate = getKolkataDateString();

  // ── Bar restoration ──────────────────────────────────────────────────────
  const barLogs = await tx.barDeductionLog.findMany({
    where: { orderId, restaurantId, status: 'SUCCESS' },
  });

  for (const log of barLogs) {
    // Tenant-scoped lock (defense-in-depth): include restaurantId to prevent
    // modifying another tenant's item even if a deduction log references it.
    const lockedItemRows = await tx.$queryRaw<Array<{ id: string; currentStock: typeof Prisma.Decimal }>>`
      SELECT "id", "currentStock" FROM "inventory_items" WHERE "id" = ${log.inventoryItemId} AND "restaurantId" = ${restaurantId} FOR UPDATE
    `;
    const lockedItem = lockedItemRows[0];

    if (!lockedItem) {
      missingItems.push(log.inventoryItemId);
      await tx.auditLog.create({
        data: {
          userId,
          restaurantId,
          action: 'REVERSAL_ITEM_MISSING',
          entityType: 'InventoryItem',
          entityId: log.inventoryItemId,
          metadata: { orderId, itemId: log.inventoryItemId, quantity: Number(log.quantity), reason } as any,
        },
      }).catch(() => {});
      continue;
    }

    const stockBefore = lockedItem.currentStock;
    const stockAfter = stockBefore.add(log.quantity);

    // Tenant-scoped update (defense-in-depth)
    const updateResult = await tx.inventoryItem.updateMany({
      where: { id: log.inventoryItemId, restaurantId },
      data: { currentStock: stockAfter, updatedAt: new Date() },
    });
    if (updateResult.count === 0) {
      missingItems.push(log.inventoryItemId);
      await tx.auditLog.create({
        data: {
          userId,
          restaurantId,
          action: 'REVERSAL_ITEM_MISSING',
          entityType: 'InventoryItem',
          entityId: log.inventoryItemId,
          metadata: { orderId, itemId: log.inventoryItemId, quantity: Number(log.quantity), reason } as any,
        },
      }).catch(() => {});
      continue;
    }

    await tx.inventoryTransaction.create({
      data: {
        restaurantId,
        itemId: log.inventoryItemId,
        orderId,
        type: 'SALE_REVERSAL',
        source: 'POS_DEDUCTION',
        quantityChange: log.quantity,
        stockBefore,
        stockAfter,
        notes: `Reversal: ${reason}`,
        createdBy: userId,
      },
    });

    await tx.dailyInventorySnapshot.upsert({
      where: {
        restaurantId_snapshotDate_itemId: {
          restaurantId,
          snapshotDate,
          itemId: log.inventoryItemId,
        },
      },
      create: {
        restaurantId,
        itemId: log.inventoryItemId,
        snapshotDate,
        itemName: 'Unknown',
        openingStock: stockBefore,
        purchased: new Prisma.Decimal(0),
        sold: new Prisma.Decimal(0).sub(log.quantity),
        wastage: new Prisma.Decimal(0),
        adjusted: new Prisma.Decimal(0),
        closingStock: stockAfter,
      },
      update: {
        sold: { decrement: log.quantity },
        closingStock: stockAfter,
      },
    });

    await tx.barDeductionLog.update({
      where: { id: log.id },
      data: { status: 'REVERSED' },
    });

    barRestored++;
  }

  // ── Kitchen restoration ──────────────────────────────────────────────────
  const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
  const kitchenLogs = await tx.orderDeductionLog.findMany({
    where: { orderId, restaurantId, status: 'SUCCESS' },
  });

  for (const log of kitchenLogs) {
    // Tenant-scoped lock (defense-in-depth): include kitchenRestaurantId
    const lockedItemRows = await tx.$queryRaw<Array<{ id: string; currentStock: typeof Prisma.Decimal }>>`
      SELECT "id", "currentStock" FROM "KitchenInventoryItem" WHERE "id" = ${log.ingredientId} AND "restaurantId" = ${kitchenRestaurantId} FOR UPDATE
    `;
    const lockedItem = lockedItemRows[0];

    if (!lockedItem) {
      missingItems.push(log.ingredientId);
      await tx.auditLog.create({
        data: {
          userId,
          restaurantId,
          action: 'REVERSAL_ITEM_MISSING',
          entityType: 'KitchenInventoryItem',
          entityId: log.ingredientId,
          metadata: { orderId, itemId: log.ingredientId, quantity: Number(log.quantity), reason } as any,
        },
      }).catch(() => {});
      continue;
    }

    const stockBefore = lockedItem.currentStock;
    const stockAfter = stockBefore.add(log.quantity);

    // Tenant-scoped update (defense-in-depth)
    const updateResult = await tx.kitchenInventoryItem.updateMany({
      where: { id: log.ingredientId, restaurantId: kitchenRestaurantId },
      data: { currentStock: stockAfter, updatedAt: new Date() },
    });
    if (updateResult.count === 0) {
      missingItems.push(log.ingredientId);
      await tx.auditLog.create({
        data: {
          userId,
          restaurantId,
          action: 'REVERSAL_ITEM_MISSING',
          entityType: 'KitchenInventoryItem',
          entityId: log.ingredientId,
          metadata: { orderId, itemId: log.ingredientId, quantity: Number(log.quantity), reason } as any,
        },
      }).catch(() => {});
      continue;
    }

    await tx.kitchenInventoryTransaction.create({
      data: {
        restaurantId: kitchenRestaurantId,
        itemId: log.ingredientId,
        type: 'SALE_REVERSAL',
        quantityChange: log.quantity,
        stockBefore,
        stockAfter,
        source: 'ORDER_REVERSAL',
        referenceId: orderId,
        notes: `Reversal: ${reason}`,
        createdBy: userId,
      },
    });

    await tx.inventoryDailyEntry.upsert({
      where: {
        restaurantId_itemId_entryDate: {
          restaurantId: kitchenRestaurantId,
          itemId: log.ingredientId,
          entryDate: snapshotDate,
        },
      },
      create: {
        restaurantId: kitchenRestaurantId,
        itemId: log.ingredientId,
        entryDate: snapshotDate,
        openingStock: stockBefore,
        addedStock: new Prisma.Decimal(0),
        consumedStock: new Prisma.Decimal(0).sub(log.quantity),
        closingStock: stockAfter,
      },
      update: {
        consumedStock: { decrement: log.quantity },
        closingStock: stockAfter,
      },
    });

    await tx.orderDeductionLog.update({
      where: { id: log.id },
      data: { status: 'REVERSED' },
    });

    kitchenRestored++;
  }

  // Set the reversal flag — idempotency guard for future calls
  await tx.order.update({
    where: { id: orderId },
    data: { inventoryReversed: true },
  });

  return { barRestored, kitchenRestored, missingItems };
}

export async function deductInventoryForOrder(

  orderId: string,

  restaurantId: string,

  tx: any,

  userId?: string | null,

  settlementTime?: Date | null,

): Promise<InventoryDeductionResult> {

  const inventoryUpdates: InventoryDeductionResult["inventoryUpdates"] = [];

  const barDeductionErrors: string[] = [];

  const kitchenDeductionErrors: string[] = [];

  const missingRecipeItems: string[] = [];



  // Re-fetch the order inside the transaction to get current flags + settlement date
  // settledAt/paidAt determine which business day the deduction belongs to.
  // When a retry job runs on a later date, we must still record the snapshot
  // under the ORIGINAL settlement date, not today's date.

  const lockedRows = await tx.$queryRaw<Array<{

    id: string;

    inventoryDeducted: boolean;

    barInventoryDeducted: boolean;

    settledAt: Date | null;

    paidAt: Date | null;

  }>>`

    SELECT "id", "inventoryDeducted", "barInventoryDeducted", "settledAt", "paidAt"

    FROM "Order" WHERE "id" = ${orderId} AND "restaurantId" = ${restaurantId} FOR UPDATE

  `;

  const lockedRow = lockedRows[0];

  if (!lockedRow) {

    throw new Error(`Order ${orderId} not found inside deduction transaction`);

  }

  // Determine the effective settlement date for snapshot/reporting purposes.
  // Priority: settledAt > paidAt > explicit settlementTime param > now.
  // The settlementTime param is passed by settleOrderService to avoid a
  // fresh new Date() that could differ near the midnight IST boundary.
  // This ensures that when the retry job processes a 28-08 order on 29-08,
  // the snapshot is still recorded under 28-08.
  const settlementDate = lockedRow.settledAt || lockedRow.paidAt || settlementTime || new Date();
  const settlementDateStr = getKolkataDateString(settlementDate);



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

  if (lockedOrder.restaurantId !== restaurantId) {

    throw new Error(`Order ${orderId} does not belong to restaurant ${restaurantId}`);

  }



  const liquorItems = lockedOrder.items.filter((item: any) => {

    const mt = item.menuItem?.menuType as string;

    return mt === "LIQUOR" || mt === "BAR";

  });



  // ── Bar inventory deduction ──────────────────────────────────────────────────

  if (!lockedRow.barInventoryDeducted) {

    const allInventoryItems = await tx.inventoryItem.findMany({

      where: { restaurantId, isActive: true },

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



    // Fetch previous day's snapshots so the settlement day's openingStock
    // = previous day's closingStock for continuous daily stock tracking.
    // Uses the settlement date (not today) so retry deductions get the
    // correct opening stock from the day the bill was actually settled.
    const [ty, tm, td] = settlementDateStr.split('-').map(Number);
    const prevDateObj = new Date(Date.UTC(ty, tm - 1, td - 1));
    const prevDateStr = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(prevDateObj.getUTCDate()).padStart(2, '0')}`;
    const prevDaySnapshots = await tx.dailyInventorySnapshot.findMany({
      where: { restaurantId, snapshotDate: prevDateStr },
      select: { itemId: true, closingStock: true },
    });
    const prevDayClosingMap = new Map<string, number>(
      prevDaySnapshots.map((s: any) => [s.itemId, Number(s.closingStock)])
    );

    // Fetch existing bar deduction logs for per-item idempotency

    const existingBarLogs = await tx.barDeductionLog.findMany({

      where: { orderId, restaurantId },

    });

    const successLogInvIds = new Set(

      existingBarLogs.filter((l: { status: string; inventoryItemId: string }) => l.status === 'SUCCESS').map((l: { inventoryItemId: string }) => l.inventoryItemId)

    );

    // Track total quantity already deducted per (menuItemId, inventoryItemId) so we

    // can skip if the full order amount was already deducted (prevents double-deduction

    // when one variant covered the full amount and the other was never touched).

    const successLogQtyByInvId = new Map<string, number>();

    for (const l of existingBarLogs as any[]) {

      if (l.status === 'SUCCESS') {

        successLogQtyByInvId.set(l.inventoryItemId, (successLogQtyByInvId.get(l.inventoryItemId) || 0) + Number(l.quantity || 0));

      }

    }



    const inventoryByName = buildInventoryByName(allInventoryItems);

    const dualVariantMap = buildDualVariantMap(inventoryByName);



    // ── Mapping lookup (Phase 4a) ────────────────────────────────────────────

    // Resolve (menuItemId, variantPrice) → BarItemMapping rows so deduction is

    // deterministic instead of name-guessing. The universal resolver
    // (resolveMenuToInventory) handles all fallback paths automatically.

    let mappingByKey = new Map<string, any>();

    try {

      const mappings = await tx.barItemMapping.findMany({

        where: {

          restaurantId,

          OR: liquorItems.map((i: any) => ({ menuItemId: i.menuItemId, variantPrice: i.price })),

        },

      });

      mappingByKey = new Map<string, any>(

        mappings.map((m: any) => [`${m.menuItemId}:${Number(m.variantPrice)}`, m] as [string, any])

      );

    } catch (mapErr: any) {

      // Table may not exist yet (migration not run) — fall back to name matcher

      logger.warn(`[Inventory] BarItemMapping lookup failed (${mapErr.message}). Using fallback matcher.`);

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

      // ── Universal menu→inventory resolution ─────────────────────────────
      // Uses resolveMenuToInventory() which tries, in priority order:
      //   1. DIRECT   — inventory item.menuItemId === this menu item's id
      //   2. MAPPING  — BarItemMapping table row for (menuItemId, variantPrice)
      //   3. BASE_NAME — normalized product name match with size awareness
      //   4. BEER_FUZZY — vowel-normalized beer name match (beer only)
      //
      // mlPerUnit is ALWAYS derived from the MENU ITEM's size (parsed from
      // the name), never from the inventory bottle size. This ensures:
      //   "Mansion House 30ml" → deduct 30ml from whatever bottle is in stock
      //   "Mansion House 180ml" → deduct 180ml from the 180ml bottle

      const match = resolveMenuToInventory(
        menuItemId,
        menuItemName,
        itemPrice,
        allInventoryItems,
        {
          mappings: mappingByKey,
          logPrefix: '[Inventory]',
          log: (m) => logger.info(m),
        },
      );

      let primaryInv: any = match.primary;
      let secondaryInv: any = match.secondary;
      let mlPerUnit: number = match.mlPerUnit;
      let variantLabel: string = match.variantLabel;

      if (!primaryInv) {

        logger.warn(`[Inventory] NO_MAPPING: "${menuItemName}" @ ₹${itemPrice} (menuItemId: ${menuItemId}). Skipping.`);

        barDeductionErrors.push(`NO_MAPPING: ${menuItemName} @ ₹${itemPrice}`);

        // Emit bar:unmapped-item socket event for live dashboard surfacing

        try {

          const io = getIo();

          if (io) io.to(restaurantId).emit('bar:unmapped-item', { menuItemName, menuItemId, price: itemPrice, restaurantId });

        } catch { /* non-fatal */ }

        continue;

      }

      const totalMl = mlPerUnit * totalQuantity;



      // Per-item idempotency: skip if the total already deducted across both variants

      // covers the full order amount for this (menuItemId, price) pair.

      const primaryAlreadyDone = successLogInvIds.has(primaryInv.id);

      const secondaryAlreadyDone = secondaryInv ? successLogInvIds.has(secondaryInv.id) : true;

      const alreadyDeductedQty =

        (successLogQtyByInvId.get(primaryInv.id) || 0) +

        (secondaryInv ? (successLogQtyByInvId.get(secondaryInv.id) || 0) : 0);

      if (primaryAlreadyDone && secondaryAlreadyDone) {

        logger.info(`[Inventory] Bar item "${menuItemName}" already deducted (both variants in success log). Skipping.`);

        continue;

      }

      // If the total already deducted equals or exceeds the expected total, skip

      // (covers the case where one variant covered the full amount and the other was never touched)

      if (alreadyDeductedQty >= totalMl) {

        logger.info(`[Inventory] Bar item "${menuItemName}" already fully deducted (${alreadyDeductedQty}ml >= ${totalMl}ml). Skipping.`);

        continue;

      }



      try {



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



          // Idempotency overrides: if one variant was already deducted, only deduct the

          // remaining amount from the other variant (not the full totalMl again)

          const remainingMl = totalMl - alreadyDeductedQty;

          if (primaryAlreadyDone) {

            deductFrom750 = 0;

            deductFrom180 = remainingMl;

          }

          if (secondaryAlreadyDone) {

            deductFrom180 = 0;

            if (!primaryAlreadyDone) {

              deductFrom750 = remainingMl;

            }

          }



          const totalAvailable = stock750 + Number(secondaryInv.currentStock);

          if (totalAvailable < totalMl) {

            logger.warn(`[Inventory] Negative stock allowed for ${menuItemName}: available ${totalAvailable}ml, required ${totalMl}ml — deducting into negative.`);

          }



          if (deductFrom750 > 0) {

            // Deduct the FULL amount — allow negative stock if needed.
            // The POS sale has already been settled; inventory MUST reflect it
            // even if opening stock was 0 or insufficient. Negative stock
            // signals a data problem (missing opening stock) but the deduction
            // itself must never be skipped or reduced.
            const available750 = Number(primaryInv.currentStock);
            const actualDeduct750 = deductFrom750;
            if (available750 < deductFrom750) {
              logger.warn(`[Inventory] Insufficient stock for ${primaryInv.menuItem?.name ?? 'item'} (750ml): available ${available750}ml, required ${deductFrom750}ml — deducting full amount (stock will go negative).`);
            }
            const updated750 = await tx.inventoryItem.update({

              where: { id: primaryInv.id },

              data: { currentStock: { decrement: actualDeduct750 } },

            });

            // Defense-in-depth: verify tenant ownership (throw rolls back the tx)
            if (updated750.restaurantId !== restaurantId) {
              throw new Error(`Tenant guard: item ${primaryInv.id} belongs to ${updated750.restaurantId}, expected ${restaurantId}`);
            }

            // Post-decrement: log negative stock (data issue, but deduction is correct)
            if (Number(updated750.currentStock) < 0) {
              logger.warn(`[Inventory] Negative stock after deduction for ${primaryInv.menuItem?.name ?? 'item'} (750ml): ${updated750.currentStock}ml — opening stock may need to be set.`);
            }



            await tx.inventoryTransaction.create({

              data: {

                restaurantId,

                itemId: primaryInv.id,

                orderId: lockedOrder.id,

                type: 'SALE',

                source: 'POS_DEDUCTION',

                quantityChange: -actualDeduct750,

                stockBefore: new Prisma.Decimal(Number(updated750.currentStock) + actualDeduct750),

                stockAfter: updated750.currentStock,

                notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel} (750ml stock)`,

                transactionDate: settlementDate,

                createdBy: userId || null,

              },

            });



            const snapshotDate = settlementDateStr;

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

                sold: actualDeduct750,

                wastage: 0,

                adjusted: 0,

                openingStock: prevDayClosingMap.has(primaryInv.id)
                  ? prevDayClosingMap.get(primaryInv.id)!
                  : Number(primaryInv.openingStock) || Number(primaryInv.currentStock),

                closingStock: updated750.currentStock,

              },

              update: {

                sold: { increment: actualDeduct750 },

                closingStock: updated750.currentStock,

                ...(prevDayClosingMap.has(primaryInv.id)
                  ? { openingStock: prevDayClosingMap.get(primaryInv.id)! }
                  : {}),

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



            await tx.barDeductionLog.upsert({

              where: { orderId_inventoryItemId: { orderId, inventoryItemId: primaryInv.id } },

              create: {

                orderId,

                restaurantId,

                inventoryItemId: primaryInv.id,

                menuItemId,

                quantity: new Prisma.Decimal(actualDeduct750),

                status: 'SUCCESS',

              },

              update: { status: 'SUCCESS', quantity: { increment: actualDeduct750 } },

            });

          }



          if (deductFrom180 > 0) {

            // Deduct the FULL amount — allow negative stock if needed.
            const available180 = Number(secondaryInv.currentStock);
            const actualDeduct180 = deductFrom180;
            if (available180 < deductFrom180) {
              logger.warn(`[Inventory] Insufficient stock for ${secondaryInv.menuItem?.name ?? 'item'} (180ml): available ${available180}ml, required ${deductFrom180}ml — deducting full amount (stock will go negative).`);
            }
            const updated180 = await tx.inventoryItem.update({

              where: { id: secondaryInv.id },

              data: { currentStock: { decrement: actualDeduct180 } },

            });

            // Defense-in-depth: verify tenant ownership (throw rolls back the tx)
            if (updated180.restaurantId !== restaurantId) {
              throw new Error(`Tenant guard: item ${secondaryInv.id} belongs to ${updated180.restaurantId}, expected ${restaurantId}`);
            }

            // Post-decrement: log negative stock (data issue, but deduction is correct)
            if (Number(updated180.currentStock) < 0) {
              logger.warn(`[Inventory] Negative stock after deduction for ${secondaryInv.menuItem?.name ?? 'item'} (180ml): ${updated180.currentStock}ml — opening stock may need to be set.`);
            }



            await tx.inventoryTransaction.create({

              data: {

                restaurantId,

                itemId: secondaryInv.id,

                orderId: lockedOrder.id,

                type: 'SALE',

                source: 'POS_DEDUCTION',

                quantityChange: -actualDeduct180,

                stockBefore: new Prisma.Decimal(Number(updated180.currentStock) + actualDeduct180),

                stockAfter: updated180.currentStock,

                notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel} (180ml stock)`,

                transactionDate: settlementDate,

                createdBy: userId || null,

              },

            });



            const snapshotDate = settlementDateStr;

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

                sold: actualDeduct180,

                wastage: 0,

                adjusted: 0,

                openingStock: prevDayClosingMap.has(secondaryInv.id)
                  ? prevDayClosingMap.get(secondaryInv.id)!
                  : Number(secondaryInv.openingStock) || Number(secondaryInv.currentStock),

                closingStock: updated180.currentStock,

              },

              update: {

                sold: { increment: actualDeduct180 },

                closingStock: updated180.currentStock,

                ...(prevDayClosingMap.has(secondaryInv.id)
                  ? { openingStock: prevDayClosingMap.get(secondaryInv.id)! }
                  : {}),

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



            await tx.barDeductionLog.upsert({

              where: { orderId_inventoryItemId: { orderId, inventoryItemId: secondaryInv.id } },

              create: {

                orderId,

                restaurantId,

                inventoryItemId: secondaryInv.id,

                menuItemId,

                quantity: new Prisma.Decimal(actualDeduct180),

                status: 'SUCCESS',

              },

              update: { status: 'SUCCESS', quantity: { increment: actualDeduct180 } },

            });

          }

        } else {

          if (primaryAlreadyDone) {

            logger.info(`[Inventory] Bar item "${menuItemName}" already deducted (single variant in success log). Skipping.`);

            continue;

          }

          if (Number(primaryInv.currentStock) < totalMl) {

            logger.warn(`[Inventory] Insufficient stock for ${primaryInv.menuItem?.name ?? 'Unknown Item'}: available ${primaryInv.currentStock}ml, required ${totalMl}ml — deducting full amount (stock will go negative).`);

          }

          // Deduct the FULL amount — allow negative stock if needed.
          // The POS sale has already been settled; inventory MUST reflect it.
          const actualDeductMl = totalMl;

          const updatedItem = await tx.inventoryItem.update({

            where: { id: primaryInv.id },

            data: { currentStock: { decrement: actualDeductMl } },

          });

          // Defense-in-depth: verify tenant ownership (throw rolls back the tx)
          if (updatedItem.restaurantId !== restaurantId) {
            throw new Error(`Tenant guard: item ${primaryInv.id} belongs to ${updatedItem.restaurantId}, expected ${restaurantId}`);
          }

          // Post-decrement: log negative stock (data issue, but deduction is correct)
          if (Number(updatedItem.currentStock) < 0) {
            logger.warn(`[Inventory] Negative stock after deduction for ${primaryInv.menuItem?.name ?? 'item'}: ${updatedItem.currentStock}ml — opening stock may need to be set.`);
          }



          await tx.inventoryTransaction.create({

            data: {

              restaurantId,

              itemId: primaryInv.id,

              orderId: lockedOrder.id,

              type: 'SALE',

              source: 'POS_DEDUCTION',

              quantityChange: -actualDeductMl,

              stockBefore: new Prisma.Decimal(Number(updatedItem.currentStock) + actualDeductMl),

              stockAfter: updatedItem.currentStock,

              notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel}`,

              transactionDate: settlementDate,

              createdBy: userId || null,

            },

          });



          const snapshotDate = settlementDateStr;

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

              sold: actualDeductMl,

              wastage: 0,

              adjusted: 0,

              openingStock: prevDayClosingMap.has(primaryInv.id)
                ? prevDayClosingMap.get(primaryInv.id)!
                : Number(primaryInv.openingStock) || Number(primaryInv.currentStock),

              closingStock: updatedItem.currentStock,

            },

            update: {

              sold: { increment: actualDeductMl },

              closingStock: updatedItem.currentStock,

              ...(prevDayClosingMap.has(primaryInv.id)
                ? { openingStock: prevDayClosingMap.get(primaryInv.id)! }
                : {}),

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



          await tx.barDeductionLog.upsert({

            where: { orderId_inventoryItemId: { orderId, inventoryItemId: primaryInv.id } },

            create: {

              orderId,

              restaurantId,

              inventoryItemId: primaryInv.id,

              menuItemId,

              quantity: new Prisma.Decimal(actualDeductMl),

              status: 'SUCCESS',

            },

            update: { status: 'SUCCESS', quantity: { increment: actualDeductMl } },

          });

        }

      } catch (err: any) {

        const errMsg = `Bar item "${menuItemName}": ${err.message}`;

        logger.error(`[Inventory] Bar deduction failed: ${errMsg}`);

        barDeductionErrors.push(errMsg);



        // Log failed deduction for per-item tracking (enables targeted retry)

        if (primaryInv && !successLogInvIds.has(primaryInv.id)) {

          await tx.barDeductionLog.upsert({

            where: { orderId_inventoryItemId: { orderId, inventoryItemId: primaryInv.id } },

            create: {

              orderId,

              restaurantId,

              inventoryItemId: primaryInv.id,

              menuItemId,

              quantity: new Prisma.Decimal(0),

              status: 'FAILED',

              error: errMsg,

            },

            update: { status: 'FAILED', error: errMsg },

          }).catch(() => {});

        }

        if (secondaryInv && !successLogInvIds.has(secondaryInv.id)) {

          await tx.barDeductionLog.upsert({

            where: { orderId_inventoryItemId: { orderId, inventoryItemId: secondaryInv.id } },

            create: {

              orderId,

              restaurantId,

              inventoryItemId: secondaryInv.id,

              menuItemId,

              quantity: new Prisma.Decimal(0),

              status: 'FAILED',

              error: errMsg,

            },

            update: { status: 'FAILED', error: errMsg },

          }).catch(() => {});

        }

      }

    }

  }



  // ── Kitchen inventory deduction ──────────────────────────────────────────────

  if (!lockedRow.inventoryDeducted) {

    const foodItems = lockedOrder.items.filter((item: any) => item.menuItem?.menuType === "FOOD");

    if (foodItems.length > 0) {

      const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);



      // ── Combo expansion ──────────────────────────────────────────────────────

      // A combo is billed as one OrderItem but has no recipe of its own. To deduct

      // inventory correctly we expand each combo into its components and look up

      // each component's existing MenuItemRecipe (× component.quantity × ordered

      // quantity). Non-combo items pass through unchanged.

      const comboOrderItems = foodItems.filter((i: any) => i.menuItem?.isCombo);

      let componentRows: any[] = [];

      if (comboOrderItems.length > 0) {

        componentRows = await tx.comboComponent.findMany({

          where: { comboMenuItemId: { in: comboOrderItems.map((i: any) => i.menuItemId) }, restaurantId },

        });

      }

      const componentsByCombo = new Map<string, any[]>();

      for (const c of componentRows) {

        const arr = componentsByCombo.get(c.comboMenuItemId) ?? [];

        arr.push(c);

        componentsByCombo.set(c.comboMenuItemId, arr);

      }

      // Build the effective recipe-lookup list: one entry per (component) menuItemId

      // with the quantity multiplier to apply against its recipe.

      const recipeLookups: Array<{ recipeMenuItemId: string; multiplier: number; sourceMenuItemId: string; sourceName: string }> = [];

      for (const item of foodItems) {

        if (item.menuItem?.isCombo) {

          const comps = componentsByCombo.get(item.menuItemId) ?? [];

          for (const comp of comps) {

            recipeLookups.push({

              recipeMenuItemId: comp.componentMenuItemId,

              multiplier: Number(comp.quantity) * item.quantity,

              sourceMenuItemId: item.menuItemId,

              sourceName: item.menuItem.name,

            });

          }

        } else {

          recipeLookups.push({

            recipeMenuItemId: item.menuItemId,

            multiplier: item.quantity,

            sourceMenuItemId: item.menuItemId,

            sourceName: item.menuItem.name,

          });

        }

      }



      const recipeMenuItemIds = Array.from(new Set(recipeLookups.map((l) => l.recipeMenuItemId)));

      const recipes = await tx.menuItemRecipe.findMany({

        where: { menuItemId: { in: recipeMenuItemIds }, restaurantId },

        include: { ingredient: true },

      });



      const recipesByMenuItem = new Map<string, any[]>();

      for (const r of recipes) {

        const arr = recipesByMenuItem.get(r.menuItemId) ?? [];

        arr.push(r);

        recipesByMenuItem.set(r.menuItemId, arr);

      }

      // Track which source items had no recipe at all (for missingRecipeItems).

      const sourcesWithRecipe = new Set<string>();

      for (const lookup of recipeLookups) {

        if ((recipesByMenuItem.get(lookup.recipeMenuItemId) ?? []).length > 0) {

          sourcesWithRecipe.add(lookup.sourceMenuItemId);

        }

      }

      for (const item of foodItems) {

        if (!sourcesWithRecipe.has(item.menuItemId)) {

          if (!missingRecipeItems.includes(item.menuItem.name)) {

            missingRecipeItems.push(item.menuItem.name);

          }

        }

      }



      const ingredientDeductions = new Map<string, { totalQty: number; menuItemIds: string[] }>();

      for (const lookup of recipeLookups) {

        for (const recipe of (recipesByMenuItem.get(lookup.recipeMenuItemId) ?? [])) {

          // Guard: skip recipes with 0 or negative quantity — they produce
          // no deduction and silently hide the fact that the recipe is broken.
          // Log a warning so admins can find and fix these via the recipe editor.
          const recipeQty = Number(recipe.quantity);
          if (!Number.isFinite(recipeQty) || recipeQty <= 0) {
            logger.warn(
              { menuItemId: lookup.sourceMenuItemId, ingredientId: recipe.ingredientId, quantity: recipe.quantity },
              "[InventoryDeduction] Recipe has 0/negative quantity — skipping deduction. Fix in recipe editor.",
            );
            continue;
          }

          const existing = ingredientDeductions.get(recipe.ingredientId);

          if (existing) {

            existing.totalQty += recipeQty * lookup.multiplier;

            if (!existing.menuItemIds.includes(lookup.sourceMenuItemId)) {

              existing.menuItemIds.push(lookup.sourceMenuItemId);

            }

          } else {

            ingredientDeductions.set(recipe.ingredientId, {

              totalQty: recipeQty * lookup.multiplier,

              menuItemIds: [lookup.sourceMenuItemId],

            });

          }

        }

      }



      const existingLogs = await tx.orderDeductionLog.findMany({

        where: { orderId: lockedOrder.id, restaurantId },

      });

      const successLogIds = new Set(existingLogs.filter((l: any) => l.status === 'SUCCESS').map((l: any) => l.ingredientId));



      // Use the settlement date for kitchen daily entries too, so retry
      // deductions record under the original bill date.
      const today = settlementDateStr;

      for (const [ingredientId, { totalQty, menuItemIds }] of ingredientDeductions.entries()) {

        if (successLogIds.has(ingredientId)) {

          logger.info(`[Kitchen] Skipping ingredient ${ingredientId} — already deducted successfully in a prior attempt.`);

          continue;

        }



        try {

          // Pre-check: read current stock so we can clamp the deduction to
          // the available quantity. This prevents the negative-stock guard
          // from throwing and leaving the order perpetually un-deducted
          // (which causes the retry job to loop forever on the same
          // ingredients).
          const ingredientBefore = await tx.kitchenInventoryItem.findFirst({
            where: { id: ingredientId, restaurantId: kitchenRestaurantId },
            select: { id: true, currentStock: true, name: true, unit: true, reorderLevel: true, restaurantId: true },
          });
          if (!ingredientBefore) {
            throw new Error(`Ingredient ${ingredientId} not found in tenant ${kitchenRestaurantId}`);
          }
          const availableStock = Number(ingredientBefore.currentStock);
          const requestedQty = totalQty;
          const shortage = Math.max(0, requestedQty - availableStock);
          const actualDeductQty = Math.min(requestedQty, availableStock);

          // If stock is already 0, skip decrement but record as SUCCESS with
          // a shortage note so the order is marked deducted and retry stops.
          if (actualDeductQty <= 0) {
            logger.warn(
              `[Kitchen] Stock shortage: ingredient ${ingredientId} (${ingredientBefore.name}) — requested ${requestedQty} ${ingredientBefore.unit}, available ${availableStock}. Deduction skipped; order marked deducted to stop retry loop.`,
            );
            await tx.orderDeductionLog.upsert({
              where: { orderId_ingredientId: { orderId: lockedOrder.id, ingredientId } },
              create: {
                orderId: lockedOrder.id,
                restaurantId,
                ingredientId,
                menuItemId: menuItemIds[0] || null,
                quantity: new Prisma.Decimal(0),
                status: 'SUCCESS',
                error: `Stock shortage: requested ${requestedQty} ${ingredientBefore.unit}, available ${availableStock}`,
              },
              update: {
                quantity: new Prisma.Decimal(0),
                status: 'SUCCESS',
                error: `Stock shortage: requested ${requestedQty} ${ingredientBefore.unit}, available ${availableStock}`,
              },
            });
            try {
              const io = getIo();
              if (io) {
                io.to(`kitchen:${kitchenRestaurantId}`).emit("kitchen:stock-shortage", {
                  ingredientId,
                  name: ingredientBefore.name,
                  restaurantId: kitchenRestaurantId,
                  orderId: lockedOrder.id,
                  requestedQty,
                  availableStock,
                  shortage: requestedQty,
                });
              }
            } catch (socketErr) { /* non-critical */ }
            continue;
          }

          // Deduct the clamped quantity (stock will never go below 0)
          const updatedIngredient = await tx.kitchenInventoryItem.update({

            where: { id: ingredientId },

            data: { currentStock: { decrement: new Prisma.Decimal(actualDeductQty) } },

          });

          // Defense-in-depth: verify tenant ownership (throw rolls back the tx)
          if (updatedIngredient.restaurantId !== kitchenRestaurantId) {
            throw new Error(`Tenant guard: ingredient ${ingredientId} belongs to ${updatedIngredient.restaurantId}, expected ${kitchenRestaurantId}`);
          }

          const stockAfterVal = Number(updatedIngredient.currentStock);

          const stockBeforeVal = stockAfterVal + actualDeductQty;

          // Log shortage if we couldn't fully satisfy the deduction
          if (shortage > 0) {
            logger.warn(
              `[Kitchen] Stock shortage: ingredient ${ingredientId} (${ingredientBefore.name}) — requested ${requestedQty} ${ingredientBefore.unit}, available ${availableStock}, deducted ${actualDeductQty}, shortage ${shortage}. Order=${lockedOrder.id}`,
            );
            try {
              const io = getIo();
              if (io) {
                io.to(`kitchen:${kitchenRestaurantId}`).emit("kitchen:stock-shortage", {
                  ingredientId,
                  name: ingredientBefore.name,
                  restaurantId: kitchenRestaurantId,
                  orderId: lockedOrder.id,
                  requestedQty,
                  availableStock,
                  shortage,
                });
              }
            } catch (socketErr) { /* non-critical */ }
          }



          // Write ledger entry for recipe consumption

          await tx.kitchenInventoryTransaction.create({

            data: {

              restaurantId: kitchenRestaurantId,

              itemId: ingredientId,

              type: "RECIPE_CONSUMPTION",

              quantityChange: new Prisma.Decimal(-Math.round(actualDeductQty * 100) / 100),

              stockBefore: new Prisma.Decimal(Math.round(stockBeforeVal * 100) / 100),

              stockAfter: new Prisma.Decimal(Math.round(stockAfterVal * 100) / 100),

              source: "ORDER_SETTLEMENT",

              referenceId: lockedOrder.id,

              notes: shortage > 0
                ? `Order settlement (SHORTAGE): ${menuItemIds.map(id => id).join(', ')} — requested ${requestedQty} ${updatedIngredient.unit}, deducted ${actualDeductQty}, shortage ${shortage}`
                : `Order settlement: ${menuItemIds.map(id => id).join(', ')} — ${actualDeductQty} ${updatedIngredient.unit}`,

              createdBy: userId || null,

            },

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

                consumedStock: { increment: new Prisma.Decimal(actualDeductQty) },

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

              : updatedIngredient.currentStock.add(new Prisma.Decimal(actualDeductQty));



            await tx.inventoryDailyEntry.create({

              data: {

                restaurantId: kitchenRestaurantId,

                itemId: ingredientId,

                entryDate: today,

                openingStock: openingForToday,

                consumedStock: new Prisma.Decimal(actualDeductQty),

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

              quantity: new Prisma.Decimal(actualDeductQty),

              status: 'SUCCESS',

            },

            update: {

              quantity: new Prisma.Decimal(actualDeductQty),

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

  // Only mark as deducted if we actually processed items.

  // When items haven't synced yet (race condition), leave flags false

  // so retryFailedDeductions picks this order up later.

  // NO_MAPPING errors are configuration issues, not deduction failures.
  // Items that DID have mappings were successfully deducted. Marking the
  // entire order as "not deducted" causes retryFailedDeductions to re-process
  // the same order every 5 minutes. Treat NO_MAPPING as non-fatal: the order
  // is marked deducted, unmapped items are logged for admin follow-up.
  const hasItems = lockedOrder.items.length > 0;
  const barRealErrors = barDeductionErrors.filter(e => !e.startsWith('NO_MAPPING:'));

  await tx.order.update({

    where: { id: orderId },

    data: {

      inventoryDeducted: hasItems && kitchenDeductionErrors.length === 0,

      barInventoryDeducted: hasItems && barRealErrors.length === 0,

    },

  });



  return { inventoryUpdates, barDeductionErrors, kitchenDeductionErrors, missingRecipeItems };

}



// ── Retry failed inventory deductions for paid orders ─────────────────────────

// Called by the periodic background job in index.ts. Uses the same

// deductInventoryForOrder() function that settlement uses, ensuring all

// deduction paths go through the same locked, idempotent logic.

export async function retryFailedDeductions(restaurantId: string): Promise<{

  retried: number;

  succeeded: number;

  failed: number;

  errors: string[];

}> {

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);



  const stuckOrders = await prisma.order.findMany({

    where: {

      restaurantId,

      status: "PAID",

      // Find orders that still need deduction. We don't filter by paidAt
      // because many edge-synced orders have Order.paidAt = null (the paidAt
      // is only on the Transaction row). Filtering by paidAt > 24h ago was
      // excluding ~95% of stuck orders. Instead, just find all PAID orders
      // with deduction flags still false, ordered by paidAt (nulls last).
      OR: [

        { inventoryDeducted: false },

        { barInventoryDeducted: false },

      ],

    },

    select: { id: true },

    take: 50,

    orderBy: { paidAt: 'desc' },

  });



  let retried = 0;

  let succeeded = 0;

  let failed = 0;

  const errors: string[] = [];



  for (const order of stuckOrders) {

    retried++;

    try {

      const result = await prisma.$transaction(async (tx: any) => {

        return await deductInventoryForOrder(order.id, restaurantId, tx, null);

      }, { timeout: 15000, maxWait: 20000 });



      if (result.barDeductionErrors.length === 0 && result.kitchenDeductionErrors.length === 0) {

        succeeded++;

      } else {

        failed++;

        errors.push(`Order ${order.id}: ${result.barDeductionErrors.length} bar errors, ${result.kitchenDeductionErrors.length} kitchen errors`);

      }

    } catch (err: any) {

      failed++;

      errors.push(`Order ${order.id}: ${err.message}`);

      logger.error(`[InvRetry] Failed to retry deduction for order ${order.id}: ${err.message}`);

    }

  }



  return { retried, succeeded, failed, errors };

}

