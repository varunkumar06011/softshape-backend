// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Routes — Redesigned single-stock-pool model
// ─────────────────────────────────────────────────────────────────────────────
// One BarInventoryItem per physical bottle SKU. All movements go into the
// append-only BarInventoryMovement ledger. Daily position is stored in the
// permanent BarDailyRecord — ALL reads come from BarDailyRecord, never
// recalculated on the fly.
//
// Endpoints (mounted at /api/bar/inventory):
//   GET    /items                     — list items + daily record for date
//   GET    /items/unlinked            — LIQUOR menu items with no barInventoryItemId
//   GET    /items/:id                 — item detail + movement history
//   POST   /items                     — create item + link menu item
//   PATCH  /items/:id                 — update master fields
//   DELETE /items/:id                 — soft-delete
//   POST   /record-purchase           — PURCHASE movement
//   POST   /adjust-stock              — ADJUSTMENT / WASTAGE / OPENING movement
//   POST   /non-ac-sale               — NON_AC_SALE or CORRECTION (safe edit) + rebuild
//   PUT    /physical-count            — set physicalClosingMl + variance
//   GET    /movements                 — movement history (filterable)
//   GET    /daily-report              — daily report from BarDailyRecord
//   GET    /stock-sheet               — printable stock sheet
//   GET    /liquor-daily-report       — full report for PDF to Admin
//   GET    /reconciliation            — variance report (defaults to today)
//   GET    /low-stock                 — low stock items
//   GET    /dashboard                 — KPIs (stock value, revenue, profit, low stock)
//   GET    /deduction-check           — diagnostic for an order
//   POST   /retry-deduction/:orderId  — manual retry of failed deductions
//   POST   /manual-report-items       — PDF-only rows
//   GET    /bottles-for-menu/:menuItemId — bottle options for picker (Screen 10)
//   GET    /opening-preview/:itemId   — today's position preview for adjustment modal
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import { Prisma } from "@prisma/client";
import { getIo } from "../socket";
import prisma from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { getKolkataDateString } from "../utils/date";
import { parseMlFromName, normalizeProductBaseName } from "../utils/barMatching";
import { isBeerItem } from "../utils/itemHelpers";
import {
  MOVEMENT_TYPES,
  MOVEMENT_SOURCES,
  createMovement,
  sequentialRebuild,
  sequentialRebuildChunked,
  recalculateDailyRecord,
  resolveDeductionMl,
  acquireItemLock,
} from "../services/barInventoryService";
import { deductInventoryForOrder } from "../services/inventoryService";

const router = Router();

router.use(authenticate);

function resolveBarId(req: any): string {
  return (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string || "";
}

function emitToBar(eventName: string, restaurantId: string, payload: Record<string, unknown>): void {
  // Socket emission is best-effort — a missing/uninitialized socket or emit
  // failure must never turn a successful DB commit into a 500. The data is
  // already persisted; the UI will refresh on next poll/socket reconnect.
  try {
    getIo().to(restaurantId).emit(eventName, { restaurantId, ...payload });
  } catch (err) {
    logger.warn({ err, eventName, restaurantId }, "[BarInventory] socket emit failed (non-fatal)");
  }
}

// ── Admin-mutation idempotency (ProcessedRequest) ────────────────────────────
// Mutation endpoints accept an optional `requestId`. When present, the request
// is recorded inside the SAME transaction as the stock change, so a retry or
// double-submit can never apply the movement twice. The stored `result` is
// returned verbatim on a duplicate call.
async function findProcessedResult(requestId: string, actionType: string, restaurantId: string): Promise<any | null> {
  const existing = await prisma.processedRequest.findUnique({
    where: { requestId_actionType_restaurantId: { requestId, actionType, restaurantId } },
    select: { result: true },
  });
  return existing?.result ?? null;
}

// Returns true when the response was already sent (duplicate detected).
async function replyIfDuplicate(requestId: string | null, actionType: string, restaurantId: string, res: any): Promise<boolean> {
  if (!requestId) return false;
  const cached = await findProcessedResult(requestId, actionType, restaurantId);
  if (cached == null) return false;
  res.json({ ...cached, duplicate: true });
  return true;
}

// Record the request inside the mutation transaction — atomic with the write.
async function markProcessed(tx: any, requestId: string | null, actionType: string, restaurantId: string, result: any): Promise<void> {
  if (!requestId) return;
  await tx.processedRequest.create({
    data: { requestId, actionType, restaurantId, result },
  });
}

/** Format ml as "N bottles + M ml" for display. Beer is bottle-count only. */
function formatBottlesPlusMl(totalMl: number, bottleSize: number, isBeer = false): { bottles: number; remainingMl: number; display: string } {
  if (bottleSize <= 0) {
    return { bottles: 0, remainingMl: Math.round(totalMl), display: `${Math.round(totalMl)} ml` };
  }
  const bottles = Math.floor(totalMl / bottleSize);
  const remainingMl = Math.round(totalMl % bottleSize);
  const display = isBeer || remainingMl === 0 ? `${bottles} bottles` : `${bottles} bottles + ${remainingMl} ml`;
  return { bottles, remainingMl, display };
}

/** Shape a BarDailyRecord + item into the API row format the frontend expects. */
function shapeRow(item: any, record: any) {
  const bottleSize = item.bottleSizeMl || 750;
  const opening = record ? Number(record.openingMl) : Number(item.currentStockMl);
  const purchased = record ? Number(record.purchasedMl) : 0;
  const acSale = record ? Number(record.acSaleMl) : 0;
  const nonAcSale = record ? Number(record.nonAcSaleMl) : 0;
  const wastage = record ? Number(record.wastageMl) : 0;
  const adjustment = record ? Number(record.adjustmentMl) : 0;
  const closing = record ? Number(record.systemClosingMl) : Number(item.currentStockMl);
  const physical = record?.physicalClosingMl != null ? Number(record.physicalClosingMl) : null;
  const variance = record?.varianceMl != null ? Number(record.varianceMl) : null;
  const totalStock = opening + purchased;
  const costPerMl = item.purchaseRate ? Number(item.purchaseRate) / bottleSize : 0;
  const stockValue = record?.stockValue != null ? Number(record.stockValue) : closing * costPerMl;

  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    category: item.category,
    bottleSizeMl: bottleSize,
    openingMl: opening,
    purchasedMl: purchased,
    totalStockMl: totalStock,
    acSaleMl: acSale,
    nonAcSaleMl: nonAcSale,
    wastageMl: wastage,
    adjustmentMl: adjustment,
    systemClosingMl: closing,
    physicalClosingMl: physical,
    varianceMl: variance,
    currentStockMl: Number(item.currentStockMl),
    purchaseRate: item.purchaseRate != null ? Number(item.purchaseRate) : null,
    sellingPricePerMl: item.sellingPricePerMl != null ? Number(item.sellingPricePerMl) : null,
    stockValue,
    acRevenue: record?.acRevenue != null ? Number(record.acRevenue) : null,
    nonAcRevenue: record?.nonAcRevenue != null ? Number(record.nonAcRevenue) : null,
    totalRevenue: record?.totalRevenue != null ? Number(record.totalRevenue) : null,
    consumptionCost: record?.consumptionCost != null ? Number(record.consumptionCost) : null,
    profit: record?.profit != null ? Number(record.profit) : null,
    profitPercent: record?.profitPercent != null ? Number(record.profitPercent) : null,
    reorderLevelBottles: Number(item.reorderLevelBottles),
    isLowStock: Number(item.reorderLevelBottles) > 0 && closing <= Number(item.reorderLevelBottles) * bottleSize,
    isHiddenFromReport: item.isHiddenFromReport,
    isActive: item.isActive,
    finalized: record?.finalized ?? false,
    // display helpers
    opening: formatBottlesPlusMl(opening, bottleSize, isBeerItem(item)),
    closing: formatBottlesPlusMl(closing, bottleSize, isBeerItem(item)),
    physicalClosing: physical != null ? formatBottlesPlusMl(physical, bottleSize, isBeerItem(item)) : null,
  };
}

