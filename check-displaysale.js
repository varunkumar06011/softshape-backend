const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-08-31';

async function main() {
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: RESTAURANT_ID, entryDate: REPORT_DATE }
  });
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } }
  });
  const itemMap = new Map(items.map(i => [i.id, i]));

  console.log('=== Adjustment displaySale values ===');
  for (const a of adjs) {
    const name = itemMap.get(a.itemId)?.menuItem?.name || a.itemId.slice(-6);
    const saleBtl = Number(a.adjustedSaleBtl);
    let displaySale = null;
    if (a.notes) {
      try {
        const noteObj = JSON.parse(a.notes);
        displaySale = noteObj.displaySale;
      } catch {}
    }
    console.log(
      name.padEnd(25),
      'saleBtl=', String(saleBtl).padStart(8),
      'displaySale=', String(displaySale).padStart(6),
      'notes=', a.notes ? a.notes.slice(0, 60) : 'NULL'
    );
  }
  await prisma.$disconnect();
}
main().catch(console.error);
