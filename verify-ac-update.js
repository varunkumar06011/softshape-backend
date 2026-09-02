const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const reportDate = '2026-08-31';
  console.log('=== Verifying AC items for', reportDate, '===\n');

  // Get all active inventory items
  const allItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: { menuItem: { select: { name: true, category: { select: { name: true } } } } },
  });

  const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
  const isSoftDrink = (inv) => {
    const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
    const itemName = String(inv.menuItem?.name || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };
  const liquorItems = allItems.filter(inv => !isSoftDrink(inv));

  // Get snapshots for the date
  const snapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { snapshotDate: reportDate },
  });
  const snapMap = new Map(snapshots.map(s => [s.itemId, s]));

  // Count visible vs hidden
  const visible = liquorItems.filter(i => !i.isHiddenFromReport);
  const hidden = liquorItems.filter(i => i.isHiddenFromReport);

  console.log('Total liquor items:', liquorItems.length);
  console.log('Visible (isHiddenFromReport=false):', visible.length);
  console.log('Hidden (isHiddenFromReport=true):', hidden.length);
  console.log('');

  // Show visible items with their snapshot data
  console.log('=== VISIBLE ITEMS (will appear in report) ===');
  let sno = 1;
  for (const item of visible) {
    const snap = snapMap.get(item.id);
    const soldMl = snap ? Number(snap.sold) : 0;
    const btlSize = Number(item.bottleSize) || 0;
    const soldBtl = btlSize > 0 ? (soldMl / btlSize).toFixed(2) : '0';
    const acSellingPrice = item.acSellingPrice ? Number(item.acSellingPrice) : 0;
    const costPerBottle = item.costPerBottle ? Number(item.costPerBottle) : 0;
    console.log(`${sno}. ${item.menuItem?.name} | ${btlSize}ml | sold: ${soldBtl} btl (${soldMl}ml) | selling: Rs${acSellingPrice} | cost: Rs${costPerBottle}`);
    sno++;
  }

  // Check if any hidden items still have sold > 0 (would show in report despite being hidden)
  console.log('');
  console.log('=== HIDDEN ITEMS WITH SOLD > 0 (problem!) ===');
  let problemCount = 0;
  for (const item of hidden) {
    const snap = snapMap.get(item.id);
    const soldMl = snap ? Number(snap.sold) : 0;
    if (soldMl > 0) {
      console.log(`⚠ ${item.menuItem?.name} | sold: ${soldMl}ml | HIDDEN but has sales!`);
      problemCount++;
    }
  }
  if (problemCount === 0) console.log('None - all good!');

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
