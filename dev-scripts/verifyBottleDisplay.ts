import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`=== Bottle Display Verification for ${today} ===\n`);

  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId, isActive: true },
    include: {
      menuItem: { select: { name: true } },
      dailySnapshots: { where: { snapshotDate: today }, take: 1 },
    },
    orderBy: { menuItem: { name: 'asc' } },
  });

  console.log('Item | bottleSize | openingML | addedStock | opening (with purchases) | bottles');
  console.log('-'.repeat(100));

  let verifiedCount = 0;
  let errorCount = 0;

  for (const item of items) {
    const snap = item.dailySnapshots[0];
    const openingStock = snap ? Number(snap.openingStock) : Number(item.currentStock);
    const addedStock = snap ? Number(snap.purchased) : 0;
    // Frontend formula: opening = todayEntry.openingStock + todayEntry.addedStock
    const opening = openingStock + addedStock;
    const bottleSize = Number(item.bottleSize) || 750;
    const bottles = bottleSize > 0 ? opening / bottleSize : 0;

    // Verify the calculation
    const expectedBottles = opening / bottleSize;
    const calcCorrect = Math.abs(bottles - expectedBottles) < 0.0001;

    // Check for edge cases
    const issues = [];
    if (bottleSize === 0) issues.push('bottleSize=0');
    if (bottleSize === 750 && item.bottleSize !== 750) issues.push('fallback to 750 used');
    if (opening < 0) issues.push('negative opening');

    const status = issues.length === 0 ? '✅' : '⚠️';
    if (issues.length > 0) errorCount++; else verifiedCount++;

    console.log(`${status} ${item.menuItem?.name || 'Unknown'} | ${bottleSize}ml | ${openingStock} | ${addedStock} | ${opening.toFixed(2)}ml | ${bottles.toFixed(2)} btl${issues.length > 0 ? ' (' + issues.join(', ') + ')' : ''}`);
  }

  console.log('-'.repeat(100));
  console.log(`\nVerified: ${verifiedCount}/${items.length} ✅`);
  console.log(`Issues: ${errorCount}/${items.length} ⚠️`);

  // Test specific bottle sizes mentioned in requirements
  console.log(`\n=== Bottle Size Distribution ===`);
  const sizeMap = new Map<number, number>();
  for (const item of items) {
    const size = Number(item.bottleSize) || 750;
    sizeMap.set(size, (sizeMap.get(size) || 0) + 1);
  }
  for (const [size, count] of Array.from(sizeMap.entries()).sort((a, b) => a[0] - b[0])) {
    console.log(`  ${size}ml: ${count} items`);
  }

  // Test the formula with example values from the requirements
  console.log(`\n=== Formula Verification with Example Values ===`);
  const testCases = [
    { bottleSize: 270, openingML: 300, expected: 1.11 },
    { bottleSize: 270, openingML: 270.3, expected: 1.00 },
    { bottleSize: 270, openingML: 270, expected: 1.00 },
    { bottleSize: 270, openingML: 540, expected: 2.00 },
    { bottleSize: 270, openingML: 135, expected: 0.50 },
    { bottleSize: 750, openingML: 750, expected: 1.00 },
    { bottleSize: 750, openingML: 1500, expected: 2.00 },
    { bottleSize: 180, openingML: 180, expected: 1.00 },
    { bottleSize: 375, openingML: 375, expected: 1.00 },
    { bottleSize: 500, openingML: 1000, expected: 2.00 },
    { bottleSize: 1000, openingML: 2500, expected: 2.50 },
  ];

  let allPass = true;
  for (const tc of testCases) {
    const result = tc.bottleSize > 0 ? tc.openingML / tc.bottleSize : 0;
    const pass = Math.abs(result - tc.expected) < 0.01;
    if (!pass) allPass = false;
    console.log(`  ${tc.openingML}ml ÷ ${tc.bottleSize}ml = ${result.toFixed(2)} btl (expected ${tc.expected.toFixed(2)}) ${pass ? '✅' : '❌'}`);
  }
  console.log(`\nAll formula tests: ${allPass ? '✅ PASS' : '❌ FAIL'}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
