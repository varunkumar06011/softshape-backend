const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // 1. Check 31-08 snapshots — how many items, which have closing > 0
  const snap31 = await prisma.dailyInventorySnapshot.findMany({
    where: { snapshotDate: '2026-08-31' },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
  });
  console.log('=== 31-08 Snapshots ===');
  console.log('Total count:', snap31.length);
  const withClosing = snap31.filter(s => Number(s.closingStock) > 0);
  const withZero = snap31.filter(s => Number(s.closingStock) === 0);
  const withNegative = snap31.filter(s => Number(s.closingStock) < 0);
  console.log(`  closing > 0: ${withClosing.length}, closing = 0: ${withZero.length}, closing < 0: ${withNegative.length}`);

  // 2. Check 01-09 snapshots
  const snap01 = await prisma.dailyInventorySnapshot.findMany({
    where: { snapshotDate: '2026-09-01' },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
  });
  console.log('\n=== 01-09 Snapshots ===');
  console.log('Total count:', snap01.length);

  // 3. Check which 31-08 items DON'T have a 01-09 snapshot
  const snap31Ids = new Set(snap31.map(s => s.itemId));
  const snap01Ids = new Set(snap01.map(s => s.itemId));
  const missingIn01 = [...snap31Ids].filter(id => !snap01Ids.has(id));
  console.log(`\n31-08 items missing from 01-09 snapshots: ${missingIn01.length}`);
  for (const id of missingIn01.slice(0, 10)) {
    const s = snap31.find(x => x.itemId === id);
    console.log(`  ${s?.item?.menuItem?.name}: 31-08 closing=${s?.closingStock}ml`);
  }

  // 4. Check 01-09 snapshots that came from 31-08 (opening = 31-08 closing)
  console.log('\n=== 01-09 snapshots with opening from 31-08 closing ===');
  let matchCount = 0, mismatchCount = 0;
  for (const s01 of snap01) {
    const s31 = snap31.find(x => x.itemId === s01.itemId);
    if (!s31) continue;
    const closing31 = Number(s31.closingStock);
    const opening01 = Number(s01.openingStock);
    if (Math.abs(closing31 - opening01) < 0.01) {
      matchCount++;
    } else {
      mismatchCount++;
      if (mismatchCount <= 5) {
        console.log(`  MISMATCH: ${s01.item?.menuItem?.name}: 31-08 closing=${closing31}ml, 01-09 opening=${opening01}ml`);
      }
    }
  }
  console.log(`  Matched: ${matchCount}, Mismatched: ${mismatchCount}`);

  // 5. Check AC report adjustments for 31-08 (admin-entered values)
  const adj31 = await prisma.acReportAdjustment.findMany({
    where: { entryDate: '2026-08-31' },
  });
  console.log(`\n=== 31-08 AC Report Adjustments ===`);
  console.log('Count:', adj31.length);

  // 6. Check AC report adjustments for 01-09
  const adj01 = await prisma.acReportAdjustment.findMany({
    where: { entryDate: '2026-09-01' },
  });
  console.log(`\n=== 01-09 AC Report Adjustments ===`);
  console.log('Count:', adj01.length);

  // 7. Check which items have 31-08 adjustments but no 01-09 adjustment
  const adj31Ids = new Set(adj31.map(a => a.itemId));
  const adj01Ids = new Set(adj01.map(a => a.itemId));
  const missingAdj = [...adj31Ids].filter(id => !adj01Ids.has(id));
  console.log(`  31-08 adjustments missing from 01-09: ${missingAdj.length}`);

  // 8. Check isHiddenFromReport for all active items
  const allItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { id: true, isHiddenFromReport: true, currentStock: true, bottleSize: true, menuItem: { select: { name: true } } },
  });
  const visible = allItems.filter(i => !i.isHiddenFromReport);
  const hidden = allItems.filter(i => i.isHiddenFromReport);
  console.log(`\n=== Inventory Items ===`);
  console.log(`Total active: ${allItems.length}, Visible: ${visible.length}, Hidden: ${hidden.length}`);

  // 9. Check 01-09 snapshots for visible items — do they have opening stock?
  console.log('\n=== 01-09 snapshots for VISIBLE items ===');
  const visibleIds = new Set(visible.map(i => i.id));
  const snap01Visible = snap01.filter(s => visibleIds.has(s.itemId));
  console.log(`01-09 snapshots for visible items: ${snap01Visible.length} / ${visible.length}`);
  for (const s of snap01Visible.slice(0, 10)) {
    const s31 = snap31.find(x => x.itemId === s.itemId);
    console.log(`  ${s.item?.menuItem?.name}: opening=${s.openingStock}ml, sold=${s.sold}ml, closing=${s.closingStock}ml (31-08 closing: ${s31?.closingStock ?? 'NO SNAP'})`);
  }

  // 10. Check visible items that have NO 01-09 snapshot
  const snap01VisibleIds = new Set(snap01Visible.map(s => s.itemId));
  const visibleNoSnap01 = visible.filter(i => !snap01VisibleIds.has(i.id));
  console.log(`\nVisible items with NO 01-09 snapshot: ${visibleNoSnap01.length}`);
  for (const item of visibleNoSnap01.slice(0, 10)) {
    const s31 = snap31.find(x => x.itemId === item.id);
    console.log(`  ${item.menuItem?.name}: currentStock=${item.currentStock}ml, 31-08 closing=${s31?.closingStock ?? 'NO 31-08 SNAP'}ml`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
