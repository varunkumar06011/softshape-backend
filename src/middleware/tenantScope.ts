import { type NextFunction, type Response } from 'express';
import { type AuthRequest } from './auth';

/**
 * Verifies that the restaurantId in the request body/query matches
 * the authenticated user's restaurantId from the JWT.
 *
 * Attach AFTER `authenticate` on any mutating route.
 * Does NOT apply to super-admin routes.
 */
export function assertTenantScope(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const bodyId = req.body?.restaurantId;
  const queryId = req.query?.restaurantId as string | undefined;
  const paramId = req.params?.restaurantId;
  const requestedId = bodyId || queryId || paramId;

  // If a restaurantId is explicitly provided in the request, it must match the token
  if (requestedId && requestedId !== req.user.restaurantId) {
    res.status(403).json({ error: 'Cross-tenant access denied' });
    return;
  }

  // Inject restaurantId from token into body for downstream use
  if (req.body && !req.body.restaurantId) {
    req.body.restaurantId = req.user.restaurantId;
  }

  next();
}
