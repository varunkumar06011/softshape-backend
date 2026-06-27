import { basePrisma } from "./prisma";
import { cacheGet, cacheSet, cacheClear } from "./cache";
import logger from "./logger";

const TENANT_CTX_TTL = 30; // seconds

export interface TenantContext {
  restaurantId: string;
  allIds: string[];
  barId?: string;
  gstin?: string;
  restaurantType?: string;
  gstCategory?: string;
  gstRate?: number | null;
  gstRegistered?: boolean;
  pricesIncludeGst?: boolean;
}

export async function invalidateTenantContextCache(restaurantId: string): Promise<void> {
  await cacheClear(`tenantctx:${restaurantId}`);
}

export async function resolveTenantContext(restaurantId: string): Promise<TenantContext> {
  const cacheKey = `tenantctx:${restaurantId}`;
  const cached = await cacheGet<TenantContext>(cacheKey);
  if (cached) return cached;

  try {
    // Query 1: Get the restaurant + its parent's GST settings in a single query
    const restaurant = await basePrisma.outlet.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        parentRestaurantId: true,
        gstin: true,
        restaurantType: true,
        gstCategory: true,
        pricesIncludeGst: true,
        parent: {
          select: {
            id: true,
            gstCategory: true,
            gstRate: true,
            gstRegistered: true,
            pricesIncludeGst: true,
            gstin: true,
          },
        },
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

    const rootId = restaurant.parentRestaurantId ?? restaurantId;
    const root = restaurant.parent;

    // Query 2: Get the root plus every direct outlet under it
    const outlets = await basePrisma.outlet.findMany({
      where: {
        OR: [{ id: rootId }, { parentRestaurantId: rootId }]
      },
      select: { id: true }
    });

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

export function isBarOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "BAR_LOUNGE" || ctx?.restaurantType === "BAR_WITH_DINING";
}

export function isVenueOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "CAFE";
}
