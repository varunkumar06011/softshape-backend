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
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { resolveTenantContext } from "../lib/tenantContext";
import { basePrisma } from "../lib/prisma";
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

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── GET /api/balance-sheet?startDate=&endDate=&outletId= ─────────────────────
router.get("/", async (req: any, res) => {
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
router.get("/:date", async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
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

// ── GET /api/balance-sheet/:date/refresh-sales ───────────────────────────────
// Returns the current sales data calculated from transactions for the given date
// Must be defined before /:date to avoid route matching conflicts
router.get("/:date/refresh-sales", async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
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
router.put("/:date", async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from body or query, default to session
    const outletId = req.body.outletId || (req.query.outletId as string) || sessionRestaurantId;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (!tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    const sheet = await upsertBalanceSheet(outletId, date, req.body, userId);
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
router.post("/:date/adjustments", async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
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

    res.status(201).json(adjustment);
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Add adjustment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/balance-sheet/adjustments/:id — edit adjustment ───────────────
router.patch("/adjustments/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    const { label, amount, sign, sortOrder } = req.body;

    // Find the adjustment and check parent sheet status
    const adjustment = await prisma.balanceAdjustment.findUnique({
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

    const updated = await prisma.balanceAdjustment.update({
      where: { id },
      data: updateData,
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Edit adjustment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/balance-sheet/adjustments/:id — delete adjustment ────────────
router.delete("/adjustments/:id", async (req: any, res) => {
  try {
    const { id } = req.params;

    const adjustment = await prisma.balanceAdjustment.findUnique({
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

    await prisma.balanceAdjustment.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[BalanceSheet] Delete adjustment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/balance-sheet/:date/submit — DRAFT → SUBMITTED ─────────────────
router.post("/:date/submit", async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from body or query, default to session
    const outletId = req.body.outletId || (req.query.outletId as string) || sessionRestaurantId;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (!tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    const sheet = await setBalanceSheetStatus(outletId, date, "SUBMITTED", userId);
    res.json(sheet);
  } catch (error: any) {
    if (error.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ err: error }, "[BalanceSheet] Submit failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/balance-sheet/:date/lock — SUBMITTED → LOCKED ──────────────────
// Guarded with requireRole(['admin','owner']) — financial mutation must not be unguarded.
router.post("/:date/lock", requireRole("admin", "owner"), async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from body or query, default to session
    const outletId = req.body.outletId || (req.query.outletId as string) || sessionRestaurantId;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (!tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    // Verify current status is SUBMITTED before locking using basePrisma
    const existing = await basePrisma.dailyBalanceSheet.findUnique({
      where: { restaurantId_reportDate: { restaurantId: outletId, reportDate: date } },
    });

    if (!existing) {
      return res.status(404).json({ error: "Balance sheet not found" });
    }

    if (existing.status !== "SUBMITTED") {
      return res.status(400).json({ error: `Cannot lock a sheet with status ${existing.status}. Must be SUBMITTED first.` });
    }

    const sheet = await setBalanceSheetStatus(outletId, date, "LOCKED", userId);
    res.json(sheet);
  } catch (error: any) {
    if (error.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ err: error }, "[BalanceSheet] Lock failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/balance-sheet/:date/unlock — LOCKED → DRAFT ────────────────────
// Guarded with requireRole(['admin','owner']). Writes an AuditLog entry.
router.post("/:date/unlock", requireRole("admin", "owner"), async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    const userId = req.user!.userId ?? req.user!.name ?? null;

    // Resolve explicit outletId from body or query, default to session
    const outletId = req.body.outletId || (req.query.outletId as string) || sessionRestaurantId;
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // Validate outletId is accessible
    if (!tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    const sheet = await setBalanceSheetStatus(outletId, date, "DRAFT", userId);
    res.json(sheet);
  } catch (error: any) {
    if (error.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ err: error }, "[BalanceSheet] Unlock failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
