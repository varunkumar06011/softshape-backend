/**
 * Phase 8: Legacy Tenant Migration Script
 * 
 * Run once per environment to migrate existing restaurants to the new Venue/Floor/Section model.
 * 
 * What it does:
 * - For each legacy restaurant (venuesMigrated = false), derive Venues from existing sections.
 * - Creates a default TaxProfile and PriceProfile.
 * - Groups sections by legacy sectionTag into Venues, or creates a single "Main" venue.
 * - Seeds VenuePrice entries for backward compatibility.
 * - Sets venuesMigrated = true when done.
 * 
 * Usage:
 *   npx ts-node scripts/backfillVenues.ts
 * 
 * Guard: skips restaurants where venuesMigrated = true (idempotent).
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.DIRECT_URL || process.env.DATABASE_URL || '') +
        ((process.env.DIRECT_URL || process.env.DATABASE_URL)?.includes('?') ? '&' : '?') +
        'connection_limit=5&pool_timeout=30',
    },
  },
});

function getSectionTagLegacy(sectionName: string): string {
  const lower = sectionName.toLowerCase();
  if (lower.includes('bar') || lower.includes('pub') || lower.includes('lounge')) return 'venue-bar';
  if (lower.includes('dining') || lower.includes('hall') || lower.includes('family')) return 'venue-dining';
  if (lower.includes('conference') || lower.includes('meeting')) return 'venue-conference';
  if (lower.includes('pdr') || lower.includes('private')) return 'venue-pdr';
  if (lower.includes('room')) return 'venue-room';
  if (lower.includes('banquet')) return 'venue-banquet';
  return 'venue-dining';
}

async function main() {
  const restaurants = await prisma.restaurant.findMany({
    where: { venuesMigrated: false },
  });

  console.log(`[Backfill] Found ${restaurants.length} legacy restaurants to migrate.`);

  for (const restaurant of restaurants) {
    const rid = restaurant.id;
    console.log(`[Backfill] Migrating restaurant: ${restaurant.name} (${rid})`);

    // Fetch sections and menu items separately
    const sections = await prisma.section.findMany({
      where: { restaurantId: rid },
      include: { tables: true },
    });
    const menuItems = await prisma.menuItem.findMany({
      where: { restaurantId: rid },
    });

    // 1. Create default TaxProfile
    const taxProfile = await prisma.taxProfile.create({
      data: {
        restaurantId: rid,
        name: 'Default',
        gstCategory: restaurant.gstCategory ?? 'NON_AC',
        gstRate: restaurant.gstRate,
        gstRegistered: restaurant.gstRegistered ?? true,
        serviceChargePercent: restaurant.serviceChargePercent ?? 0,
        isDefault: true,
      },
    });

    // 2. Create default PriceProfile
    const priceProfile = await prisma.priceProfile.create({
      data: { restaurantId: rid, name: 'Default', isDefault: true },
    });

    // 3. Derive venues from sections
    const sectionGroups = new Map<string, typeof sections>();
    for (const section of sections) {
      const tag = (section as any)?.sectionTag || getSectionTagLegacy(section.name);
      const venueType = tag.replace('venue-', '').toUpperCase() as any;
      if (!sectionGroups.has(venueType)) sectionGroups.set(venueType, []);
      sectionGroups.get(venueType)!.push(section);
    }

    const venueMap = new Map<string, string>();
    for (const [venueType, venueSections] of sectionGroups) {
      const venueName = venueType === 'DINING' ? 'Main Dining' :
        venueType === 'BAR' ? 'Bar' :
        venueType === 'CONFERENCE' ? 'Conference Hall' :
        venueType === 'PDR' ? 'Private Dining' :
        venueType === 'ROOM' ? 'Room Service' :
        venueType === 'BANQUET' ? 'Banquet Hall' : 'Main Venue';

      const venue = await prisma.venue.create({
        data: {
          restaurantId: rid,
          name: venueName,
          venueType: venueType as any,
          priceProfileId: priceProfile.id,
          taxProfileId: taxProfile.id,
        },
      });
      venueMap.set(venueType, venue.id);

      // Create default floor for each venue
      const floor = await prisma.floor.create({
        data: { venueId: venue.id, restaurantId: rid, name: 'Ground Floor' },
      });

      // Link sections to venue/floor
      for (const section of venueSections) {
        await prisma.section.update({
          where: { id: section.id },
          data: { venueId: venue.id, floorId: floor.id },
        });
      }
    }

    // 4. Seed PriceProfileItem + VenuePrice for all menu items
    for (const menuItem of menuItems) {
      await prisma.priceProfileItem.create({
        data: {
          priceProfileId: priceProfile.id,
          menuItemId: menuItem.id,
          price: menuItem.basePrice,
          restaurantId: rid,
        },
      });
      for (const [, venueId] of venueMap) {
        await prisma.venuePrice.create({
          data: {
            venueId,
            menuItemId: menuItem.id,
            price: menuItem.basePrice,
            isActive: true,
            restaurantId: rid,
          },
        });
      }
    }

    // 5. Mark as migrated
    await prisma.restaurant.update({
      where: { id: rid },
      data: { venuesMigrated: true },
    });

    console.log(`[Backfill] Done: ${restaurant.name} — created ${venueMap.size} venue(s)`);
  }

  console.log('[Backfill] Migration complete.');
}

main()
  .catch((e) => {
    console.error('[Backfill] Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
