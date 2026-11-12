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
  let venue = await db.venue.findFirst({
    where: { id: venueId, restaurantId, isDeleted: false },
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
  let venue = await db.venue.findFirst({
    where: { id: venueId, restaurantId, isDeleted: false },
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

// ─── Per-venue price lists ──────────────────────────────────────────────────
// Each venue should have its own price list (PriceProfile). Some venues ended
// up sharing one, and a save that sends every venue's price then lets the last
// venue written overwrite the one just edited — the new price never shows.
// These helpers make sure a price is written to a list that belongs to that
// venue alone, copying the shared list first so no other venue's price moves.

type PriceListVenue = { id: string; name?: string | null; priceProfileId?: string | null };

/** The venue's own price list: created when missing, copied off a shared one. */
export async function giveVenueOwnPriceList(
  db: any,
  venue: PriceListVenue,
  restaurantId: string,
): Promise<string> {
  const name = venue.name || venue.id;

  if (!venue.priceProfileId) {
    const created = await db.priceProfile.create({ data: { restaurantId, name } });
    await db.venue.update({ where: { id: venue.id }, data: { priceProfileId: created.id } });
    return created.id;
  }

  const sharedWith = await db.venue.count({
    where: { priceProfileId: venue.priceProfileId, isDeleted: false, id: { not: venue.id } },
  });
  if (sharedWith === 0) return venue.priceProfileId;

  const copy = await db.priceProfile.create({ data: { restaurantId, name } });
  const items = await db.priceProfileItem.findMany({
    where: { priceProfileId: venue.priceProfileId },
    select: { menuItemId: true, price: true, restaurantId: true },
  });
  if (items.length > 0) {
    await db.priceProfileItem.createMany({
      data: items.map((i: any) => ({
        priceProfileId: copy.id,
        menuItemId: i.menuItemId,
        price: i.price,
        restaurantId: i.restaurantId ?? restaurantId,
      })),
      skipDuplicates: true,
    });
  }
  await db.venue.update({ where: { id: venue.id }, data: { priceProfileId: copy.id } });
  return copy.id;
}

/**
 * THE way to change one item's price in one venue from the cloud. Every admin
 * screen must call this (never write PriceProfileItem/VenuePrice directly):
 *   - writes the venue's OWN price list (split off a shared one if needed),
 *   - writes VenuePrice, the per-venue copy billing PCs download and bill from.
 * Writing only the price list left the billing PC showing and billing its old
 * per-venue copy, so admin price edits never reached the restaurant.
 * A price of 0 is stored as 0 — it means "not sold in this venue" (screens
 * hide the item). To clear a venue's price entirely use removeVenueItemPrice.
 */
export async function setVenueItemPrice(
  db: any,
  restaurantId: string,
  venue: PriceListVenue,
  menuItemId: string,
  price: number,
): Promise<void> {
  const clean = Number(price);
  if (!Number.isFinite(clean) || clean < 0) return;
  const priceProfileId = await priceListForWrite(db, venue, restaurantId, menuItemId, clean);
  await db.priceProfileItem.upsert({
    where: { priceProfileId_menuItemId: { priceProfileId, menuItemId } },
    create: { priceProfileId, menuItemId, price: clean, restaurantId },
    update: { price: clean },
  });
  await mirrorVenuePrice(db, restaurantId, venue.id, menuItemId, clean, true);
}


/** Remove a venue's price for an item (from its own list and the PC copy). */
export async function removeVenueItemPrice(
  db: any,
  restaurantId: string,
  venue: PriceListVenue,
  menuItemId: string,
): Promise<void> {
  if (venue.priceProfileId) {
    const sharedWith = await db.venue.count({
      where: { priceProfileId: venue.priceProfileId, isDeleted: false, id: { not: venue.id } },
    });
    const ownList = sharedWith === 0
      ? venue.priceProfileId
      : await giveVenueOwnPriceList(db, venue, restaurantId);
    await db.priceProfileItem.deleteMany({ where: { priceProfileId: ownList, menuItemId } });
  }
  // isActive=false travels to the PC, which then drops the price there too.
  await mirrorVenuePrice(db, restaurantId, venue.id, menuItemId, 0, false);
}

/**
 * Keep VenuePrice (downloaded by billing PCs) equal to what the cloud now
 * charges. Its updatedAt change is what makes the PC download it.
 */
export async function mirrorVenuePrice(
  db: any,
  restaurantId: string,
  venueId: string,
  menuItemId: string,
  price: number,
  isActive: boolean,
): Promise<void> {
  await db.venuePrice.upsert({
    where: { venueId_menuItemId: { venueId, menuItemId } },
    create: { id: `vp-${venueId}-${menuItemId}`, venueId, menuItemId, restaurantId, price, isActive },
    update: { price, isActive },
  });
}

/**
 * After a whole price list was edited (price-profile editor), mirror its new
 * prices — and removals — to every venue that uses it.
 */
export async function mirrorPriceListToVenues(
  db: any,
  restaurantId: string,
  priceProfileId: string,
  items: Array<{ menuItemId: string; price: number }>,
  removedMenuItemIds: string[],
): Promise<void> {
  const venues = await db.venue.findMany({
    where: { priceProfileId, isDeleted: false },
    select: { id: true },
  });
  for (const v of venues) {
    for (const it of items) {
      const p = Number(it.price);
      if (!Number.isFinite(p) || p < 0) continue;
      await mirrorVenuePrice(db, restaurantId, v.id, it.menuItemId, p, true);
    }
    for (const menuItemId of removedMenuItemIds) {
      await mirrorVenuePrice(db, restaurantId, v.id, menuItemId, 0, false);
    }
  }
}

/**
 * The price list to write one item's new price into. A venue on a shared list
 * only gets its own copy when the price really changes, so re-sending an
 * unchanged price (the edit form sends every venue's) never splits anything.
 */
export async function priceListForWrite(
  db: any,
  venue: PriceListVenue,
  restaurantId: string,
  menuItemId: string,
  newPrice: number,
): Promise<string> {
  if (venue.priceProfileId) {
    const current = await db.priceProfileItem.findUnique({
      where: { priceProfileId_menuItemId: { priceProfileId: venue.priceProfileId, menuItemId } },
      select: { price: true },
    });
    if (current && Number(current.price) === Number(newPrice)) return venue.priceProfileId;
  }
  return giveVenueOwnPriceList(db, venue, restaurantId);
}
