const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  // Check 01-09 snapshots
  const snap01 = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: '2026-09-01' },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
    orderBy: { item: { menuItem: { name: 'asc' } } },
  });
  console.log(`01-09 snapshots: ${snap01.length} items`);
  snap01.forEach(s => {
    console.log(`  ${s.itemName} | opening: ${s.openingStock} | closing: ${s.closingStock} | purchased: ${s.purchased} | sold: ${s.sold}`);
  });

  // Check what the bar inventory API returns for opening stock
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true, openingStock: { gt: 0 } },
    include: { menuItem: { select: { name: true } } },
  });
  console.log(`\nInventory items with openingStock > 0: ${items.length}`);
  items.forEach(i => console.log(`  ${i.menuItem.name} [${i.bottleSize}ml] opening: ${i.openingStock} cost: ${i.costPerBottle}`));

  await p.$disconnect();
})();
