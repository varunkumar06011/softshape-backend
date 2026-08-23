// ─────────────────────────────────────────────────────────────────────────────
// X Report Routes — Daily cashier X report with denomination tracking
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints:
//   GET  /api/xreports?startDate=&endDate=  — list X reports for a date range
//   GET  /api/xreports/:date                — get or auto-seed a single X report
//   POST /api/xreports                      — create or update an X report
//   POST /api/xreports/:date/print          — mark an X report as printed
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { upsertXReport, listXReports, getXReport, markXReportPrinted, computeTotalSalesFromTransactions, computePaymentBreakdownFromTransactions, computeTipsFromTransactions, computeVenueSalesFromTransactions, confirmXReportPayout, finalizeXReport, reopenXReport } from "../services/xReportService";
import { computePaymentSummary } from "../services/paymentSummaryService";
import { buildXReport } from "../utils/escpos";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import prisma from "../lib/prisma";
import { basePrisma } from "../lib/prisma";
import { resolveTenantContext } from "../lib/tenantContext";
import logger from "../lib/logger";

const router = Router();

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── GET /api/xreports?startDate=&endDate=&outletId= ───────────────────────
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }

    const outletId = (req.query.outletId as string) || 'all';
    const ctx = await resolveTenantContext(restaurantId);
    const tenantIds = ctx.allIds ?? [restaurantId];

    let reports: any[];
    if (outletId && outletId !== 'all' && tenantIds.includes(outletId)) {
      reports = await listXReports(outletId, startDate as string, endDate as string);
    } else {
      // Query across all outlets using basePrisma (unscoped)
      reports = await basePrisma.xReport.findMany({
        where: {
          restaurantId: { in: tenantIds },
          reportDate: { gte: startDate as string, lte: endDate as string },
        },
        orderBy: { reportDate: "desc" },
      });
    }

    // Enrich each report with outlet name
    const outletMap = new Map<string, string>();
    for (const id of tenantIds) {
      const outlet = await basePrisma.outlet.findUnique({
        where: { id },
        select: { name: true },
      });
      if (outlet) outletMap.set(id, outlet.name);
    }

    const enriched = reports.map((r: any) => ({
      ...r,
      outletName: outletMap.get(r.restaurantId) || 'Unknown Outlet',
    }));

    res.json(enriched);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] List failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/xreports/:date/refresh-sales ───────────────────────────────────
// Returns the current total sales calculated from transactions for the given date
// Must be defined before /:date to avoid route matching conflicts
router.get("/:date/refresh-sales", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const [totalSales, breakdown, tips] = await Promise.all([
      computeTotalSalesFromTransactions(restaurantId, date),
      computePaymentBreakdownFromTransactions(restaurantId, date),
      computeTipsFromTransactions(restaurantId, date),
    ]);

    res.json({
      totalSales,
      cashAmount: breakdown.cashSales,
      cardAmount: breakdown.cardSales,
      upiAmount: breakdown.upiSales,
      otherAmount: breakdown.otherSales,
      tipsAmount: tips.totalTips,
      cashTipsAmount: tips.cashTips,
      cardTipsAmount: tips.cardTips,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Refresh sales failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/xreports/:date ──────────────────────────────────────────────────
router.get("/:date", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const report = await getXReport(restaurantId, date);
    res.json(report);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Get failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/xreports/:date/venue-sales ─────────────────────────────────
// Get venue-wise sales breakdown for a given date
router.get("/:date/venue-sales", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    const venueSales = await computeVenueSalesFromTransactions(restaurantId, date);
    res.json(venueSales);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Venue sales failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/xreports ───────────────────────────────────────────────────────
// Update denomination counts for a DRAFT X-report. Derived totals are always
// recomputed from PaymentSummary server-side; manual payment overrides are no
// longer accepted.
router.post("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const {
      reportDate,
      notes500,
      notes200,
      notes100,
      notes50,
      notes20,
      notes10,
    } = req.body;

    if (!reportDate) return res.status(400).json({ error: "reportDate required" });

    const createdBy = req.user!.userId ?? req.user!.name ?? null;

    const report = await upsertXReport(
      restaurantId,
      reportDate,
      { notes500, notes200, notes100, notes50, notes20, notes10 },
      createdBy
    );

    res.json(report);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Upsert failed");
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: error.message });
  }
});

// ── POST /api/xreports/:date/confirm-payout ──────────────────────────────────
// Transition a DRAFT X-report to PAYOUT_CONFIRMED. Requires tips > 0 and
// explicit cashier acknowledgement that tips were paid from the cash drawer.
router.post("/:date/confirm-payout", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
    const userId = req.user!.userId;
    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const { notes500, notes200, notes100, notes50, notes20, notes10 } = req.body || {};
    const report = await confirmXReportPayout(restaurantId, date, userId, {
      notes500, notes200, notes100, notes50, notes20, notes10,
    });
    res.json(report);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Confirm payout failed");
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: error.message });
  }
});

