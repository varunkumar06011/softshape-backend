// Check Non-AC items contribution to opening stock value
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const DATE = '2026-08-31';

(async () => {
  // Load Non-AC items
  const nonAcItems = await p.nonAcInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
  });
  console.log(`Non-AC items: ${nonAcItems.length}`);
  
  // Load Non-AC daily entries for 31-08
  const nonAcEntries = await p.nonAcDailyEntry.findMany({
    where: { restaurantId: RESTAURANT_ID, entryDate: DATE },
  });
  const entryMap = new Map();
  nonAcEntries.forEach(e => entryMap.set(e.itemId, e));
  
  let nonAcOpeningValue = 0;
  let standaloneNonAcValue = 0;
  let linkedNonAcCount = 0;
  let standaloneCount = 0;
  
  console.log('\nNon-AC items detail:');
  nonAcItems.forEach(item => {
    const entry = entryMap.get(item.id);
    const opening = entry ? Number(entry.openingBottles) : Number(item.openingBottles);
    const cost = Number(item.purchaseRate) || 0;
    const value = opening * cost;
    const isLinked = !!item.acInventoryItemId;
    
    if (value > 0) {
      console.log(`  ${item.itemName} | ${item.bottleSize}ml | linked=${isLinked} | opening=${opening} btl | cost=Rs ${cost} | value=Rs ${value.toFixed(2)}`);
    }
    
    if (isLinked) {
      linkedNonAcCount++;
      // Linked items share AC stock — NOT counted separately in the summary
      // because openingStockBottles comes from the AC snapshot
    } else {
      standaloneCount++;
      standaloneNonAcValue += value;
    }
    nonAcOpeningValue += value;
  });
  
  console.log(`\n=== Non-AC Summary ===`);
  console.log(`Total Non-AC items: ${nonAcItems.length}`);
  console.log(`Linked to AC: ${linkedNonAcCount}`);
  console.log(`Standalone: ${standaloneCount}`);
  console.log(`Non-AC total opening value (all): Rs ${nonAcOpeningValue.toFixed(2)}`);
  console.log(`Standalone Non-AC opening value (added to summary): Rs ${standaloneNonAcValue.toFixed(2)}`);
  
  // Now check the AC items total
  const acItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  const snaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: DATE },
  });
  const snapMap = new Map();
  snaps.forEach(s => snapMap.set(s.itemId, s));
  
  let acOpeningValue = 0;
  acItems.forEach(item => {
    const snap = snapMap.get(item.id);
    const btlSize = Number(item.bottleSize) || 0;
    const openingMl = snap ? Number(snap.openingStock) : Number(item.currentStock);
    const openingBtl = btlSize > 0 ? Math.round(openingMl / btlSize * 100) / 100 : 0;
    const cost = Number(item.costPerBottle) || 0;
    acOpeningValue += openingBtl * cost;
  });
  
  console.log(`\n=== AC Summary ===`);
  console.log(`AC opening value: Rs ${acOpeningValue.toFixed(2)}`);
  console.log(`\n=== TOTAL (AC + standalone Non-AC) ===`);
  console.log(`Total: Rs ${(acOpeningValue + standaloneNonAcValue).toFixed(2)}`);
  
  // Check if any Non-AC items are NOT linked but have same name as AC items (double counting)
  console.log(`\n=== Checking for potential double-counting ===`);
  const acNames = new Set(acItems.map(i => i.menuItem?.name?.toLowerCase().replace(/\s*\d+\s*ml\b/gi, '').trim()));
  nonAcItems.forEach(item => {
    if (!item.acInventoryItemId) {
      const baseName = item.itemName?.toLowerCase().replace(/\s*\d+\s*ml\b/gi, '').trim();
      if (acNames.has(baseName)) {
        const entry = entryMap.get(item.id);
        const opening = entry ? Number(entry.openingBottles) : Number(item.openingBottles);
        const cost = Number(item.purchaseRate) || 0;
        const value = opening * cost;
        if (value > 0) {
          console.log(`  POSSIBLE DOUBLE: Non-AC "${item.itemName}" (standalone, opening=${opening}, value=Rs ${value.toFixed(2)}) matches AC brand`);
        }
      }
    }
  });
  
  await p.$disconnect();
})();
