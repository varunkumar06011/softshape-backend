const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
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
  liquorItems.sort((a, b) => {
    const catCmp = (a.menuItem?.category?.name || '').localeCompare(b.menuItem?.category?.name || '');
    if (catCmp !== 0) return catCmp;
    return (a.menuItem?.name || '').localeCompare(b.menuItem?.name || '');
  });

  let sno = 1;
  for (const item of liquorItems) {
    console.log(`${sno}. ${item.menuItem?.name || 'Unknown'}`);
    sno++;
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
