// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Service — Shared utilities for the new single-stock-pool model
//
// Provides:
//   recalculateDailyRecord — aggregate movements for one (item, date) into a BarDailyRecord
//   sequentialRebuild      — cascade recalculation from a date through today
//   createMovement          — append-only movement creation helper
//
// All functions accept a Prisma transaction client (tx) so they can be used
// inside settlement, void, and admin-edit transactions.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { getKolkataDateString } from "../utils/date";
import { parseMlFromName } from "../utils/barMatching";
import logger from "../lib/logger";
import { getIo } from "../socket";

// ── Per-item edit serialization ──────────────────────────────────────────────
// Prevents two concurrent admin edits to the SAME item from racing on the
// "current effective total" computation. Each item gets its own promise chain;
// the second edit waits for the first to complete before reading movements.
const itemLocks = new Map<string, Promise<unknown>>();

/** Acquire a per-item mutex. Returns a release function. */
export function acquireItemLock(itemId: string): () => void {
  const prev = itemLocks.get(itemId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  itemLocks.set(itemId, prev.then(() => next));
  prev.catch(() => {}); // don't propagate errors from the previous edit
  return release;
}

// ── Movement types ────────────────────────────────────────────────────────────

export const MOVEMENT_TYPES = {
  OPENING: "OPENING",
  PURCHASE: "PURCHASE",
  AC_SALE: "AC_SALE",
  NON_AC_SALE: "NON_AC_SALE",
  WASTAGE: "WASTAGE",
  ADJUSTMENT: "ADJUSTMENT",
  SALE_REVERSAL: "SALE_REVERSAL",
  CORRECTION: "CORRECTION",
  PHYSICAL_COUNT: "PHYSICAL_COUNT",
} as const;

export const MOVEMENT_SOURCES = {
  POS_SETTLEMENT: "POS_SETTLEMENT",
  PDF_TO_ADMIN: "PDF_TO_ADMIN",
  MANUAL_ENTRY: "MANUAL_ENTRY",
  PURCHASE_ENTRY: "PURCHASE_ENTRY",
  OPENING_SETUP: "OPENING_SETUP",
  AUTO_CREATE: "AUTO_CREATE",
  VOID_REFUND: "VOID_REFUND",
  CORRECTION_EDIT: "CORRECTION_EDIT",
} as const;

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns an array of YYYY-MM-DD strings from startDate to today (inclusive). */
function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const start = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return dates;
}

/** Returns the previous day's YYYY-MM-DD string. */
function getPreviousDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
}

// ── recalculateDailyRecord ────────────────────────────────────────────────────

/**
 * Recalculate a single BarDailyRecord for (itemId, date) by aggregating all
 * movements for that date. Creates or updates the record.
 *
 * openingMl = previous day's systemClosingMl (or physicalClosingMl if set).
 * If no previous day record exists, openingMl = 0.
 *
 * @returns The recalculated BarDailyRecord
 */
