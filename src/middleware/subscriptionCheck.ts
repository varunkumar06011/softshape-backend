// ─────────────────────────────────────────────────────────────────────────────
// Subscription Check Middleware — SaaS billing enforcement
// ─────────────────────────────────────────────────────────────────────────────
// Checks the organization's billing status on every authenticated request.
// If the subscription is expired or suspended, requests are blocked with 403.
//
// Grace period: Essential GET endpoints (menu, orders, tables, sections, bar)
// are allowed for 24 hours after suspension, so restaurants can still view
// their data during a billing dispute or payment delay. Non-essential endpoints
// (mutations, analytics, reports, etc.) are blocked immediately.
//
// The billing status is always checked from the DB (never trusts stale JWT)
// to ensure suspended accounts are blocked immediately.
//
// Must be used AFTER authenticate (requires req.user).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextFunction, type Request, type Response } from "express";
import prisma from "../lib/prisma";

// Essential GET paths allowed during the 24h grace period after suspension.
// These are read-only endpoints that let restaurants view their data while
// resolving billing issues.
const ESSENTIAL_GET_PATHS = ["/api/menu", "/api/orders", "/api/tables", "/api/sections", "/api/bar"];
// Grace period: 24 hours after suspension, essential GETs are still allowed
const SUSPENSION_GRACE_MS = 24 * 60 * 60 * 1000;

// Middleware that checks the organization's subscription status.
// Returns 403 if the subscription is expired/suspended (outside grace period).
// Returns 401 if not authenticated. Returns 500 on DB error.
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
