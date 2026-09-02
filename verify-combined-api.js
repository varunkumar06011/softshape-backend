// Verify the combined inventory API output for 31-08
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  // Simulate what the combined inventory API does
  const date = '2026-08-31';
  
  const acItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true, category: { select: { name: true } } } } },
  });
  
  const snaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: date },
  });
  const snapMap = new Map();
  snaps.forEach(s => snapMap.set(s.itemId, s));

  console.log(`=== Combined Inventory for ${date} (Outlet Z3695J) ===\n`);
  console.log('Name | BottleSize | OpeningML | OpeningBtl | ClosingML | ClosingBtl | CostPerBtl | OpeningValue');
  console.log('-'.repeat(120));
  
  let totalOpeningValue = 0;
  let totalClosingValue = 0;
  let count = 0;
  
  for (const item of acItems) {
    const snap = snapMap.get(item.id);
    const btlSize = Number(item.bottleSize) || 0;
    const openingMl = snap ? Number(snap.openingStock) : Number(item.currentStock);
    const closingMl = snap ? Number(snap.closingStock) : Number(item.currentStock);
    const openingBtl = btlSize > 0 ? Math.round(openingMl / btlSize * 100) / 100 : 0;
    const closingBtl = btlSize > 0 ? Math.round(closingMl / btlSize * 100) / 100 : 0;
    const cost = Number(item.costPerBottle) || 0;
    const openingValue = openingBtl * cost;
    const closingValue = closingBtl * cost;
    
    if (openingBtl > 0 || closingBtl > 0) {
      totalOpeningValue += openingValue;
      totalClosingValue += closingValue;
      count++;
      console.log(`  ${item.menuItem?.name} | ${btlSize}ml | ${openingMl}ml | ${openingBtl} btl | ${closingMl}ml | ${closingBtl} btl | Rs ${cost.toFixed(2)} | Rs ${openingValue.toFixed(2)}`);
    }
  }
  
  console.log('-'.repeat(120));
  console.log(`\nItems with stock: ${count}`);
  console.log(`Total Opening Stock Value: Rs ${totalOpeningValue.toFixed(2)}`);
  console.log(`Total Closing Stock Value: Rs ${totalClosingValue.toFixed(2)}`);
  
  await p.$disconnect();
})();
