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

// Cache TTL for tenant context (30 seconds) — balances freshness with DB load.
// The versioned cache key ensures that invalidation is immediate even before TTL expires.
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
  serviceChargePercent?: number;  // Service charge percentage (0 = none)
  name?: string;                  // Outlet name (for KOT headers)
  receiptHeader?: string;         // Receipt header text (for KOT headers)
  sharedKitchenOutletId?: string; // When set, kitchen inventory is scoped to this outlet
}

// ── Versioned cache for tenant context ────────────────────────────────────────
// Each outlet has a version counter in Redis. The cache key includes the version,
// so when invalidateTenantContextCache bumps the version, the old cache entry
// becomes unreachable and the next read fetches fresh data from the DB.
// This eliminates the race where a settings update and a bill print happen
// within the same TTL window.

async function getTenantVersion(restaurantId: string): Promise<number> {
  const v = await cacheGet<number>(`tenantctx:version:${restaurantId}`);
  return v ?? 0;
}

async function bumpTenantVersion(restaurantId: string): Promise<void> {
  // Use cacheSet to store the incremented version. Redis INCR would be ideal
  // but our cache abstraction doesn't expose it — set with explicit value.
  const current = await getTenantVersion(restaurantId);
  await cacheSet(`tenantctx:version:${restaurantId}`, current + 1, 3600); // version lives 1h
}

// Invalidates the cached tenant context for a restaurant.
// Call this after updating restaurant settings (GST, type, etc.) to ensure
// the next request gets fresh data.
export async function invalidateTenantContextCache(restaurantId: string): Promise<void> {
  await bumpTenantVersion(restaurantId);
  await cacheClear(`tenantctx:${restaurantId}`);
}

// Resolves the tenant context for a restaurant, with versioned Redis caching.
// Queries the outlet and all sibling outlets in the same organization.
// GST settings are inherited from the root (first-created) outlet.
// Returns a minimal context on error to avoid crashing the request.
export async function resolveTenantContext(restaurantId: string): Promise<TenantContext> {
  const version = await getTenantVersion(restaurantId);
  const cacheKey = `tenantctx:${restaurantId}:v${version}`;
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
        serviceChargePercent: true,
        name: true,
        receiptHeader: true,
        sharedKitchenOutletId: true,
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
        serviceChargePercent: 0,
        sharedKitchenOutletId: undefined,
      };
    }

    // Query 2: Get all outlets in the same organization
    const outlets = await basePrisma.outlet.findMany({
      where: { organizationId: restaurant.organizationId },
      select: { id: true, gstCategory: true, gstRate: true, gstRegistered: true, pricesIncludeGst: true, serviceChargePercent: true, gstin: true, createdAt: true },
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
      serviceChargePercent: root?.serviceChargePercent ?? restaurant.serviceChargePercent ?? 0,
      name: restaurant.name ?? undefined,
      receiptHeader: restaurant.receiptHeader ?? undefined,
      sharedKitchenOutletId: restaurant.sharedKitchenOutletId ?? undefined,
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
      serviceChargePercent: 0,
      sharedKitchenOutletId: undefined,
    };
  }
}

// Resolves the effective kitchen restaurantId for a given outlet.
// If the outlet has sharedKitchenOutletId set, returns that (the kitchen owner).
// Otherwise returns the outlet's own ID (kitchen is self-scoped).
export async function resolveKitchenRestaurantId(restaurantId: string): Promise<string> {
  const ctx = await resolveTenantContext(restaurantId);
  return ctx.sharedKitchenOutletId ?? restaurantId;
}

// Validates that an outlet can safely share a kitchen with the target outlet.
// Enforces: no self-reference, same org only, no chains (target can't itself have sharedKitchenOutletId).
export async function validateSharedKitchenOutlet(
  outletId: string,
  targetKitchenOutletId: string
): Promise<{ valid: boolean; error?: string }> {
  if (outletId === targetKitchenOutletId) {
    return { valid: false, error: "Cannot share kitchen with self" };
  }
  const [outlet, target] = await Promise.all([
    basePrisma.outlet.findUnique({ where: { id: outletId }, select: { organizationId: true } }),
    basePrisma.outlet.findUnique({ where: { id: targetKitchenOutletId }, select: { organizationId: true, sharedKitchenOutletId: true } }),
  ]);
  if (!target) return { valid: false, error: "Target outlet not found" };
  if (target.organizationId !== outlet?.organizationId) {
    return { valid: false, error: "Target outlet must be in the same organization" };
  }
  if (target.sharedKitchenOutletId) {
    return { valid: false, error: "Target outlet already shares a kitchen — cannot chain" };
  }
  return { valid: true };
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
