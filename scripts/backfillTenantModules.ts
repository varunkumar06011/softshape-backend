import { PrismaClient } from '@prisma/client';
import { computeEnabledModules } from '../src/lib/moduleDefaults';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

const LEGACY_VENUE_SECTION_IDS = [
  'section-family-restaurant', 'section-parcel', 'section-conference',
  'section-pdr', 'section-rooms', 'section-venue-gobox',
];

async function main() {
  const restaurants = await prisma.restaurant.findMany({
    select: { id: true, slug: true, restaurantCode: true, enabledModules: true },
  });

  let migrated = 0, skipped = 0, leakDetected = 0;

  for (const r of restaurants) {
    if (r.enabledModules) { skipped++; continue; }

    const isLegacyDefaultTenant = r.restaurantCode === 'RESTAURANT-001'
      || ['restaurant-001', 'bar-001', 'venue-001'].includes(r.slug);

    const leakedSections = await prisma.section.findMany({
      where: { restaurantId: r.id, id: { in: LEGACY_VENUE_SECTION_IDS } },
      select: { id: true },
    });
    const hasLeakedVenueData = !isLegacyDefaultTenant && leakedSections.length > 0;
    if (hasLeakedVenueData) leakDetected++;

    const sectionNames = (await prisma.section.findMany({ where: { restaurantId: r.id }, select: { name: true } })).map(s => s.name);
    const enabledModules = computeEnabledModules({
      restaurantType: isLegacyDefaultTenant || hasLeakedVenueData ? 'BAR_AND_RESTAURANT' : 'FAMILY_RESTAURANT',
      sectionNames,
      hasLiquorItems: isLegacyDefaultTenant || hasLeakedVenueData,
    });

    console.log(`${DRY_RUN ? '[DRY-RUN]' : '[APPLY]'} ${r.slug} (${r.restaurantCode}) -> bar=${enabledModules.bar} venue=${enabledModules.venue}${hasLeakedVenueData ? '  ⚠ pre-existing leaked venue data detected — preserving visibility, not deleting data' : ''}`);

    if (!DRY_RUN) {
      await prisma.restaurant.update({
        where: { id: r.id },
        data: { enabledModules, paymentStatus: 'LEGACY_EXEMPT' },
      });
      migrated++;
    }
  }

  console.log(`\nDone. migrated=${migrated} skipped(already migrated)=${skipped} leakedTenantsFound=${leakDetected} dryRun=${DRY_RUN}`);
}

main().finally(() => prisma.$disconnect());
