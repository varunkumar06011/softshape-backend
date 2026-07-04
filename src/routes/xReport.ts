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
import { upsertXReport, listXReports, getXReport, markXReportPrinted } from "../services/xReportService";
import { buildXReport } from "../utils/escpos";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import prisma from "../lib/prisma";
import logger from "../lib/logger";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── GET /api/xreports?startDate=&endDate= ───────────────────────────────────
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }

    const reports = await listXReports(restaurantId, startDate as string, endDate as string);
    res.json(reports);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] List failed");
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

// ── POST /api/xreports ───────────────────────────────────────────────────────
router.post("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const {
      reportDate,
      totalSales,
      voucherAmount,
      cardAmount,
      cashAmount,
      notes500,
      notes200,
      notes100,
      notes50,
      notes20,
      notes10,
    } = req.body;

    if (!reportDate) return res.status(400).json({ error: "reportDate required" });
    if (typeof totalSales !== "number") return res.status(400).json({ error: "totalSales must be a number" });

    // No strict validation: card/cash amounts and denominations are recorded as declared by the cashier
    // and may not match the auto-filled total sales.
    const card = cardAmount ?? 0;
    const cash = cashAmount ?? 0;
    const voucher = voucherAmount ?? 0;

    const createdBy = req.user!.userId ?? req.user!.name ?? null;

    const report = await upsertXReport(
      restaurantId,
      reportDate,
      {
        totalSales,
        voucherAmount: voucher,
        cardAmount: card,
        cashAmount: cash,
        notes500,
        notes200,
        notes100,
        notes50,
        notes20,
        notes10,
      },
      createdBy
    );

    res.json(report);
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Upsert failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/xreports/:date/print ──────────────────────────────────────────
// Emits the X Report as a FINAL_BILL print job so it routes to the configured bill printer.
router.post("/:date/print", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
    const userName = req.user!.name ?? req.user!.userId ?? null;

    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const report = await getXReport(restaurantId, date);
    if (!report || !report.id) {
      return res.status(404).json({ error: "X Report not found for this date" });
    }

    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, receiptHeader: true },
    });

    const finalAmount = Number(report.totalSales) - Number(report.voucherAmount);
    const escposData = buildXReport({
      restaurantName: outlet?.receiptHeader || outlet?.name || undefined,
      reportDate: date,
      cashierName: userName || undefined,
      finalAmount,
      voucherAmount: Number(report.voucherAmount),
      cardAmount: Number(report.cardAmount),
      cashAmount: Number(report.cashAmount),
      cashFromNotes: Number(report.cashFromNotes),
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
    getIo().to(`print:${restaurantId}`).emit("print_job", payload);
    bufferPrintJob(restaurantId, payload).catch(() => {});

    await markXReportPrinted(restaurantId, date);
    res.json({ success: true, printed: true });
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Mark printed failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
