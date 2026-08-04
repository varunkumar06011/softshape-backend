// INSPECT: Search ALL restaurants for Budweiser Beer and Kf Strong Beer items
// (active ones, isDeleted=false), showing isVeg, restaurant, category, orders, inventory.
// Read-only.
//
// Usage: npx tsx dev-scripts/inspectBudweiserKfStrongAllRestaurants.ts

import prisma from '../src/lib/prisma';

async function main() {
  console.log(`\n=== Budweiser Beer & Kf Strong Beer across ALL restaurants (active only) ===\n`);

  const items = await prisma.menuItem.findMany({
    where: {
      isDeleted: false,
      OR: [
        { name: { equals: 'Budweiser Beer', mode: 'insensitive' } },
        { name: { equals: 'Kf Strong Beer', mode: 'insensitive' } },
        { name: { contains: 'budweiser beer', mode: 'insensitive' } },
        { name: { contains: 'kf strong beer', mode: 'insensitive' } },
      ],
    },
    include: {
      variants: true,
      inventoryItem: true,
      orderItems: { select: { id: true } },
      category: { select: { name: true } },
    },
    orderBy: [{ restaurantId: 'asc' }, { name: 'asc' }],
  });

  console.log(`Total active matching items across all restaurants: ${items.length}\n`);
  for (const item of items) {
    console.log(`ID:          ${item.id}`);
    console.log(`Name:        ${item.name}`);
    console.log(`isVeg:       ${item.isVeg}`);
    console.log(`isAvailable: ${item.isAvailable}`);
    console.log(`Restaurant:  ${item.restaurantId}`);
    console.log(`Category:    ${item.category?.name || '—'}`);
    console.log(`basePrice:   ${item.basePrice}`);
    console.log(`Orders:      ${item.orderItems.length}`);
    console.log(`Inventory:   ${item.inventoryItem ? `stock=${item.inventoryItem.currentStock}ml` : 'NONE'}`);
    for (const v of item.variants) {
      console.log(`  variant: name="${v.name}" price=${v.price} default=${v.isDefault}`);
    }
    console.log('---');
  }

  // Also show soft-deleted ones for context
  console.log(`\n=== Soft-deleted matching items (for context) ===\n`);
  const softDeleted = await prisma.menuItem.findMany({
    where: {
      isDeleted: true,
      OR: [
        { name: { equals: 'Budweiser Beer', mode: 'insensitive' } },
        { name: { equals: 'Kf Strong Beer', mode: 'insensitive' } },
        { name: { contains: 'budweiser beer', mode: 'insensitive' } },
        { name: { contains: 'kf strong beer', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, isVeg: true, isAvailable: true, restaurantId: true, deletedAt: true },
  });
  for (const item of softDeleted) {
    console.log(`SOFT-DELETED: id=${item.id} name="${item.name}" isVeg=${item.isVeg} restaurant=${item.restaurantId} deletedAt=${item.deletedAt}`);
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
