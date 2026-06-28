/**
 * One-off cleanup script: Remove phantom "Counter" sections and Table #999
 * created by the old auto-provisioning side-effect in GET /api/bar/tables.
 *
 * Criteria:
 *   - Section named "Counter" with venueId: null
 *   - Table numbered 999 under that section
 *   - Table has NO order history (zero orders ever)
 *
 * Usage:
 *   npx tsx dev-scripts/cleanupCounterTables.ts
 *
 * Dry-run by default. Pass --execute to actually delete.
 */

import prisma from '../src/lib/prisma';

async function main() {
  const execute = process.argv.includes('--execute');

  console.log(execute
    ? '⚠️  EXECUTE MODE — deletions will be applied'
    : '🔍 DRY RUN — no changes will be made. Pass --execute to apply.'

  );

  // Find all Counter sections with venueId: null
  const counterSections = await prisma.section.findMany({
    where: {
      name: 'Counter',
      venueId: null,
    },
    include: {
      tables: {
        where: { number: 999 },
        include: {
          _count: { select: { orders: true } },
        },
      },
    },
  });

  if (counterSections.length === 0) {
    console.log('No phantom "Counter" sections with venueId: null found.');
    return;
  }

  let sectionsToDelete: string[] = [];
  let tablesToDelete: string[] = [];
  let skippedWithOrders = 0;

  for (const section of counterSections) {
    const table999 = section.tables[0];

    if (!table999) {
      // Section exists but no table 999 — safe to delete the section
      console.log(`  [section] ${section.id} (restaurant: ${section.restaurantId}) — no table #999, marking for deletion`);
      sectionsToDelete.push(section.id);
      continue;
    }

    if (table999._count.orders > 0) {
      console.log(`  [SKIP] table ${table999.id} (#999, restaurant: ${section.restaurantId}) has ${table999._count.orders} orders — preserving`);
      skippedWithOrders++;
      continue;
    }

    console.log(`  [table]  ${table999.id} (#999, restaurant: ${section.restaurantId}) — 0 orders, marking for deletion`);
    tablesToDelete.push(table999.id);
    sectionsToDelete.push(section.id);
  }

  console.log('\n--- Summary ---');
  console.log(`Counter sections found:   ${counterSections.length}`);
  console.log(`Tables to delete:         ${tablesToDelete.length}`);
  console.log(`Sections to delete:       ${sectionsToDelete.length}`);
  console.log(`Skipped (has order hist): ${skippedWithOrders}`);

  if (!execute) {
    console.log('\nDry run complete. Re-run with --execute to apply deletions.');
    return;
  }

  if (tablesToDelete.length > 0) {
    await prisma.table.deleteMany({ where: { id: { in: tablesToDelete } } });
    console.log(`\n✅ Deleted ${tablesToDelete.length} table(s).`);
  }

  if (sectionsToDelete.length > 0) {
    await prisma.section.deleteMany({ where: { id: { in: sectionsToDelete } } });
    console.log(`✅ Deleted ${sectionsToDelete.length} section(s).`);
  }

  console.log('Cleanup complete.');
}

main()
  .catch((err) => {
    console.error('Cleanup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
