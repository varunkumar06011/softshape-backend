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

    // Validation: card + cash + voucher should equal totalSales
    const card = cardAmount ?? 0;
    const cash = cashAmount ?? 0;
    const voucher = voucherAmount ?? 0;
    const sum = round2(card + cash + voucher);
    const expected = round2(totalSales);

    if (Math.abs(sum - expected) > 0.01) {
      return res.status(400).json({
        error: `Card + Cash + Voucher (₹${sum}) must equal Total Sales (₹${expected})`,
      });
    }

    // Validation: cashFromNotes should equal cashAmount
    const notesSum =
      (notes500 ?? 0) * 500 +
      (notes200 ?? 0) * 200 +
      (notes100 ?? 0) * 100 +
      (notes50 ?? 0) * 50 +
      (notes20 ?? 0) * 20 +
      (notes10 ?? 0) * 10;

    if (Math.abs(round2(notesSum) - round2(cash)) > 0.01) {
      return res.status(400).json({
        error: `Cash from Notes (₹${notesSum}) must equal Cash Amount (₹${cash})`,
      });
    }

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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── POST /api/xreports/:date/print ──────────────────────────────────────────
router.post("/:date/print", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "date required" });

    const result = await markXReportPrinted(restaurantId, date);
    if (result.count === 0) {
      return res.status(404).json({ error: "X Report not found for this date" });
    }
    res.json({ success: true, printed: true });
  } catch (error: any) {
    logger.error({ err: error }, "[XReport] Mark printed failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
