// INSPECT: List all beer menu items (active + soft-deleted) for a restaurant.
// Shows id, name, basePrice, isDeleted, isAvailable, deletedAt, order count, inventory stock.
// Read-only — does NOT modify anything.
//
// Usage: npx tsx dev-scripts/inspectBeerDuplicates.ts [restaurantId]

import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\n=== Beer menu items for restaurant ${restaurantId} ===\n`);

  const items = await prisma.menuItem.findMany({
    where: {
      restaurantId,
      menuType: 'LIQUOR',
      OR: [
        { name: { contains: 'beer', mode: 'insensitive' } },
        { name: { contains: 'budw', mode: 'insensitive' } },
        { name: { contains: 'kf ', mode: 'insensitive' } },
        { name: { contains: 'stok', mode: 'insensitive' } },
        { name: { contains: 'british', mode: 'insensitive' } },
        { name: { contains: 'karjura', mode: 'insensitive' } },
        { name: { contains: 'kalyani', mode: 'insensitive' } },
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
  console.log(
    'ID'.padEnd(38) +
      '| Name'.padEnd(42) +
      '| BasePrice'.padEnd(12) +
      '| Avail'.padEnd(8) +
      '| Deleted'.padEnd(9) +
      '| Orders'.padEnd(9) +
      '| Stock(ml)'.padEnd(12) +
      '| Category'
  );
  console.log('-'.repeat(150));

  for (const item of items) {
    const stock = item.inventoryItem ? String(item.inventoryItem.currentStock) : '—';
    console.log(
      item.id.padEnd(38) +
        '| ' + item.name.padEnd(40) +
        '| ' + String(item.basePrice).padEnd(10) +
        '| ' + String(item.isAvailable).padEnd(6) +
        '| ' + String(item.isDeleted).padEnd(7) +
        '| ' + String(item.orderItems.length).padEnd(7) +
        '| ' + stock.padEnd(10) +
        '| ' + (item.category?.name || '—')
    );
    if (item.variants.length > 0) {
      for (const v of item.variants) {
        console.log('  variant: ' + v.name + '  price=' + v.price + '  default=' + v.isDefault);
      }
    }
    if (item.priceProfileItems.length > 0) {
      for (const pp of item.priceProfileItems) {
        console.log('  venuePrice: profile=' + pp.priceProfileId + '  price=' + pp.price);
      }
    }
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
