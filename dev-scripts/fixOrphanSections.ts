// Temporary fix for Prisma db push failing on Section -> Outlet foreign key.
//
// `db push` is trying to create the FK constraint "Section_restaurantId_fkey",
// but existing Section rows reference restaurantIds that no longer exist in Outlet.
//
// Usage (from softshape-backend directory):
//   npx ts-node dev-scripts/fixOrphanSections.ts        -- dry run
//   npx ts-node dev-scripts/fixOrphanSections.ts --apply -- delete orphans

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  const orphans = await prisma.$queryRaw<{ id: string; restaurantId: string; name: string | null }[]>`
    SELECT s.id, s."restaurantId", s.name
    FROM "Section" s
    WHERE NOT EXISTS (SELECT 1 FROM "Outlet" o WHERE o.id = s."restaurantId")
  `;

  console.log(`Found ${orphans.length} orphan Section rows (restaurantId not in Outlet).`);
  if (orphans.length > 0) {
    console.log('First 10 orphan rows:');
    for (const o of orphans.slice(0, 10)) {
      console.log(`  id=${o.id} restaurantId=${o.restaurantId} name=${o.name ?? ''}`);
    }
  }

  if (!APPLY) {
    console.log();
    console.log('Dry run. Add --apply to delete these rows.');
    return;
  }

  if (orphans.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  const result = await prisma.$executeRaw`
    DELETE FROM "Section" s
    WHERE NOT EXISTS (SELECT 1 FROM "Outlet" o WHERE o.id = s."restaurantId")
  `;

  console.log(`Deleted ${result} orphan Section rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
