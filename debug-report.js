const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-08-31';

async function main() {
  // Get all adjustments
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: RESTAURANT_ID, entryDate: REPORT_DATE },
  });
  
  // Get all inventory items
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true, category: { select: { name: true } } } } }
  });
  
  const itemMap = new Map(items.map(i => [i.id, i]));
  const adjMap = new Map(adjs.map(a => [a.itemId, a]));
  
  // Check which image items have adjustments
  const IMAGE_NAMES = [
    'BUDWISER BEER','BLEDERSPRIDE','KINGFISHER ULTRA','KINGFISHER STRONG',
    'COURRIER NAPOLEAN','BREEZER','BUDWISER MAGNUM','RED LABEL','MORPHEUS',
    'VAT 69','KARJURA','ROYAL STAG','MORPHEUS BLUE','MANSION HOUSE',
    'MC WHISKY','KYRON BRANDY','STOCK STRONG','IMPERIAL BLUE',
    'BUDWISER MAGNUM TIN','100 PIPERS','SIGNATURE','MAGIC MOMENTS OR',
    'ABSOLUTE','BACARDI CRANBERRY','BLACK LABEL'
  ];
  
  console.log('=== Items with adjustments ===\n');
  let totalSA = 0, totalCons = 0, totalProf = 0;
  
  for (const adj of adjs) {
    const item = itemMap.get(adj.itemId);
    const name = item?.menuItem?.name || 'Unknown';
    const isImage = IMAGE_NAMES.some(n => name.toUpperCase().includes(n) || n.includes(name.toUpperCase()));
    const sa = Number(adj.adjustedSaleAmount) || 0;
    const c = Number(adj.adjustedConsumption) || 0;
    const p = Number(adj.adjustedProfit) || 0;
    totalSA += sa; totalCons += c; totalProf += p;
    console.log(
      (isImage ? '[IMG] ' : '[extra] ').padEnd(8),
      name.padEnd(25),
      'sale=', String(Number(adj.adjustedSaleBtl)).padStart(6),
      'pc=', String(Number(adj.adjustedPurchaseCost)).padStart(8),
      'cons=', String(c).padStart(8),
      'sp=', String(Number(adj.adjustedSellingPrice)).padStart(6),
      'SA=', String(sa).padStart(8),
      'prof=', String(p).padStart(8),
      'hidden=', item?.isHiddenFromReport ?? '?'
    );
  }
  
  console.log('\n=== Totals from adjustments ===');
  console.log('Sale Amount:', totalSA.toFixed(2));
  console.log('Consumption:', totalCons.toFixed(2));
  console.log('Profit:', totalProf.toFixed(2));
  
  // Check if any items are NOT hidden but have zero adjustment
  console.log('\n=== Visible items without adjustment ===');
  for (const item of items) {
    if (!item.isHiddenFromReport && !adjMap.has(item.id)) {
      console.log('Visible but no adj:', item.menuItem?.name || 'Unknown');
    }
  }
  
  // Check if any adjusted items are hidden
  console.log('\n=== Adjusted items that are HIDDEN ===');
  for (const adj of adjs) {
    const item = itemMap.get(adj.itemId);
    if (item?.isHiddenFromReport) {
      console.log('HIDDEN with adj:', item.menuItem?.name, 'SA=', Number(adj.adjustedSaleAmount));
    }
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);
