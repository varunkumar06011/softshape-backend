// ─────────────────────────────────────────────────────────────────────────────
// list-categories.ts
//
// Read-only script that lists all categories with their item counts and menuType
// distribution, so we can decide which parent bucket (Food/Beverages/Liquor)
// each category should belong to.
//
// Usage:
//   npx tsx scripts/list-categories.ts
//
// Safety:
//   - Read-only (no writes)
//   - No data loss
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log(`\n=== All Categories ===\n`);

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      restaurantId: true,
      _count: { select: { items: { where: { isDeleted: false } } } },
    },
    orderBy: { name: 'asc' },
  });

  // Group by restaurant
  const byRestaurant = new Map<string, typeof categories>();
  for (const cat of categories) {
    const list = byRestaurant.get(cat.restaurantId) || [];
    list.push(cat);
    byRestaurant.set(cat.restaurantId, list);
  }

  // Get restaurant names
  const restaurantIds = Array.from(byRestaurant.keys());
  const restaurants = await prisma.outlet.findMany({
    where: { id: { in: restaurantIds } },
    select: { id: true, name: true },
  });
  const restaurantNameMap = new Map(restaurants.map(r => [r.id, r.name]));

  for (const [rid, cats] of byRestaurant) {
    const rName = restaurantNameMap.get(rid) || rid;
    console.log(`\n--- Outlet: ${rName} (${rid}) ---`);
    console.log(`  Total active categories: ${cats.length}\n`);

    // For each category, get menuType distribution
    for (const cat of cats) {
      const items = await prisma.menuItem.findMany({
        where: { categoryId: cat.id, isDeleted: false },
        select: { menuType: true, reportCategory: true },
      });

      const menuTypes = new Map<string, number>();
      const reportCats = new Map<string, number>();
      for (const item of items) {
        const mt = String(item.menuType || 'FOOD');
        menuTypes.set(mt, (menuTypes.get(mt) || 0) + 1);
        const rc = item.reportCategory || '(null)';
        reportCats.set(rc, (reportCats.get(rc) || 0) + 1);
      }

      const mtStr = Array.from(menuTypes.entries()).map(([k, v]) => `${k}:${v}`).join(', ');
      const rcStr = Array.from(reportCats.entries()).map(([k, v]) => `${k}:${v}`).join(', ');
      console.log(`  ${cat.name.padEnd(30)} items=${cat._count.items}  menuType={${mtStr}}  reportCategory={${rcStr}}`);
    }
  }

  // Also print a simple flat list of unique category names across all outlets
  const uniqueNames = new Set<string>();
  for (const cat of categories) uniqueNames.add(cat.name);
  console.log(`\n--- Unique category names across all outlets ---`);
  console.log(Array.from(uniqueNames).sort().join('\n'));
  console.log(`\nTotal unique: ${uniqueNames.size}`);
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
