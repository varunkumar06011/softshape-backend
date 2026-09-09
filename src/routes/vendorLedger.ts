// ─────────────────────────────────────────────────────────────────────────────
// Vendor Ledger Route — editable daily vendor ledger with carry-forward
// ─────────────────────────────────────────────────────────────────────────────
// Per-date, per-vendor running ledger:
//
//   Opening Balance + Purchases − Payments = Closing Balance
//
// The Closing Balance automatically becomes the next day's Opening Balance.
// Editing any day cascades re-computation through all subsequent existing entries.
//
// Purchases are HYBRID: the admin enters a manual amount, and Daily Entry totals
// (DailyPurchaseEntry.totalPrice for that vendor+date) are added on top at read
// time. This avoids double-counting while keeping Daily Entry as the inventory
// feed and the ledger as the vendor balance book.
//
// Endpoints:
//   GET /api/vendor-ledger?date=YYYY-MM-DD        — ledger rows for that date
//   PUT /api/vendor-ledger/:vendorId              — save opening/purchases/payments + cascade
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

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(Number(n || 0) * 100) / 100;
}

// Sum of DailyPurchaseEntry.totalPrice for a vendor on a given date.
// This is the "Daily Entry" portion of the hybrid purchases column.
async function getDailyEntryTotal(vendorId: string, date: string): Promise<number> {
  const rows = await prisma.dailyPurchaseEntry.findMany({
    where: { vendorId, date },
    select: { totalPrice: true },
  });
  return round2(rows.reduce((s, r) => s + Number(r.totalPrice), 0));
}

// Compute the opening balance for a vendor on a given date when no entry exists yet.
//   - If there is a prior VendorDailyEntry, use its closingBalance (carry-forward).
//   - If no prior entry exists and the date is today, seed from vendor.outstandingBalance.
//   - Otherwise 0.
async function computeAutoOpening(
  restaurantId: string,
  vendorId: string,
  date: string,
  today: string,
  outstandingBalance: number
): Promise<number> {
  const prevEntry = await prisma.vendorDailyEntry.findFirst({
    where: { vendorId, date: { lt: date } },
    orderBy: { date: "desc" },
    select: { closingBalance: true },
  });
  if (prevEntry) return round2(Number(prevEntry.closingBalance));
  if (date === today) return round2(outstandingBalance);
  return 0;
}

// ── GET /api/vendor-ledger?date=YYYY-MM-DD ─────────────────────────────────────
// Returns one row per vendor. If a VendorDailyEntry exists for the date, uses
// stored values. Otherwise computes the opening on-the-fly (carry-forward or
// outstanding seed) without persisting — the entry is only created on PUT.
router.get(
  "/",
  requireRole("ADMIN", "OWNER", "MANAGER") as any,
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
      const today = getKolkataDateString();

      const date = (req.query.date as string) || today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }

      const [vendors, existingEntries, dailyEntries] = await Promise.all([
        prisma.vendor.findMany({
          where: { restaurantId },
          orderBy: { name: "asc" },
          select: { id: true, name: true, isActive: true, outstandingBalance: true },
        }),
        prisma.vendorDailyEntry.findMany({
          where: { restaurantId, date },
          select: {
            vendorId: true,
            openingBalance: true,
            purchases: true,
            payments: true,
            closingBalance: true,
          },
        }),
        prisma.dailyPurchaseEntry.findMany({
          where: { restaurantId, date },
          select: { vendorId: true, totalPrice: true },
        }),
      ]);

      const entryMap = new Map(existingEntries.map((e) => [e.vendorId, e]));
      const dailyMap = new Map<string, number>();
      for (const d of dailyEntries) {
        dailyMap.set(d.vendorId, (dailyMap.get(d.vendorId) || 0) + Number(d.totalPrice));
      }

      // For vendors without a stored entry, we need the auto opening.
      // Batch-fetch the most recent prior entry per vendor + outstanding for today.
      const missingVendorIds = vendors
        .filter((v) => !entryMap.has(v.id))
        .map((v) => v.id);

      const autoOpeningMap = new Map<string, number>();
      if (missingVendorIds.length > 0) {
        const prevEntries = await prisma.vendorDailyEntry.findMany({
          where: { vendorId: { in: missingVendorIds }, date: { lt: date } },
          orderBy: { date: "desc" },
          select: { vendorId: true, closingBalance: true, date: true },
        });
        // keep only the most recent per vendor
        const seen = new Set<string>();
        for (const pe of prevEntries) {
          if (seen.has(pe.vendorId)) continue;
          seen.add(pe.vendorId);
          autoOpeningMap.set(pe.vendorId, round2(Number(pe.closingBalance)));
        }
      }

      const rows = vendors.map((v) => {
        const entry = entryMap.get(v.id);
        const dailyTotal = round2(dailyMap.get(v.id) || 0);

        let opening: number;
        let manualPurchases: number;
        let payments: number;

        if (entry) {
          opening = round2(Number(entry.openingBalance));
          manualPurchases = round2(Number(entry.purchases));
          payments = round2(Number(entry.payments));
        } else {
          // Auto opening: carry-forward, or outstanding seed for today, or 0
          if (autoOpeningMap.has(v.id)) {
            opening = autoOpeningMap.get(v.id)!;
          } else if (date === today) {
            opening = round2(Number(v.outstandingBalance));
          } else {
            opening = 0;
          }
          manualPurchases = 0;
          payments = 0;
        }

        const effectivePurchases = round2(manualPurchases + dailyTotal);
        const closing = round2(opening + effectivePurchases - payments);

        return {
          vendorId: v.id,
          name: v.name,
          isActive: v.isActive,
          openingBalance: opening,
          purchases: effectivePurchases,
          manualPurchases,
          dailyEntryPurchases: dailyTotal,
          payments,
          closingBalance: closing,
          hasEntry: !!entry,
        };
      });

      res.json(rows);
    } catch (error: any) {
      logger.error({ err: error }, "[VendorLedger] GET failed");
      res.status(500).json({ error: error.message });
    }
  }
);

