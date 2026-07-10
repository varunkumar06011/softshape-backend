// ─────────────────────────────────────────────────────────────────────────────
// Tenant Context Middleware — Sets up AsyncLocalStorage for auto-scoped Prisma queries
// ─────────────────────────────────────────────────────────────────────────────
// Wraps each request in a tenantStorage AsyncLocalStorage context so that the
// Prisma extension (lib/prisma.ts) can automatically inject restaurantId into
// all queries on tenant-scoped models.
//
// The restaurantId is taken from req.user.activeRestaurantId (for multi-outlet
// users who switched outlets) or req.user.restaurantId (for single-outlet users).
//
// Must be used AFTER authenticate (requires req.user).
// If req.user is not set (unauthenticated request), the middleware passes through
// without setting up a tenant context — queries will not be auto-scoped.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from "express";
import { tenantStorage } from "../lib/prisma";

// Wraps the request in a tenantStorage context with the user's restaurantId.
// This enables automatic tenant scoping in the Prisma extension.
// Using a wrapper function ensures AsyncLocalStorage propagates through the
// entire async chain of the request, not just the synchronous next() call.
export function withTenantContext(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user?.restaurantId) {
    return next();
  }
  const restaurantId = user.activeRestaurantId ?? user.restaurantId;
  tenantStorage.run({ restaurantId }, () => next());
}
