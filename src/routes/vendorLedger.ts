// ─────────────────────────────────────────────────────────────────────────────
// Vendor Ledger Route — read-only, point-in-time daily vendor ledger
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the flat vendor list with a per-date ledger:
//
//   | Vendor | Balance on {date-1} | Purchases on {date} | Payments on {date} | Balance on {date} |
//
// This endpoint performs ZERO writes. It only re-projects the existing financial
// records (PurchaseOrder, PurchaseOrderPayment, DailyPurchaseEntry, Expenditure,
// OutstandingHistory) onto a chosen date. It does NOT modify recalcVendorBalance,
// outstandingBalance, or any other write path — the numbers shown here can never
// drift from the outstandingBalance shown elsewhere because they are derived from
// the same source tables.
//
// Endpoint:
//   GET /api/vendor-ledger?date=YYYY-MM-DD   — ledger rows for that date
//
// Auth/middleware chain mirrors vendors.ts:
//   authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext,
//   requireRole('ADMIN','OWNER','MANAGER').
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import prisma from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { getKolkataDateString } from "../utils/date";
import logger from "../lib/logger";
import { PO_STATUS, EXPENDITURE_STATUS, ENTRY_TYPE } from "../utils/constants";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── Helper: add days to a "YYYY-MM-DD" calendar string ─────────────────────────
// Dates in this app are IST calendar strings (no timezone component), so we do
// pure calendar arithmetic via UTC to avoid any DST/offset drift.
function addDaysToDateStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const shifted = new Date(utc + delta * 86400000);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ── GET /api/vendor-ledger?date=YYYY-MM-DD ─────────────────────────────────────
router.get(
  "/",
  requireRole("ADMIN", "OWNER", "MANAGER") as any,
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

      const date =
        (req.query.date as string) || getKolkataDateString();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
      const prevDate = addDaysToDateStr(date, -1);

      // ── Bulk fetch all source rows for the tenant up to `date` ──────────────
      // One query per table, grouped in memory — no per-vendor queries.
      const [vendors, pos, dailyEntries, expenditures, writeoffs] = await Promise.all([
        prisma.vendor.findMany({
          where: { restaurantId },
          orderBy: { name: "asc" },
          select: { id: true, name: true, isActive: true },
        }),
        // Non-cancelled POs up to `date`, with their payments up to `date`.
        prisma.purchaseOrder.findMany({
          where: {
            restaurantId,
            status: { not: PO_STATUS.CANCELLED },
            orderDate: { lte: date },
          },
          select: {
            vendorId: true,
            totalAmount: true,
            orderDate: true,
            payments: {
              where: { paymentDate: { lte: date } },
              select: { amount: true, paymentDate: true },
            },
          },
        }),
        // ALL daily purchase entries up to `date` (not filtered by paymentStatus —
        // paymentStatus is a "currently unpaid" flag, not a historical one).
        prisma.dailyPurchaseEntry.findMany({
          where: { restaurantId, date: { lte: date } },
          select: { vendorId: true, totalPrice: true, date: true },
        }),
        // Standalone vendor payments (LIABILITY_PAYMENT) up to `date`.
        prisma.expenditure.findMany({
          where: {
            restaurantId,
            entryType: ENTRY_TYPE.LIABILITY_PAYMENT,
            status: { not: EXPENDITURE_STATUS.VOIDED },
            linkedVendorId: { not: null },
            expenditureDate: { lte: date },
          },
          select: { linkedVendorId: true, amount: true, expenditureDate: true },
        }),
        // Outstanding write-off history (point-in-time via IST calendar date of deletedAt).
        prisma.outstandingHistory.findMany({
          where: { restaurantId },
          select: { vendorId: true, deletedAmount: true, deletedAt: true },
        }),
      ]);

      // ── Group into per-vendor cumulative + on-date accumulators ─────────────
      // Keys: vendorId. Values are raw (unclamped) running totals.
      const poTotalToDate = new Map<string, number>();       // Σ totalAmount, orderDate <= cutoff
      const poPaymentsToDate = new Map<string, number>();    // Σ payments.amount, paymentDate <= cutoff
      const dailyToDate = new Map<string, number>();         // Σ totalPrice, date <= cutoff
      const expToDate = new Map<string, number>();           // Σ expenditure.amount, expenditureDate <= cutoff
      const writeoffToDate = new Map<string, number>();      // Σ deletedAmount, istDate <= cutoff

      const poTotalOnDate = new Map<string, number>();
      const poPaymentsOnDate = new Map<string, number>();
      const dailyOnDate = new Map<string, number>();
      const expOnDate = new Map<string, number>();
      const writeoffOnDate = new Map<string, number>();

      const acc = (map: Map<string, number>, id: string, v: number) =>
        map.set(id, (map.get(id) || 0) + v);

      for (const po of pos) {
        const vid = po.vendorId;
        const amt = Number(po.totalAmount);
        // orderDate <= date is guaranteed by the query.
        acc(poTotalToDate, vid, amt);
        if (po.orderDate === date) acc(poTotalOnDate, vid, amt);
        for (const p of po.payments) {
          const pamt = Number(p.amount);
          acc(poPaymentsToDate, vid, pamt);
          if (p.paymentDate === date) acc(poPaymentsOnDate, vid, pamt);
        }
      }

      for (const e of dailyEntries) {
        const vid = e.vendorId;
        const amt = Number(e.totalPrice);
        acc(dailyToDate, vid, amt);
        if (e.date === date) acc(dailyOnDate, vid, amt);
      }

      for (const ex of expenditures) {
        const vid = ex.linkedVendorId as string;
        const amt = Number(ex.amount);
        acc(expToDate, vid, amt);
        if (ex.expenditureDate === date) acc(expOnDate, vid, amt);
      }

      for (const w of writeoffs) {
        const vid = w.vendorId;
        const istDate = getKolkataDateString(w.deletedAt);
        // Only count write-offs that occurred on or before `date` (point-in-time).
        if (istDate <= date) acc(writeoffToDate, vid, Number(w.deletedAmount));
        if (istDate === date) acc(writeoffOnDate, vid, Number(w.deletedAmount));
      }

      // ── ledgerBalanceRaw(vendorId, cutoff) ───────────────────────────────────
      // Read-only sibling of recalcVendorBalance, reconstructed for an arbitrary
      // cutoff date. Uses OutstandingHistory (point-in-time) instead of the
      // cumulative vendor.writtenOffAmount so historical dates stay accurate.
      const sumAt = (map: Map<string, number>, id: string) => map.get(id) || 0;

      // For the opening balance we need cumulative-through-prevDate. We fetched
      // everything through `date`, so recompute the prevDate cumulative by
      // subtracting the on-date slices.
      const ledgerBalanceRaw = (id: string, cutoff: string): number => {
        // cumulative-through-date
        const throughDate =
          sumAt(poTotalToDate, id) -
          sumAt(poPaymentsToDate, id) +
          sumAt(dailyToDate, id) -
          sumAt(expToDate, id) -
          sumAt(writeoffToDate, id);
        if (cutoff === date) return throughDate;
        // cutoff === prevDate: subtract on-date slices (including write-offs)
        return (
          throughDate -
          sumAt(poTotalOnDate, id) +
          sumAt(poPaymentsOnDate, id) -
          sumAt(dailyOnDate, id) +
          sumAt(expOnDate, id) +
          sumAt(writeoffOnDate, id)
        );
      };

      const clamp0 = (n: number) => (n < 0 ? 0 : Math.round(n * 100) / 100);

      const rows = vendors.map((v) => {
        const rawOpening = ledgerBalanceRaw(v.id, prevDate);
        const purchasesOnDate =
          sumAt(poTotalOnDate, v.id) + sumAt(dailyOnDate, v.id);
        // On-date write-offs are folded into the payments column: a write-off
        // reduces the outstanding balance just like a payment, and including it
        // here keeps the invariant opening + purchases − payments === closing
        // exact (before clamping) while staying consistent with outstandingBalance
        // (which also subtracts write-offs via recalcVendorBalance).
        const paymentsOnDate =
          sumAt(poPaymentsOnDate, v.id) + sumAt(expOnDate, v.id) + sumAt(writeoffOnDate, v.id);
        const rawClosing = rawOpening + purchasesOnDate - paymentsOnDate;

        // Sanity invariant (holds before clamping): rawOpening + purchases - payments === rawClosing.
        return {
          vendorId: v.id,
          name: v.name,
          isActive: v.isActive,
          openingBalance: clamp0(rawOpening),
          purchasesOnDate: Math.round(purchasesOnDate * 100) / 100,
          paymentsOnDate: Math.round(paymentsOnDate * 100) / 100,
          closingBalance: clamp0(rawClosing),
        };
      });

      res.json(rows);
    } catch (error: any) {
      logger.error({ err: error }, "[VendorLedger] GET failed");
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
