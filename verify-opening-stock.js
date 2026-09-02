const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });

  // Load 31-08 snapshots
  const snaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: '2026-08-31' },
  });
  const snapMap = new Map();
  snaps.forEach(s => snapMap.set(s.itemId, s));

  let totalValue = 0;
  let itemsWithStock = 0;
  let itemsWithoutCost = 0;

  console.log('=== 31-08 Opening Stock Report for Vgrand Lounge (Z3695J) ===\n');
  console.log('Name | BottleSize(ml) | OpeningStock(ml) | Bottles | CostPerBottle | Value');
  console.log('-'.repeat(100));

  for (const item of items) {
    const name = item.menuItem?.name || '';
    const bottleSize = Number(item.bottleSize || 0);
    const opening = Number(item.openingStock || 0);
    const cost = Number(item.costPerBottle || 0);
    const snap = snapMap.get(item.id);
    const snapOpening = snap ? Number(snap.openingStock) : null;

    if (opening > 0) {
      itemsWithStock++;
      const bottles = bottleSize > 0 ? opening / bottleSize : 0;
      const value = bottles * cost;
      totalValue += value;
      if (cost === 0) itemsWithoutCost++;

      const snapMatch = snapOpening === opening ? 'OK' : `MISMATCH(snap:${snapOpening})`;
      console.log(`${name} | ${bottleSize}ml | ${opening}ml | ${bottles.toFixed(2)} | Rs ${cost.toFixed(2)} | Rs ${value.toFixed(2)} | ${snapMatch}`);
    }
  }

  console.log('-'.repeat(100));
  console.log(`\nItems with opening stock: ${itemsWithStock}`);
  console.log(`Items without cost: ${itemsWithoutCost}`);
  console.log(`Total opening stock value: Rs ${totalValue.toFixed(2)}`);

  await p.$disconnect();
})();
