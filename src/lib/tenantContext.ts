import { basePrisma } from "./prisma";

export interface TenantContext {
  restaurantId: string;
  allIds: string[];
  barId?: string;
  gstin?: string;
  restaurantType?: string;
}

export async function resolveTenantContext(restaurantId: string): Promise<TenantContext> {
  // Find the restaurant and, if it is a child outlet, walk up to the root parent
  const restaurant = await basePrisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, parentRestaurantId: true, gstin: true, restaurantType: true }
  });

  const rootId = restaurant?.parentRestaurantId ?? restaurantId;

  // Get the root plus every direct outlet under it
  const outlets = await basePrisma.restaurant.findMany({
    where: {
      OR: [{ id: rootId }, { parentRestaurantId: rootId }]
    },
    select: { id: true }
  });

  return {
    restaurantId,
    allIds: outlets.map(o => o.id),
    barId: undefined,
    gstin: restaurant?.gstin ?? undefined,
    restaurantType: restaurant?.restaurantType ?? undefined
  };
}

export function isBarOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "BAR_LOUNGE" || ctx?.restaurantType === "BAR_WITH_DINING";
}

export function isVenueOutlet(_id: string, ctx?: TenantContext): boolean {
  return ctx?.restaurantType === "CAFE";
}
