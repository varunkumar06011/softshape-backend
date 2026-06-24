import prisma from './prisma';

export interface TenantContext {
  mainId: string;
  barId: string;
  venueId: string;
  allIds: string[];
  isDefaultTenant: boolean;
  restaurantCode: string;
  gstin: string | null;
}

const contextCache = new Map<string, { ctx: TenantContext; expiry: number }>();
const CACHE_TTL = 60_000;

export async function resolveTenantContext(restaurantId: string): Promise<TenantContext> {
  const cached = contextCache.get(restaurantId);
  if (cached && Date.now() < cached.expiry) return cached.ctx;

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, restaurantCode: true, gstin: true, parentRestaurantId: true, outletCount: true }
  });

  if (!restaurant) {
    throw new Error(`Restaurant not found: ${restaurantId}`);
  }

  const isDefaultTenant = restaurant.restaurantCode === 'RESTAURANT-001';

  let allIds: string[];
  let barId: string;
  let venueId: string;

  if (isDefaultTenant) {
    // Legacy default tenant: resolve via hardcoded bar-001/venue-001
    const outlets = await prisma.restaurant.findMany({
      where: {
        OR: [
          { id: 'restaurant-001' },
          { id: 'bar-001' },
          { id: 'venue-001' },
          { slug: 'restaurant-001' },
          { slug: 'bar-001' },
          { slug: 'venue-001' },
        ]
      },
      select: { id: true, slug: true }
    });

    const barRow = outlets.find(o => o.slug === 'bar-001' || o.id === 'bar-001');
    const venueRow = outlets.find(o => o.slug === 'venue-001' || o.id === 'venue-001');
    const mainRow = outlets.find(o => o.slug === 'restaurant-001' || o.id === 'restaurant-001');

    barId = barRow?.id ?? 'bar-001';
    venueId = venueRow?.id ?? 'venue-001';
    const mainOutletId = mainRow?.id ?? restaurantId;

    allIds = [...new Set([mainOutletId, barId, venueId, restaurantId])];
  } else if (restaurant.parentRestaurantId) {
    // This is a child outlet — resolve siblings via parent
    const parent = await prisma.restaurant.findUnique({
      where: { id: restaurant.parentRestaurantId },
      select: { id: true, restaurantCode: true, gstin: true }
    });
    if (parent) {
      const siblings = await prisma.restaurant.findMany({
        where: { parentRestaurantId: parent.id },
        select: { id: true }
      });
      allIds = [...new Set([parent.id, ...siblings.map(s => s.id)])];
    } else {
      allIds = [restaurantId];
    }
    barId = restaurantId;
    venueId = restaurantId;
  } else if (restaurant.outletCount > 1) {
    // This is a parent with child outlets — resolve via parentRestaurantId relation
    const childOutlets = await prisma.restaurant.findMany({
      where: { parentRestaurantId: restaurantId },
      select: { id: true }
    });
    allIds = [...new Set([restaurantId, ...childOutlets.map(o => o.id)])];
    barId = restaurantId;
    venueId = restaurantId;
  } else {
    // Single outlet restaurant
    barId = restaurantId;
    venueId = restaurantId;
    allIds = [restaurantId];
  }

  const ctx: TenantContext = {
    mainId: restaurantId,
    barId,
    venueId,
    allIds,
    isDefaultTenant,
    restaurantCode: restaurant.restaurantCode,
    gstin: restaurant.gstin ?? null,
  };

  contextCache.set(restaurantId, { ctx, expiry: Date.now() + CACHE_TTL });
  return ctx;
}

export function invalidateTenantContext(restaurantId: string): void {
  contextCache.delete(restaurantId);
}

export function isBarOutlet(restaurantId: string, ctx: TenantContext): boolean {
  return restaurantId === ctx.barId;
}

export function isVenueOutlet(restaurantId: string, ctx: TenantContext): boolean {
  return restaurantId === ctx.venueId;
}
