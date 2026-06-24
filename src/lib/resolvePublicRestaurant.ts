import prisma from "./prisma";

export interface ResolvedPublicRestaurant {
  restaurantId: string;
  restaurant: { id: string; name: string; slug: string; isActive: boolean };
}

/**
 * Resolve a public (customer-facing) menu request to a verified, active restaurant.
 *
 * When BOTH slug and tableId are provided, they are CROSS-VALIDATED:
 *   - tableId must belong to a Table whose restaurantId matches the Restaurant with the given slug
 *   - the Restaurant must be active
 * This prevents URL tampering (e.g. mixing Restaurant A's slug with Restaurant B's tableId).
 *
 * When only slug is provided, resolves by slug alone.
 * When only tableId is provided, resolves by table alone.
 * Returns null if no active restaurant is found or cross-validation fails — caller should 404.
 */
export async function resolvePublicRestaurant(
  tableId?: string,
  slug?: string
): Promise<ResolvedPublicRestaurant | null> {
  const tId = tableId && typeof tableId === "string" ? tableId.trim() : undefined;
  const s = slug && typeof slug === "string" ? slug.trim() : undefined;

  // Both provided: cross-validate
  if (tId && s) {
    const [table, restaurantBySlug] = await Promise.all([
      prisma.table.findUnique({ where: { id: tId }, select: { restaurantId: true } }),
      prisma.restaurant.findUnique({ where: { slug: s } }),
    ]);

    if (!table || !restaurantBySlug || !restaurantBySlug.isActive) {
      return null;
    }

    // Cross-validation: table must belong to the restaurant with the given slug
    if (table.restaurantId !== restaurantBySlug.id) {
      return null;
    }

    return { restaurantId: restaurantBySlug.id, restaurant: restaurantBySlug };
  }

  // Only tableId
  if (tId) {
    const table = await prisma.table.findUnique({
      where: { id: tId },
      select: { restaurantId: true },
    });
    if (table?.restaurantId) {
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: table.restaurantId },
      });
      if (restaurant?.isActive) {
        return { restaurantId: restaurant.id, restaurant };
      }
    }
  }

  // Only slug
  if (s) {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: s },
    });
    if (restaurant?.isActive) {
      return { restaurantId: restaurant.id, restaurant };
    }
  }

  return null;
}
