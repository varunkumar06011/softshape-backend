// Compare the two API endpoints for the same date
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const DATE = '2026-08-31';

(async () => {
  // 1. Simulate the combined inventory API (main inventory screen)
  // This loads ALL active inventory items (including soft drinks)
  const allAcItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true, category: { select: { name: true } } } } },
  });

  // Filter soft drinks (same as buildLiquorReportForDate)
  const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
  const isSoftDrink = (inv) => {
    const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
    const itemName = String(inv.menuItem?.name || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };

  const liquorAcItems = allAcItems.filter(inv => !isSoftDrink(inv));

  // Load snapshots for 31-08
  const snaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: DATE },
  });
  const snapMap = new Map();
  snaps.forEach(s => snapMap.set(s.itemId, s));

  // === CALCULATION 1: Combined Inventory API style ===
  // This is what the main Inventory screen uses
  // It uses: openingStockBottles from snapshot, purchaseRate from item
  let combinedOpeningValue = 0;
  let combinedPurchaseValue = 0;
  let combinedConsumption = 0;
  let combinedClosingValue = 0;

  for (const item of liquorAcItems) {
    const snap = snapMap.get(item.id);
    const btlSize = Number(item.bottleSize) || 0;
    const pr = Number(item.costPerBottle) || 0;

    // Combined API: openingStockBottles = snap.openingStock / btlSize
    const openingMl = snap ? Number(snap.openingStock) : Number(item.currentStock);
    const openingBtl = btlSize > 0 ? openingMl / btlSize : 0;
    const receivedBtl = snap ? Number(snap.purchased) / btlSize : 0;
    const soldBtl = snap ? Number(snap.sold) / btlSize : 0;
    const closingBtl = snap ? Number(snap.closingStock) / btlSize : 0;

    combinedOpeningValue += openingBtl * pr;
    combinedPurchaseValue += receivedBtl * pr;
    combinedConsumption += soldBtl * pr;
    combinedClosingValue += closingBtl * pr;
  }

  // Non-AC items (combined API)
  const nonAcItems = await p.nonAcInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
  });
  const nonAcLiquorItems = nonAcItems.filter(item => {
    const catName = String(item.category || '').toLowerCase();
    const itemName = String(item.itemName || '').toLowerCase();
    return !SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) &&
           !SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  });

  const nonAcEntries = await p.nonAcDailyEntry.findMany({
    where: { restaurantId: RESTAURANT_ID, entryDate: DATE },
  });
  const nonAcEntryMap = new Map();
  nonAcEntries.forEach(e => nonAcEntryMap.set(e.itemId, e));

  let combinedNonAcOpeningValue = 0;
  let combinedNonAcPurchaseValue = 0;
  let combinedNonAcConsumption = 0;
  let combinedNonAcClosingValue = 0;
  let combinedNonAcSales = 0;

  for (const item of nonAcLiquorItems) {
    const entry = nonAcEntryMap.get(item.id);
    const pr = Number(item.purchaseRate) || 0;
    const sp = Number(item.nonAcSellingPrice) || 0;
    const opening = entry ? Number(entry.openingBottles) : Number(item.openingBottles);
    const received = entry ? Number(entry.receivedBottles) : 0;
    const sold = entry ? Number(entry.adminDeduction) : 0;
    const closing = entry ? Number(entry.closingBottles) : opening + received - sold;

    combinedNonAcOpeningValue += opening * pr;
    combinedNonAcPurchaseValue += received * pr;
    combinedNonAcConsumption += sold * pr;
    combinedNonAcClosingValue += closing * pr;
    combinedNonAcSales += sold * sp;
  }

  console.log('=== COMBINED INVENTORY API (Main Inventory Screen) ===');
  console.log(`AC Opening Stock Value: Rs ${combinedOpeningValue.toFixed(2)}`);
  console.log(`AC Purchase Value: Rs ${combinedPurchaseValue.toFixed(2)}`);
  console.log(`AC Consumption: Rs ${combinedConsumption.toFixed(2)}`);
  console.log(`AC Closing Stock Value: Rs ${combinedClosingValue.toFixed(2)}`);
  console.log(`Non-AC Opening Stock Value: Rs ${combinedNonAcOpeningValue.toFixed(2)}`);
  console.log(`Non-AC Purchase Value: Rs ${combinedNonAcPurchaseValue.toFixed(2)}`);
  console.log(`Non-AC Consumption: Rs ${combinedNonAcConsumption.toFixed(2)}`);
  console.log(`Non-AC Closing Stock Value: Rs ${combinedNonAcClosingValue.toFixed(2)}`);
  console.log(`Non-AC Sales: Rs ${combinedNonAcSales.toFixed(2)}`);
  console.log(`TOTAL Opening Stock Value: Rs ${(combinedOpeningValue + combinedNonAcOpeningValue).toFixed(2)}`);
  console.log(`TOTAL Closing Stock Value: Rs ${(combinedClosingValue + combinedNonAcClosingValue).toFixed(2)}`);

  // === CALCULATION 2: Liquor Daily Report API style ===
  // This is what the PDF-to-Admin uses
  // The liquor report uses different data sources for the summary
  // Let me check what the report's summary object contains

  // The liquor report's summary comes from nonAcManualEntries (summaryOverrides)
  // and AC revenue from POS transactions
  const nonAcManualEntries = await p.liquorReportNonAcEntry.findMany({
    where: { restaurantId: RESTAURANT_ID, reportDate: DATE },
  });

  let summaryOverrides = null;
  let nonAcManualTotal = { nonAcSales: 0, nonAcLandingCost: 0 };

  for (const e of nonAcManualEntries) {
    if (e.categoryName === '__SUMMARY__') {
      try { summaryOverrides = JSON.parse(e.notes || '{}'); } catch {}
      continue;
    }
    if (e.categoryName === 'TOTAL') {
      nonAcManualTotal = { nonAcSales: Number(e.nonAcSales), nonAcLandingCost: Number(e.nonAcLandingCost) };
    }
  }

  console.log('\n=== LIQUOR DAILY REPORT API (PDF-to-Admin) ===');
  console.log(`Summary Overrides:`, JSON.stringify(summaryOverrides, null, 2));
  console.log(`Non-AC Manual Total Sales: Rs ${nonAcManualTotal.nonAcSales}`);
  console.log(`Non-AC Manual Total Landing Cost: Rs ${nonAcManualTotal.nonAcLandingCost}`);

  // The liquor report calculates opening stock value differently
  // It uses the item-wise table data, not the combined API logic
  // Let me check the actual report calculation

  // In buildLiquorReportForDate, the summary is computed from the acItems array
  // which uses different fields than the combined API

  // Check: does the liquor report use openingStock from snapshot or from item.currentStock?
  // The liquor report's acItems use: opening = snap.openingStock / btlSize (in bottles)
  // But the summary might use different values

  // Let me check what values the liquor report's acItems would have
  let reportOpeningValue = 0;
  let reportItems = 0;

  for (const item of liquorAcItems) {
    const snap = snapMap.get(item.id);
    if (!snap) continue;

    const btlSize = Number(item.bottleSize) || 0;
    if (btlSize <= 0) continue;

    // The liquor report uses: opening = Number(snap.openingStock) / btlSize
    // But only for items that have a snapshot
    const openingBtl = Number(snap.openingStock) / btlSize;
    const pr = Number(item.costPerBottle) || 0;

    if (openingBtl > 0) {
      reportOpeningValue += openingBtl * pr;
      reportItems++;
    }
  }

  console.log(`\nLiquor Report AC Opening Value (from snapshots): Rs ${reportOpeningValue.toFixed(2)}`);
  console.log(`Items with snapshots: ${reportItems}`);

  // Check: how many liquor items have NO snapshot for 31-08?
  let noSnapCount = 0;
  let noSnapValue = 0;
  for (const item of liquorAcItems) {
    const snap = snapMap.get(item.id);
    if (!snap) {
      const btlSize = Number(item.bottleSize) || 0;
      const openingBtl = btlSize > 0 ? Number(item.currentStock) / btlSize : 0;
      const pr = Number(item.costPerBottle) || 0;
      if (openingBtl > 0) {
        noSnapCount++;
        noSnapValue += openingBtl * pr;
        console.log(`  NO SNAP: ${item.menuItem?.name} | currentStock=${item.currentStock}ml | btlSize=${btlSize}ml | openingBtl=${openingBtl.toFixed(2)} | cost=${pr} | value=${(openingBtl * pr).toFixed(2)}`);
      }
    }
  }
  console.log(`\nItems with NO snapshot: ${noSnapCount}`);
  console.log(`Value of items with no snapshot: Rs ${noSnapValue.toFixed(2)}`);

  await p.$disconnect();
})();
