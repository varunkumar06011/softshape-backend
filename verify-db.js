const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', entryDate: '2026-08-31' },
  });
  console.log('Adjustments:', adjs.length);
  
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true },
    include: { menuItem: true }
  });
  const itemMap = new Map(items.map(i => [i.id, i]));
  
  for (const a of adjs.slice(0, 10)) {
    const item = itemMap.get(a.itemId);
    const name = item?.menuItem?.name || a.itemId.slice(-6);
    console.log(name.padEnd(25), 'saleBtl=', String(Number(a.adjustedSaleBtl)).padStart(6), 'saleAmount=', String(Number(a.adjustedSaleAmount)).padStart(8));
  }
  
  const visibleItems = items.filter(i => !i.isHiddenFromReport);
  console.log('\nVisible items:', visibleItems.length);
  for (const i of visibleItems.slice(0, 15)) {
    console.log(i.menuItem?.name || 'Unknown');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
