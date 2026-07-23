// ─────────────────────────────────────────────────────────────────────────────
// Manager Tab Guard Middleware — Server-side enforcement of manager tab visibility
// ─────────────────────────────────────────────────────────────────────────────
// The frontend hides tabs from managers based on enabledModules.managerTabs.
// However, the backend never enforced this — a manager with a valid JWT could
// call any API endpoint directly (e.g. /api/reports, /api/payroll) even if
// those tabs were toggled off in the admin settings.
//
// This middleware maps request path prefixes to tab keys and blocks MANAGER-role
// users from accessing endpoints for tabs that are not explicitly enabled in
// managerTabs. OWNER and ADMIN roles are never restricted.
//
// Must be used AFTER authenticate (requires req.user).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextFunction, type Request, type Response } from "express";
import prisma from "../lib/prisma";
import { cacheGet, cacheSet, cacheDelete } from "../lib/cache";

// Map of route path prefixes → admin tab keys (matching frontend adminRoutes.jsx)
// Only sensitive routes that should be gated for managers are included.
// Routes not listed here are allowed for managers (e.g. orders, tables, print —
// these are operational routes managers may need).
const PATH_TO_TAB: Array<{ prefix: string; tab: string }> = [
  // Finance group
  { prefix: "/api/reports", tab: "reports" },
  { prefix: "/api/balance-sheet", tab: "balanceSheet" },
  { prefix: "/api/expenditures", tab: "vouchers" },
  { prefix: "/api/vouchers", tab: "vouchers" },
  { prefix: "/api/opening-balance", tab: "opening-balance" },
  { prefix: "/api/purchase-orders", tab: "purchases" },
  { prefix: "/api/cogs", tab: "cogs" },
  { prefix: "/api/fixed-assets", tab: "assets-liabilities" },
  { prefix: "/api/liabilities", tab: "assets-liabilities" },
  { prefix: "/api/equity", tab: "assets-liabilities" },
  { prefix: "/api/audit-log", tab: "audit-trail" },
  // HR group
  { prefix: "/api/payroll", tab: "payroll" },
  { prefix: "/api/attendance", tab: "attendance" },
  // Analytics
  { prefix: "/api/analytics", tab: "reports" },
  // Captain analytics
  { prefix: "/api/captain-targets", tab: "captains" },
  { prefix: "/api/captain-assignments", tab: "captains" },
];

// Cache TTL for managerTabs lookup (60 seconds — same as billing status)
const MANAGER_TABS_CACHE_TTL = 60;

const tabsCacheKey = (restaurantId: string) => `managerTabs:${restaurantId}`;

async function getManagerTabs(restaurantId: string): Promise<Record<string, boolean> | null> {
  const cached = await cacheGet<Record<string, boolean>>(tabsCacheKey(restaurantId));
  if (cached !== null) return cached;

  const outlet = await prisma.outlet.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true },
  });

  const enabledModules = (outlet?.enabledModules as Record<string, any>) || {};
  const managerTabs = (enabledModules.managerTabs as Record<string, boolean>) || null;

  await cacheSet(tabsCacheKey(restaurantId), managerTabs || {}, MANAGER_TABS_CACHE_TTL);
  return managerTabs;
}

/**
 * Middleware that blocks MANAGER-role users from accessing endpoints for tabs
 * that are not explicitly enabled in enabledModules.managerTabs.
 *
 * OWNER and ADMIN roles are never restricted.
 * Must be used AFTER authenticate (requires req.user).
 */
export async function managerTabGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const role = (user.role || "").toUpperCase();

  // Only restrict MANAGER role — OWNER and ADMIN have full access
  if (role !== "MANAGER") {
    next();
    return;
  }

  // Determine which tab this path maps to
  const path = (req.originalUrl || req.url || "").split("?")[0];
  const match = PATH_TO_TAB.find((entry) => path.startsWith(entry.prefix));

  // If the path isn't in our guard list, allow it (operational routes like
  // orders, tables, menu, print are not gated for managers)
  if (!match) {
    next();
    return;
  }

  const restaurantId = user.activeRestaurantId || user.restaurantId;
  if (!restaurantId) {
    res.status(403).json({ error: "Tenant context required" });
    return;
  }

  const managerTabs = await getManagerTabs(restaurantId);

  // If managerTabs is not configured at all, block all gated tabs
  // (matches frontend behavior: isManagerTabEnabled returns false when undefined)
  if (!managerTabs || typeof managerTabs !== "object") {
    res.status(403).json({ error: "This section is not enabled for manager access" });
    return;
  }

  if (managerTabs[match.tab] !== true) {
    res.status(403).json({ error: "This section is not enabled for manager access" });
    return;
  }

  next();
}

/**
 * Invalidate the cached managerTabs for a restaurant.
 * Call this when the admin updates enabledModules.managerTabs in restaurant settings.
 */
export async function invalidateManagerTabsCache(restaurantId: string): Promise<void> {
  await cacheDelete(tabsCacheKey(restaurantId));
}
