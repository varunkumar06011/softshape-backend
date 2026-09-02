const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // 1. Check ALL __SUMMARY__ entries for 31-08 and 01-09
  console.log('=== 31-08 __SUMMARY__ entries ===');
  const entries31 = await prisma.liquorReportNonAcEntry.findMany({
    where: { reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
  });
  console.log('Count:', entries31.length);
  for (const e of entries31) {
    console.log(`  id=${e.id}, updatedAt=${e.updatedAt}`);
    try {
      const overrides = JSON.parse(e.notes || '{}');
      console.log('  Saved overrides:');
      for (const [key, val] of Object.entries(overrides)) {
        console.log(`    ${key} = ${val}`);
      }
    } catch (err) {
      console.log('  PARSE ERROR:', e.notes);
    }
  }

  console.log('\n=== 01-09 __SUMMARY__ entries ===');
  const entries01 = await prisma.liquorReportNonAcEntry.findMany({
    where: { reportDate: '2026-09-01', categoryName: '__SUMMARY__' },
  });
  console.log('Count:', entries01.length);
  for (const e of entries01) {
    console.log(`  id=${e.id}, updatedAt=${e.updatedAt}`);
    try {
      const overrides = JSON.parse(e.notes || '{}');
      console.log('  Saved overrides:');
      for (const [key, val] of Object.entries(overrides)) {
        console.log(`    ${key} = ${val}`);
      }
    } catch (err) {
      console.log('  PARSE ERROR:', e.notes);
    }
  }

  // 2. Check ALL liquorReportNonAcEntry for 31-08 (including non-summary)
  console.log('\n=== 31-08 ALL liquorReportNonAcEntry ===');
  const all31 = await prisma.liquorReportNonAcEntry.findMany({
    where: { reportDate: '2026-08-31' },
  });
  console.log('Count:', all31.length);
  for (const e of all31) {
    console.log(`  ${e.categoryName}: nonAcSales=${e.nonAcSales}, nonAcLandingCost=${e.nonAcLandingCost}`);
  }

  // 3. Check ALL liquorReportNonAcEntry for 01-09
  console.log('\n=== 01-09 ALL liquorReportNonAcEntry ===');
  const all01 = await prisma.liquorReportNonAcEntry.findMany({
    where: { reportDate: '2026-09-01' },
  });
  console.log('Count:', all01.length);
  for (const e of all01) {
    console.log(`  ${e.categoryName}: nonAcSales=${e.nonAcSales}, nonAcLandingCost=${e.nonAcLandingCost}`);
  }

  // 4. Check for duplicate __SUMMARY__ entries on any date
  console.log('\n=== Check for duplicate __SUMMARY__ entries ===');
  const duplicates = await prisma.liquorReportNonAcEntry.groupBy({
    by: ['reportDate'],
    where: { categoryName: '__SUMMARY__' },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });
  if (duplicates.length === 0) {
    console.log('  No duplicates found.');
  } else {
    for (const d of duplicates) {
      console.log(`  ${d.reportDate}: ${d._count.id} entries`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
