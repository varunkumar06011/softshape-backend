const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const reportDate = '2026-09-01';
  const prevDate = '2026-08-31';

  // Replicate the new logic
  const allItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: { menuItem: { include: { category: true } } },
  });

  const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
  const isSoftDrink = (inv) => {
    const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
    const itemName = String(inv.menuItem?.name || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };
  const filteredItems = allItems.filter(inv => !isSoftDrink(inv));

  const [todaySnaps, prevSnaps] = await Promise.all([
    prisma.dailyInventorySnapshot.findMany({ where: { snapshotDate: reportDate } }),
    prisma.dailyInventorySnapshot.findMany({ where: { snapshotDate: prevDate } }),
  ]);
  const todaySnapMap = new Map(todaySnaps.map(s => [s.itemId, s]));
  const prevSnapMap = new Map(prevSnaps.map(s => [s.itemId, s]));

  // Items with POS activity (simulated — would need actual POS data)
  // For now, just check which items would be included by the NEW logic
  const visibleItems = filteredItems.filter(inv => !inv.isHiddenFromReport);
  const hiddenItems = filteredItems.filter(inv => inv.isHiddenFromReport);

  console.log('=== NEW LOGIC: Items that would appear in 01-09 AC report ===');
  console.log(`Total filtered (liquor) items: ${filteredItems.length}`);
  console.log(`Visible: ${visibleItems.length}, Hidden: ${hiddenItems.length}`);

  // Check which visible items have snap or prevSnap
  const withTodaySnap = visibleItems.filter(inv => todaySnapMap.has(inv.id));
  const withPrevSnapOnly = visibleItems.filter(inv => !todaySnapMap.has(inv.id) && prevSnapMap.has(inv.id));
  const withNoSnap = visibleItems.filter(inv => !todaySnapMap.has(inv.id) && !prevSnapMap.has(inv.id));

  console.log(`\nVisible items with today's snapshot: ${withTodaySnap.length}`);
  console.log(`Visible items with ONLY prev day's snapshot: ${withPrevSnapOnly.length}`);
  console.log(`Visible items with NO snapshot: ${withNoSnap.length}`);

  // Show what the report would look like
  console.log('\n=== Items that WILL appear in 01-09 report (with stock) ===');
  let count = 0;
  for (const inv of visibleItems) {
    const snap = todaySnapMap.get(inv.id);
    const prevSnap = prevSnapMap.get(inv.id);
    if (!snap && !prevSnap) continue;
    count++;

    const openingMl = snap ? Number(snap.openingStock) : (prevSnap ? Number(prevSnap.closingStock) : 0);
    const closingMl = snap ? Number(snap.closingStock) : (prevSnap ? Number(prevSnap.closingStock) : 0);
    const soldMl = snap ? Number(snap.sold) : 0;
    const bottleSize = Number(inv.bottleSize) || 0;
    const openingBtl = bottleSize > 0 ? (openingMl / bottleSize).toFixed(2) : '0';
    const closingBtl = bottleSize > 0 ? (closingMl / bottleSize).toFixed(2) : '0';

    console.log(`  ${count}. ${inv.menuItem?.name} | ${bottleSize}ml | opening: ${openingBtl} btl (${openingMl}ml) | sold: ${soldMl}ml | closing: ${closingBtl} btl (${closingMl}ml)`);
  }
  console.log(`\nTotal items in 01-09 report: ${count}`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
