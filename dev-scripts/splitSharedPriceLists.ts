/// <reference types="node" />
/**
 * Finds venues that share one price list and gives each its own copy, so an
 * item price saved for one venue can no longer change (or be undone by) another.
 * Prices stay exactly as they are today — only the lists are separated.
 *
 * Usage:
 *   npx tsx dev-scripts/splitSharedPriceLists.ts            (report only, changes nothing)
 *   npx tsx dev-scripts/splitSharedPriceLists.ts --apply    (split the lists)
 */
import { PrismaClient } from '@prisma/client';
import { giveVenueOwnPriceList } from '../src/lib/priceResolver';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

(async () => {
  const venues = await prisma.venue.findMany({
    where: { isDeleted: false, priceProfileId: { not: null } },
    select: { id: true, name: true, restaurantId: true, priceProfileId: true },
    orderBy: [{ restaurantId: 'asc' }, { name: 'asc' }],
  });

  const byList = new Map<string, typeof venues>();
  for (const v of venues) {
    const group = byList.get(v.priceProfileId!) ?? [];
    group.push(v);
    byList.set(v.priceProfileId!, group);
  }
  const shared = [...byList.entries()].filter(([, group]) => group.length > 1);

  if (shared.length === 0) {
    console.log('No venues share a price list. Nothing to do.');
    return;
  }

  for (const [listId, group] of shared) {
    const count = await prisma.priceProfileItem.count({ where: { priceProfileId: listId } });
    console.log(`\nPrice list ${listId} (${count} items) is shared by ${group.length} venues of outlet ${group[0].restaurantId}:`);
    for (const v of group) console.log(`  - ${v.name} (${v.id})`);

    if (!apply) continue;
    // The first venue keeps the original list; every other venue gets a copy.
    for (const v of group.slice(1)) {
      const newId = await giveVenueOwnPriceList(prisma, v, v.restaurantId);
      console.log(`  → ${v.name} now has its own list ${newId}`);
    }
  }

  if (!apply) console.log('\nReport only. Run again with --apply to split these lists.');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
