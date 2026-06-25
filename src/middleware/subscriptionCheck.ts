import { type NextFunction, type Request, type Response } from "express";
import prisma from "../lib/prisma";

export async function assertSubscriptionActive(req: any, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // GET requests are always allowed so captains can view menus/orders mid-shift
  if (req.method === "GET") {
    next();
    return;
  }

  // Fast path: read billingStatus from JWT payload (avoids DB lookup)
  const jwtStatus = req.user.billingStatus;
  if (jwtStatus) {
    if (jwtStatus === "expired") {
      res.status(403).json({ error: "Subscription expired. Please renew to continue." });
      return;
    }
    next();
    return;
  }

  // Fallback: DB lookup for legacy tokens without billingStatus
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.user.restaurantId },
      select: { billingStatus: true }
    });

    if (restaurant?.billingStatus === "expired") {
      res.status(403).json({ error: "Subscription expired. Please renew to continue." });
      return;
    }

    next();
  } catch (err) {
    res.status(500).json({ error: "Failed to check subscription status" });
  }
}