// ── PUT /api/vendor-ledger/:vendorId ───────────────────────────────────────────
// Body: { date, openingBalance, purchases, payments }
// Saves the admin-entered values, recomputes closing (including Daily Entry total
// for that date), and cascades the new closing forward as the opening of all
// subsequent existing entries for this vendor.
router.put(
  "/:vendorId",
  requireRole("ADMIN", "OWNER", "MANAGER") as any,
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
      const { vendorId } = req.params;
      const { date, openingBalance, purchases, payments } = req.body;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }

      // Validate vendor belongs to this tenant
      const vendor = await prisma.vendor.findFirst({
        where: { id: vendorId, restaurantId },
        select: { id: true, name: true, isActive: true },
      });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      const opening = round2(Number(openingBalance) || 0);
      const manualPurchases = round2(Number(purchases) || 0);
      const pay = round2(Number(payments) || 0);

      // Daily Entry total for this vendor+date (hybrid purchases)
      const dailyTotal = await getDailyEntryTotal(vendorId, date);
      const closing = round2(opening + manualPurchases + dailyTotal - pay);

      // Upsert the entry for this date
      const entry = await prisma.vendorDailyEntry.upsert({
        where: { vendorId_date: { vendorId, date } },
        create: {
          restaurantId,
          vendorId,
          date,
          openingBalance: opening,
          purchases: manualPurchases,
          payments: pay,
          closingBalance: closing,
        },
        update: {
          openingBalance: opening,
          purchases: manualPurchases,
          payments: pay,
          closingBalance: closing,
        },
      });

      // ── Cascade: recompute opening + closing for all subsequent existing entries ──
      const subsequent = await prisma.vendorDailyEntry.findMany({
        where: { vendorId, date: { gt: date } },
        orderBy: { date: "asc" },
        select: { id: true, date: true, purchases: true, payments: true },
      });

      let prevClosing = closing;
      for (const sub of subsequent) {
        const subDaily = await getDailyEntryTotal(vendorId, sub.date);
        const subClosing = round2(prevClosing + Number(sub.purchases) + subDaily - Number(sub.payments));
        await prisma.vendorDailyEntry.update({
          where: { id: sub.id },
          data: { openingBalance: prevClosing, closingBalance: subClosing },
        });
        prevClosing = subClosing;
      }

      res.json({
        vendorId,
        name: vendor.name,
        isActive: vendor.isActive,
        openingBalance: opening,
        purchases: round2(manualPurchases + dailyTotal),
        manualPurchases,
        dailyEntryPurchases: dailyTotal,
        payments: pay,
        closingBalance: closing,
        hasEntry: true,
      });
    } catch (error: any) {
      logger.error({ err: error }, "[VendorLedger] PUT failed");
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
