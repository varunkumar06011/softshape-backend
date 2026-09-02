// Check the actual combined inventory API calculation for 31-08
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const DATE = '2026-08-31';

(async () => {
  // Load all active inventory items
  const acItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true, category: { select: { name: true } } } } },
  });

  // Load snapshots for 31-08
  const snaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: DATE },
  });
  const snapMap = new Map();
  snaps.forEach(s => snapMap.set(s.itemId, s));

  // Load previous day snapshots (30-08) for fallback
  const prevSnaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: '2026-08-30' },
  });
  const prevSnapMap = new Map();
  prevSnaps.forEach(s => prevSnapMap.set(s.itemId, s));

  console.log(`=== Opening Stock Value Audit for ${DATE} ===\n`);
  console.log(`Active inventory items: ${acItems.length}`);
  console.log(`Snapshots for ${DATE}: ${snaps.length}`);
  console.log(`Snapshots for 2026-08-30: ${prevSnaps.length}\n`);

  let totalOpeningValue = 0;
  let totalFromSnap = 0;
  let totalFromPrevSnap = 0;
  let totalFromCurrentStock = 0;
  let itemsWithStock = 0;
  let itemsWithHighValue = 0;
  const details = [];

  for (const item of acItems) {
    const btlSize = Number(item.bottleSize) || 0;
    const snap = snapMap.get(item.id);
    const prevSnap = prevSnapMap.get(item.id);
    
    // Same logic as the API: snap.openingStock > prevSnap.closingStock > item.currentStock
    let openingMl;
    let source;
    if (snap) {
      openingMl = Number(snap.openingStock);
      source = 'snap31';
    } else if (prevSnap) {
      openingMl = Number(prevSnap.closingStock);
      source = 'prevSnap30';
    } else {
      openingMl = Number(item.currentStock);
      source = 'currentStock';
    }

    const openingBtl = btlSize > 0 ? Math.round(openingMl / btlSize * 100) / 100 : 0;
    const cost = Number(item.costPerBottle) || 0;
    const value = openingBtl * cost;
    
    if (value > 0) {
      totalOpeningValue += value;
      itemsWithStock++;
      if (source === 'snap31') totalFromSnap++;
      else if (source === 'prevSnap30') totalFromPrevSnap++;
      else totalFromCurrentStock++;
      
      if (value > 10000) itemsWithHighValue++;
      
      details.push({
        name: item.menuItem?.name,
        btlSize,
        openingMl,
        openingBtl,
        cost,
        value,
        source,
      });
    }
  }

  // Sort by value descending
  details.sort((a, b) => b.value - a.value);

  console.log('Top 20 items by opening value:');
  console.log('Name | Size | OpeningML | OpeningBtl | Cost | Value | Source');
  console.log('-'.repeat(120));
  details.slice(0, 20).forEach(d => {
    console.log(`  ${d.name} | ${d.btlSize}ml | ${d.openingMl} | ${d.openingBtl} | Rs ${d.cost.toFixed(2)} | Rs ${d.value.toFixed(2)} | ${d.source}`);
  });

  console.log(`\n=== SUMMARY ===`);
  console.log(`Items with stock: ${itemsWithStock}`);
  console.log(`  From 31-08 snapshot: ${totalFromSnap}`);
  console.log(`  From 30-08 prev snapshot: ${totalFromPrevSnap}`);
  console.log(`  From currentStock fallback: ${totalFromCurrentStock}`);
  console.log(`Items with value > Rs 10,000: ${itemsWithHighValue}`);
  console.log(`\nTotal Opening Stock Value: Rs ${totalOpeningValue.toFixed(2)}`);

  // Check for items where prevSnap (30-08) has different closing than 31-08 opening
  console.log(`\n=== Items where 30-08 closing != 31-08 opening (fallback mismatch) ===`);
  let mismatchCount = 0;
  for (const item of acItems) {
    const snap31 = snapMap.get(item.id);
    const snap30 = prevSnapMap.get(item.id);
    if (snap31 && snap30) {
      const open31 = Number(snap31.openingStock);
      const close30 = Number(snap30.closingStock);
      if (Math.abs(open31 - close30) > 0.01) {
        mismatchCount++;
        const btlSize = Number(item.bottleSize) || 0;
        const cost = Number(item.costPerBottle) || 0;
        const openBtl = btlSize > 0 ? open31 / btlSize : 0;
        const closeBtl = btlSize > 0 ? close30 / btlSize : 0;
        console.log(`  ${item.menuItem?.name}: 31-08 open=${open31}ml (${openBtl}btl) vs 30-08 close=${close30}ml (${closeBtl}btl) | cost=${cost} | diff value=Rs ${(openBtl * cost - closeBtl * cost).toFixed(2)}`);
      }
    }
  }
  console.log(`Total mismatches: ${mismatchCount}`);

  await p.$disconnect();
})();
