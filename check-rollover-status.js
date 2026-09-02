const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // Check 31-08 snapshots for the 26 visible items
  const snap31 = await prisma.dailyInventorySnapshot.findMany({
    where: { snapshotDate: '2026-08-31' },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
    orderBy: { itemId: 'asc' },
  });

  console.log('=== 31-08 Snapshots ===');
  console.log('Count:', snap31.length);
  for (const s of snap31.slice(0, 10)) {
    console.log(`  ${s.item?.menuItem?.name}: opening=${s.openingStock}ml, purchased=${s.purchased}ml, sold=${s.sold}ml, closing=${s.closingStock}ml`);
  }
  console.log('  ...');

  // Check 01-09 snapshots
  const snap01 = await prisma.dailyInventorySnapshot.findMany({
    where: { snapshotDate: '2026-09-01' },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
    orderBy: { itemId: 'asc' },
  });

  console.log('\n=== 01-09 Snapshots ===');
  console.log('Count:', snap01.length);
  for (const s of snap01.slice(0, 10)) {
    console.log(`  ${s.item?.menuItem?.name}: opening=${s.openingStock}ml, purchased=${s.purchased}ml, sold=${s.sold}ml, closing=${s.closingStock}ml`);
  }

  // Check if 31-08 closing == 01-09 opening for matching items
  console.log('\n=== Rollover Check (31-08 closing → 01-09 opening) ===');
  const snap31Map = new Map(snap31.map(s => [s.itemId, s]));
  const snap01Map = new Map(snap01.map(s => [s.itemId, s]));
  let matchCount = 0, mismatchCount = 0, noNextSnap = 0;
  for (const [itemId, s31] of snap31Map) {
    const s01 = snap01Map.get(itemId);
    if (!s01) {
      noNextSnap++;
      continue;
    }
    const closing31 = Number(s31.closingStock);
    const opening01 = Number(s01.openingStock);
    if (Math.abs(closing31 - opening01) < 0.01) {
      matchCount++;
    } else {
      mismatchCount++;
      console.log(`  MISMATCH: ${s31.item?.menuItem?.name}: 31-08 closing=${closing31}ml, 01-09 opening=${opening01}ml`);
    }
  }
  console.log(`\nRollover: ${matchCount} matched, ${mismatchCount} mismatched, ${noNextSnap} no 01-09 snapshot`);

  // Check currentStock on InventoryItem (the live stock)
  console.log('\n=== Live currentStock vs 31-08 closing ===');
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, id: { in: Array.from(snap31Map.keys()) } },
    include: { menuItem: { select: { name: true } } },
  });
  for (const item of items.slice(0, 10)) {
    const s31 = snap31Map.get(item.id);
    const closing31 = s31 ? Number(s31.closingStock) : null;
    const current = Number(item.currentStock);
    const match = closing31 != null && Math.abs(closing31 - current) < 0.01;
    console.log(`  ${item.menuItem?.name}: currentStock=${current}ml, 31-08 closing=${closing31}ml ${match ? '✓' : '✗ MISMATCH'}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