export async function recalculateDailyRecord(
  tx: any,
  restaurantId: string,
  itemId: string,
  date: string,
): Promise<any> {
  // Get all movements for this date (oldest first so the latest OPENING wins)
  const movements = await tx.barInventoryMovement.findMany({
    where: { restaurantId, itemId, date },
    orderBy: { createdAt: "asc" },
  });

  // Aggregate by movement type
  let purchasedMl = 0;
  let acSaleMl = 0;
  let nonAcSaleMl = 0;
  let wastageMl = 0;
  let adjustmentMl = 0;
  // An OPENING movement sets the absolute opening for its date (append-only:
  // the most recent OPENING movement wins). This overrides prev-day closing.
  let openingOverrideMl: number | null = null;

  for (const m of movements) {
    const qty = Number(m.quantityMl);
    switch (m.movementType) {
      case MOVEMENT_TYPES.PURCHASE:
        purchasedMl += qty;
        break;
      case MOVEMENT_TYPES.AC_SALE:
        acSaleMl += Math.abs(qty);
        break;
      case MOVEMENT_TYPES.SALE_REVERSAL:
        acSaleMl -= qty; // reversal is positive, so subtract from acSale
        break;
      case MOVEMENT_TYPES.NON_AC_SALE:
        nonAcSaleMl += Math.abs(qty);
        break;
      case MOVEMENT_TYPES.WASTAGE:
        wastageMl += Math.abs(qty);
        break;
      case MOVEMENT_TYPES.ADJUSTMENT:
        adjustmentMl += qty; // signed: + add, - remove
        break;
      case MOVEMENT_TYPES.CORRECTION: {
        // Corrections are deltas — apply based on what they correct
        const correctionFor = m.correctionForId
          ? movements.find((x: any) => x.id === m.correctionForId)
          : null;
        if (correctionFor) {
          // Correction quantityMl is a STOCK delta (negative = more stock out).
          // Types stored as negative movements (sales, wastage) need the sign
          // flipped when expressed as "amount consumed".
          switch (correctionFor.movementType) {
            case MOVEMENT_TYPES.PURCHASE:
              purchasedMl += qty;
              break;
            case MOVEMENT_TYPES.AC_SALE:
              acSaleMl -= qty;
              break;
            case MOVEMENT_TYPES.NON_AC_SALE:
              nonAcSaleMl -= qty;
              break;
            case MOVEMENT_TYPES.WASTAGE:
              wastageMl -= qty;
              break;
            case MOVEMENT_TYPES.ADJUSTMENT:
              adjustmentMl += qty;
              break;
            default:
              // Generic correction — apply as adjustment
              adjustmentMl += qty;
              break;
          }
        } else {
          // No correctionFor reference — apply as adjustment
          adjustmentMl += qty;
        }
        break;
      }
      case MOVEMENT_TYPES.PHYSICAL_COUNT:
        // Physical count doesn't affect system calculations
        break;
      case MOVEMENT_TYPES.OPENING:
        // Absolute opening override for this date — latest OPENING wins
        openingOverrideMl = Math.abs(qty);
        break;
    }
  }

  // Ensure non-negative (reversals can make acSale negative if over-reversed)
  acSaleMl = Math.max(0, acSaleMl);

  // Get previous day's closing for opening
  const prevDate = getPreviousDate(date);
  const prevRecord = await tx.barDailyRecord.findUnique({
    where: {
      restaurantId_date_itemId: {
        restaurantId,
        date: prevDate,
        itemId,
      },
    },
  });

  const openingMl = openingOverrideMl ?? (prevRecord
    ? Number(prevRecord.physicalClosingMl ?? prevRecord.systemClosingMl)
    : 0);

  const systemClosingMl = openingMl + purchasedMl - acSaleMl - nonAcSaleMl - wastageMl + adjustmentMl;

  // Get item for financial calculations
  const item = await tx.barInventoryItem.findUnique({
    where: { id: itemId },
    select: { purchaseRate: true, sellingPricePerMl: true },
  });

  const purchaseRate = item?.purchaseRate ? Number(item.purchaseRate) : 0;
  const sellingPricePerMl = item?.sellingPricePerMl ? Number(item.sellingPricePerMl) : 0;

  // Financial calculations
  const stockValue = systemClosingMl * purchaseRate / (item ? 1 : 1); // per ml cost = purchaseRate / bottleSizeMl
  // Actually, purchaseRate is per bottle. Cost per ml = purchaseRate / bottleSizeMl.
  // We need bottleSizeMl for accurate per-ml cost.
  const itemFull = await tx.barInventoryItem.findUnique({
    where: { id: itemId },
    select: { purchaseRate: true, sellingPricePerMl: true, bottleSizeMl: true },
  });
  const bottleSizeMl = itemFull?.bottleSizeMl || 750;
  const costPerMl = itemFull?.purchaseRate ? Number(itemFull.purchaseRate) / bottleSizeMl : 0;
  const finalSellingPricePerMl = itemFull?.sellingPricePerMl ? Number(itemFull.sellingPricePerMl) : 0;

  const finalStockValue = systemClosingMl * costPerMl;
  const acRevenue = acSaleMl * finalSellingPricePerMl;
  const nonAcRevenue = nonAcSaleMl * finalSellingPricePerMl;
  const totalRevenue = acRevenue + nonAcRevenue;
  const consumptionCost = (acSaleMl + nonAcSaleMl + wastageMl) * costPerMl;
  const profit = totalRevenue - consumptionCost;
  const profitPercent = consumptionCost > 0 ? (profit / consumptionCost) * 100 : 0;

  // Upsert the daily record
  const record = await tx.barDailyRecord.upsert({
    where: {
      restaurantId_date_itemId: {
        restaurantId,
        date,
        itemId,
      },
    },
    create: {
      restaurantId,
      itemId,
      date,
      openingMl,
      purchasedMl,
      acSaleMl,
      nonAcSaleMl,
      wastageMl,
      adjustmentMl,
      systemClosingMl,
      purchaseRate: itemFull?.purchaseRate ?? null,
      stockValue: finalStockValue,
      acRevenue,
      nonAcRevenue,
      totalRevenue,
      consumptionCost,
      profit,
      profitPercent,
    },
    update: {
      openingMl,
      purchasedMl,
      acSaleMl,
      nonAcSaleMl,
      wastageMl,
      adjustmentMl,
      systemClosingMl,
      purchaseRate: itemFull?.purchaseRate ?? null,
      stockValue: finalStockValue,
      acRevenue,
      nonAcRevenue,
      totalRevenue,
      consumptionCost,
      profit,
      profitPercent,
    },
  });

  return record;
}

