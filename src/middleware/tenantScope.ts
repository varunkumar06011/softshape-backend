import { type NextFunction, type Response } from 'express';
import { resolveTenantContext } from '../lib/tenantContext';

/**
 * Verifies that the restaurantId in the request body/query/params belongs to the
 * authenticated user's tenant (including parent/child outlets).
 *
 * Attach AFTER `authenticate` on any route that accepts a restaurantId.
 * Does NOT apply to super-admin or intentionally public routes.
 */
export async function assertTenantScope(req: any, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const bodyId = req.body?.restaurantId;
  const queryId = req.query?.restaurantId as string | undefined;
  const paramId = req.params?.restaurantId;
  const requestedId = bodyId || queryId || paramId;

  // If a restaurantId is explicitly provided, it must belong to the user's tenant
  if (requestedId) {
    try {
      const ctx = await resolveTenantContext(req.user.restaurantId);
      if (!ctx.allIds.includes(requestedId)) {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
    } catch (err) {
      console.error('[TenantScope] Failed to resolve tenant context:', err);
      res.status(403).json({ error: 'Tenant validation failed' });
      return;
    }
  }

  // Inject restaurantId from token into body for downstream use
  if (req.body && !req.body.restaurantId) {
    req.body.restaurantId = req.user.restaurantId;
  }

  next();
}
