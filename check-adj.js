const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', entryDate: '2026-08-31' },
    select: { itemId: true, adjustedSaleBtl: true, adjustedSaleAmount: true, adjustedConsumption: true, adjustedProfit: true }
  });
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true },
    include: { menuItem: { select: { name: true } } }
  });
  const itemMap = new Map(items.map(i => [i.id, i]));
  let totalSA = 0, totalC = 0, totalP = 0;
  for (const a of adjs) {
    const name = itemMap.get(a.itemId)?.menuItem?.name || a.itemId.slice(-6);
    const sa = Number(a.adjustedSaleAmount);
    const c = Number(a.adjustedConsumption);
    const p = Number(a.adjustedProfit);
    totalSA += sa; totalC += c; totalP += p;
    console.log(name.padEnd(25), 'saleAmt=', String(sa).padStart(8), 'cons=', String(c).padStart(8), 'prof=', String(p).padStart(8));
  }
  console.log('\nTotals: saleAmt=', totalSA.toFixed(2), 'cons=', totalC.toFixed(2), 'prof=', totalP.toFixed(2));
  console.log('Expected: saleAmt=42885.00 cons=22230.60 prof=20654.40');
  await prisma.$disconnect();
}
main().catch(console.error);
