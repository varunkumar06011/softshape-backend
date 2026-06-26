import { type NextFunction, type Request, type Response } from "express";
import prisma from "../lib/prisma";

export async function assertSubscriptionActive(req: any, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Allow GET only for essential captain-shift data (menus, orders, tables).
  // Block reports, analytics, and other GET endpoints for suspended tenants.
  if (req.method === "GET") {
    const path = req.path || "";
    const allowedGetPaths = ["/api/menu", "/api/orders", "/api/tables", "/api/sections", "/api/bar"];
    const isEssentialGet = allowedGetPaths.some((p) => path.startsWith(p));
    if (isEssentialGet) {
      next();
      return;
    }
  }

  // Writes: always verify from DB — never trust the stale JWT billingStatus
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.user.restaurantId },
      select: { billingStatus: true }
    });

    if (restaurant?.billingStatus === "expired" || restaurant?.billingStatus === "suspended") {
      res.status(403).json({ error: "Subscription expired. Please renew to continue." });
      return;
    }

    next();
  } catch (err) {
    res.status(500).json({ error: "Failed to check subscription status" });
  }
}
