// ─────────────────────────────────────────────────────────────────────────────
// COGS (Cost of Goods Sold) Routes — read endpoint for P&L consumption
// ─────────────────────────────────────────────────────────────────────────────
// Returns summed cogsAmount for a date range, plus per-item breakdown.
// Step 8's P&L formula (Revenue − COGS = Gross Profit) calls this directly.
//
// Endpoint:
//   GET /api/cogs?dateFrom=&dateTo=  — summed COGS + per-item breakdown
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import prisma, { basePrisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { resolveKitchenRestaurantId } from "../lib/tenantContext";
import { getKolkataDateString } from "../utils/date";
import logger from "../lib/logger";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── GET /api/cogs?dateFrom=&dateTo= ───────────────────────────────────────────
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const today = getKolkataDateString();
    const dateFrom = (req.query.dateFrom as string) || today;
    const dateTo = (req.query.dateTo as string) || today;

    if (dateFrom > dateTo) {
      return res.status(400).json({ error: "dateFrom must be <= dateTo" });
    }

    // COGS entries are scoped to the kitchen restaurant (may differ from outlet
    // if sharedKitchenOutletId is set — same resolution logic as kitchen inventory)
    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    const entries = await basePrisma.dailyCogsEntry.findMany({
      where: {
        restaurantId: kitchenRestaurantId,
        date: { gte: dateFrom, lte: dateTo },
      },
      include: {
        kitchenInventoryItem: {
          select: { id: true, name: true, unit: true },
        },
      },
      orderBy: { date: "asc" },
    });

    // Aggregate total COGS
    const totalCogs = entries.reduce(
      (sum, e) => sum + Number(e.cogsAmount),
      0
    );

    // Per-item breakdown
    const itemMap = new Map<string, {
      kitchenInventoryItemId: string;
      name: string;
      unit: string;
      totalConsumedQty: number;
      totalCogsAmount: number;
    }>();

    for (const e of entries) {
      const existing = itemMap.get(e.kitchenInventoryItemId);
      if (existing) {
        existing.totalConsumedQty += Number(e.consumedQty);
        existing.totalCogsAmount += Number(e.cogsAmount);
      } else {
        itemMap.set(e.kitchenInventoryItemId, {
          kitchenInventoryItemId: e.kitchenInventoryItemId,
          name: e.kitchenInventoryItem?.name || "Unknown",
          unit: e.kitchenInventoryItem?.unit || "",
          totalConsumedQty: Number(e.consumedQty),
          totalCogsAmount: Number(e.cogsAmount),
        });
      }
    }

    const perItemBreakdown = Array.from(itemMap.values())
      .map((v) => ({
        ...v,
        totalConsumedQty: Math.round(v.totalConsumedQty * 100) / 100,
        totalCogsAmount: Math.round(v.totalCogsAmount * 100) / 100,
      }))
      .sort((a, b) => b.totalCogsAmount - a.totalCogsAmount);

    // Per-day breakdown
    const dayMap = new Map<string, number>();
    for (const e of entries) {
      dayMap.set(e.date, (dayMap.get(e.date) || 0) + Number(e.cogsAmount));
    }
    const perDayBreakdown = Array.from(dayMap.entries())
      .map(([date, amount]) => ({ date, cogsAmount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      dateFrom,
      dateTo,
      totalCogs: Math.round(totalCogs * 100) / 100,
      itemCount: perItemBreakdown.length,
      entryCount: entries.length,
      perItemBreakdown,
      perDayBreakdown,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[COGS] GET failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
