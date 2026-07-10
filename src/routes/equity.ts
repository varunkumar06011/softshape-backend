// ─────────────────────────────────────────────────────────────────────────────
// Owner's Equity Routes
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints:
//   GET    /api/equity/adjustments              — list (filterable by ?dateFrom=&dateTo=&direction=)
//   POST   /api/equity/adjustments              — create (INVESTMENT or DRAWING)
//   GET    /api/equity/summary                  — openingEquity + investments − drawings + retainedProfit
//
// No edit/delete endpoints — corrections should be a reversing entry (a new
// adjustment with opposite direction and a narration explaining the correction).
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { getKolkataDateString } from "../utils/date";
import logger from "../lib/logger";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── Helper: write AuditLog ────────────────────────────────────────────────────
async function writeAuditLog(
  restaurantId: string,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata?: any
) {
  try {
    await prisma.auditLog.create({
      data: {
        restaurantId,
        userId,
        action,
        entityType,
        entityId: entityId || null,
        metadata: metadata || undefined,
      },
    });
  } catch (err) {
    logger.error({ err }, "[Equity] AuditLog write failed");
  }
}

// ── GET /api/equity/adjustments — list ────────────────────────────────────────
router.get("/adjustments", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { dateFrom, dateTo, direction } = req.query;

    const where: any = { restaurantId };
    if (direction) where.direction = direction;
    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.gte = dateFrom as string;
      if (dateTo) where.date.lte = dateTo as string;
    }

    const adjustments = await prisma.equityAdjustment.findMany({
      where,
      orderBy: { date: "desc" },
    });

    res.json(
      adjustments.map((a) => ({
        ...a,
        amount: Number(a.amount),
      }))
    );
  } catch (error: any) {
    logger.error({ err: error }, "[Equity] GET adjustments failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/equity/adjustments — create ─────────────────────────────────────
router.post("/adjustments", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { direction, amount, date, narration } = req.body;

    if (!direction || (direction !== "INVESTMENT" && direction !== "DRAWING")) {
      return res.status(400).json({ error: "direction must be INVESTMENT or DRAWING" });
    }
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }
    if (!narration || !narration.trim()) {
      return res.status(400).json({ error: "narration is required — explain why this equity movement happened" });
    }

    const adjustment = await prisma.equityAdjustment.create({
      data: {
        restaurantId,
        direction,
        amount: new Prisma.Decimal(amount),
        date,
        narration: narration.trim(),
        createdById: userId,
      },
    });

    await writeAuditLog(restaurantId, userId, "EQUITY_ADJUSTMENT_CREATED", "EquityAdjustment", adjustment.id, {
      direction,
      amount: Number(amount),
      date,
      narration: narration.trim(),
    });

    res.json({ ...adjustment, amount: Number(adjustment.amount) });
  } catch (error: any) {
    logger.error({ err: error }, "[Equity] POST adjustment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/equity/summary — full equity rollup ──────────────────────────────
// Formula: currentEquity = openingEquity + totalInvestments − totalDrawings + retainedProfit
// retainedProfit = Revenue (COMPLETED Transactions) − COGS (DailyCogsEntry)
//                  − Expenditure(EXPENSE) − Payroll(netPayable) − Depreciation
// All summed from OpeningBalance.asOfDate through today.
router.get("/summary", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const today = getKolkataDateString();

    // Get opening balance for asOfDate and openingEquity
    const openingBalance = await prisma.openingBalance.findFirst({
      where: { restaurantId },
    });

    const asOfDate = openingBalance?.asOfDate || "2000-01-01";
    const openingEquity = openingBalance ? Number(openingBalance.openingEquity) : 0;

    // 1. Total Investments
    const investments = await prisma.equityAdjustment.findMany({
      where: { restaurantId, direction: "INVESTMENT" },
      select: { amount: true },
    });
    const totalInvestments = investments.reduce((sum, a) => sum + Number(a.amount), 0);

    // 2. Total Drawings
    const drawings = await prisma.equityAdjustment.findMany({
      where: { restaurantId, direction: "DRAWING" },
      select: { amount: true },
    });
    const totalDrawings = drawings.reduce((sum, a) => sum + Number(a.amount), 0);

    // 3. Retained Profit = Revenue − COGS − Expenses − Payroll − Depreciation

    // 3a. Revenue: COMPLETED transactions from asOfDate to today
    const revenueRows = await prisma.transaction.findMany({
      where: {
        restaurantId,
        status: "COMPLETED",
        txnDate: { gte: asOfDate, lte: today },
      },
      select: { amount: true },
    });
    const revenue = revenueRows.reduce((sum, t) => sum + Number(t.amount), 0);

    // 3b. COGS: DailyCogsEntry from asOfDate to today
    const cogsRows = await prisma.dailyCogsEntry.findMany({
      where: {
        restaurantId,
        date: { gte: asOfDate, lte: today },
      },
      select: { cogsAmount: true },
    });
    const cogs = cogsRows.reduce((sum, e) => sum + Number(e.cogsAmount), 0);

    // 3c. Expenses: Expenditure with entryType EXPENSE, status not VOIDED, from asOfDate to today
    const expenseRows = await prisma.expenditure.findMany({
      where: {
        restaurantId,
        entryType: "EXPENSE",
        status: { not: "VOIDED" },
        expenditureDate: { gte: asOfDate, lte: today },
      },
      select: { amount: true },
    });
    const expenses = expenseRows.reduce((sum, e) => sum + Number(e.amount), 0);

    // 3d. Payroll: sum of netPayable for PayrollRecords from asOfDate month to today
    // Use monthYear >= asOfDate's month
    const asOfMonth = asOfDate.slice(0, 7);
    const todayMonth = today.slice(0, 7);
    const payrollRows = await prisma.payrollRecord.findMany({
      where: {
        restaurantId,
        monthYear: { gte: asOfMonth, lte: todayMonth },
      },
      select: { netPayable: true },
    });
    const payroll = payrollRows.reduce((sum, p) => sum + Number(p.netPayable), 0);

    // 3e. Depreciation: sum of DepreciationEntry.depreciationAmount
    const depRows = await prisma.depreciationEntry.findMany({
      where: {
        restaurantId,
        periodMonth: { gte: asOfMonth, lte: todayMonth },
      },
      select: { depreciationAmount: true },
    });
    const depreciation = depRows.reduce((sum, d) => sum + Number(d.depreciationAmount), 0);

    const retainedProfit = revenue - cogs - expenses - payroll - depreciation;
    const currentEquity = openingEquity + totalInvestments - totalDrawings + retainedProfit;

    const round2 = (n: number) => Math.round(n * 100) / 100;

    res.json({
      openingEquity: round2(openingEquity),
      totalInvestments: round2(totalInvestments),
      totalDrawings: round2(totalDrawings),
      retainedProfit: round2(retainedProfit),
      currentEquity: round2(currentEquity),
      breakdown: {
        revenue: round2(revenue),
        cogs: round2(cogs),
        expenses: round2(expenses),
        payroll: round2(payroll),
        depreciation: round2(depreciation),
      },
      asOfDate,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[Equity] Summary failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
