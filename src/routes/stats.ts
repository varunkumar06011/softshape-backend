import { Router } from "express";
import { Decimal } from "@prisma/client/runtime/library";
import prisma from "../lib/prisma";
import { cacheMiddleware } from "../lib/cache";
import { getKolkataDateString } from "../utils/date";

const router = Router();

/**
 * GET /api/stats/today?restaurantId=...
 *
 * Returns lean daily aggregates for the current IST calendar day:
 *   { revenue: number, orderCount: number }
 *
 * This replaces the admin dashboard's loadStats() pattern of fetching
 * 500 full transactions per outlet every 60 seconds.
 */
router.get("/today", cacheMiddleware("stats:today", 10_000), async (req, res) => {
  try {
    const restaurantId = (req.query.restaurantId as string) || "restaurant-001";
    const today = getKolkataDateString();

    // Use the txnDate string index for a fast exact match
    const aggregates = await prisma.transaction.aggregate({
      where: {
        restaurantId,
        txnDate: today,
      },
      _sum: {
        amount: true,
      },
      _count: {
        id: true,
      },
    });

    const revenue = Number((aggregates._sum.amount as Decimal) ?? 0);
    const orderCount = aggregates._count.id;

    res.json({ revenue, orderCount });
  } catch (err) {
    console.error("[stats/today] error:", err);
    res.status(500).json({ error: "Failed to fetch today stats" });
  }
});

export default router;
