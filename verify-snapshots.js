const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  // Verify 31-08 snapshots match inventoryItem.openingStock
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  const snaps31 = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: '2026-08-31' },
  });
  const snapMap = new Map();
  snaps31.forEach(s => snapMap.set(s.itemId, s));

  let mismatches = 0;
  let totalOpeningValue = 0;
  let totalItems = 0;

  console.log('=== 31-08 Snapshot Verification ===\n');
  console.log('Item | ItemOpening | SnapOpening | SnapClosing | Match');
  console.log('-'.repeat(80));

  for (const item of items) {
    const itemOpening = Number(item.openingStock);
    const snap = snapMap.get(item.id);
    const name = item.menuItem?.name || '';
    const cost = Number(item.costPerBottle || 0);

    if (snap) {
      const snapOpening = Number(snap.openingStock);
      const snapClosing = Number(snap.closingStock);
      const match = itemOpening === snapOpening && snapOpening === snapClosing && Number(snap.sold) === 0;
      if (!match) {
        mismatches++;
        console.log(`${name} | item:${itemOpening} | snap:${snapOpening} | close:${snapClosing} | sold:${snap.sold} | MISMATCH`);
      }
      if (itemOpening > 0) {
        totalOpeningValue += itemOpening * cost;
        totalItems++;
      }
    } else {
      console.log(`${name} | item:${itemOpening} | NO SNAPSHOT`);
      mismatches++;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total active items: ${items.length}`);
  console.log(`31-08 snapshots: ${snaps31.length}`);
  console.log(`Mismatches: ${mismatches}`);
  console.log(`Items with opening > 0: ${totalItems}`);
  console.log(`Total opening stock value: Rs ${totalOpeningValue.toFixed(2)}`);

  // Also check 01-09
  const snaps01 = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: '2026-09-01' },
  });
  console.log(`\n01-09 snapshots: ${snaps01.length}`);

  let mismatches01 = 0;
  for (const item of items) {
    const snap = snaps01.find(s => s.itemId === item.id);
    if (!snap) { mismatches01++; continue; }
    const itemOpening = Number(item.openingStock);
    const snapOpening = Number(snap.openingStock);
    if (itemOpening !== snapOpening || Number(snap.sold) !== 0) mismatches01++;
  }
  console.log(`01-09 mismatches: ${mismatches01}`);

  await p.$disconnect();
})();