// ==========================================
// GET /items — list items + daily record for a date
// ==========================================
router.get("/items", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const date = (req.query.date as string) || getKolkataDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const items = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true },
      orderBy: [{ brand: "asc" }, { bottleSizeMl: "desc" }],
    });

    const records = await prisma.barDailyRecord.findMany({
      where: { restaurantId, date, itemId: { in: items.map((i) => i.id) } },
    });
    const recordByItem = new Map(records.map((r) => [r.itemId, r]));

    const rows = items.map((item) => shapeRow(item, recordByItem.get(item.id)));

    res.json({ date, items: rows });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /items failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /items/unlinked — LIQUOR menu items with no barInventoryItemId
// ==========================================
router.get("/items/unlinked", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const items = await prisma.menuItem.findMany({
      where: { restaurantId, menuType: "LIQUOR", isDeleted: false, barInventoryItemId: null },
      select: { id: true, name: true, basePrice: true, category: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    res.json({ items });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /items/unlinked failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /bottles-for-menu/:menuItemId — bottle options for the picker (Screen 10)
// ==========================================
router.get("/bottles-for-menu/:menuItemId", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const menuItem = await prisma.menuItem.findFirst({
      where: { id: req.params.menuItemId, restaurantId, isDeleted: false },
      select: { id: true, name: true, barInventoryItemId: true, deductionMl: true },
    });
    if (!menuItem) return res.status(404).json({ error: "Menu item not found" });

    const baseName = normalizeProductBaseName(menuItem.name);
    const candidates = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { bottleSizeMl: "desc" },
    });
    let sameBrand = candidates.filter((bi) => normalizeProductBaseName(bi.name) === baseName);

    // Fallback: menu name doesn't match any SKU base (e.g. consolidated/
    // renamed SKUs — "Vat69" menu → "Vat 69" SKU). Group around the linked
    // SKU's base instead — the direct link is authoritative.
    if (sameBrand.length === 0 && menuItem.barInventoryItemId) {
      const linked = candidates.find((bi) => bi.id === menuItem.barInventoryItemId)
        ?? await prisma.barInventoryItem.findFirst({ where: { id: menuItem.barInventoryItemId } });
      if (linked) {
        const linkedBase = normalizeProductBaseName(linked.name);
        sameBrand = candidates.filter((bi) => normalizeProductBaseName(bi.name) === linkedBase);
      }
    }

    // Show one picker option per physical bottle size. Name variants such as
    // "Brand" and "Brand 750ml" must not appear as duplicate choices.
    const bottleBySize = new Map<number, any>();
    for (const bi of sameBrand) {
      const current = bottleBySize.get(bi.bottleSizeMl);
      const shouldReplace = !current
        || (bi.id === menuItem.barInventoryItemId && current.id !== menuItem.barInventoryItemId)
        || (bi.id !== menuItem.barInventoryItemId && current.id !== menuItem.barInventoryItemId
          && Number(bi.currentStockMl) > Number(current.currentStockMl));
      if (shouldReplace) bottleBySize.set(bi.bottleSizeMl, bi);
    }

    const bottles = [...bottleBySize.values()].map((bi) => ({
      id: bi.id,
      name: bi.name,
      brand: bi.brand,
      bottleSizeMl: bi.bottleSizeMl,
      currentStockMl: Number(bi.currentStockMl),
      stockDisplay: formatBottlesPlusMl(Number(bi.currentStockMl), bi.bottleSizeMl, isBeerItem(bi)).display,
      isDefault: bi.id === menuItem.barInventoryItemId,
    }));

    res.json({
      menuItemId: menuItem.id,
      defaultItemId: menuItem.barInventoryItemId,
      deductionMl: menuItem.deductionMl ?? parseMlFromName(menuItem.name),
      bottles,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /bottles-for-menu failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /items/:id — item detail + movement history
// ==========================================
router.get("/items/:id", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const item = await prisma.barInventoryItem.findFirst({
      where: { id: req.params.id, restaurantId },
      include: { linkedMenuItems: { select: { id: true, name: true, deductionMl: true, isDeleted: true } } },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });

    const movements = await prisma.barInventoryMovement.findMany({
      where: { itemId: item.id },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 200,
    });

    const dailyRecords = await prisma.barDailyRecord.findMany({
      where: { itemId: item.id },
      orderBy: { date: "desc" },
      take: 60,
    });

    res.json({ item, movements, dailyRecords });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /items/:id failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /items — create item + optionally link a menu item
// ==========================================
router.post("/items", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  const restaurantId = resolveBarId(req);
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;
  const actionType = "bar-inventory:create-item";
  try {
    const userId = req.user?.userId || req.user?.id || "system";
    const {
      menuItemId, name, brand, category, bottleSizeMl,
      openingStockMl, openingStockBottles, reorderLevelBottles,
      purchaseRate, sellingPricePerMl,
    } = req.body;

    const size = Number(bottleSizeMl);
    if (!name || !size || size <= 0) {
      return res.status(400).json({ error: "name and a positive bottleSizeMl are required" });
    }

    if (await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;

    const result = await prisma.$transaction(async (tx: any) => {
      const item = await tx.barInventoryItem.create({
        data: {
          restaurantId,
          name: String(name).trim(),
          brand: String(brand || name).trim(),
          category: String(category || "Liquor").trim(),
          bottleSizeMl: size,
          currentStockMl: 0,
          reorderLevelBottles: Number(reorderLevelBottles) || 0,
          purchaseRate: purchaseRate != null ? Number(purchaseRate) : null,
          sellingPricePerMl: sellingPricePerMl != null ? Number(sellingPricePerMl) : null,
        },
      });

      // Link the menu item if provided
      if (menuItemId) {
        const mi = await tx.menuItem.findFirst({ where: { id: menuItemId, restaurantId } });
        if (!mi) throw Object.assign(new Error("Menu item not found"), { statusCode: 404 });
        await tx.menuItem.update({
          where: { id: menuItemId },
          data: {
            barInventoryItemId: item.id,
            deductionMl: mi.deductionMl ?? parseMlFromName(mi.name),
          },
        });
      }

      // Opening stock
      const openingMl = openingStockMl != null
        ? Number(openingStockMl)
        : openingStockBottles != null ? Number(openingStockBottles) * size : 0;
      if (openingMl !== 0) {
        const today = getKolkataDateString();
        await createMovement(tx, {
          restaurantId,
          itemId: item.id,
          date: today,
          movementType: MOVEMENT_TYPES.OPENING,
          quantityMl: openingMl,
          source: MOVEMENT_SOURCES.OPENING_SETUP,
          notes: "Initial stock",
          createdBy: userId,
        });
        await sequentialRebuild(tx, restaurantId, item.id, today);
      }

      await markProcessed(tx, requestId, actionType, restaurantId, { item });
      return item;
    });

    emitToBar("bar:inventory-updated", restaurantId, { itemId: result.id });
    res.status(201).json({ item: result });
  } catch (error: any) {
    if (error.code === "P2002") {
      // Unique violation — either a duplicate requestId (idempotent replay)
      // or a duplicate item name.
      if (await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;
      return res.status(409).json({ error: "An item with this name already exists" });
    }
    logger.error({ err: error }, "[BarInventory] POST /items failed");
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ==========================================
// PATCH /items/:id — update master fields (no movement)
// ==========================================
router.patch("/items/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const existing = await prisma.barInventoryItem.findFirst({
      where: { id: req.params.id, restaurantId },
    });
    if (!existing) return res.status(404).json({ error: "Item not found" });

    const {
      name, brand, category, bottleSizeMl, reorderLevelBottles,
      purchaseRate, sellingPricePerMl, isHiddenFromReport, isActive, date,
    } = req.body;

    const item = await prisma.barInventoryItem.update({
      where: { id: existing.id },
      data: {
        ...(name != null && { name: String(name).trim() }),
        ...(brand != null && { brand: String(brand).trim() }),
        ...(category != null && { category: String(category).trim() }),
        ...(bottleSizeMl != null && { bottleSizeMl: Number(bottleSizeMl) }),
        ...(reorderLevelBottles != null && { reorderLevelBottles: Number(reorderLevelBottles) }),
        ...(purchaseRate !== undefined && { purchaseRate: purchaseRate != null ? Number(purchaseRate) : null }),
        ...(sellingPricePerMl !== undefined && { sellingPricePerMl: sellingPricePerMl != null ? Number(sellingPricePerMl) : null }),
        ...(isHiddenFromReport != null && { isHiddenFromReport: Boolean(isHiddenFromReport) }),
        ...(isActive != null && { isActive: Boolean(isActive) }),
      },
    });

    if (sellingPricePerMl !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
      await sequentialRebuildChunked(prisma, restaurantId, item.id, String(date));
    }

    emitToBar("bar:inventory-updated", restaurantId, { itemId: item.id });
    res.json({ item });
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "An item with this name already exists" });
    }
    logger.error({ err: error }, "[BarInventory] PATCH /items/:id failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// DELETE /items/:id — soft-delete (isActive=false)
// ==========================================
router.delete("/items/:id", requireRole("OWNER", "ADMIN"), async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const existing = await prisma.barInventoryItem.findFirst({
      where: { id: req.params.id, restaurantId },
    });
    if (!existing) return res.status(404).json({ error: "Item not found" });

    await prisma.$transaction([
      prisma.barInventoryItem.update({
        where: { id: existing.id },
        data: { isActive: false },
      }),
      prisma.menuItem.updateMany({
        where: { barInventoryItemId: existing.id },
        data: { barInventoryItemId: null },
      }),
    ]);

    emitToBar("bar:inventory-updated", restaurantId, { itemId: existing.id });
    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] DELETE /items/:id failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /record-purchase — PURCHASE movement
// ==========================================
router.post("/record-purchase", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  const restaurantId = resolveBarId(req);
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;
  const actionType = "bar-inventory:record-purchase";
  try {
    const userId = req.user?.userId || req.user?.id || "system";
    const { itemId, bottles, quantityMl, costPerBottle, date, notes } = req.body;

    const item = await prisma.barInventoryItem.findFirst({
      where: { id: itemId, restaurantId, isActive: true },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });

    const qtyMl = quantityMl != null ? Number(quantityMl) : Number(bottles || 0) * item.bottleSizeMl;
    if (!qtyMl || qtyMl <= 0) {
      return res.status(400).json({ error: "A positive quantity (bottles or quantityMl) is required" });
    }
    const movementDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : getKolkataDateString();

    if (await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;

    const releaseLock = acquireItemLock(item.id);
    try {
    await prisma.$transaction(async (tx: any) => {
      // Optionally update purchase rate when a cost is provided
      if (costPerBottle != null && Number(costPerBottle) > 0) {
        await tx.barInventoryItem.update({
          where: { id: item.id },
          data: { purchaseRate: Number(costPerBottle) },
        });
      }

      await createMovement(tx, {
        restaurantId,
        itemId: item.id,
        date: movementDate,
        movementType: MOVEMENT_TYPES.PURCHASE,
        quantityMl: qtyMl,
        unitCost: costPerBottle != null ? Number(costPerBottle) / item.bottleSizeMl : null,
        source: MOVEMENT_SOURCES.PURCHASE_ENTRY,
        notes: notes || null,
        createdBy: userId,
      });

      await markProcessed(tx, requestId, actionType, restaurantId, {
        success: true, itemId: item.id, addedMl: qtyMl,
      });
    });

    // Rebuild daily records post-commit in short chunks (avoids long lock).
    await sequentialRebuildChunked(prisma, restaurantId, item.id, movementDate);

    emitToBar("bar:inventory-updated", restaurantId, { itemId: item.id });
    res.json({ success: true, itemId: item.id, addedMl: qtyMl });
    } finally { releaseLock(); }
  } catch (error: any) {
    if (error.code === "P2002" && await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;
    logger.error({ err: error }, "[BarInventory] POST /record-purchase failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /opening-preview/:itemId — today's position preview for adjustment modal
// ==========================================
router.get("/opening-preview/:itemId", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const itemId = req.params.itemId;
    const date = (req.query.date as string) || getKolkataDateString();

    const item = await prisma.barInventoryItem.findFirst({
      where: { id: itemId, restaurantId },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });

    const record = await prisma.barDailyRecord.findUnique({
      where: { restaurantId_date_itemId: { restaurantId, date, itemId } },
    });

    const opening = record ? Number(record.openingMl) : Number(item.currentStockMl);
    const purchased = record ? Number(record.purchasedMl) : 0;
    const sold = record ? Number(record.acSaleMl) + Number(record.nonAcSaleMl) : 0;
    const wastage = record ? Number(record.wastageMl) : 0;
    const projected = opening + purchased - sold - wastage;

    res.json({
      itemId,
      date,
      openingMl: opening,
      purchasedMl: purchased,
      soldMl: sold,
      wastageMl: wastage,
      projectedClosingMl: projected,
      currentStockMl: Number(item.currentStockMl),
      bottleSizeMl: item.bottleSizeMl,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /opening-preview failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /adjust-stock — ADJUSTMENT / WASTAGE / OPENING movement
// ==========================================
router.post("/adjust-stock", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  const restaurantId = resolveBarId(req);
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;
  const actionType = "bar-inventory:adjust-stock";
  try {
    const userId = req.user?.userId || req.user?.id || "system";
    const { itemId, adjustmentType, quantity, unit, quantityMl, reason, date } = req.body;
    // adjustmentType: "ADD" | "REMOVE" | "OPENING" | "WASTAGE"

    const item = await prisma.barInventoryItem.findFirst({
      where: { id: itemId, restaurantId },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });

    let qtyMl = quantityMl != null
      ? Number(quantityMl)
      : unit === "ml" ? Number(quantity) : Number(quantity || 0) * item.bottleSizeMl;
    if (!qtyMl || qtyMl === 0) {
      return res.status(400).json({ error: "A non-zero quantity is required" });
    }

    const type = String(adjustmentType || "").toUpperCase();
    let movementType: string;
    let signedQty: number;
    if (type === "ADD") {
      movementType = MOVEMENT_TYPES.ADJUSTMENT;
      signedQty = Math.abs(qtyMl);
    } else if (type === "REMOVE") {
      movementType = MOVEMENT_TYPES.ADJUSTMENT;
      signedQty = -Math.abs(qtyMl);
    } else if (type === "WASTAGE" || type === "BREAKAGE") {
      movementType = MOVEMENT_TYPES.WASTAGE;
      signedQty = -Math.abs(qtyMl);
    } else if (type === "OPENING") {
      movementType = MOVEMENT_TYPES.OPENING;
      signedQty = qtyMl;
    } else {
      return res.status(400).json({ error: "adjustmentType must be ADD, REMOVE, WASTAGE, or OPENING" });
    }

    const movementDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : getKolkataDateString();

    if (await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;

    const releaseLock = acquireItemLock(item.id);
    try {
    await prisma.$transaction(async (tx: any) => {
      await createMovement(tx, {
        restaurantId,
        itemId: item.id,
        date: movementDate,
        movementType,
        quantityMl: signedQty,
        source: type === "OPENING" ? MOVEMENT_SOURCES.OPENING_SETUP : MOVEMENT_SOURCES.MANUAL_ENTRY,
        notes: reason || null,
        createdBy: userId,
      });

      await markProcessed(tx, requestId, actionType, restaurantId, {
        success: true, itemId: item.id, adjustmentMl: signedQty,
      });
    });

    // Rebuild daily records post-commit in short chunks (avoids long lock).
    await sequentialRebuildChunked(prisma, restaurantId, item.id, movementDate);

    emitToBar("bar:inventory-updated", restaurantId, { itemId: item.id });
    res.json({ success: true, itemId: item.id, adjustmentMl: signedQty });
    } finally { releaseLock(); }
  } catch (error: any) {
    if (error.code === "P2002" && await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;
    logger.error({ err: error }, "[BarInventory] POST /adjust-stock failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /non-ac-sale — NON_AC_SALE or CORRECTION (safe edit) + sequential rebuild
//
// Rule 3 (append-only correction):
//   First entry      → create NON_AC_SALE movement (-qty)
//   Edit (750→900)   → original stays; create CORRECTION with delta (-150)
//   Clear (→0)       → create CORRECTION +750 (reverses)
//   Re-edit          → delta vs. current effective total
// ==========================================
router.post("/non-ac-sale", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  const restaurantId = resolveBarId(req);
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;
  const actionType = "bar-inventory:non-ac-sale";
  try {
    const userId = req.user?.userId || req.user?.id || "system";
    const { itemId, date, quantityMl, bottles, sellingPrice, sellingPricePerMl, notes, reason } = req.body;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const item = await prisma.barInventoryItem.findFirst({
      where: { id: itemId, restaurantId },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });

    const targetMl = quantityMl != null
      ? Math.abs(Number(quantityMl))
      : Math.abs(Number(bottles || 0)) * item.bottleSizeMl;

    if (await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;

    const releaseLock = acquireItemLock(item.id);
    try {
    const result = await prisma.$transaction(async (tx: any) => {
      // Current effective Non-AC total for (item, date):
      // sum(NON_AC_SALE) + sum(CORRECTION whose correctionForId → a NON_AC_SALE for this date)
      const movements = await tx.barInventoryMovement.findMany({
        where: { restaurantId, itemId: item.id, date },
      });
      const nonAcIds = new Set(
        movements.filter((m: any) => m.movementType === MOVEMENT_TYPES.NON_AC_SALE).map((m: any) => m.id),
      );
      const originalNonAc = movements
        .filter((m: any) => m.movementType === MOVEMENT_TYPES.NON_AC_SALE)
        .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];

      // Correction quantityMl is a stock delta (negative = more sold), so it
      // contributes -qty to the effective sale total.
      const currentEffectiveMl =
        movements
          .filter((m: any) => m.movementType === MOVEMENT_TYPES.NON_AC_SALE)
          .reduce((s: number, m: any) => s + Math.abs(Number(m.quantityMl)), 0) -
        movements
          .filter((m: any) => m.movementType === MOVEMENT_TYPES.CORRECTION && nonAcIds.has(m.correctionForId))
          .reduce((s: number, m: any) => s + Number(m.quantityMl), 0);

      let movement;
      let action: "FIRST_ENTRY" | "CORRECTION";
      if (!originalNonAc) {
        // First entry — create the original NON_AC_SALE movement
        if (targetMl <= 0) {
          throw Object.assign(new Error("Quantity must be positive for a new Non-AC sale"), { statusCode: 400 });
        }
        movement = await createMovement(tx, {
          restaurantId,
          itemId: item.id,
          date,
          movementType: MOVEMENT_TYPES.NON_AC_SALE,
          quantityMl: -targetMl,
          source: MOVEMENT_SOURCES.PDF_TO_ADMIN,
          notes: notes || null,
          createdBy: userId,
        });
        action = "FIRST_ENTRY";
      } else {
        // Edit — create a CORRECTION movement with the delta
        const delta = -(targetMl - currentEffectiveMl); // negative = more sold
        if (delta === 0) {
          await markProcessed(tx, requestId, actionType, restaurantId, {
            success: true, action: "NO_CHANGE", currentEffectiveMl, targetMl,
          });
          return { action: "NO_CHANGE", currentEffectiveMl, movement: null };
        }
        movement = await createMovement(tx, {
          restaurantId,
          itemId: item.id,
          date,
          movementType: MOVEMENT_TYPES.CORRECTION,
          quantityMl: delta,
          source: MOVEMENT_SOURCES.CORRECTION_EDIT,
          correctionForId: originalNonAc.id,
          notes: notes || `Non-AC sale corrected to ${targetMl}ml`,
          createdBy: userId,
        });
        action = "CORRECTION";
      }

      // Optionally update selling price per ml.
      // sellingPricePerMl is the direct per-ml rate (preferred).
      // sellingPrice is the per-bottle price (divided by bottleSizeMl).
      const spPerMl = sellingPricePerMl != null && Number(sellingPricePerMl) > 0
        ? Number(sellingPricePerMl)
        : sellingPrice != null && Number(sellingPrice) > 0
          ? Number(sellingPrice) / item.bottleSizeMl
          : null;
      if (spPerMl != null) {
        await tx.barInventoryItem.update({
          where: { id: item.id },
          data: { sellingPricePerMl: spPerMl },
        });
      }

      // Edit log (audit trail)
      await tx.barInventoryEditLog.create({
        data: {
          restaurantId,
          itemId: item.id,
          date,
          fieldName: "nonAcSaleMl",
          oldValue: String(currentEffectiveMl),
          newValue: String(targetMl),
          differenceMl: targetMl - currentEffectiveMl,
          reason: reason || notes || null,
          changedBy: userId,
        },
      });

      await markProcessed(tx, requestId, actionType, restaurantId, {
        success: true, action, currentEffectiveMl, targetMl,
      });
      return { action, currentEffectiveMl, targetMl, movement };
    });

    // Rebuild daily records post-commit in short chunks (avoids long lock).
    await sequentialRebuildChunked(prisma, restaurantId, item.id, date);

    emitToBar("bar:inventory-updated", restaurantId, { itemId: item.id });
    res.json({ success: true, ...result, movement: result.movement ?? undefined });
    } finally { releaseLock(); }
  } catch (error: any) {
    if (error.code === "P2002" && await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;
    logger.error({ err: error }, "[BarInventory] POST /non-ac-sale failed");
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ==========================================
// PUT /physical-count — set physicalClosingMl + compute variance
// ==========================================
router.put("/physical-count", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  const restaurantId = resolveBarId(req);
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;
  const actionType = "bar-inventory:physical-count";
  try {
    const userId = req.user?.userId || req.user?.id || "system";
    const { itemId, date, physicalClosingMl, physicalBottles, notes } = req.body;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const item = await prisma.barInventoryItem.findFirst({
      where: { id: itemId, restaurantId },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });

    const physicalMl = physicalClosingMl != null
      ? Number(physicalClosingMl)
      : physicalBottles != null ? Number(physicalBottles) * item.bottleSizeMl : null;
    if (physicalMl == null || physicalMl < 0) {
      return res.status(400).json({ error: "physicalClosingMl or physicalBottles is required" });
    }

    if (await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;

    const releaseLock = acquireItemLock(item.id);
    try {
    // Materialize any idle-day records BEFORE the interactive tx — a long gap
    // fill would otherwise blow the 5s interactive-transaction budget, and a
    // rolled-back fill would fail identically on every retry. Outside a tx
    // these are plain queries with no timeout; the in-tx recalc below then
    // only sees a contiguous chain.
    await recalculateDailyRecord(prisma, restaurantId, item.id, date);

    const result = await prisma.$transaction(async (tx: any) => {
      // Ensure the daily record exists
      const record = await recalculateDailyRecord(tx, restaurantId, item.id, date);
      const variance = physicalMl - Number(record.systemClosingMl);

      await tx.barDailyRecord.update({
        where: { id: record.id },
        data: {
          physicalClosingMl: physicalMl,
          varianceMl: variance,
          updatedBy: userId,
        },
      });

      // Audit log
      await tx.barInventoryEditLog.create({
        data: {
          restaurantId,
          itemId: item.id,
          date,
          fieldName: "physicalClosingMl",
          oldValue: record.physicalClosingMl != null ? String(record.physicalClosingMl) : "",
          newValue: String(physicalMl),
          differenceMl: variance,
          reason: notes || null,
          changedBy: userId,
        },
      });

      await markProcessed(tx, requestId, actionType, restaurantId, {
        success: true, itemId: item.id, physicalClosingMl: physicalMl, varianceMl: variance,
      });
      return { record, physicalMl, variance };
    });

    // Rebuild following days post-commit (next day's opening uses physicalClosing).
    const [y, m, d] = date.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
    await sequentialRebuildChunked(prisma, restaurantId, item.id, nextDate);

    emitToBar("bar:inventory-updated", restaurantId, { itemId: item.id });
    res.json({ success: true, itemId: item.id, physicalClosingMl: result.physicalMl, varianceMl: result.variance });
    } finally { releaseLock(); }
  } catch (error: any) {
    if (error.code === "P2002" && await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;
    logger.error({ err: error }, "[BarInventory] PUT /physical-count failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /daily-record-edit — edit Opening / Purchases / AC Sale for a date
//
// Creates append-only movements so the daily record is recalculated from the
// ledger (never a direct override that a rebuild would wipe):
//   openingMl   → OPENING movement (absolute override; latest wins)
//   purchasedMl → PURCHASE movement with the delta (signed)
//   acSaleMl    → AC_SALE (increase) or SALE_REVERSAL (decrease) with the delta
//
// Each changed field creates an edit-log entry. After the transaction commits,
// a chunked sequential rebuild from the edit date through today updates all
// downstream daily records + currentStockMl.
// ==========================================
router.post("/daily-record-edit", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  const restaurantId = resolveBarId(req);
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;
  const actionType = "bar-inventory:daily-record-edit";
  try {
    const userId = req.user?.userId || req.user?.id || "system";
    const { itemId, date, openingMl, purchasedMl, acSaleMl, notes } = req.body;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const item = await prisma.barInventoryItem.findFirst({
      where: { id: itemId, restaurantId },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });

    if (await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;

    const releaseLock = acquireItemLock(item.id);
    try {
      // Materialize any idle-day records BEFORE the interactive tx so the
      // opening→closing chain is contiguous when we read the current record.
      await recalculateDailyRecord(prisma, restaurantId, item.id, date);

      const currentRecord = await prisma.barDailyRecord.findUnique({
        where: { restaurantId_date_itemId: { restaurantId, date, itemId: item.id } },
      });
      const curOpening = currentRecord ? Number(currentRecord.openingMl) : 0;
      const curPurchased = currentRecord ? Number(currentRecord.purchasedMl) : 0;
      const curAcSale = currentRecord ? Number(currentRecord.acSaleMl) : 0;

      const round2 = (n: number) => Math.round(n * 100) / 100;
      const changed = round2(Number(openingMl)) !== round2(curOpening)
        || round2(Number(purchasedMl)) !== round2(curPurchased)
        || round2(Number(acSaleMl)) !== round2(curAcSale);
      if (!changed) {
        res.json({ success: true, action: "NO_CHANGE" });
        return;
      }

      const result = await prisma.$transaction(async (tx: any) => {
        const edits: string[] = [];

        // 1. Opening — OPENING movement (absolute override; latest wins)
        if (openingMl != null && round2(Number(openingMl)) !== round2(curOpening)) {
          await createMovement(tx, {
            restaurantId,
            itemId: item.id,
            date,
            movementType: MOVEMENT_TYPES.OPENING,
            quantityMl: Math.abs(Number(openingMl)),
            source: MOVEMENT_SOURCES.PDF_TO_ADMIN,
            notes: notes || `Opening override: ${curOpening} → ${openingMl}`,
            createdBy: userId,
          });
          await tx.barInventoryEditLog.create({
            data: {
              restaurantId,
              itemId: item.id,
              date,
              fieldName: "openingMl",
              oldValue: String(curOpening),
              newValue: String(openingMl),
              differenceMl: Number(openingMl) - curOpening,
              reason: notes || null,
              changedBy: userId,
            },
          });
          edits.push("openingMl");
        }

        // 2. Purchases — PURCHASE movement with the signed delta
        if (purchasedMl != null && round2(Number(purchasedMl)) !== round2(curPurchased)) {
          const delta = Number(purchasedMl) - curPurchased;
          await createMovement(tx, {
            restaurantId,
            itemId: item.id,
            date,
            movementType: MOVEMENT_TYPES.PURCHASE,
            quantityMl: delta,
            unitCost: item.purchaseRate ? Number(item.purchaseRate) / item.bottleSizeMl : null,
            source: MOVEMENT_SOURCES.PDF_TO_ADMIN,
            notes: notes || `Purchase adjustment: ${curPurchased} → ${purchasedMl}`,
            createdBy: userId,
          });
          await tx.barInventoryEditLog.create({
            data: {
              restaurantId,
              itemId: item.id,
              date,
              fieldName: "purchasedMl",
              oldValue: String(curPurchased),
              newValue: String(purchasedMl),
              differenceMl: delta,
              reason: notes || null,
              changedBy: userId,
            },
          });
          edits.push("purchasedMl");
        }

        // 3. AC Sale — AC_SALE (increase) or SALE_REVERSAL (decrease)
        if (acSaleMl != null && round2(Number(acSaleMl)) !== round2(curAcSale)) {
          const delta = Number(acSaleMl) - curAcSale;
          if (delta > 0) {
            // More sale → AC_SALE movement (negative stock delta)
            await createMovement(tx, {
              restaurantId,
              itemId: item.id,
              date,
              movementType: MOVEMENT_TYPES.AC_SALE,
              quantityMl: -delta,
              source: MOVEMENT_SOURCES.PDF_TO_ADMIN,
              notes: notes || `AC sale adjustment: ${curAcSale} → ${acSaleMl}`,
              createdBy: userId,
            });
          } else {
            // Less sale → SALE_REVERSAL movement (positive stock delta)
            await createMovement(tx, {
              restaurantId,
              itemId: item.id,
              date,
              movementType: MOVEMENT_TYPES.SALE_REVERSAL,
              quantityMl: -delta, // positive
              source: MOVEMENT_SOURCES.PDF_TO_ADMIN,
              notes: notes || `AC sale adjustment: ${curAcSale} → ${acSaleMl}`,
              createdBy: userId,
            });
          }
          await tx.barInventoryEditLog.create({
            data: {
              restaurantId,
              itemId: item.id,
              date,
              fieldName: "acSaleMl",
              oldValue: String(curAcSale),
              newValue: String(acSaleMl),
              differenceMl: delta,
              reason: notes || null,
              changedBy: userId,
            },
          });
          edits.push("acSaleMl");
        }

        await markProcessed(tx, requestId, actionType, restaurantId, {
          success: true, itemId: item.id, edits,
        });
        return { edits };
      });

      // Rebuild from the edit date through today (chunked, post-commit).
      await sequentialRebuildChunked(prisma, restaurantId, item.id, date);

      emitToBar("bar:inventory-updated", restaurantId, { itemId: item.id });
      res.json({ success: true, itemId: item.id, ...result });
    } finally {
      releaseLock();
    }
  } catch (error: any) {
    if (error.code === "P2002" && await replyIfDuplicate(requestId, actionType, restaurantId, res)) return;
    logger.error({ err: error }, "[BarInventory] POST /daily-record-edit failed");
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ==========================================
// GET /movements — movement history (filterable)
// ==========================================
router.get("/movements", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const { itemId, date, fromDate, toDate, movementType, orderId, page = "1", limit = "50" } = req.query;

    const where: any = { restaurantId };
    if (itemId) where.itemId = String(itemId);
    if (movementType) where.movementType = String(movementType);
    if (orderId) where.orderId = String(orderId);
    if (date) {
      where.date = String(date);
    } else if (fromDate || toDate) {
      where.date = {};
      if (fromDate) where.date.gte = String(fromDate);
      if (toDate) where.date.lte = String(toDate);
    }

    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    const skip = (Math.max(1, Number(page) || 1) - 1) * take;

    const [movements, total] = await Promise.all([
      prisma.barInventoryMovement.findMany({
        where,
        include: { item: { select: { name: true, brand: true, bottleSizeMl: true } } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        skip,
        take,
      }),
      prisma.barInventoryMovement.count({ where }),
    ]);

    res.json({ movements, total, page: Number(page) || 1, limit: take });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /movements failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /daily-report — daily report from BarDailyRecord
// ==========================================
router.get("/daily-report", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const date = (req.query.date as string) || getKolkataDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const items = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true },
      orderBy: [{ category: "asc" }, { brand: "asc" }, { bottleSizeMl: "desc" }],
    });

    const records = await prisma.barDailyRecord.findMany({
      where: { restaurantId, date, itemId: { in: items.map((i) => i.id) } },
    });
    const recordByItem = new Map(records.map((r) => [r.itemId, r]));

    const rows = items.map((item) => shapeRow(item, recordByItem.get(item.id)));

    const totals = rows.reduce(
      (acc, r) => ({
        openingMl: acc.openingMl + r.openingMl,
        purchasedMl: acc.purchasedMl + r.purchasedMl,
        acSaleMl: acc.acSaleMl + r.acSaleMl,
        nonAcSaleMl: acc.nonAcSaleMl + r.nonAcSaleMl,
        wastageMl: acc.wastageMl + r.wastageMl,
        closingMl: acc.closingMl + r.systemClosingMl,
        stockValue: acc.stockValue + r.stockValue,
        acRevenue: acc.acRevenue + (r.acRevenue || 0),
        nonAcRevenue: acc.nonAcRevenue + (r.nonAcRevenue || 0),
        totalRevenue: acc.totalRevenue + (r.totalRevenue || 0),
        consumptionCost: acc.consumptionCost + (r.consumptionCost || 0),
        profit: acc.profit + (r.profit || 0),
      }),
      { openingMl: 0, purchasedMl: 0, acSaleMl: 0, nonAcSaleMl: 0, wastageMl: 0, closingMl: 0, stockValue: 0, acRevenue: 0, nonAcRevenue: 0, totalRevenue: 0, consumptionCost: 0, profit: 0 },
    );

    res.json({ date, items: rows, totals });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /daily-report failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /stock-sheet — printable stock sheet (grouped by category)
// ==========================================
router.get("/stock-sheet", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const date = (req.query.date as string) || getKolkataDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const items = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true, isHiddenFromReport: false },
      orderBy: [{ category: "asc" }, { brand: "asc" }, { bottleSizeMl: "desc" }],
    });

    const records = await prisma.barDailyRecord.findMany({
      where: { restaurantId, date, itemId: { in: items.map((i) => i.id) } },
    });
    const recordByItem = new Map(records.map((r) => [r.itemId, r]));

    const categories = new Map<string, any[]>();
    for (const item of items) {
      const cat = item.category || "Other";
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat)!.push(shapeRow(item, recordByItem.get(item.id)));
    }

    const groups = Array.from(categories.entries()).map(([category, rows]) => ({
      category,
      items: rows,
      subtotal: {
        openingMl: rows.reduce((s, r) => s + r.openingMl, 0),
        purchasedMl: rows.reduce((s, r) => s + r.purchasedMl, 0),
        acSaleMl: rows.reduce((s, r) => s + r.acSaleMl, 0),
        nonAcSaleMl: rows.reduce((s, r) => s + r.nonAcSaleMl, 0),
        wastageMl: rows.reduce((s, r) => s + r.wastageMl, 0),
        closingMl: rows.reduce((s, r) => s + r.systemClosingMl, 0),
      },
    }));

    res.json({ date, groups });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /stock-sheet failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /liquor-daily-report — full report for PDF to Admin
// ==========================================
router.get("/liquor-daily-report", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const date = (req.query.date as string) || getKolkataDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const items = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true },
      orderBy: [{ category: "asc" }, { brand: "asc" }, { bottleSizeMl: "desc" }],
    });

    const records = await prisma.barDailyRecord.findMany({
      where: { restaurantId, date, itemId: { in: items.map((i) => i.id) } },
    });
    const recordByItem = new Map(records.map((r) => [r.itemId, r]));

    const rows = items.map((item, idx) => {
      const row = shapeRow(item, recordByItem.get(item.id));
      return { sno: idx + 1, ...row };
    });

    // Manual PDF-only rows for this date
    const manualItems = await prisma.manualReportItem.findMany({
      where: { restaurantId, reportDate: date },
      orderBy: { createdAt: "asc" },
    });

    const totals = rows.reduce(
      (acc, r) => ({
        openingStockValue: acc.openingStockValue + r.openingMl * (r.purchaseRate ? r.purchaseRate / r.bottleSizeMl : 0),
        purchases: acc.purchases + r.purchasedMl * (r.purchaseRate ? r.purchaseRate / r.bottleSizeMl : 0),
        acSales: acc.acSales + (r.acRevenue || 0),
        nonAcSales: acc.nonAcSales + (r.nonAcRevenue || 0),
        closingStockValue: acc.closingStockValue + r.stockValue,
        consumptionCost: acc.consumptionCost + (r.consumptionCost || 0),
        totalRevenue: acc.totalRevenue + (r.totalRevenue || 0),
        profit: acc.profit + (r.profit || 0),
      }),
      { openingStockValue: 0, purchases: 0, acSales: 0, nonAcSales: 0, closingStockValue: 0, consumptionCost: 0, totalRevenue: 0, profit: 0 },
    );
    const totalAvailable = totals.openingStockValue + totals.purchases;

    const missingPhysicalCount = rows.filter((r) => r.physicalClosingMl == null).length;

    res.json({
      date,
      items: rows,
      manualItems,
      businessPosition: { ...totals, totalAvailable },
      missingPhysicalCount,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /liquor-daily-report failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /reconciliation — variance report (defaults to TODAY)
// ==========================================
router.get("/reconciliation", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const date = (req.query.date as string) || getKolkataDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const records = await prisma.barDailyRecord.findMany({
      where: { restaurantId, date },
      include: { item: { select: { name: true, brand: true, category: true, bottleSizeMl: true, isActive: true, isHiddenFromReport: true } } },
      orderBy: { itemId: "asc" },
    });

    const items = records
      .filter((r) => r.item?.isActive && !r.item?.isHiddenFromReport)
      .map((r) => {
        const system = Number(r.systemClosingMl);
        const physical = r.physicalClosingMl != null ? Number(r.physicalClosingMl) : null;
        const variance = r.varianceMl != null ? Number(r.varianceMl) : physical != null ? physical - system : null;
        const variancePercent = system !== 0 && variance != null ? (variance / Math.abs(system)) * 100 : null;
        return {
          itemId: r.itemId,
          name: r.item.name,
          brand: r.item.brand,
          category: r.item.category,
          bottleSizeMl: r.item.bottleSizeMl,
          systemClosingMl: system,
          physicalClosingMl: physical,
          varianceMl: variance,
          variancePercent,
          hasPhysicalCount: physical != null,
        };
      });

    res.json({ date, items, missingPhysicalCount: items.filter((i) => !i.hasPhysicalCount).length });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /reconciliation failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /low-stock — items at or below reorder level
// ==========================================
router.get("/low-stock", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const items = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true, reorderLevelBottles: { gt: 0 } },
      orderBy: { name: "asc" },
    });

    const lowStock = items
      .filter((i) => Number(i.currentStockMl) <= Number(i.reorderLevelBottles) * i.bottleSizeMl)
      .map((i) => ({
        id: i.id,
        name: i.name,
        brand: i.brand,
        category: i.category,
        bottleSizeMl: i.bottleSizeMl,
        currentStockMl: Number(i.currentStockMl),
        stockDisplay: formatBottlesPlusMl(Number(i.currentStockMl), i.bottleSizeMl, isBeerItem(i)).display,
        reorderLevelBottles: Number(i.reorderLevelBottles),
        purchaseRate: i.purchaseRate != null ? Number(i.purchaseRate) : null,
      }));

    res.json({ items: lowStock, count: lowStock.length });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /low-stock failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /dashboard — KPIs (stock value, revenue, profit, low stock count)
// ==========================================
router.get("/dashboard", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const date = (req.query.date as string) || getKolkataDateString();

    const items = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true },
    });

    const inventoryValue = items.reduce((sum, i) => {
      const costPerMl = i.purchaseRate ? Number(i.purchaseRate) / i.bottleSizeMl : 0;
      return sum + Number(i.currentStockMl) * costPerMl;
    }, 0);

    const lowStockItems = items.filter(
      (i) => Number(i.reorderLevelBottles) > 0 && Number(i.currentStockMl) <= Number(i.reorderLevelBottles) * i.bottleSizeMl,
    );

    const todayRecords = await prisma.barDailyRecord.findMany({
      where: { restaurantId, date },
    });

    const todayRevenue = todayRecords.reduce((s, r) => s + Number(r.totalRevenue || 0), 0);
    const todayProfit = todayRecords.reduce((s, r) => s + Number(r.profit || 0), 0);
    const todayConsumptionCost = todayRecords.reduce((s, r) => s + Number(r.consumptionCost || 0), 0);
    const todayAcSaleMl = todayRecords.reduce((s, r) => s + Number(r.acSaleMl), 0);
    const todayNonAcSaleMl = todayRecords.reduce((s, r) => s + Number(r.nonAcSaleMl), 0);

    res.json({
      date,
      inventoryValue,
      totalItems: items.length,
      lowStockCount: lowStockItems.length,
      lowStockItems: lowStockItems.map((i) => ({
        id: i.id,
        name: i.name,
        currentStockMl: Number(i.currentStockMl),
        stockDisplay: formatBottlesPlusMl(Number(i.currentStockMl), i.bottleSizeMl, isBeerItem(i)).display,
        reorderLevelBottles: Number(i.reorderLevelBottles),
      })),
      todayRevenue,
      todayProfit,
      todayConsumptionCost,
      todayAcSaleMl,
      todayNonAcSaleMl,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /dashboard failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /deduction-check — diagnostic for an order
// ==========================================
router.get("/deduction-check", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const orderId = (req.query.orderId || req.params.orderId) as string | undefined;
    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: { select: { id: true, name: true, menuType: true, barInventoryItemId: true, deductionMl: true } } },
        },
      },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.restaurantId !== restaurantId) return res.status(403).json({ error: "Forbidden" });

    const liquorItems = order.items.filter((i) => i.menuItem?.menuType === "LIQUOR" || (i.menuItem?.menuType as string) === "BAR");

    const movements = await prisma.barInventoryMovement.findMany({
      where: { orderId, movementType: { in: [MOVEMENT_TYPES.AC_SALE, MOVEMENT_TYPES.SALE_REVERSAL] } },
      include: { item: { select: { name: true, bottleSizeMl: true } } },
    });

    const logs = await prisma.barDeductionLog.findMany({ where: { orderId } });

    const liquorItemBreakdown = liquorItems.map((item) => {
      const linkedItemId = item.pourFromInventoryItemId ?? item.menuItem.barInventoryItemId;
      const itemMovements = movements.filter((m) => m.orderItemId === item.id);
      const deducted = itemMovements
        .filter((m) => m.movementType === MOVEMENT_TYPES.AC_SALE)
        .reduce((s, m) => s + Math.abs(Number(m.quantityMl)), 0);
      const reversed = itemMovements
        .filter((m) => m.movementType === MOVEMENT_TYPES.SALE_REVERSAL)
        .reduce((s, m) => s + Number(m.quantityMl), 0);
      const expectedMl = resolveDeductionMl(item.menuItem) * item.quantity;
      const log = logs.find((l) => l.orderItemId === item.id);
      return {
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        name: item.menuItem.name,
        orderedQty: item.quantity,
        expectedMl,
        deductionMlPerUnit: resolveDeductionMl(item.menuItem),
        linkedBarInventoryItemId: linkedItemId,
        hasInventoryLink: !!linkedItemId,
        pourOverride: item.pourFromInventoryItemId ?? null,
        deductedMl: deducted,
        reversedMl: reversed,
        logStatus: log?.status ?? null,
        logError: log?.error ?? null,
      };
    });

    res.json({
      orderId: order.id,
      status: order.status,
      barInventoryDeducted: order.barInventoryDeducted,
      summary: {
        totalLiquorItems: liquorItems.length,
        itemsWithNoLink: liquorItemBreakdown.filter((i) => !i.hasInventoryLink).length,
        itemsNotDeducted: liquorItemBreakdown.filter((i) => i.deductedMl < i.expectedMl).length,
      },
      missingInventoryLinks: liquorItemBreakdown.filter((i) => !i.hasInventoryLink).map((i) => i.name),
      liquorItems: liquorItemBreakdown,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /deduction-check failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /retry-deduction/:orderId — manual retry
// ==========================================
router.post("/retry-deduction/:orderId", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const orderId = req.params.orderId;
    const userId = req.user?.userId || req.user?.id || null;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.restaurantId !== restaurantId) return res.status(403).json({ error: "Forbidden" });
    if (order.status !== "PAID") return res.status(400).json({ error: "Order must be paid before retrying deductions" });

    // Clear the flag so deductInventoryForOrder re-processes the bar items.
    // Per-line-item idempotency inside deductInventoryForOrder prevents double deduction.
    await prisma.order.update({ where: { id: orderId }, data: { barInventoryDeducted: false } });

    const result = await prisma.$transaction(async (tx: any) => {
      return deductInventoryForOrder(orderId, restaurantId, tx, userId, order.settledAt || order.paidAt);
    });

    const fresh = await prisma.order.findUnique({ where: { id: orderId }, select: { barInventoryDeducted: true } });

    res.json({
      orderId,
      barInventoryDeducted: fresh?.barInventoryDeducted ?? false,
      barDeductionErrors: result.barDeductionErrors,
      retried: true,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] POST /retry-deduction failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /manual-report-items — PDF-only rows (unchanged from previous version)
// ==========================================
router.post("/manual-report-items", async (req: any, res: any) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }
    const { date, items } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }
    if (!Array.isArray(items)) {
      res.status(400).json({ error: "items must be an array" });
      return;
    }
    const userId = req.user?.userId || req.user?.id || "system";

    // Dedup incoming items by (itemName + section)
    const dedupMap = new Map<string, any>();
    for (const item of items) {
      const section = item.section === "AC" ? "AC" : "NON_AC";
      const key = `${String(item.itemName || "").trim().toLowerCase()}|${section}`;
      const existing = dedupMap.get(key);
      if (!existing || (!existing.id && item.id)) {
        dedupMap.set(key, item);
      }
    }
    const dedupedItems = Array.from(dedupMap.values());

    const result = await prisma.$transaction(async (tx) => {
      const savedIds: string[] = [];
      for (const item of dedupedItems) {
        const section = item.section === "AC" ? "AC" : "NON_AC";
        const data = {
          restaurantId: barId,
          reportDate: date,
          section,
          itemName: String(item.itemName || "").trim() || "Unnamed Item",
          categoryName: item.categoryName || null,
          qty: Math.max(0, Number(item.qty) || 0),
          sale: Math.max(0, Number(item.sale) || 0),
          purchaseCost: Math.max(0, Number(item.purchaseCost) || 0),
          sellingPrice: Math.max(0, Number(item.sellingPrice) || 0),
          consumption: Math.max(0, Number(item.consumption) || 0),
          saleAmount: Math.max(0, Number(item.saleAmount) || 0),
          profit: Number(item.profit) || 0,
          opening: Math.max(0, Number(item.opening) || 0),
          received: Math.max(0, Number(item.received) || 0),
          closing: Math.max(0, Number(item.closing) || 0),
          isHidden: Boolean(item.isHidden),
          createdBy: userId,
        };

        if (item.id) {
          try {
            await tx.manualReportItem.update({
              where: { id: item.id },
              data: { ...data, createdBy: undefined },
            });
            savedIds.push(item.id);
          } catch (e: any) {
            if (e?.code === "P2025") {
              const created = await tx.manualReportItem.create({ data });
              savedIds.push(created.id);
            } else {
              throw e;
            }
          }
        } else {
          const created = await tx.manualReportItem.create({ data });
          savedIds.push(created.id);
        }
      }

      await tx.manualReportItem.deleteMany({
        where: { restaurantId: barId, reportDate: date, id: { notIn: savedIds } },
      });

      return savedIds;
    }, { timeout: 30000, maxWait: 15000 });

    logger.info(`[BarInventory] Save manual items: date=${date}, saved=${result.length}`);
    res.json({ date, saved: result.length });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] POST /manual-report-items failed");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /manual-report-items — list PDF-only rows for a date
// ==========================================
router.get("/manual-report-items", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
    const date = (req.query.date as string) || getKolkataDateString();
    const items = await prisma.manualReportItem.findMany({
      where: { restaurantId, reportDate: date },
      orderBy: { createdAt: "asc" },
    });
    res.json({ date, items });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] GET /manual-report-items failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
