// Verify the liquor report API excludes soft drinks/beverages
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const DATE = '2026-08-31';

(async () => {
  // Simulate the buildLiquorReportForDate filter logic
  const allItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { include: { category: true } } },
  });

  const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
  const isSoftDrink = (inv) => {
    const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
    const itemName = String(inv.menuItem?.name || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };

  const filtered = allItems.filter(inv => !isSoftDrink(inv));
  const excluded = allItems.filter(inv => isSoftDrink(inv));

  console.log(`=== AC Items Filter Result ===`);
  console.log(`Total active items: ${allItems.length}`);
  console.log(`Liquor items (included): ${filtered.length}`);
  console.log(`Soft drinks/beverages (excluded): ${excluded.length}`);
  console.log(`\nExcluded AC items:`);
  excluded.forEach(i => console.log(`  ${i.menuItem?.name} [${i.menuItem?.category?.name}]`));

  // Check Non-AC items
  const nonAcItems = await p.nonAcInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
  });

  const isNonAcSoftDrink = (item) => {
    const catName = String(item.category || '').toLowerCase();
    const itemName = String(item.itemName || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };

  const nonAcFiltered = nonAcItems.filter(i => !isNonAcSoftDrink(i));
  const nonAcExcluded = nonAcItems.filter(i => isNonAcSoftDrink(i));

  console.log(`\n=== Non-AC Items Filter Result ===`);
  console.log(`Total Non-AC items: ${nonAcItems.length}`);
  console.log(`Liquor items (included): ${nonAcFiltered.length}`);
  console.log(`Soft drinks/beverages (excluded): ${nonAcExcluded.length}`);
  console.log(`\nExcluded Non-AC items:`);
  nonAcExcluded.forEach(i => console.log(`  ${i.itemName} [${i.category}]`));

  await p.$disconnect();
})();
