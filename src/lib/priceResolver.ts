// ─────────────────────────────────────────────────────────────────────────────
// Price Resolver — Venue-specific item pricing
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for "what is the price of this item in this venue".
// Uses the PriceProfile system: looks up Venue.priceProfileId → PriceProfileItem.
//
// Resolution order:
//   1. Look up Venue by ID → get priceProfileId → find PriceProfileItem for this item
//   2. Final fallback → item.basePrice
//
// Usage:
//   const price = await resolveItemPrice(menuItemId, venueId, restaurantId);
//   // If called within a transaction, pass the tx client:
//   const price = await resolveItemPrice(menuItemId, venueId, restaurantId, txClient);
// ─────────────────────────────────────────────────────────────────────────────

import prisma from './prisma';

/**
 * Single source of truth for "what is the price of this item in this venue".
 *
 * Resolution order:
 * 1. Look up Venue → priceProfileId → PriceProfileItem for this item
 * 2. Final fallback → item.basePrice
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
      select: {
        basePrice: true,
        variants: { where: { isDefault: true }, select: { price: true }, take: 1 },
      },
    });
    const base = Number(item?.basePrice ?? 0);
    if (base > 0) return base;
    return Number(item?.variants[0]?.price ?? 0);
  }

  // Resolve via PriceProfile — try direct Venue lookup by ID
  let venue = await db.venue.findUnique({
    where: { id: venueId },
    include: {
      priceProfile: {
        include: {
          items: { where: { menuItemId } },
        },
      },
    },
  });

  // Legacy fallback: if venueId is a string tag like "venue-bar-ac-hall",
  // try to find a Venue by matching the tag to venue name
  if (!venue && venueId.startsWith('venue-')) {
    const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const tagSuffix = venueId.replace(/^venue-/, "");
    const normalizedTag = normalizeForMatch(tagSuffix);

    const candidates = await db.venue.findMany({
      where: { restaurantId, isDeleted: false },
      include: {
        priceProfile: {
          include: {
            items: { where: { menuItemId } },
          },
        },
      },
    });

    venue = candidates.find((v: any) => normalizeForMatch(v.name) === normalizedTag)
      || candidates.find((v: any) => {
        const normName = normalizeForMatch(v.name);
        return normName.includes(normalizedTag) || normalizedTag.includes(normName);
      })
      || undefined;
  }

  const profileItem = venue?.priceProfile?.items[0];
  if (profileItem) {
    return Number(profileItem.price);
  }

  // Final fallback: basePrice, then default variant price
  const item = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: {
      basePrice: true,
      variants: { where: { isDefault: true }, select: { price: true }, take: 1 },
    },
  });
  const base = Number(item?.basePrice ?? 0);
  if (base > 0) return base;
  return Number(item?.variants[0]?.price ?? 0);
}

/**
 * Build a map of menuItemId → price for a given venue's PriceProfile.
 * Returns an empty Map if the venue has no priceProfileId or no items.
 */
export async function buildVenuePriceMap(
  venueId: string,
  restaurantId?: string,
  txClient?: any
): Promise<Map<string, number>> {
  const db = txClient ?? prisma;

  // Try direct Venue lookup by ID (new-style UUID)
  let venue = await db.venue.findUnique({
    where: { id: venueId },
    select: { id: true, priceProfileId: true, name: true, restaurantId: true },
  });

  // Legacy fallback: if venueId is a string tag like "venue-bar-ac-hall",
  // try to find a Venue by matching the tag to venue name
  if (!venue && restaurantId && venueId.startsWith('venue-')) {
    const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const tagSuffix = venueId.replace(/^venue-/, "");
    const normalizedTag = normalizeForMatch(tagSuffix);

    const candidates = await db.venue.findMany({
      where: { restaurantId, isDeleted: false },
      select: { id: true, name: true, priceProfileId: true },
    });

    // Try exact normalized match, then partial
    venue = candidates.find((v: any) => normalizeForMatch(v.name) === normalizedTag)
      || candidates.find((v: any) => {
        const normName = normalizeForMatch(v.name);
        return normName.includes(normalizedTag) || normalizedTag.includes(normName);
      })
      || undefined;
  }

  if (!venue?.priceProfileId) {
    return new Map();
  }

  const items = await db.priceProfileItem.findMany({
    where: { priceProfileId: venue.priceProfileId },
    select: { menuItemId: true, price: true },
  });

  return new Map(items.map((i: any) => [i.menuItemId, Number(i.price)]));
}

/**
 * Build a map of menuItemId → price for ALL venues in a restaurant.
 * Returns a map keyed by venueId, each containing a map of menuItemId → price.
 */
export async function buildAllVenuePriceMaps(
  restaurantId: string,
  txClient?: any
): Promise<Map<string, Map<string, number>>> {
  const db = txClient ?? prisma;

  const venues = await db.venue.findMany({
    where: { restaurantId, isDeleted: false, priceProfileId: { not: null } },
    select: { id: true, priceProfileId: true },
  });

  if (venues.length === 0) return new Map();

  const profileIds = [...new Set(venues.map((v: any) => v.priceProfileId!).filter(Boolean))];
  const allItems = await db.priceProfileItem.findMany({
    where: { priceProfileId: { in: profileIds } },
    select: { priceProfileId: true, menuItemId: true, price: true },
  });

  const profileItemMap = new Map<string, Map<string, number>>();
  for (const item of allItems) {
    if (!profileItemMap.has(item.priceProfileId)) {
      profileItemMap.set(item.priceProfileId, new Map());
    }
    profileItemMap.get(item.priceProfileId)!.set(item.menuItemId, Number(item.price));
  }

  const result = new Map<string, Map<string, number>>();
  for (const venue of venues) {
    if (venue.priceProfileId) {
      result.set(venue.id, profileItemMap.get(venue.priceProfileId) ?? new Map());
    }
  }
  return result;
}