// ── POST /api/xreports/:date/finalize ────────────────────────────────────────
// Transition a DRAFT (tips=0) or PAYOUT_CONFIRMED X-report to FINALIZED.
// After FINALIZED the report is an immutable snapshot.
router.post("/:date/finalize", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
    const userId = req.user!.userId;
    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const report = await finalizeXReport(restaurantId, date, userId);
    res.json(report);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Finalize failed");
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: error.message });
  }
});

// ── POST /api/xreports/:date/reopen ──────────────────────────────────────────
// Reopen a FINALIZED X-report back to DRAFT for correction.
router.post("/:date/reopen", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
    const userId = req.user!.userId;
    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const report = await reopenXReport(restaurantId, date, userId);
    res.json(report);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Reopen failed");
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: error.message });
  }
});

// ── POST /api/xreports/:date/print ──────────────────────────────────────────
// Emits the X Report as a FINAL_BILL print job. The report must be FINALIZED
// before printing; physical printing is an idempotent external side effect that
// follows the atomic database finalization.
router.post("/:date/print", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
    const userId = req.user!.userId;
    const user = await basePrisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const userName = user?.name || null;

    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const report = await getXReport(restaurantId, date);
    if (!report || !report.id) {
      return res.status(404).json({ error: "X Report not found for this date" });
    }

    // Printing requires FINALIZED state. If the report is still DRAFT or
    // PAYOUT_CONFIRMED, reject so the cashier completes the finalization flow.
    if (report.reportStatus && report.reportStatus !== "FINALIZED") {
      return res.status(409).json({
        error: `X Report must be FINALIZED before printing (current: ${report.reportStatus})`,
      });
    }

    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, receiptHeader: true },
    });

    const expenditures = await prisma.expenditure.findMany({
      where: { restaurantId, expenditureDate: date, status: { not: "VOIDED" } },
      include: { approvedBy: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    });

    const finalAmount = round2(Number(report.totalAmount));
    const escposData = buildXReport({
      restaurantName: outlet?.receiptHeader || outlet?.name || undefined,
      reportDate: date,
      cashierName: userName || undefined,
      totalSales: Number(report.totalSales),
      finalAmount,
      expenditureAmount: Number(report.expenditureAmount),
      cardAmount: Number(report.cardAmount),
      cashAmount: Number(report.cashAmount),
      upiAmount: Number(report.upiAmount || 0),
      otherAmount: Number(report.otherAmount || 0),
      tipsAmount: Number(report.tipsAmount || 0),
      cashFromNotes: Number(report.cashFromNotes),
      expenditures: expenditures.map((v) => ({
        paidToName: v.paidToName,
        paidToType: v.paidToType,
        category: v.category,
        narration: v.narration,
        approvedByName: (v as any).approvedByName || v.approvedBy?.name || null,
        amount: Number(v.amount),
      })),
      denominations: [
        { label: 'Rs.500', value: 500, count: Number(report.notes500 || 0) },
        { label: 'Rs.200', value: 200, count: Number(report.notes200 || 0) },
        { label: 'Rs.100', value: 100, count: Number(report.notes100 || 0) },
        { label: 'Rs.50', value: 50, count: Number(report.notes50 || 0) },
        { label: 'Rs.20', value: 20, count: Number(report.notes20 || 0) },
        { label: 'Rs.10', value: 10, count: Number(report.notes10 || 0) },
      ],
    });

    const eventId = `${restaurantId}-XREPORT-${date}-${Date.now()}`;
    const payload = {
      type: "FINAL_BILL",
      data: {
        reportDate: date,
        restaurantId,
        escposData,
      },
      eventId,
    };

    // Emit to the dedicated print room and buffer for durability
    const xTargetRoom = `print:${restaurantId}:FINAL_BILL`;
    const xGeneralRoom = `print:${restaurantId}`;
    getIo().to(xTargetRoom).emit("print_job", payload);
    const xSockets = await (getIo() as any).adapter.sockets(new Set([xTargetRoom]));
    if (xSockets.size === 0) {
      getIo().to(xGeneralRoom).emit("print_job", payload);
    }
    bufferPrintJob(restaurantId, payload).catch(err => logger.error({ err }, '[xReport] bufferPrintJob failed for X-report print'));

    await markXReportPrinted(restaurantId, date);
    // Return escposData + eventId so the frontend can attempt a direct local
    // print via the Print Agent's HTTP endpoint in parallel with the socket
    // emission above (same reliability pattern as Final Bill / Voucher print).
    res.json({ success: true, printed: true, escposData, eventId });
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Mark printed failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
