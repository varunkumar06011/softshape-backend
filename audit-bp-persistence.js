const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // 1. Check saved summary overrides for 31-08 and 01-09
  const entries31 = await prisma.liquorReportNonAcEntry.findMany({
    where: { reportDate: '2026-08-31' },
  });
  const entries01 = await prisma.liquorReportNonAcEntry.findMany({
    where: { reportDate: '2026-09-01' },
  });

  console.log('=== 31-08 LiquorReportNonAcEntry ===');
  console.log('Count:', entries31.length);
  for (const e of entries31) {
    if (e.categoryName === '__SUMMARY__') {
      console.log('  __SUMMARY__ override:');
      try {
        const overrides = JSON.parse(e.notes || '{}');
        for (const [key, val] of Object.entries(overrides)) {
          console.log(`    ${key} = ${val}`);
        }
      } catch (err) {
        console.log('    PARSE ERROR:', e.notes);
      }
    } else {
      console.log(`  ${e.categoryName}: nonAcSales=${e.nonAcSales}, nonAcLandingCost=${e.nonAcLandingCost}`);
    }
  }

  console.log('\n=== 01-09 LiquorReportNonAcEntry ===');
  console.log('Count:', entries01.length);
  for (const e of entries01) {
    if (e.categoryName === '__SUMMARY__') {
      console.log('  __SUMMARY__ override:');
      try {
        const overrides = JSON.parse(e.notes || '{}');
        for (const [key, val] of Object.entries(overrides)) {
          console.log(`    ${key} = ${val}`);
        }
      } catch (err) {
        console.log('    PARSE ERROR:', e.notes);
      }
    } else {
      console.log(`  ${e.categoryName}: nonAcSales=${e.nonAcSales}, nonAcLandingCost=${e.nonAcLandingCost}`);
    }
  }

  // 2. Check if there are MULTIPLE __SUMMARY__ records for the same date (duplicate bug)
  const allSummaryEntries = await prisma.liquorReportNonAcEntry.findMany({
    where: { categoryName: '__SUMMARY__' },
    orderBy: { reportDate: 'desc' },
    take: 10,
  });
  console.log('\n=== Recent __SUMMARY__ entries (check for duplicates) ===');
  for (const e of allSummaryEntries) {
    console.log(`  date=${e.reportDate}, id=${e.id}, updatedAt=${e.updatedAt}`);
  }

  // 3. Check what the combined API would return for openingStockValue on 01-09
  // Simulate: sum(openingStock × costPerBottle) for all items with snapshots on 01-09
  const snap01 = await prisma.dailyInventorySnapshot.findMany({
    where: { snapshotDate: '2026-09-01' },
    include: { item: { select: { costPerBottle: true, menuItem: { select: { name: true } } } } },
  });
  let computedOpeningValue = 0;
  for (const s of snap01) {
    const cost = Number(s.item?.costPerBottle || 0);
    const opening = Number(s.openingStock || 0);
    computedOpeningValue += opening * cost;
  }
  console.log('\n=== Computed openingStockValue for 01-09 (from snapshots) ===');
  console.log(`  sum(openingStock × costPerBottle) = ₹${Math.round(computedOpeningValue * 100) / 100}`);

  // 4. Check what 31-08's saved closingStockValue override is
  const summary31 = entries31.find(e => e.categoryName === '__SUMMARY__');
  if (summary31) {
    try {
      const overrides = JSON.parse(summary31.notes || '{}');
      console.log(`\n=== 31-08 saved closingStockValue ===`);
      console.log(`  closingStockValue = ${overrides.closingStockValue ?? 'NOT SAVED'}`);
      console.log(`  openingStockValue = ${overrides.openingStockValue ?? 'NOT SAVED'}`);
    } catch {}
  } else {
    console.log('\n=== 31-08 has NO __SUMMARY__ override ===');
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
