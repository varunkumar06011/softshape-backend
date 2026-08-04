// @ts-nocheck

/**
 * One-time fix: update venueType for venues whose name contains "family" and
 * were backfilled with a generic type (DINING / DINE_IN / unknown) to the
 * canonical FAMILY_RESTAURANT type so balance-sheet venue mapping works.
 *
 * Run: npx ts-node scripts/fixFamilyVenueTypes.ts
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

async function main() {
  const { count } = await prisma.venue.updateMany({
    where: {
      name: { contains: 'family', mode: 'insensitive' },
      venueType: { notIn: ['FAMILY_RESTAURANT', 'FAMILY_WING', 'FAMILY'] },
    },
    data: { venueType: 'FAMILY_RESTAURANT' },
  });

  console.log(`[fixFamilyVenueTypes] Updated ${count} family venue(s) to FAMILY_RESTAURANT`);
}

main()
  .catch((e) => {
    console.error('[fixFamilyVenueTypes] Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
