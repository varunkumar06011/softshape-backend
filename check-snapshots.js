const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  // Check existing snapshots
  const snapCount = await p.dailyInventorySnapshot.count({
    where: { restaurantId: RESTAURANT_ID },
  });
  console.log(`Total snapshots: ${snapCount}`);

  const snapDates = await p.dailyInventorySnapshot.groupBy({
    by: ['snapshotDate'],
    where: { restaurantId: RESTAURANT_ID },
    _count: true,
    orderBy: { snapshotDate: 'desc' },
  });
  console.log('\nSnapshots by date:');
  snapDates.forEach(d => console.log(`  ${d.snapshotDate}: ${d._count} items`));

  // Check 31-08 specifically
  const snap31 = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: '2026-08-31' },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
    orderBy: { item: { menuItem: { name: 'asc' } } },
  });
  console.log(`\n31-08 snapshots: ${snap31.length} items`);
  snap31.slice(0, 10).forEach(s => {
    console.log(`  ${s.itemName} | opening: ${s.openingStock} | closing: ${s.closingStock} | purchased: ${s.purchased} | sold: ${s.sold}`);
  });

  // Check inventory items openingStock vs snapshot openingStock
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  console.log(`\nInventory items with openingStock > 0: ${items.filter(i => Number(i.openingStock) > 0).length}`);

  await p.$disconnect();
})();
