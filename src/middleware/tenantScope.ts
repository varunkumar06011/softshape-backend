import { type NextFunction, type Response } from 'express';
import logger from "../lib/logger";
import { resolveTenantContext } from '../lib/tenantContext';
import { basePrisma } from '../lib/prisma';

/**
 * Map of nested resource param names to their Prisma model names.
 * Used to verify that a nested resource ID belongs to the authenticated tenant.
 */
const NESTED_RESOURCE_MAP: Record<string, string> = {
  tableId: 'Table',
  orderId: 'Order',
  menuItemId: 'MenuItem',
  sectionId: 'Section',
  categoryId: 'Category',
  transactionId: 'Transaction',
  venueId: 'Venue',
  floorId: 'Floor',
  priceProfileId: 'PriceProfile',
  taxProfileId: 'TaxProfile',
};

/**
 * Verifies that the restaurantId in the request body/query/params belongs to the
 * authenticated user's tenant (including parent/child outlets).
 *
 * Also validates nested resource IDs (e.g. tableId, orderId) to ensure they
 * belong to the same tenant, preventing cross-tenant ID enumeration.
 *
 * Attach AFTER `authenticate` on any route that accepts a restaurantId.
 * Does NOT apply to super-admin or intentionally public routes.
 */
export async function assertTenantScope(req: any, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const effectiveRestaurantId = req.user.activeRestaurantId || req.user.restaurantId;

  const bodyId = req.body?.restaurantId;
  const queryId = req.query?.restaurantId as string | undefined;
  const paramId = req.params?.restaurantId;
  const requestedId = bodyId || queryId || paramId;

  // Resolve tenant context once for both restaurantId and nested resource checks
  let tenantCtx: Awaited<ReturnType<typeof resolveTenantContext>>;
  try {
    tenantCtx = await resolveTenantContext(effectiveRestaurantId);
  } catch (err) {
    logger.error({ err }, '[TenantScope] Failed to resolve tenant context');
    res.status(403).json({ error: 'Tenant validation failed' });
    return;
  }

  // If a restaurantId is explicitly provided, it must belong to the user's tenant
  if (requestedId && !tenantCtx.allIds.includes(requestedId)) {
    res.status(403).json({ error: 'Cross-tenant access denied' });
    return;
  }

  // Validate nested resource IDs from params — ensure they belong to the same tenant
  const checkedIds = new Set<string>();
  for (const [paramName, modelName] of Object.entries(NESTED_RESOURCE_MAP)) {
    const resourceId = req.params?.[paramName] || req.body?.[paramName];
    if (!resourceId || checkedIds.has(resourceId)) continue;
    checkedIds.add(resourceId);

    try {
      // @ts-expect-error — dynamic model access
      const record = await basePrisma[modelName].findUnique({
        where: { id: resourceId },
        select: { restaurantId: true },
      });
      if (!record) {
        res.status(404).json({ error: `${modelName} not found` });
        return;
      }
      if (!tenantCtx.allIds.includes(record.restaurantId)) {
        res.status(403).json({ error: 'Cross-tenant resource access denied' });
        return;
      }
    } catch (err) {
      // If the model doesn't have restaurantId or query fails, skip silently
      // (defense-in-depth — the Prisma extension still scopes by ALS context)
      logger.warn({ err }, `[TenantScope] Nested resource check skipped for ${modelName}:${resourceId}`);
    }
  }

  // Inject restaurantId from token into body/query for downstream use
  if (req.body && !req.body.restaurantId) {
    req.body.restaurantId = effectiveRestaurantId;
  }
  if (req.query && !req.query.restaurantId) {
    req.query.restaurantId = effectiveRestaurantId;
  }

  next();
}
