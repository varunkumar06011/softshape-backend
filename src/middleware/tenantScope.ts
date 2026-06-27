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
  // Batch all resource IDs into a single query per model to avoid N+1 round-trips
  const resourcesByModel: Record<string, { paramName: string; id: string }[]> = {};
  const checkedIds = new Set<string>();
  for (const [paramName, modelName] of Object.entries(NESTED_RESOURCE_MAP)) {
    const resourceId = req.params?.[paramName] || req.body?.[paramName];
    if (!resourceId || checkedIds.has(resourceId)) continue;
    checkedIds.add(resourceId);
    if (!resourcesByModel[modelName]) resourcesByModel[modelName] = [];
    resourcesByModel[modelName].push({ paramName, id: resourceId });
  }

  for (const [modelName, resources] of Object.entries(resourcesByModel)) {
    try {
      // @ts-expect-error — dynamic model access
      const records: { id: string; restaurantId: string }[] = await basePrisma[modelName].findMany({
        where: { id: { in: resources.map(r => r.id) } },
        select: { id: true, restaurantId: true },
      });

      const recordMap = new Map(records.map(r => [r.id, r]));
      for (const { paramName, id } of resources) {
        const record = recordMap.get(id);
        if (!record) {
          res.status(404).json({ error: `${modelName} not found` });
          return;
        }
        if (!tenantCtx.allIds.includes(record.restaurantId)) {
          res.status(403).json({ error: 'Cross-tenant resource access denied' });
          return;
        }
      }
    } catch (err) {
      logger.warn({ err }, `[TenantScope] Nested resource check skipped for ${modelName}`);
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
