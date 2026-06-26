import { basePrisma } from "./prisma";

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

export async function resolveTenantContext(restaurantId: string): Promise<TenantContext> {
  // Find the restaurant and, if it is a child outlet, walk up to the root parent
  const restaurant = await basePrisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, parentRestaurantId: true, gstin: true, restaurantType: true, gstCategory: true, pricesIncludeGst: true }
  });

  const rootId = restaurant?.parentRestaurantId ?? restaurantId;

  // Get the root plus every direct outlet under it
  const outlets = await basePrisma.restaurant.findMany({
    where: {
      OR: [{ id: rootId }, { parentRestaurantId: rootId }]
    },
    select: { id: true }
  });

  // Fetch GST settings from the ROOT restaurant (not child outlet) so that
  // changes made at the root level propagate to all outlets. Fixes BUG 4.
  const root = await basePrisma.restaurant.findUnique({
    where: { id: rootId },
    select: {
      gstCategory: true,
      gstRate: true,
      gstRegistered: true,
      pricesIncludeGst: true,
      gstin: true,
    }
  });

  return {
    restaurantId,
    allIds: outlets.map(o => o.id),
    barId: undefined,
    gstin: root?.gstin ?? restaurant?.gstin ?? undefined,
    restaurantType: restaurant?.restaurantType ?? undefined,
    gstCategory: root?.gstCategory ?? restaurant?.gstCategory ?? undefined,
    gstRate: root?.gstRate ?? null,
    gstRegistered: root?.gstRegistered ?? true,
    pricesIncludeGst: root?.pricesIncludeGst ?? restaurant?.pricesIncludeGst ?? false,
  };
}

export function isBarOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "BAR_LOUNGE" || ctx?.restaurantType === "BAR_WITH_DINING";
}

export function isVenueOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "CAFE";
}
