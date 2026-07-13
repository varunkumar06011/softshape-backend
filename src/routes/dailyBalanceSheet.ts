// ─────────────────────────────────────────────────────────────────────────────
// Daily Balance Sheet Routes — Per-outlet daily balance sheet
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints:
//   GET    /api/balance-sheet?startDate=&endDate=&outletId=  — list/range
//   GET    /api/balance-sheet/:date?outletId=                — single day
//   PUT    /api/balance-sheet/:date                          — full save
//   POST   /api/balance-sheet/:date/adjustments              — add adjustment
//   PATCH  /api/balance-sheet/adjustments/:id                — edit adjustment
//   DELETE /api/balance-sheet/adjustments/:id                — delete adjustment
//   POST   /api/balance-sheet/:date/submit                   — DRAFT → SUBMITTED
//   POST   /api/balance-sheet/:date/lock                     — SUBMITTED → LOCKED
//   POST   /api/balance-sheet/:date/unlock                   — LOCKED → DRAFT
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { authenticate, requireRole, type AuthRequest } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { resolveTenantContext } from "../lib/tenantContext";
import { basePrisma, tenantStorage } from "../lib/prisma";
import prisma from "../lib/prisma";
import {
  getOrSeedBalanceSheet,
  getOrSeedAggregateBalanceSheet,
  upsertBalanceSheet,
  listBalanceSheets,
  listBalanceSheetsAcrossOutlets,
  setBalanceSheetStatus,
  computeVenueSales,
  computeExpenditureTotal,
  computeAggregatorSales,
} from "../services/dailyBalanceSheetService";
import logger from "../lib/logger";
import { createAuditLog } from "../lib/auditLog";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── GET /api/balance-sheet?startDate=&endDate=&outletId= ─────────────────────
router.get("/", requireRole('ADMIN', 'OWNER', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }

    const outletId = (req.query.outletId as string) || "all";
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (outletId !== "all" && !tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    let sheets: any[];
    if (outletId !== "all") {
      sheets = await listBalanceSheets(outletId, startDate as string, endDate as string);
    } else {
      sheets = await listBalanceSheetsAcrossOutlets(tenantIds, startDate as string, endDate as string);
    }

    // Enrich with outlet name
    const outletMap = new Map<string, string>();
    for (const id of tenantIds) {
      const outlet = await basePrisma.outlet.findUnique({
        where: { id },
        select: { name: true },
      });
      if (outlet) outletMap.set(id, outlet.name);
    }

    const enriched = sheets.map((s: any) => ({
      ...s,
      outletName: outletMap.get(s.restaurantId) || "Unknown Outlet",
    }));

    res.json(enriched);
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] List failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/balance-sheet/:date?outletId= ───────────────────────────────────
router.get("/:date", requireRole('ADMIN', 'OWNER', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    if (!date) return res.status(400).json({ error: "date required" });

    // Support cross-outlet admin view
    const outletId = (req.query.outletId as string) || null;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (outletId && outletId !== "all" && !tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    if (outletId === "all") {
      const sheet = await getOrSeedAggregateBalanceSheet(tenantIds, date);
      res.json(sheet);
      return;
    }

    const effectiveId = outletId || sessionRestaurantId;

    const sheet = await getOrSeedBalanceSheet(effectiveId, date);
    res.json(sheet);
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Get failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/balance-sheet/:date/ledger-activity ─────────────────────────────
// Returns itemized ledger activity for the date: grocery by category, cash liability
// payments, and liabilities (AP) created that day. Read-only — does not modify the
// balance sheet or create BalanceAdjustment rows.
router.get("/:date/ledger-activity", requireRole('ADMIN', 'OWNER', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    if (!date) return res.status(400).json({ error: "date required" });

    const outletId = (req.query.outletId as string) || null;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    if (outletId && outletId !== "all" && !tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    const effectiveId = outletId && outletId !== "all" ? outletId : sessionRestaurantId;

    // 1. Grocery expenditures by category
    const groceryRows = await basePrisma.expenditure.findMany({
      where: {
        restaurantId: effectiveId,
        expenditureDate: date,
        status: { not: "VOIDED" },
        entryType: "GROCERY",
      },
      select: { amount: true, category: true, paidToName: true },
    });
    const groceryMap = new Map<string, number>();
    for (const row of groceryRows) {
      const catName = row.category || "Uncategorized";
      groceryMap.set(catName, (groceryMap.get(catName) || 0) + Number(row.amount));
    }
    const groceryByCategory = Array.from(groceryMap.entries()).map(([categoryName, amount]) => ({
      categoryName,
      amount: Math.round(amount * 100) / 100,
    }));

    // 2. Cash liability payments (LIABILITY_PAYMENT entries with paymentMethod CASH)
    const cashPaymentRows = await basePrisma.expenditure.findMany({
      where: {
        restaurantId: effectiveId,
        expenditureDate: date,
        status: { not: "VOIDED" },
        entryType: "LIABILITY_PAYMENT",
        paymentMethod: "CASH",
      },
      select: { id: true, amount: true, paidToName: true },
    });
    const cashLiabilityPayments = cashPaymentRows.map((row) => ({
      vendorName: row.paidToName,
      amount: Math.round(Number(row.amount) * 100) / 100,
      expenditureId: row.id,
    }));

    // 3. Liabilities (AP) created that day — not a cash expense
    const liabilityRows = await basePrisma.expenditure.findMany({
      where: {
        restaurantId: effectiveId,
        expenditureDate: date,
        status: { not: "VOIDED" },
        entryType: "LIABILITY",
      },
      select: { id: true, amount: true, paidToName: true },
    });
    const liabilitiesCreatedToday = liabilityRows.map((row) => ({
      vendorName: row.paidToName,
      amount: Math.round(Number(row.amount) * 100) / 100,
      expenditureId: row.id,
    }));

    res.json({
      groceryByCategory,
      cashLiabilityPayments,
      liabilitiesCreatedToday,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Ledger activity failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/balance-sheet/:date/refresh-sales ───────────────────────────────
// Returns the current sales data calculated from transactions for the given date
// Must be defined before /:date to avoid route matching conflicts
router.get("/:date/refresh-sales", requireRole('ADMIN', 'OWNER', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    if (!date) return res.status(400).json({ error: "date required" });

    const outletId = (req.query.outletId as string) || null;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (outletId && outletId !== "all" && !tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    const effectiveId = outletId === "all" ? tenantIds : (outletId || sessionRestaurantId);

    const [venueSales, totalExpenditures, aggregatorSales] = await Promise.all([
      computeVenueSales(effectiveId, date),
      computeExpenditureTotal(effectiveId, date),
      computeAggregatorSales(effectiveId, date),
    ]);

    res.json({
      acBarSale: venueSales.acBar,
      nonAcBarSale: venueSales.nonAcBar,
      familyWingSale: venueSales.familyWing,
      parcelSale: venueSales.parcel,
      swiggySale: aggregatorSales.swiggy,
      zomatoSale: aggregatorSales.zomato,
      totalExpenditures,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Refresh sales failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PUT /api/balance-sheet/:date — full save ─────────────────────────────────
router.put("/:date", requireRole('ADMIN', 'OWNER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    if (!date) return res.status(400).json({ error: "date required" });

    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from query, default to session
    const outletId = (req.query.outletId as string) || null;
    let effectiveId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      effectiveId = outletId;
    }

    // Run within the target outlet's tenant context so the Prisma extension
    // scopes all queries (upsert, computeVenueSales, etc.) to the correct outlet.
    const sheet = await tenantStorage.run({ restaurantId: effectiveId }, async () => {
      return upsertBalanceSheet(effectiveId, date, req.body, userId);
    });

    createAuditLog({
      userId: req.user!.userId,
      restaurantId: effectiveId,
      action: "BALANCE_SHEET_SAVED",
      entityType: "DailyBalanceSheet",
      entityId: sheet?.id ?? null,
      metadata: {
        date,
        status: sheet?.status ?? null,
        closingBalance: sheet?.closingBalance != null ? Number(sheet.closingBalance) : null,
      },
    });

    res.json(sheet);
  } catch (error: any) {
    if (error.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    logger.error({ err: error }, "[BalanceSheet] PUT failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/balance-sheet/:date/adjustments — add one adjustment ───────────
router.post("/:date/adjustments", requireRole('ADMIN', 'OWNER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    if (!date) return res.status(400).json({ error: "date required" });

    const { label, amount, sign, sortOrder } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: "label required" });
    if (typeof amount !== "number") return res.status(400).json({ error: "amount must be a number" });
    if (sign !== "PLUS" && sign !== "MINUS") return res.status(400).json({ error: "sign must be PLUS or MINUS" });

    // Resolve explicit outletId from body or query, default to session
    const outletId = req.body.outletId || (req.query.outletId as string) || sessionRestaurantId;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (!tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    // Check if locked using basePrisma with explicit outletId
    const existing = await basePrisma.dailyBalanceSheet.findUnique({
      where: { restaurantId_reportDate: { restaurantId: outletId, reportDate: date } },
    });

    if (!existing) {
      return res.status(404).json({ error: "Balance sheet not found. Save the sheet first." });
    }

    if (existing.status === "LOCKED") {
      return res.status(409).json({ error: "Balance sheet is LOCKED. Unlock first to edit." });
    }

    const adjustment = await basePrisma.balanceAdjustment.create({
      data: {
        dailyBalanceSheetId: existing.id,
        label: label.trim(),
        amount: amount,
        sign,
        sortOrder: sortOrder ?? 0,
      },
    });

    createAuditLog({
      userId: req.user!.userId,
      restaurantId: outletId,
      action: "BALANCE_ADJUSTMENT_SAVED",
      entityType: "DailyBalanceSheet",
      entityId: existing.id,
      metadata: {
        date,
        label: adjustment.label,
        amount: adjustment.amount,
        direction: adjustment.sign === "PLUS" ? "positive" : "negative",
      },
    });

    res.status(201).json(adjustment);
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Add adjustment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/balance-sheet/adjustments/:id — edit adjustment ───────────────
router.patch("/adjustments/:id", requireRole('ADMIN', 'OWNER'), async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);
    const { label, amount, sign, sortOrder } = req.body;

    // Find the adjustment and check parent sheet status
    const adjustment = await basePrisma.balanceAdjustment.findUnique({
      where: { id },
      include: { dailyBalanceSheet: true },
    });

    if (!adjustment) return res.status(404).json({ error: "Adjustment not found" });

    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (adjustment.dailyBalanceSheet.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Cross-tenant access denied" });
    }

    if (adjustment.dailyBalanceSheet.status === "LOCKED") {
      return res.status(409).json({ error: "Balance sheet is LOCKED. Unlock first to edit." });
    }

    const updateData: any = {};
    if (label !== undefined) updateData.label = label.trim();
    if (amount !== undefined) updateData.amount = amount;
    if (sign !== undefined) updateData.sign = sign;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    const updated = await basePrisma.balanceAdjustment.update({
      where: { id },
      data: updateData,
    });

    createAuditLog({
      userId: req.user!.userId,
      restaurantId,
      action: "BALANCE_ADJUSTMENT_SAVED",
      entityType: "DailyBalanceSheet",
      entityId: adjustment.dailyBalanceSheetId,
      metadata: {
        date: adjustment.dailyBalanceSheet.reportDate,
        label: updated.label,
        amount: updated.amount,
        direction: updated.sign === "PLUS" ? "positive" : "negative",
      },
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Edit adjustment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/balance-sheet/adjustments/:id — delete adjustment ────────────
router.delete("/adjustments/:id", requireRole('ADMIN', 'OWNER'), async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);

    const adjustment = await basePrisma.balanceAdjustment.findUnique({
      where: { id },
      include: { dailyBalanceSheet: true },
    });

    if (!adjustment) return res.status(404).json({ error: "Adjustment not found" });

    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (adjustment.dailyBalanceSheet.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Cross-tenant access denied" });
    }

    if (adjustment.dailyBalanceSheet.status === "LOCKED") {
      return res.status(409).json({ error: "Balance sheet is LOCKED. Unlock first to edit." });
    }

    await basePrisma.balanceAdjustment.delete({ where: { id } });

    createAuditLog({
      userId: req.user!.userId,
      restaurantId,
      action: "BALANCE_ADJUSTMENT_DELETED",
      entityType: "DailyBalanceSheet",
      entityId: adjustment.dailyBalanceSheetId,
      metadata: {
        date: adjustment.dailyBalanceSheet.reportDate,
        label: adjustment.label,
        amount: adjustment.amount,
        direction: adjustment.sign === "PLUS" ? "positive" : "negative",
      },
    });

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Delete adjustment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/balance-sheet/:date/submit — DRAFT → SUBMITTED ─────────────────
router.post("/:date/submit", requireRole('ADMIN', 'OWNER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from query, default to session
    const outletId = (req.query.outletId as string) || null;
    let effectiveId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      effectiveId = outletId;
    }

    const sheet = await tenantStorage.run({ restaurantId: effectiveId }, async () => {
      return setBalanceSheetStatus(effectiveId, date, "SUBMITTED", userId);
    });
    res.json(sheet);
  } catch (error: any) {
    if (error.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ err: error }, "[BalanceSheet] Submit failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/balance-sheet/:date/lock — SUBMITTED → LOCKED ──────────────────
// Guarded with requireRole(['admin','owner']) — financial mutation must not be unguarded.
router.post("/:date/lock", requireRole("admin", "owner"), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from query, default to session
    const outletId = (req.query.outletId as string) || null;
    let effectiveId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      effectiveId = outletId;
    }

    // Verify current status is SUBMITTED before locking
    const existing = await tenantStorage.run({ restaurantId: effectiveId }, async () => {
      return prisma.dailyBalanceSheet.findUnique({
        where: { restaurantId_reportDate: { restaurantId: effectiveId, reportDate: date } },
      });
    });

    if (!existing) {
      return res.status(404).json({ error: "Balance sheet not found" });
    }

    if (existing.status !== "SUBMITTED") {
      return res.status(400).json({ error: `Cannot lock a sheet with status ${existing.status}. Must be SUBMITTED first.` });
    }

    const sheet = await tenantStorage.run({ restaurantId: effectiveId }, async () => {
      return setBalanceSheetStatus(effectiveId, date, "LOCKED", userId);
    });

    createAuditLog({
      userId: req.user!.userId,
      restaurantId: effectiveId,
      action: "BALANCE_SHEET_LOCKED",
      entityType: "DailyBalanceSheet",
      entityId: (sheet as any)?.id,
      metadata: {
        date,
        totalSales: Number((sheet as any)?.totalSales ?? 0),
        closingBalance: Number((sheet as any)?.closingBalance ?? 0),
      },
    });

    res.json(sheet);
  } catch (error: any) {
    if (error.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ err: error }, "[BalanceSheet] Lock failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/balance-sheet/:date/unlock — LOCKED → DRAFT ────────────────────
// Guarded with requireRole(['admin','owner']). Writes an AuditLog entry.
router.post("/:date/unlock", requireRole("admin", "owner"), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from query, default to session
    const outletId = (req.query.outletId as string) || null;
    let effectiveId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      effectiveId = outletId;
    }

    const sheet = await tenantStorage.run({ restaurantId: effectiveId }, async () => {
      return setBalanceSheetStatus(effectiveId, date, "DRAFT", userId);
    });

    createAuditLog({
      userId: req.user!.userId,
      restaurantId: effectiveId,
      action: "BALANCE_SHEET_UNLOCKED",
      entityType: "DailyBalanceSheet",
      entityId: (sheet as any)?.id,
      metadata: {
        date,
        totalSales: Number((sheet as any)?.totalSales ?? 0),
        closingBalance: Number((sheet as any)?.closingBalance ?? 0),
      },
    });

    res.json(sheet);
  } catch (error: any) {
    if (error.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ err: error }, "[BalanceSheet] Unlock failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/balance-sheet/:date/reconciliation ─────────────────────────────
// Daily cash reconciliation: compares system-computed closing vs stored closing.
router.get("/:date/reconciliation", requireRole('ADMIN', 'OWNER', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = String(req.params.date);
    if (!date) return res.status(400).json({ error: "date required" });

    const outletId = (req.query.outletId as string) || null;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    if (outletId && outletId !== "all" && !tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    const effectiveId = outletId && outletId !== "all" ? outletId : sessionRestaurantId;

    const sheet = await basePrisma.dailyBalanceSheet.findUnique({
      where: { restaurantId_reportDate: { restaurantId: effectiveId, reportDate: date } },
      include: { adjustments: { orderBy: { sortOrder: "asc" } } },
    });

    if (!sheet) {
      return res.json({
        date,
        outletId: effectiveId,
        outletName: null,
        status: "INCOMPLETE",
        message: "No balance sheet found for this date",
      });
    }

    // Get outlet name
    const outlet = await basePrisma.outlet.findUnique({
      where: { id: effectiveId },
      select: { name: true },
    });

    // If closingBalance is null, the cashier hasn't entered it yet
    if (sheet.closingBalance == null) {
      return res.json({
        date,
        outletId: effectiveId,
        outletName: outlet?.name || null,
        openingBalance: Number(sheet.openingBalance),
        totalSales: 0,
        totalExpenditures: 0,
        adjustmentsNet: 0,
        systemClosing: 0,
        actualClosing: null,
        variance: null,
        status: "INCOMPLETE",
        message: "Closing balance not entered yet",
        sheetStatus: sheet.status,
      });
    }

    // Compute systemClosing from stored components
    const openingBalance = Number(sheet.openingBalance);

    // Total sales: use override if set, else sum effective venue sales + aggregator sales
    const acBar = sheet.acBarSaleOverride != null ? Number(sheet.acBarSaleOverride) : Number(sheet.acBarSaleComputed ?? 0);
    const nonAcBar = sheet.nonAcBarSaleOverride != null ? Number(sheet.nonAcBarSaleOverride) : Number(sheet.nonAcBarSaleComputed ?? 0);
    const familyWing = sheet.familyWingSaleOverride != null ? Number(sheet.familyWingSaleOverride) : Number(sheet.familyWingSaleComputed ?? 0);
    const parcel = sheet.parcelSaleOverride != null ? Number(sheet.parcelSaleOverride) : Number(sheet.parcelSaleComputed ?? 0);
    const swiggy = Number(sheet.swiggySale ?? 0);
    const zomato = Number(sheet.zomatoSale ?? 0);

    const totalSales = sheet.totalSalesOverride != null
      ? Number(sheet.totalSalesOverride)
      : Math.round((acBar + nonAcBar + familyWing + parcel + swiggy + zomato) * 100) / 100;

    // Total expenditures: use override if set, else stored computed
    const totalExpenditures = sheet.totalExpendituresOverride != null
      ? Number(sheet.totalExpendituresOverride)
      : Number(sheet.totalExpenditures ?? 0);

    // Adjustments net: sum of PLUS - sum of MINUS
    const positiveAdj = sheet.adjustments
      .filter((a: any) => a.sign === "PLUS")
      .reduce((sum: number, a: any) => sum + Number(a.amount), 0);
    const negativeAdj = sheet.adjustments
      .filter((a: any) => a.sign === "MINUS")
      .reduce((sum: number, a: any) => sum + Number(a.amount), 0);
    const adjustmentsNet = Math.round((positiveAdj - negativeAdj) * 100) / 100;

    // systemClosing = opening + totalSales - totalExpenditures + adjustmentsNet
    // Note: the service's calculateRunningBalance also subtracts aggregator sales,
    // but those are included in totalSales. The net effect is:
    // opening + cashSales + aggregatorSales - aggregatorSales - expenditures + adjustments
    // = opening + cashSales - expenditures + adjustments
    // However, since totalSales includes aggregator sales and the service subtracts them,
    // the effective system closing is:
    // opening + totalSales - aggregatorSales - expenditures + adjustmentsNet
    const aggregatorSales = Math.round((swiggy + zomato) * 100) / 100;
    const systemClosing = Math.round(
      (openingBalance + totalSales - aggregatorSales - totalExpenditures + adjustmentsNet) * 100
    ) / 100;

    const actualClosing = Number(sheet.closingBalance);
    const variance = Math.round((actualClosing - systemClosing) * 100) / 100;

    const status = variance === 0 ? "BALANCED" : "MISMATCH";

    res.json({
      date,
      outletId: effectiveId,
      outletName: outlet?.name || null,
      openingBalance,
      totalSales,
      totalExpenditures,
      adjustmentsNet,
      systemClosing,
      actualClosing,
      variance,
      status,
      sheetStatus: sheet.status,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Reconciliation failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/balance-sheet/reconciliation/summary?startDate=&endDate=&outletId= ─
// Period reconciliation summary: loops over every sheet in the date range.
router.get("/reconciliation/summary", requireRole('ADMIN', 'OWNER', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }

    const outletId = (req.query.outletId as string) || "all";
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    if (outletId !== "all" && !tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    // Fetch sheets for the date range
    const queryIds = outletId === "all" ? tenantIds : [outletId];
    const sheets = await basePrisma.dailyBalanceSheet.findMany({
      where: {
        restaurantId: { in: queryIds },
        reportDate: { gte: startDate as string, lte: endDate as string },
      },
      orderBy: { reportDate: "asc" },
      include: { adjustments: true },
    });

    // Build outlet name map
    const outletMap = new Map<string, string>();
    for (const id of queryIds) {
      const o = await basePrisma.outlet.findUnique({ where: { id }, select: { name: true } });
      if (o) outletMap.set(id, o.name);
    }

    const dailyBreakdown: any[] = [];
    let balancedDays = 0;
    let mismatchDays = 0;
    let incompleteDays = 0;
    let totalVariance = 0;
    let largestVariance: { date: string; variance: number } | null = null;

    for (const sheet of sheets) {
      // Skip empty drafts — no data entered yet
      const hasSales = sheet.totalSalesOverride != null ||
        Number(sheet.acBarSaleComputed ?? 0) > 0 ||
        Number(sheet.nonAcBarSaleComputed ?? 0) > 0 ||
        Number(sheet.familyWingSaleComputed ?? 0) > 0 ||
        Number(sheet.parcelSaleComputed ?? 0) > 0;
      const hasClosing = sheet.closingBalance != null;

      if (sheet.status === "DRAFT" && !hasSales && !hasClosing) {
        continue;
      }

      if (sheet.closingBalance == null) {
        incompleteDays++;
        dailyBreakdown.push({
          date: sheet.reportDate,
          variance: null,
          status: "INCOMPLETE",
          sheetStatus: sheet.status,
          outletId: sheet.restaurantId,
          outletName: outletMap.get(sheet.restaurantId) || null,
        });
        continue;
      }

      // Compute systemClosing
      const openingBalance = Number(sheet.openingBalance);
      const acBar = sheet.acBarSaleOverride != null ? Number(sheet.acBarSaleOverride) : Number(sheet.acBarSaleComputed ?? 0);
      const nonAcBar = sheet.nonAcBarSaleOverride != null ? Number(sheet.nonAcBarSaleOverride) : Number(sheet.nonAcBarSaleComputed ?? 0);
      const familyWing = sheet.familyWingSaleOverride != null ? Number(sheet.familyWingSaleOverride) : Number(sheet.familyWingSaleComputed ?? 0);
      const parcel = sheet.parcelSaleOverride != null ? Number(sheet.parcelSaleOverride) : Number(sheet.parcelSaleComputed ?? 0);
      const swiggy = Number(sheet.swiggySale ?? 0);
      const zomato = Number(sheet.zomatoSale ?? 0);

      const totalSales = sheet.totalSalesOverride != null
        ? Number(sheet.totalSalesOverride)
        : Math.round((acBar + nonAcBar + familyWing + parcel + swiggy + zomato) * 100) / 100;

      const totalExpenditures = sheet.totalExpendituresOverride != null
        ? Number(sheet.totalExpendituresOverride)
        : Number(sheet.totalExpenditures ?? 0);

      const positiveAdj = sheet.adjustments
        .filter((a: any) => a.sign === "PLUS")
        .reduce((sum: number, a: any) => sum + Number(a.amount), 0);
      const negativeAdj = sheet.adjustments
        .filter((a: any) => a.sign === "MINUS")
        .reduce((sum: number, a: any) => sum + Number(a.amount), 0);
      const adjustmentsNet = Math.round((positiveAdj - negativeAdj) * 100) / 100;

      const aggregatorSales = Math.round((swiggy + zomato) * 100) / 100;
      const systemClosing = Math.round(
        (openingBalance + totalSales - aggregatorSales - totalExpenditures + adjustmentsNet) * 100
      ) / 100;

      const actualClosing = Number(sheet.closingBalance);
      const variance = Math.round((actualClosing - systemClosing) * 100) / 100;

      const status = variance === 0 ? "BALANCED" : "MISMATCH";

      if (status === "BALANCED") balancedDays++;
      else mismatchDays++;

      totalVariance = Math.round((totalVariance + variance) * 100) / 100;

      if (largestVariance === null || Math.abs(variance) > Math.abs(largestVariance.variance)) {
        largestVariance = { date: sheet.reportDate, variance };
      }

      dailyBreakdown.push({
        date: sheet.reportDate,
        variance,
        status,
        sheetStatus: sheet.status,
        outletId: sheet.restaurantId,
        outletName: outletMap.get(sheet.restaurantId) || null,
        openingBalance,
        totalSales,
        totalExpenditures,
        adjustmentsNet,
        systemClosing,
        actualClosing,
      });
    }

    // Sort ascending by date
    dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      period: { startDate, endDate },
      outletId,
      summary: {
        totalDays: dailyBreakdown.length,
        balancedDays,
        mismatchDays,
        incompleteDays,
        largestVariance: largestVariance || { date: null, variance: 0 },
        totalVariance,
      },
      dailyBreakdown,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Reconciliation summary failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
