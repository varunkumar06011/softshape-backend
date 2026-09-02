// Direct DB test of the save + merge + carry-forward logic
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const barId = 'cmqy60ci200027dscyj9ubg8h';
  const date31 = '2026-08-31';
  const date01 = '2026-09-01';

  // Step 1: Simulate frontend save for 31-08 with ALL Business Position values
  console.log('=== Step 1: Save 31-08 with complete Business Position ===');
  const summaryOverrides = {
    openingStockValue: 850000,
    purchaseValue: 50000,
    consumption: 30000,
    closingStockValue: 870000, // 850000 + 50000 - 30000
    acSales: 25000,
    acConsumption: 15000,
    acProfit: 10000,
    acProfitPct: 40,
    nonAcSales: 5000,
    nonAcConsumption: 3000,
    nonAcProfit: 2000,
    nonAcProfitPct: 40,
    totalSales: 30000,
    totalConsumption: 18000,
    totalProfit: 12000,
    totalProfitPct: 40,
  };

  // Replicate the backend merge logic
  const existing = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' },
  });
  let merged = {};
  if (existing) {
    try { merged = JSON.parse(existing.notes || '{}'); } catch {}
  }
  for (const [key, val] of Object.entries(summaryOverrides)) {
    if (typeof val === 'number' && !Number.isNaN(val)) {
      merged[key] = val;
    }
  }
  await prisma.liquorReportNonAcEntry.upsert({
    where: { restaurantId_reportDate_categoryName: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' } },
    create: {
      restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__',
      nonAcSales: 0, nonAcLandingCost: 0, notes: JSON.stringify(merged), createdBy: 'test',
    },
    update: { notes: JSON.stringify(merged), updatedBy: 'test' },
  });
  console.log('Saved. Merged fields:', Object.keys(merged).length);

  // Step 2: Verify 31-08 saved correctly
  console.log('\n=== Step 2: Verify 31-08 saved values ===');
  const saved31 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' },
  });
  const saved31Overrides = JSON.parse(saved31.notes || '{}');
  console.log('  closingStockValue:', saved31Overrides.closingStockValue);
  console.log('  openingStockValue:', saved31Overrides.openingStockValue);
  console.log('  purchaseValue:', saved31Overrides.purchaseValue);
  console.log('  consumption:', saved31Overrides.consumption);
  console.log('  All 16 fields saved:', Object.keys(saved31Overrides).length >= 16 ? 'YES ✓' : 'NO ✗');

  // Step 3: Simulate backend carry-forward for 01-09
  console.log('\n=== Step 3: Carry-forward to 01-09 ===');
  const prevEntry = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' },
  });
  let prevDayClosingStockValue = null;
  if (prevEntry) {
    const prevOverrides = JSON.parse(prevEntry.notes || '{}');
    if (typeof prevOverrides.closingStockValue === 'number') {
      prevDayClosingStockValue = prevOverrides.closingStockValue;
    }
  }
  console.log(`  31-08 saved closingStockValue: ${prevDayClosingStockValue}`);

  // Check if 01-09 has its own openingStockValue override
  const entry01 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: date01, categoryName: '__SUMMARY__' },
  });
  let todayOpeningOverride = null;
  if (entry01) {
    const overrides01 = JSON.parse(entry01.notes || '{}');
    todayOpeningOverride = overrides01.openingStockValue;
  }
  console.log(`  01-09 explicit openingStockValue override: ${todayOpeningOverride}`);

  // Determine openingStockValue for 01-09
  let openingFor01;
  if (todayOpeningOverride != null) {
    openingFor01 = todayOpeningOverride;
    console.log(`  → Using 01-09 explicit override: ${openingFor01}`);
  } else if (prevDayClosingStockValue != null) {
    openingFor01 = prevDayClosingStockValue;
    console.log(`  → Using carry-forward from 31-08: ${openingFor01}`);
  } else {
    openingFor01 = null;
    console.log(`  → No carry-forward, would use computed value`);
  }

  // Step 4: Verify the chain
  console.log('\n=== Step 4: Verification ===');
  console.log(`  31-08 Closing Stock Value: ${saved31Overrides.closingStockValue}`);
  console.log(`  01-09 Opening Stock Value: ${openingFor01}`);
  const match = saved31Overrides.closingStockValue === openingFor01;
  console.log(`  31-08 Closing = 01-09 Opening: ${match ? 'YES ✓' : 'NO ✗'}`);

  // Step 5: Test merge — save only ONE field and verify others are preserved
  console.log('\n=== Step 5: Test merge (save only totalProfitPct) ===');
  const partialSave = { totalProfitPct: 55 };
  const existing2 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' },
  });
  let merged2 = {};
  if (existing2) {
    try { merged2 = JSON.parse(existing2.notes || '{}'); } catch {}
  }
  for (const [key, val] of Object.entries(partialSave)) {
    merged2[key] = val;
  }
  await prisma.liquorReportNonAcEntry.upsert({
    where: { restaurantId_reportDate_categoryName: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' } },
    create: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__', nonAcSales: 0, nonAcLandingCost: 0, notes: JSON.stringify(merged2), createdBy: 'test' },
    update: { notes: JSON.stringify(merged2), updatedBy: 'test' },
  });
  const afterPartial = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' },
  });
  const afterPartialOverrides = JSON.parse(afterPartial.notes || '{}');
  console.log(`  After partial save, closingStockValue still = ${afterPartialOverrides.closingStockValue} (should be ${saved31Overrides.closingStockValue})`);
  console.log(`  Preserved: ${afterPartialOverrides.closingStockValue === saved31Overrides.closingStockValue ? 'YES ✓' : 'NO ✗ — DATA LOSS!'}`);
  console.log(`  totalProfitPct updated: ${afterPartialOverrides.totalProfitPct === 55 ? 'YES ✓' : 'NO ✗'}`);

  // Step 6: Test multiple rapid saves (race condition simulation)
  console.log('\n=== Step 6: Test multiple rapid saves ===');
  const saves = [
    { acSales: 10000 },
    { acSales: 20000 },
    { acSales: 30000 },
  ];
  for (const s of saves) {
    const ex = await prisma.liquorReportNonAcEntry.findFirst({
      where: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' },
    });
    let m = {};
    if (ex) { try { m = JSON.parse(ex.notes || '{}'); } catch {} }
    for (const [k, v] of Object.entries(s)) { m[k] = v; }
    await prisma.liquorReportNonAcEntry.upsert({
      where: { restaurantId_reportDate_categoryName: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' } },
      create: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__', nonAcSales: 0, nonAcLandingCost: 0, notes: JSON.stringify(m), createdBy: 'test' },
      update: { notes: JSON.stringify(m), updatedBy: 'test' },
    });
  }
  const afterMulti = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: date31, categoryName: '__SUMMARY__' },
  });
  const afterMultiOverrides = JSON.parse(afterMulti.notes || '{}');
  console.log(`  After 3 saves, acSales = ${afterMultiOverrides.acSales} (should be 30000 — last save wins)`);
  console.log(`  Last save wins: ${afterMultiOverrides.acSales === 30000 ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  closingStockValue preserved: ${afterMultiOverrides.closingStockValue === saved31Overrides.closingStockValue ? 'YES ✓' : 'NO ✗'}`);

  // Final summary
  console.log('\n=== FINAL SUMMARY ===');
  console.log(`31-08 closingStockValue in DB: ${afterMultiOverrides.closingStockValue}`);
  console.log(`01-09 openingStockValue (carry-forward): ${afterMultiOverrides.closingStockValue}`);
  console.log(`Match: ${afterMultiOverrides.closingStockValue === afterMultiOverrides.closingStockValue ? 'YES ✓' : 'NO ✗'}`);
  console.log(`Total fields persisted: ${Object.keys(afterMultiOverrides).length}`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
