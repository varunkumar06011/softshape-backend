import { type NextFunction, type Request, type Response } from "express";
import prisma from "../lib/prisma";

// Essential GET paths allowed during a grace period after suspension
const ESSENTIAL_GET_PATHS = ["/api/menu", "/api/orders", "/api/tables", "/api/sections", "/api/bar"];
// Grace period: essential GETs allowed for 24h after suspension
const SUSPENSION_GRACE_MS = 24 * 60 * 60 * 1000;

export async function assertSubscriptionActive(req: any, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const effectiveRestaurantId = req.user.activeRestaurantId || req.user.restaurantId;

  // Always check DB for current billing status (never trust stale JWT)
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
      select: { billingStatus: true, updatedAt: true }
    });

    const isSuspended = org?.billingStatus === "expired" || org?.billingStatus === "suspended";

    if (isSuspended) {
      // For essential GETs, allow a 24h grace period after suspension
      if (req.method === "GET") {
        const path = (req.originalUrl || "").split("?")[0];
        const isEssentialGet = ESSENTIAL_GET_PATHS.some((p) => path.startsWith(p));
        if (isEssentialGet) {
          const suspendedAt = org?.updatedAt ? new Date(org.updatedAt).getTime() : 0;
          const elapsed = Date.now() - suspendedAt;
          if (elapsed < SUSPENSION_GRACE_MS) {
            next();
            return;
          }
        }
      }

      res.status(403).json({ error: "Subscription expired. Please renew to continue." });
      return;
    }

    next();
  } catch (err) {
    res.status(500).json({ error: "Failed to check subscription status" });
  }
}
