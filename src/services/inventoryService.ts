import { Prisma } from "@prisma/client";

import { getKolkataDateString } from "../utils/date";

import { resolveKitchenRestaurantId } from "../lib/tenantContext";
import { normalizeProductBaseName, parseMlFromName } from "../utils/barMatching";

// Drinks sold as a whole bottle/can rather than poured by the peg.
// Wine is deliberately NOT here: it is often sold by the glass.
const BY_THE_BOTTLE = /\b(beers?|breezers?|ciders?|lagers?|ales?|stouts?|rtd|ready.?to.?drink|cans?)\b/i;
function isSoldByTheBottle(barItem: { category?: string | null; name?: string | null }): boolean {
  return BY_THE_BOTTLE.test(String(barItem.category || "")) || /\bbeer\b/i.test(String(barItem.name || ""));
}

import { getIo } from "../socket";

import prisma from "../lib/prisma";

import logger from "../lib/logger";

import {

  MOVEMENT_TYPES,

  MOVEMENT_SOURCES,

  createMovement,

  sequentialRebuild,

  flagUnmappedItem,

  resolveDeductionMl,

} from "./barInventoryService";



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

// Put `qty` back into the kitchen's daily figures for `saleDate` and carry it
// forward through every later day (their opening and closing rise by `qty`).
async function restoreKitchenDailyFigures(
  tx: any,
  kitchenRestaurantId: string,
  itemId: string,
  saleDate: string,
  qty: any,
  stockBefore: any,
  stockAfter: any,
): Promise<void> {
  const today = getKolkataDateString();
  if (saleDate >= today) {
    await tx.inventoryDailyEntry.upsert({
      where: { restaurantId_itemId_entryDate: { restaurantId: kitchenRestaurantId, itemId, entryDate: saleDate } },
      create: {
        restaurantId: kitchenRestaurantId,
        itemId,
        entryDate: saleDate,
        openingStock: stockBefore,
        addedStock: new Prisma.Decimal(0),
        consumedStock: new Prisma.Decimal(0).sub(qty),
        closingStock: stockAfter,
      },
      update: { consumedStock: { decrement: qty }, closingStock: stockAfter },
    });
    return;
  }
  // Past day: that day used less, so it closed higher …
  await tx.inventoryDailyEntry.updateMany({
    where: { restaurantId: kitchenRestaurantId, itemId, entryDate: saleDate },
    data: { consumedStock: { decrement: qty }, closingStock: { increment: qty } },
  });
  // … and every later day opened and closed higher by the same amount.
  await tx.inventoryDailyEntry.updateMany({
    where: { restaurantId: kitchenRestaurantId, itemId, entryDate: { gt: saleDate } },
    data: { openingStock: { increment: qty }, closingStock: { increment: qty } },
  });
}

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
  // Stock goes back on the day it was sold, so that day's report and every
  // day after it stay right (today's date put the return on the wrong day).
  const soldAt = await tx.order.findUnique({ where: { id: orderId }, select: { settledAt: true, paidAt: true } });
  const snapshotDate = getKolkataDateString(soldAt?.settledAt ?? soldAt?.paidAt ?? new Date());

  // ── Bar restoration (new single-stock-pool model) ─────────────────────────
  // Creates SALE_REVERSAL movements (append-only, positive quantity).
  // Original AC_SALE movements stay unchanged. Sequential rebuild from
  // the original sale date through today recalculates all daily records.
  const barLogs = await tx.barDeductionLog.findMany({
    where: { orderId, restaurantId, status: "SUCCESS" },
  });

  // Track the earliest sale date for sequential rebuild
  let earliestSaleDate: string | null = null;
  const itemsToRebuild = new Set<string>();

  for (const log of barLogs) {
    // Find the original AC_SALE movement to get the sale date
    const originalMovement = await tx.barInventoryMovement.findFirst({
      where: {
        orderId,
        orderItemId: log.orderItemId,
        itemId: log.inventoryItemId,
        movementType: MOVEMENT_TYPES.AC_SALE,
      },
      select: { id: true, date: true },
      orderBy: { createdAt: "asc" },
    });

    const saleDate = originalMovement?.date ?? getKolkataDateString(log.createdAt);

    // Track earliest date for sequential rebuild
    if (!earliestSaleDate || saleDate < earliestSaleDate) {
      earliestSaleDate = saleDate;
    }
    itemsToRebuild.add(log.inventoryItemId);

    // Create SALE_REVERSAL movement (positive quantity, same date as original sale)
    await createMovement(tx, {
      restaurantId,
      itemId: log.inventoryItemId,
      date: saleDate,
      movementType: MOVEMENT_TYPES.SALE_REVERSAL,
      quantityMl: Number(log.quantity),
      orderId,
      orderItemId: log.orderItemId,
      source: MOVEMENT_SOURCES.VOID_REFUND,
      notes: `Reversal: ${reason}`,
      createdBy: userId,
    });

    // Mark deduction log as reversed
    await tx.barDeductionLog.update({
      where: { id: log.id },
      data: { status: "REVERSED" },
    });

    barRestored++;
  }

  // Sequential rebuild for each affected item from the earliest sale date
  if (earliestSaleDate) {
    for (const itemId of itemsToRebuild) {
      await sequentialRebuild(tx, restaurantId, itemId, earliestSaleDate);
    }
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

    await restoreKitchenDailyFigures(tx, kitchenRestaurantId, log.ingredientId, snapshotDate, log.quantity, stockBefore, stockAfter);

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

// ── reverseBarDeductionForOrderItem ───────────────────────────────────────────
// Per-line reversal: restores stock for ONE order item that was deducted and
// later removed from the bill (e.g. an edge re-sync marking the line
// removedFromBill). The movement ledger is append-only, so the removal needs
// an explicit SALE_REVERSAL — otherwise stock stays deducted forever.
// Idempotent: only logs still at status SUCCESS are reversed.
// Returns the number of deduction lines reversed.
export async function reverseBarDeductionForOrderItem(
  tx: any,
  restaurantId: string,
  orderId: string,
  orderItemId: string,
  reason: string,
  userId?: string | null,
): Promise<number> {
  const logs = await tx.barDeductionLog.findMany({
    where: { orderId, orderItemId, restaurantId, status: "SUCCESS" },
  });
  if (logs.length === 0) return 0;

  let earliestSaleDate: string | null = null;
  const itemsToRebuild = new Set<string>();

  for (const log of logs) {
    const originalMovement = await tx.barInventoryMovement.findFirst({
      where: {
        orderId,
        orderItemId: log.orderItemId,
        itemId: log.inventoryItemId,
        movementType: MOVEMENT_TYPES.AC_SALE,
      },
      select: { id: true, date: true },
      orderBy: { createdAt: "asc" },
    });
    const saleDate = originalMovement?.date ?? getKolkataDateString(log.createdAt);
    if (!earliestSaleDate || saleDate < earliestSaleDate) earliestSaleDate = saleDate;
    itemsToRebuild.add(log.inventoryItemId);

    await createMovement(tx, {
      restaurantId,
      itemId: log.inventoryItemId,
      date: saleDate,
      movementType: MOVEMENT_TYPES.SALE_REVERSAL,
      quantityMl: Number(log.quantity),
      orderId,
      orderItemId,
      source: MOVEMENT_SOURCES.VOID_REFUND,
      notes: `Reversal: ${reason}`,
      createdBy: userId ?? null,
    });
    await tx.barDeductionLog.update({
      where: { id: log.id },
      data: { status: "REVERSED" },
    });
  }

  // Rebuild daily records from the original sale date through today.
  if (earliestSaleDate) {
    for (const itemId of itemsToRebuild) {
      await sequentialRebuild(tx, restaurantId, itemId, earliestSaleDate);
    }
  }

  return logs.length;
}

// ── Kitchen usage an order's current lines need (recipes × qty, combos expanded)
async function expectedKitchenUsage(tx: any, restaurantId: string, orderId: string): Promise<Map<string, number>> {
  const items = await tx.orderItem.findMany({
    where: { orderId, removedFromBill: false, quantity: { gt: 0 } },
    include: { menuItem: true },
  });
  const food = items.filter((i: any) => i.menuItem?.menuType === "FOOD");
  const lookups: Array<{ id: string; mult: number }> = [];
  const combos = food.filter((i: any) => i.menuItem?.isCombo);
  const comps = combos.length
    ? await tx.comboComponent.findMany({ where: { comboMenuItemId: { in: combos.map((c: any) => c.menuItemId) }, restaurantId } })
    : [];
  for (const it of food) {
    if (it.menuItem?.isCombo) {
      for (const c of comps.filter((x: any) => x.comboMenuItemId === it.menuItemId)) {
        lookups.push({ id: c.componentMenuItemId, mult: Number(c.quantity) * it.quantity });
      }
    } else {
      lookups.push({ id: it.menuItemId, mult: it.quantity });
    }
  }
  const usage = new Map<string, number>();
  if (lookups.length === 0) return usage;
  const recipes = await tx.menuItemRecipe.findMany({
    where: { menuItemId: { in: [...new Set(lookups.map((l) => l.id))] }, restaurantId },
  });
  for (const l of lookups) {
    for (const r of recipes.filter((x: any) => x.menuItemId === l.id)) {
      const q = Number(r.quantity);
      if (!(q > 0)) continue;
      usage.set(r.ingredientId, (usage.get(r.ingredientId) ?? 0) + q * l.mult);
    }
  }
  return usage;
}

/**
 * Kitchen counterpart of reverseBarDeductionForOrderItem: after lines were
 * removed from an already-deducted bill, give back the ingredients those lines
 * used (dated to the sale day). Idempotent — compares what was deducted with
 * what the bill's remaining lines need, and returns only the surplus.
 */
export async function reconcileKitchenDeductionForOrder(
  tx: any,
  restaurantId: string,
  orderId: string,
  reason: string,
): Promise<number> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { inventoryDeducted: true, settledAt: true, paidAt: true },
  });
  if (!order?.inventoryDeducted) return 0; // not deducted yet — deduction will use current lines
  const logs = await tx.orderDeductionLog.findMany({ where: { orderId, restaurantId, status: "SUCCESS" } });
  if (logs.length === 0) return 0;

  const needed = await expectedKitchenUsage(tx, restaurantId, orderId);
  const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
  const saleDate = getKolkataDateString(order.settledAt ?? order.paidAt ?? new Date());
  let restored = 0;

  for (const log of logs) {
    const surplus = Number(log.quantity) - (needed.get(log.ingredientId) ?? 0);
    if (surplus < 0.01) continue; // ignore rounding noise
    const qty = new Prisma.Decimal(Math.round(surplus * 1000) / 1000);
    const rows = await tx.$queryRaw<Array<{ id: string; currentStock: any }>>`
      SELECT "id", "currentStock" FROM "KitchenInventoryItem" WHERE "id" = ${log.ingredientId} AND "restaurantId" = ${kitchenRestaurantId} FOR UPDATE
    `;
    if (!rows[0]) continue;
    const before = new Prisma.Decimal(rows[0].currentStock);
    const after = before.add(qty);
    await tx.kitchenInventoryItem.update({ where: { id: log.ingredientId }, data: { currentStock: after } });
    await tx.kitchenInventoryTransaction.create({
      data: {
        restaurantId: kitchenRestaurantId, itemId: log.ingredientId, type: "SALE_REVERSAL",
        quantityChange: qty, stockBefore: before, stockAfter: after,
        source: "ORDER_REVERSAL", referenceId: orderId, notes: `Line removed: ${reason}`,
      },
    });
    await restoreKitchenDailyFigures(tx, kitchenRestaurantId, log.ingredientId, saleDate, qty, before, after);
    await tx.orderDeductionLog.update({
      where: { id: log.id },
      data: { quantity: new Prisma.Decimal(Number(log.quantity)).sub(qty) },
    });
    restored++;
  }
  return restored;
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

  // Distinguish a genuinely empty/not-yet-synced order from an order whose
  // only persisted lines were removed from the bill.
  const persistedOrderItemCount = await tx.orderItem.count({ where: { orderId } });

  const liquorItems = lockedOrder.items.filter((item: any) => {

    const mt = item.menuItem?.menuType as string;

    return mt === "LIQUOR" || mt === "BAR";

  });



  // ── Bar inventory deduction (new single-stock-pool model) ───────────────────
  // Uses MenuItem.barInventoryItemId directly — no 4-tier matching.
  // Creates AC_SALE movements + updates BarDailyRecord immediately.
  // Append-only ledger: movements are never updated or deleted.
  if (!lockedRow.barInventoryDeducted) {

    // Fetch existing bar deduction logs for idempotency
    const existingBarLogs = await tx.barDeductionLog.findMany({
      where: { orderId, restaurantId },
    });
    const successLogKeys = new Set(
      existingBarLogs
        .filter((l: any) => l.status === "SUCCESS")
        .map((l: any) => `${l.orderItemId ?? "null"}:${l.inventoryItemId}`),
    );

    // Process lines in a fixed bottle order: each bottle row is locked below,
    // and two deductions locking the same bottles in different orders could
    // deadlock each other.
    const bottleKey = (i: any) => String(i.pourFromInventoryItemId ?? i.menuItem?.barInventoryItemId ?? "");
    liquorItems.sort((a: any, b: any) => bottleKey(a).localeCompare(bottleKey(b)));

    // Aggregate liquor order items by (menuItemId, pourFromInventoryItemId, orderItemId)
    // to handle multiple pegs of the same bottle in one order.
    for (const orderItem of liquorItems) {

      const menuItem = orderItem.menuItem;
      if (!menuItem) continue;

      // Resolve source bottle: pourFromInventoryItemId (captain override) → MenuItem.barInventoryItemId
      let sourceBarItemId: string | null = orderItem.pourFromInventoryItemId ?? null;

      if (!sourceBarItemId) {
        // Fall back to the menu item's direct link
        sourceBarItemId = menuItem.barInventoryItemId ?? null;
      }

      if (!sourceBarItemId) {
        // No inventory link — flag loudly and skip
        const errMsg = `NO_MAPPING: ${menuItem.name} (menuItemId: ${orderItem.menuItemId})`;
        barDeductionErrors.push(errMsg);
        flagUnmappedItem(restaurantId, menuItem.name, orderItem.menuItemId, orderId);
        continue;
      }

      // Verify the BarInventoryItem exists and belongs to this tenant
      let barItem = await tx.barInventoryItem.findUnique({
        where: { id: sourceBarItemId },
        select: { id: true, restaurantId: true, name: true, category: true, bottleSizeMl: true, currentStockMl: true, reorderLevelBottles: true, purchaseRate: true, sellingPricePerMl: true },
      });

      if (!barItem || barItem.restaurantId !== restaurantId) {
        const errMsg = `ITEM_NOT_FOUND: ${menuItem.name} (barInventoryItemId: ${sourceBarItemId})`;
        barDeductionErrors.push(errMsg);
        flagUnmappedItem(restaurantId, menuItem.name, orderItem.menuItemId, orderId);
        continue;
      }

      // If the operator skipped bottle selection for a partial pour, always
      // fall back to the 750ml stock SKU when one exists. Explicit bottle
      // selections remain authoritative; full-bottle sales keep their linked SKU.
      const deductionMl = resolveDeductionMl(menuItem);
      const isBottlePickerSize = [30, 60, 90, 180, 375].includes(deductionMl);
      if (!orderItem.pourFromInventoryItemId && isBottlePickerSize && barItem.bottleSizeMl !== 750) {
        const candidates = await tx.barInventoryItem.findMany({
          where: { restaurantId, isActive: true },
          select: { id: true, name: true, bottleSizeMl: true },
        });
        const baseName = normalizeProductBaseName(menuItem.name);
        const default750 = candidates.find((candidate: any) =>
          candidate.id !== barItem.id
          && candidate.name
          && normalizeProductBaseName(candidate.name) === baseName
          && Number(candidate.bottleSizeMl || 0) === 750,
        );
        if (default750) {
          sourceBarItemId = default750.id;
          barItem = await tx.barInventoryItem.findUnique({
            where: { id: sourceBarItemId },
            select: { id: true, restaurantId: true, name: true, category: true, bottleSizeMl: true, currentStockMl: true, reorderLevelBottles: true, purchaseRate: true, sellingPricePerMl: true },
          });
        }
      }

      // Per-line-item idempotency: skip if already deducted
      const logKey = `${orderItem.id}:${barItem.id}`;
      if (successLogKeys.has(logKey)) {
        logger.info(`[Inventory] Bar item "${menuItem.name}" (orderItem ${orderItem.id}) already deducted. Skipping.`);
        continue;
      }

      // Lock this bottle's stock row until the transaction ends. Two bills for
      // the same brand settling together otherwise each recomputed stock from
      // what they could see and the last one overwrote the other's sale.
      await tx.$queryRaw`SELECT "id" FROM "bar_inventory_items" WHERE "id" = ${barItem.id} FOR UPDATE`;

      // Items sold by the bottle (beer, wine, breezer…) with no size set deduct
      // the whole linked bottle — the old 30 ml default made a 650 ml beer
      // count as 30 ml.
      const effectiveMl = (menuItem.deductionMl == null || menuItem.deductionMl <= 0)
        && parseMlFromName(menuItem.name) == null
        && isSoldByTheBottle(barItem)
        ? Number(barItem.bottleSizeMl)
        : deductionMl;

      // Deduction amount: ml per unit × quantity
      const totalDeductionMl = effectiveMl * orderItem.quantity;

      try {
        // Create AC_SALE movement (append-only, negative quantity)
        await createMovement(tx, {
          restaurantId,
          itemId: barItem.id,
          date: settlementDateStr,
          movementType: MOVEMENT_TYPES.AC_SALE,
          quantityMl: -totalDeductionMl,
          orderId: lockedOrder.id,
          orderItemId: orderItem.id,
          unitCost: barItem.purchaseRate ? Number(barItem.purchaseRate) / barItem.bottleSizeMl : null,
          source: MOVEMENT_SOURCES.POS_SETTLEMENT,
          notes: `${orderItem.quantity}x ${menuItem.name} (${effectiveMl}ml each)`,
          createdBy: userId ?? null,
        });

        // Rebuild BarDailyRecords from the settlement date through today.
        // A single-day recalc would leave days between the sale date and
        // today stale when the deduction lands late (edge catch-up, retry
        // job on an old PAID order). sequentialRebuild also fills idle-day
        // gaps via recalculateDailyRecord's carry-forward.
        await sequentialRebuild(tx, restaurantId, barItem.id, settlementDateStr);

        // Create BarDeductionLog (with orderItemId for unique key)
        await tx.barDeductionLog.upsert({
          where: {
            orderId_orderItemId_inventoryItemId: {
              orderId,
              orderItemId: orderItem.id,
              inventoryItemId: barItem.id,
            },
          },
          create: {
            orderId,
            restaurantId,
            inventoryItemId: barItem.id,
            menuItemId: orderItem.menuItemId,
            orderItemId: orderItem.id,
            quantity: new Prisma.Decimal(totalDeductionMl),
            status: "SUCCESS",
          },
          update: {
            status: "SUCCESS",
            quantity: new Prisma.Decimal(totalDeductionMl),
          },
        });

        // Track for inventory updates response
        const updatedItem = await tx.barInventoryItem.findUnique({
          where: { id: barItem.id },
          select: { currentStockMl: true, reorderLevelBottles: true, bottleSizeMl: true, name: true },
        });

        if (updatedItem) {
          const currentStock = Number(updatedItem.currentStockMl);
          const reorderLevelMl = Number(updatedItem.reorderLevelBottles) * updatedItem.bottleSizeMl;
          inventoryUpdates.push({
            id: barItem.id,
            name: updatedItem.name,
            currentStock,
            reorderLevel: reorderLevelMl,
            unitOfMeasure: "ML",
            isLowStock: currentStock <= reorderLevelMl,
          });

          if (currentStock < 0) {
            logger.warn(
              `[Inventory] Negative stock after deduction for "${updatedItem.name}": ${currentStock}ml — opening stock may need to be set.`,
            );
          }
        }

      } catch (err: any) {
        const errMsg = `Bar item "${menuItem.name}": ${err.message}`;
        logger.error(`[Inventory] Bar deduction failed: ${errMsg}`);
        barDeductionErrors.push(errMsg);

        // Log failed deduction
        await tx.barDeductionLog.upsert({
          where: {
            orderId_orderItemId_inventoryItemId: {
              orderId,
              orderItemId: orderItem.id,
              inventoryItemId: barItem.id,
            },
          },
          create: {
            orderId,
            restaurantId,
            inventoryItemId: barItem.id,
            menuItemId: orderItem.menuItemId,
            orderItemId: orderItem.id,
            quantity: new Prisma.Decimal(0),
            status: "FAILED",
            error: errMsg,
          },
          update: { status: "FAILED", error: errMsg },
        }).catch(() => {});
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
          const shortage = Math.max(0, requestedQty - Math.max(0, availableStock));
          // Always record what the kitchen actually used. Stock may go below
          // zero — that means a purchase was not entered (or wastage/theft) and
          // must be visible. Clamping at zero hid the usage: food cost and the
          // variance against a physical count came out wrong.
          const actualDeductQty = requestedQty;

          // Deduct the full quantity (stock may go negative — flagged below)
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

          // Sale from an earlier day arriving late (outage, retry job): book it
          // on that day and lower every later day's opening/closing by the same
          // amount. Writing today's live stock into a past day's closing broke
          // the day-to-day chain.
          const isPastDay = today < getKolkataDateString();
          if (isPastDay) {
            const qty = new Prisma.Decimal(actualDeductQty);
            if (existingEntry) {
              await tx.inventoryDailyEntry.update({
                where: { id: existingEntry.id },
                data: { consumedStock: { increment: qty }, closingStock: { decrement: qty } },
              });
            } else {
              const prior = await tx.inventoryDailyEntry.findFirst({
                where: { restaurantId: kitchenRestaurantId, itemId: ingredientId, entryDate: { lt: today } },
                orderBy: { entryDate: 'desc' },
              });
              const opening = prior ? prior.closingStock : updatedIngredient.currentStock.add(qty);
              await tx.inventoryDailyEntry.create({
                data: {
                  restaurantId: kitchenRestaurantId, itemId: ingredientId, entryDate: today,
                  openingStock: opening, consumedStock: qty, closingStock: new Prisma.Decimal(opening).sub(qty),
                },
              });
            }
            await tx.inventoryDailyEntry.updateMany({
              where: { restaurantId: kitchenRestaurantId, itemId: ingredientId, entryDate: { gt: today } },
              data: { openingStock: { decrement: qty }, closingStock: { decrement: qty } },
            });
          } else if (existingEntry) {

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
  const hasPersistedItems = persistedOrderItemCount > 0;
  const barRealErrors = barDeductionErrors.filter(e => !e.startsWith('NO_MAPPING:'));

  await tx.order.update({

    where: { id: orderId },

    data: {

      inventoryDeducted: hasPersistedItems && kitchenDeductionErrors.length === 0,

      barInventoryDeducted: hasPersistedItems && barRealErrors.length === 0,

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

      // Skip orders with no settledAt — the edge sync hasn't arrived yet, so
      // deductInventoryForOrder would fall back to new Date() and date the
      // movement to today (wrong if the order was settled yesterday). The
      // edge sync will set settledAt and trigger deduction itself.
      settledAt: { not: null },

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

