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
    const path = (req.originalUrl || "").split("?")[0];
    const allowedGetPaths = ["/api/menu", "/api/orders", "/api/tables", "/api/sections", "/api/bar"];
    const isEssentialGet = allowedGetPaths.some((p) => path.startsWith(p));
    if (isEssentialGet) {
      next();
      return;
    }
  }

  // Writes: always verify from DB — never trust the stale JWT billingStatus
  const effectiveRestaurantId = req.user.activeRestaurantId || req.user.restaurantId;
  try {
    const outlet = await prisma.outlet.findUnique({
      where: { id: effectiveRestaurantId },
      select: { organizationId: true }
    });
    if (!outlet?.organizationId) {
      res.status(403).json({ error: "Subscription expired. Please renew to continue." });
      return;
    }
    const org = await prisma.organization.findUnique({
      where: { id: outlet.organizationId },
      select: { billingStatus: true }
    });

    if (org?.billingStatus === "expired" || org?.billingStatus === "suspended") {
      res.status(403).json({ error: "Subscription expired. Please renew to continue." });
      return;
    }

    next();
  } catch (err) {
    res.status(500).json({ error: "Failed to check subscription status" });
  }
}
