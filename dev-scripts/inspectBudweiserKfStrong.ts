// INSPECT: Find all Budweiser Beer and Kf Strong Beer menu items (incl. soft-deleted),
// showing isVeg, isDeleted, isAvailable, category, orders, inventory, variants, venue prices.
// Read-only.
//
// Usage: npx tsx dev-scripts/inspectBudweiserKfStrong.ts [restaurantId]

import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\n=== Budweiser Beer & Kf Strong Beer items for ${restaurantId} ===\n`);

  const items = await prisma.menuItem.findMany({
    where: {
      restaurantId,
      OR: [
        { name: { equals: 'Budweiser Beer', mode: 'insensitive' } },
        { name: { equals: 'Kf Strong Beer', mode: 'insensitive' } },
        { name: { contains: 'budweiser', mode: 'insensitive' } },
        { name: { contains: 'kf strong', mode: 'insensitive' } },
      ],
    },
    include: {
      variants: true,
      inventoryItem: true,
      orderItems: { select: { id: true } },
      priceProfileItems: { select: { id: true, price: true, priceProfileId: true } },
      category: { select: { name: true } },
    },
    orderBy: { name: 'asc' },
  });

  console.log(`Total matching items (incl. soft-deleted): ${items.length}\n`);
  for (const item of items) {
    console.log(`ID:          ${item.id}`);
    console.log(`Name:        ${item.name}`);
    console.log(`isVeg:       ${item.isVeg}`);
    console.log(`isAvailable: ${item.isAvailable}`);
    console.log(`isDeleted:   ${item.isDeleted}`);
    console.log(`deletedAt:   ${item.deletedAt}`);
    console.log(`Category:    ${item.category?.name || '—'}`);
    console.log(`basePrice:   ${item.basePrice}`);
    console.log(`menuType:    ${item.menuType}`);
    console.log(`printerTarget: ${item.printerTarget || '—'}`);
    console.log(`Orders:      ${item.orderItems.length}`);
    console.log(`Inventory:   ${item.inventoryItem ? `id=${item.inventoryItem.id} stock=${item.inventoryItem.currentStock}ml bottleSize=${item.inventoryItem.bottleSize}` : 'NONE'}`);
    if (item.variants.length > 0) {
      for (const v of item.variants) {
        console.log(`  variant: id=${v.id} name="${v.name}" price=${v.price} default=${v.isDefault}`);
      }
    }
    if (item.priceProfileItems.length > 0) {
      for (const pp of item.priceProfileItems) {
        console.log(`  venuePrice: profile=${pp.priceProfileId} price=${pp.price}`);
      }
    }
    console.log('---');
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
