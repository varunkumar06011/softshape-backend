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

function getVenueType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('lounge') || lower.includes('bar') || lower.includes('pub')) return 'BAR_LOUNGE';
  if (lower.includes('family') || lower.includes('dining') || lower.includes('restaurant')) return 'RESTAURANT';
  return 'DINE_IN';
}

function getSectionTagLegacy(sectionName: string, sectionId?: string): string {
  if (sectionId === 'section-parcel') return 'venue-restaurant-parcel';
  if (sectionId === 'section-bar-parcel' || sectionId === 'section-venue-gobox') return 'venue-bar-gobox';
  if (sectionId === 'section-family-restaurant') return 'venue-family-restaurant';
  if (sectionId === 'section-conference') return 'venue-bar-conference';
  if (sectionId === 'section-pdr') return 'venue-bar-pdr';
  if (sectionId === 'section-rooms') return 'venue-bar-rooms';
  const n = sectionName.trim().toLowerCase();
  if (n.includes('bar ac') || n === 'bar hall' || n === 'main hall') return 'venue-bar-ac-hall';
  if (n.includes('conference')) return 'venue-bar-conference';
  if (n.includes('pdr')) return 'venue-bar-pdr';
  if (n.includes('rooms') || n.includes('room')) return 'venue-bar-rooms';
  if (n.includes('parcel') && n.includes('restaurant')) return 'venue-restaurant-parcel';
  if (n.includes('gobox') || n.includes('go box') || (n.includes('bar') && n.includes('parcel'))) return 'venue-bar-gobox';
  if (n.includes('family restaurant')) return 'venue-family-restaurant';
  return 'venue-unknown';
}

async function ensureTaxAndPriceProfiles(outletId: string) {
  let taxProfile = await prisma.taxProfile.findFirst({ where: { restaurantId: outletId, isDefault: true } });
  if (!taxProfile) {
    const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
    taxProfile = await prisma.taxProfile.create({
      data: {
        restaurantId: outletId,
        name: 'Default',
        gstCategory: outlet?.gstCategory ?? 'NON_AC',
        gstRate: outlet?.gstRate ?? null,
        gstRegistered: outlet?.gstRegistered ?? true,
        serviceChargePercent: outlet?.serviceChargePercent ?? 0,
        isDefault: true,
      },
    });
  }
  let priceProfile = await prisma.priceProfile.findFirst({ where: { restaurantId: outletId, isDefault: true } });
  if (!priceProfile) {
    priceProfile = await prisma.priceProfile.create({
      data: { restaurantId: outletId, name: 'Default', isDefault: true },
    });
  }
  return { taxProfile, priceProfile };
}

async function ensureVenueFloorSectionTables(outlet: any, tableCount = 10) {
  const { taxProfile, priceProfile } = await ensureTaxAndPriceProfiles(outlet.id);

  let venue = await prisma.venue.findFirst({ where: { restaurantId: outlet.id } });
  let floor: any;

  if (!venue) {
    const venueType = getVenueType(outlet.name);
    const venueName = outlet.name.replace(/vgrand/i, '').trim() || 'Main';
    venue = await prisma.venue.create({
      data: {
        restaurantId: outlet.id,
        name: venueName,
        venueType,
        priceProfileId: priceProfile.id,
        taxProfileId: taxProfile.id,
        kotEnabled: true,
      },
    });
    console.log(`[vgrand] Created venue '${venue.name}' (${venue.venueType}) for outlet ${outlet.name}`);
  }

  floor = await prisma.floor.findFirst({ where: { restaurantId: outlet.id } });
  if (!floor) {
    floor = await prisma.floor.create({
      data: { venueId: venue.id, restaurantId: outlet.id, name: 'Ground Floor' },
    });
  }

  let section = await prisma.section.findFirst({ where: { restaurantId: outlet.id } });
  if (!section) {
    section = await prisma.section.create({
      data: {
        restaurantId: outlet.id,
        venueId: venue.id,
        floorId: floor.id,
        name: 'Main Section',
      },
    });
  } else if (!section.venueId || !section.floorId) {
    section = await prisma.section.update({
      where: { id: section.id },
      data: { venueId: venue.id, floorId: floor.id },
    });
  }

  const existingTables = await prisma.table.count({ where: { restaurantId: outlet.id } });
  if (existingTables === 0) {
    const numTables = Math.max(1, Math.min(100, tableCount));
    for (let i = 1; i <= numTables; i++) {
      await prisma.table.create({
        data: {
          number: i,
          capacity: 4,
          status: 'AVAILABLE',
          sectionId: section.id,
          restaurantId: outlet.id,
          workflowStatus: 'Free',
          sectionTag: getSectionTagLegacy(section.name, section.id),
        },
      });
    }
    console.log(`[vgrand] Created ${numTables} tables for outlet ${outlet.name}`);
  }

  const tables = await prisma.table.findMany({
    where: { restaurantId: outlet.id },
    include: { section: true },
  });
  let updated = 0;
  for (const table of tables) {
    const tag = getSectionTagLegacy(table.section?.name || '', table.section?.id);
    if (tag !== 'venue-unknown' && (table as any).sectionTag !== tag) {
      await prisma.table.update({ where: { id: table.id }, data: { sectionTag: tag } as any });
      updated++;
    }
  }
  if (updated > 0) console.log(`[vgrand] Updated sectionTag on ${updated} tables for outlet ${outlet.name}`);

  await prisma.outlet.update({ where: { id: outlet.id }, data: { venuesMigrated: true } });
}

async function main() {
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const TABLE_COUNT = Number(process.env.TABLE_COUNT) || 10;

  const outlets = await prisma.outlet.findMany({
    where: {
      OR: [
        { name: { contains: 'vgrand', mode: 'insensitive' } },
        { slug: { contains: 'vgrand', mode: 'insensitive' } },
        { restaurantCode: { contains: 'vgrand', mode: 'insensitive' } },
      ],
    },
  });

  if (outlets.length === 0) {
    console.log(`[vgrand] No outlets found matching 'vgrand'. Existing outlets:`);
    const all = await prisma.outlet.findMany({ select: { id: true, name: true, restaurantCode: true, venuesMigrated: true } });
    all.forEach(o => console.log(`  - ${o.name} (${o.restaurantCode}) migrated=${o.venuesMigrated}`));
    process.exit(1);
  }

  console.log(`[vgrand] Found ${outlets.length} matching outlet(s):`);
  for (const outlet of outlets) {
    const sectionCount = await prisma.section.count({ where: { restaurantId: outlet.id } });
    const tableCount = await prisma.table.count({ where: { restaurantId: outlet.id } });
    const venueCount = await prisma.venue.count({ where: { restaurantId: outlet.id } });
    console.log(`  - ${outlet.name} (${outlet.restaurantCode}) — venues=${venueCount}, sections=${sectionCount}, tables=${tableCount}, migrated=${outlet.venuesMigrated}`);
  }

  if (DRY_RUN) {
    console.log('[vgrand] DRY_RUN=true — no changes made');
    process.exit(0);
  }

  for (const outlet of outlets) {
    await ensureVenueFloorSectionTables(outlet, TABLE_COUNT);
  }

  console.log('[vgrand] Done.');
}

main()
  .catch(e => { console.error('[vgrand] Error:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
