// ─────────────────────────────────────────────────────────────────────────────
// Stats Routes — Daily aggregate statistics for dashboard
// ─────────────────────────────────────────────────────────────────────────────
// Provides a lightweight endpoint for the admin dashboard to fetch today's
// revenue and order count without loading full transaction lists.
//
// Endpoints:
//   GET /api/stats/today — returns { revenue, orderCount } for current IST day
//
// Uses Prisma aggregate queries on the Transaction table with a fast txnDate
// string index. Cached for 10 seconds to handle dashboard polling.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import { Decimal } from "@prisma/client/runtime/library";
import prisma from "../lib/prisma";
import { cacheMiddleware } from "../lib/cache";
import { getKolkataDateString } from "../utils/date";
import { authenticate } from "../middleware/auth";
import { completedTxnWhere } from "../lib/transactionHelpers";

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
router.get("/today", authenticate, cacheMiddleware("stats:today", 10_000), async (req: any, res) => {
  try {
    const userRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!userRestaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const restaurantId = userRestaurantId;
    const today = getKolkataDateString();

    // Use the txnDate string index for a fast exact match
    const aggregates = await prisma.transaction.aggregate({
      where: completedTxnWhere(restaurantId, { txnDate: today }),
      _sum: {
        amount: true,
        grandTotal: true,
      },
      _count: {
        id: true,
      },
    });

    const revenue = Number((aggregates._sum.grandTotal as Decimal) ?? (aggregates._sum.amount as Decimal) ?? 0);
    const orderCount = aggregates._count.id;

    res.json({ revenue, orderCount });
  } catch (err) {
    logger.error({ err }, "[stats/today] error:");
    res.status(500).json({ error: "Failed to fetch today stats" });
  }
});

export default router;
