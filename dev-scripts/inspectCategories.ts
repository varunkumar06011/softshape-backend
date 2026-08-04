// INSPECT: List all categories for the restaurant, showing id, name, isActive,
// printerTarget, sortOrder, and count of active menu items in each.
// Read-only.
//
// Usage: npx tsx dev-scripts/inspectCategories.ts [restaurantId]

import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\n=== Categories for restaurant ${restaurantId} ===\n`);

  const categories = await prisma.category.findMany({
    where: { restaurantId },
    include: {
      _count: { select: { items: { where: { isDeleted: false } } } },
    },
    orderBy: { sortOrder: 'asc' },
  });

  for (const cat of categories) {
    console.log(`ID:            ${cat.id}`);
    console.log(`Name:          "${cat.name}"`);
    console.log(`isActive:      ${cat.isActive}`);
    console.log(`printerTarget: ${cat.printerTarget || '—'}`);
    console.log(`sortOrder:     ${cat.sortOrder}`);
    console.log(`Active items:  ${cat._count.items}`);
    console.log('---');
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
