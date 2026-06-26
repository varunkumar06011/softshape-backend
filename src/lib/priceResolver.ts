import prisma from './prisma';

/**
 * Single source of truth for "what is the price of this item in this venue".
 *
 * Resolution order:
 * 1. If venueId is a real Venue UUID → look up PriceProfileItem via venue.priceProfileId
 * 2. Else (legacy string like "venue-bar-conference") → look up VenuePrice
 * 3. Final fallback → item.basePrice
 */
export async function resolveItemPrice(
  menuItemId: string,
  venueId: string | null | undefined,
  restaurantId: string,
  txClient?: any
): Promise<number> {
  const db = txClient ?? prisma;

  if (!venueId) {
    const item = await db.menuItem.findUnique({
      where: { id: menuItemId },
      select: { basePrice: true },
    });
    return Number(item?.basePrice ?? 0);
  }

  const isLegacyVenueId = venueId.startsWith('venue-');

  if (!isLegacyVenueId) {
    // New path: resolve via PriceProfile
    const venue = await db.venue.findUnique({
      where: { id: venueId },
      include: {
        priceProfile: {
          include: {
            items: { where: { menuItemId } },
          },
        },
      },
    });
    const profileItem = venue?.priceProfile?.items[0];
    if (profileItem) {
      return Number(profileItem.price);
    }
  }

  // Legacy fallback: VenuePrice (venueId is a raw string tag)
  const venuePrice = await db.venuePrice.findFirst({
    where: { venueId, menuItemId, isActive: true },
  });
  if (venuePrice) {
    return Number(venuePrice.price);
  }

  // Final fallback: basePrice
  const item = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: { basePrice: true },
  });
  return Number(item?.basePrice ?? 0);
}
