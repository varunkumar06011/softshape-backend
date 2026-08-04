// Temporary fix for Prisma db push failing on foreign keys to Outlet.
//
// Some child tables (e.g., Section) reference restaurantIds that no longer exist in Outlet.
// Instead of cascading deletes, this script creates placeholder Outlet rows for the missing IDs
// so the FK constraints can be created without losing data.
//
// The placeholder outlets are marked inactive and given a recognizable name so they can be
// cleaned up manually later if desired.
//
// Usage (from softshape-backend directory):
//   npx ts-node dev-scripts/createDummyOutletsForOrphans.ts        -- dry run
//   npx ts-node dev-scripts/createDummyOutletsForOrphans.ts --apply -- create outlets

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  // Find every distinct restaurantId referenced by Section that does not exist in Outlet.
  const missing = await prisma.$queryRaw<{ restaurantId: string }[]>`
    SELECT DISTINCT s."restaurantId"
    FROM "Section" s
    WHERE NOT EXISTS (SELECT 1 FROM "Outlet" o WHERE o.id = s."restaurantId")
  `;

  if (missing.length === 0) {
    console.log('No missing Outlet IDs found in Section. Nothing to do.');
    return;
  }

  console.log(`Found ${missing.length} missing Outlet ID(s) referenced by Section:`);
  for (const m of missing) {
    console.log(`  ${m.restaurantId}`);
  }

  // Pick an existing organization to own the placeholder outlets.
  const firstOrg = await prisma.organization.findFirst({ select: { id: true } });
  if (!firstOrg) {
    console.error('No Organization exists. Cannot create placeholder outlets.');
    process.exit(1);
  }

  console.log(`Will use organization ${firstOrg.id} for placeholder outlets.`);

  if (!APPLY) {
    console.log();
    console.log('Dry run. Add --apply to create the outlets.');
    return;
  }

  const created: string[] = [];
  for (const { restaurantId } of missing) {
    try {
      await prisma.outlet.create({
        data: {
          id: restaurantId,
          name: `Recovered Outlet (${restaurantId.slice(-8)})`,
          slug: `recovered-${restaurantId}`,
          restaurantCode: `RECOVERED-${restaurantId}`,
          organizationId: firstOrg.id,
          isActive: false,
        },
      });
      created.push(restaurantId);
    } catch (err: any) {
      // If the outlet already exists (race/idempotency), ignore.
      if (err.code === 'P2002') {
        console.log(`  Outlet ${restaurantId} already exists, skipping.`);
      } else {
        throw err;
      }
    }
  }

  console.log(`Created ${created.length} placeholder outlet(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
