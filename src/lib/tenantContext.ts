// ─────────────────────────────────────────────────────────────────────────────
// Tenant Context — Per-request restaurant context with Redis caching
// ─────────────────────────────────────────────────────────────────────────────
// Resolves and caches the tenant context for a given restaurantId.
// The tenant context includes:
//   - restaurantId: the active outlet ID
//   - allIds: all outlet IDs in the same organization (for multi-outlet queries)
//   - gstin: GST identification number (inherited from the root/first outlet)
//   - restaurantType: DINE_IN, BAR_LOUNGE, BAR_WITH_DINING, CAFE, CLOUD_KITCHEN
//   - gstCategory: GST tax category
//   - gstRate: GST percentage rate
//   - gstRegistered: whether the restaurant is GST-registered
//   - pricesIncludeGst: whether prices are tax-inclusive
//
// GST settings are inherited from the "root" (first-created) outlet in the
// organization, so all outlets share the same GST configuration.
//
// The context is cached in Redis for 30 seconds to avoid repeated DB queries
// on every request. Call invalidateTenantContextCache() after updating restaurant
// settings to ensure fresh data on the next request.
//
// Usage:
//   const ctx = await resolveTenantContext(restaurantId);
//   if (isBarOutlet(restaurantId, ctx)) { /* bar-specific logic */ }
// ─────────────────────────────────────────────────────────────────────────────

import { basePrisma } from "./prisma";
import { cacheGet, cacheSet, cacheClear } from "./cache";
import logger from "./logger";

// Cache TTL for tenant context (30 seconds) — balances freshness with DB load
const TENANT_CTX_TTL = 30; // seconds

// Tenant context structure — contains all restaurant-level config needed by route handlers
export interface TenantContext {
  restaurantId: string;           // The active outlet ID
  allIds: string[];               // All outlet IDs in the same organization
  barId?: string;                 // Reserved for bar outlet linking (currently unused)
  gstin?: string;                 // GST identification number
  restaurantType?: string;        // Restaurant type (DINE_IN, BAR_LOUNGE, etc.)
  gstCategory?: string;           // GST tax category
  gstRate?: number | null;        // GST percentage rate
  gstRegistered?: boolean;        // Whether the restaurant is GST-registered
  pricesIncludeGst?: boolean;     // Whether menu prices include GST
}

// Invalidates the cached tenant context for a restaurant.
// Call this after updating restaurant settings (GST, type, etc.) to ensure
// the next request gets fresh data.
export async function invalidateTenantContextCache(restaurantId: string): Promise<void> {
  await cacheClear(`tenantctx:${restaurantId}`);
}

// Resolves the tenant context for a restaurant, with Redis caching.
// Queries the outlet and all sibling outlets in the same organization.
// GST settings are inherited from the root (first-created) outlet.
// Returns a minimal context on error to avoid crashing the request.
export async function resolveTenantContext(restaurantId: string): Promise<TenantContext> {
  const cacheKey = `tenantctx:${restaurantId}`;
  const cached = await cacheGet<TenantContext>(cacheKey);
  if (cached) return cached;

  try {
    // Query 1: Get the restaurant + its organizationId
    const restaurant = await basePrisma.outlet.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        organizationId: true,
        gstin: true,
        restaurantType: true,
        gstCategory: true,
        pricesIncludeGst: true,
      },
    });

    if (!restaurant) {
      return {
        restaurantId,
        allIds: [restaurantId],
        barId: undefined,
        gstin: undefined,
        restaurantType: undefined,
        gstCategory: undefined,
        gstRate: null,
        gstRegistered: true,
        pricesIncludeGst: false,
      };
    }

    // Query 2: Get all outlets in the same organization
    const outlets = await basePrisma.outlet.findMany({
      where: { organizationId: restaurant.organizationId },
      select: { id: true, gstCategory: true, gstRate: true, gstRegistered: true, pricesIncludeGst: true, gstin: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // The primary (first-created) outlet is the "root" for GST inheritance
    const root = outlets[0];

    const ctx: TenantContext = {
      restaurantId,
      allIds: outlets.map(o => o.id),
      barId: undefined,
      gstin: root?.gstin ?? restaurant.gstin ?? undefined,
      restaurantType: restaurant.restaurantType ?? undefined,
      gstCategory: root?.gstCategory ?? restaurant.gstCategory ?? undefined,
      gstRate: root?.gstRate ?? null,
      gstRegistered: root?.gstRegistered ?? true,
      pricesIncludeGst: root?.pricesIncludeGst ?? restaurant.pricesIncludeGst ?? false,
    };

    await cacheSet(cacheKey, ctx, TENANT_CTX_TTL);
    return ctx;
  } catch (err) {
    logger.warn({ err, restaurantId }, "[TenantContext] Failed to resolve, returning minimal context");
    return {
      restaurantId,
      allIds: [restaurantId],
      barId: undefined,
      gstin: undefined,
      restaurantType: undefined,
      gstCategory: undefined,
      gstRate: null,
      gstRegistered: true,
      pricesIncludeGst: false,
    };
  }
}

// Returns true if the outlet is a bar-type restaurant (BAR_LOUNGE or BAR_WITH_DINING).
// Uses the restaurantType from the tenant context.
export function isBarOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "BAR_LOUNGE" || ctx?.restaurantType === "BAR_WITH_DINING";
}

// Returns true if the outlet is a cafe-type restaurant.
// Currently maps CAFE type to venue status.
export function isVenueOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "CAFE";
}