// ── sequentialRebuild ─────────────────────────────────────────────────────────

/**
 * Sequentially rebuild BarDailyRecords from fromDate through today for an item.
 *
 * For each date in the range:
 *   1. Recalculate the daily record from movements
 *   2. The opening = previous day's systemClosing (or physicalClosing if set)
 *
 * After all dates are rebuilt, updates BarInventoryItem.currentStockMl = today's
 * systemClosingMl.
 *
 * @param tx - Prisma transaction client
 * @param restaurantId - Restaurant scope
 * @param itemId - BarInventoryItem id
 * @param fromDate - Start date (YYYY-MM-DD)
 */
export async function sequentialRebuild(
  tx: any,
  restaurantId: string,
  itemId: string,
  fromDate: string,
): Promise<void> {
  const today = getKolkataDateString();
  const dates = getDateRange(fromDate, today);

  let lastClosingMl = 0;

  for (const date of dates) {
    const record = await recalculateDailyRecord(tx, restaurantId, itemId, date);
    lastClosingMl = Number(record.systemClosingMl);
  }

  // Update current stock to today's system closing
  await tx.barInventoryItem.update({
    where: { id: itemId },
    data: { currentStockMl: lastClosingMl },
  });
}

// ── sequentialRebuildChunked ──────────────────────────────────────────────────

/** Maximum days rebuilt per chunk to keep transactions short and lock-free. */
const REBUILD_CHUNK_DAYS = 30;

/**
 * Chunked variant of sequentialRebuild for post-commit use.
 *
 * Runs the rebuild in independent transactions of ≤ REBUILD_CHUNK_DAYS days
 * each, so a deep-history edit (months back) doesn't hold one long transaction.
 * Daily records are derived from movements — if a chunk fails, the next rebuild
 * self-heals. currentStockMl is already updated by createMovement, so real-time
 * stock is correct regardless.
 *
 * Use this AFTER the movement + edit log are committed, not inside their tx.
 */
export async function sequentialRebuildChunked(
  prismaClient: any,
  restaurantId: string,
  itemId: string,
  fromDate: string,
): Promise<void> {
  const today = getKolkataDateString();
  const dates = getDateRange(fromDate, today);

  for (let i = 0; i < dates.length; i += REBUILD_CHUNK_DAYS) {
    const chunk = dates.slice(i, i + REBUILD_CHUNK_DAYS);
    await prismaClient.$transaction(async (tx: any) => {
      let lastClosingMl = 0;
      // If this isn't the first chunk, read the previous chunk's closing.
      if (i > 0) {
        const prevDate = getPreviousDate(chunk[0]);
        const prevRecord = await tx.barDailyRecord.findUnique({
          where: { restaurantId_date_itemId: { restaurantId, date: prevDate, itemId } },
        });
        lastClosingMl = prevRecord
          ? Number(prevRecord.physicalClosingMl ?? prevRecord.systemClosingMl)
          : 0;
      }
      for (const date of chunk) {
        const record = await recalculateDailyRecord(tx, restaurantId, itemId, date);
        lastClosingMl = Number(record.systemClosingMl);
      }
      // Update currentStockMl on the final chunk only.
      if (i + REBUILD_CHUNK_DAYS >= dates.length) {
        await tx.barInventoryItem.update({
          where: { id: itemId },
          data: { currentStockMl: lastClosingMl },
        });
      }
    });
  }
}

// ── createMovement ────────────────────────────────────────────────────────────

/**
 * Create a new BarInventoryMovement (append-only — never update or delete).
 * Also updates BarInventoryItem.currentStockMl immediately for real-time stock.
 *
 * Does NOT trigger a sequential rebuild — the caller is responsible for that.
 */
export async function createMovement(
  tx: any,
  params: {
    restaurantId: string;
    itemId: string;
    date: string;
    movementType: string;
    quantityMl: number;
    orderId?: string | null;
    orderItemId?: string | null;
    unitCost?: number | null;
    source: string;
    correctionForId?: string | null;
    notes?: string | null;
    createdBy?: string | null;
  },
): Promise<any> {
  const movement = await tx.barInventoryMovement.create({
    data: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      date: params.date,
      movementType: params.movementType,
      quantityMl: params.quantityMl,
      orderId: params.orderId ?? null,
      orderItemId: params.orderItemId ?? null,
      unitCost: params.unitCost ?? null,
      source: params.source,
      correctionForId: params.correctionForId ?? null,
      notes: params.notes ?? null,
      createdBy: params.createdBy ?? null,
    },
  });

  // Update current stock immediately (signed quantity)
  const updatedItem = await tx.barInventoryItem.update({
    where: { id: params.itemId },
    data: { currentStockMl: { increment: params.quantityMl } },
    select: { currentStockMl: true, reorderLevelBottles: true, bottleSizeMl: true, name: true },
  });

  // Low-stock detection: emit socket event when stock drops to/below reorder.
  // Only for stock-reducing movements (sales, wastage, negative adjustments) —
  // not for purchases or positive adjustments that increase stock.
  const reorderLevelMl = Number(updatedItem.reorderLevelBottles) * updatedItem.bottleSizeMl;
  if (reorderLevelMl > 0 && Number(updatedItem.currentStockMl) <= reorderLevelMl && params.quantityMl < 0) {
    try {
      const io = getIo();
      io.to(params.restaurantId).emit("bar:low-stock", {
        restaurantId: params.restaurantId,
        item: {
          id: params.itemId,
          name: updatedItem.name,
          currentStockMl: Number(updatedItem.currentStockMl),
          reorderLevelBottles: Number(updatedItem.reorderLevelBottles),
          bottleSizeMl: updatedItem.bottleSizeMl,
          stockDisplay: `${Math.round(Number(updatedItem.currentStockMl))}ml / ${Number(updatedItem.reorderLevelBottles)} bottles reorder`,
        },
      });
    } catch {
      // Socket not initialized — non-fatal
    }
    logger.warn(
      `[BarInventory] LOW STOCK: "${updatedItem.name}" at ${updatedItem.currentStockMl}ml (reorder at ${reorderLevelMl}ml)`,
    );
  }

  return movement;
}

// ── flagUnmappedItem ──────────────────────────────────────────────────────────

/**
 * Emit a socket event + log for an unmapped liquor item (no BarInventoryItem link).
 * Used by the deduction flow when a MenuItem has no barInventoryItemId.
 */
export function flagUnmappedItem(
  restaurantId: string,
  menuItemName: string,
  menuItemId: string,
  orderId?: string,
): void {
  logger.warn(
    `[BarInventory] NO_MAPPING: "${menuItemName}" (menuItemId: ${menuItemId})${orderId ? ` in order ${orderId}` : ""}. Skipping deduction.`,
  );

  try {
    const io = getIo();
    if (io) {
      io.to(restaurantId).emit("bar:unmapped-item", {
        menuItemName,
        menuItemId,
        restaurantId,
        orderId,
      });
    }
  } catch {
    /* non-fatal */
  }
}

// ── resolveDeductionMl ────────────────────────────────────────────────────────

/**
 * Resolve the ml to deduct per unit for a menu item.
 * Priority: MenuItem.deductionMl → parse from name → default 30ml.
 */
export function resolveDeductionMl(menuItem: any): number {
  if (menuItem.deductionMl != null && menuItem.deductionMl > 0) {
    return menuItem.deductionMl;
  }
  const parsed = parseMlFromName(menuItem.name);
  if (parsed && parsed > 0) return parsed;
  return 30; // default peg size
}

// ── getOrCreateDailyRecord ────────────────────────────────────────────────────

/**
 * Get or create a BarDailyRecord for today. Used by the deduction flow for
 * immediate record updates without a full sequential rebuild.
 */
export async function getOrCreateDailyRecord(
  tx: any,
  restaurantId: string,
  itemId: string,
  date: string,
): Promise<any> {
  const existing = await tx.barDailyRecord.findUnique({
    where: {
      restaurantId_date_itemId: { restaurantId, date, itemId },
    },
  });
  if (existing) return existing;

  // Get previous day's closing for opening
  const prevDate = getPreviousDate(date);
  const prevRecord = await tx.barDailyRecord.findUnique({
    where: {
      restaurantId_date_itemId: { restaurantId, date: prevDate, itemId },
    },
  });
  const openingMl = prevRecord
    ? Number(prevRecord.physicalClosingMl ?? prevRecord.systemClosingMl)
    : 0;

  return tx.barDailyRecord.create({
    data: {
      restaurantId,
      itemId,
      date,
      openingMl,
      systemClosingMl: openingMl,
    },
  });
}
