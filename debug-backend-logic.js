const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-08-31';

async function main() {
  // Load all data the backend uses
  const [allItems, adjs, todaySnapshots, prevSnapshots] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId: RESTAURANT_ID, isActive: true },
      include: { menuItem: { include: { category: true, variants: true } } }
    }),
    prisma.acReportAdjustment.findMany({
      where: { restaurantId: RESTAURANT_ID, entryDate: REPORT_DATE }
    }),
    prisma.dailyInventorySnapshot.findMany({
      where: { restaurantId: RESTAURANT_ID, snapshotDate: REPORT_DATE }
    }),
    prisma.dailyInventorySnapshot.findMany({
      where: { restaurantId: RESTAURANT_ID, snapshotDate: '2026-08-30' }
    })
  ]);

  const itemMap = new Map(allItems.map(i => [i.id, i]));
  const adjMap = new Map(adjs.map(a => [a.itemId, a]));
  const todaySnapMap = new Map(todaySnapshots.map(s => [s.itemId, s]));
  const prevSnapMap = new Map(prevSnapshots.map(s => [s.itemId, s]));

  // Simulate backend's TWO passes for building acItems

  // PASS 1: Items with POS activity (systemConsumption.ml > 0 || acRevenue > 0)
  // For simplicity, we'll just check which items have snapshots
  const pass1Items = [];
  for (const inv of allItems) {
    const snap = todaySnapMap.get(inv.id);
    const hasPosActivity = snap && (Number(snap.systemConsumption) > 0 || Number(snap.sales) > 0);
    if (hasPosActivity) {
      pass1Items.push(inv);
    }
  }

  console.log('=== PASS 1: Items with POS/snapshot activity ===');
  console.log('Count:', pass1Items.length);
  for (const inv of pass1Items) {
    const adj = adjMap.get(inv.id);
    console.log('  ', inv.menuItem?.name, '| adjSaleAmt=', adj ? Number(adj.adjustedSaleAmount) : 'NO ADJ', '| hidden=', inv.isHiddenFromReport);
  }

  // PASS 2: Items WITHOUT POS activity but with adjustments
  const pass2Items = [];
  for (const inv of allItems) {
    const snap = todaySnapMap.get(inv.id);
    const hasPosActivity = snap && (Number(snap.systemConsumption) > 0 || Number(snap.sales) > 0);
    const adj = adjMap.get(inv.id);
    if (!hasPosActivity && adj) {
      pass2Items.push(inv);
    }
  }

  console.log('\n=== PASS 2: Items WITHOUT POS activity but WITH adjustments ===');
  console.log('Count:', pass2Items.length);
  for (const inv of pass2Items) {
    const adj = adjMap.get(inv.id);
    console.log('  ', inv.menuItem?.name, '| adjSaleAmt=', Number(adj.adjustedSaleAmount), '| hidden=', inv.isHiddenFromReport);
  }

  // Now simulate what the backend returns
  const acItems = [];

  // PASS 1 simulation
  for (const inv of pass1Items) {
    const adj = adjMap.get(inv.id);
    const saleAmount = adj?.adjustedSaleAmount != null ? Number(adj.adjustedSaleAmount) : 0;
    const consumption = adj?.adjustedConsumption != null ? Number(adj.adjustedConsumption) : 0;
    const profit = adj?.adjustedProfit != null ? Number(adj.adjustedProfit) : 0;
    acItems.push({
      itemName: inv.menuItem?.name,
      saleAmount,
      consumption,
      profit,
      isHidden: inv.isHiddenFromReport ?? false,
      source: 'pass1'
    });
  }

  // PASS 2 simulation
  for (const inv of pass2Items) {
    const adj = adjMap.get(inv.id);
    const saleAmount = adj?.adjustedSaleAmount != null ? Number(adj.adjustedSaleAmount) : 0;
    const consumption = adj?.adjustedConsumption != null ? Number(adj.adjustedConsumption) : 0;
    const profit = adj?.adjustedProfit != null ? Number(adj.adjustedProfit) : 0;
    acItems.push({
      itemName: inv.menuItem?.name,
      saleAmount,
      consumption,
      profit,
      isHidden: inv.isHiddenFromReport ?? false,
      source: 'pass2'
    });
  }

  console.log('\n=== ALL AC ITEMS ===');
  let totalSA = 0, totalCons = 0, totalProf = 0;
  for (const item of acItems) {
    console.log(
      (item.isHidden ? '[HIDDEN]' : '[VISIBLE]').padEnd(10),
      item.itemName.padEnd(25),
      'SA=', String(item.saleAmount).padStart(8),
      'Cons=', String(item.consumption).padStart(8),
      'Prof=', String(item.profit).padStart(8),
      'src=', item.source
    );
    if (!item.isHidden) {
      totalSA += item.saleAmount;
      totalCons += item.consumption;
      totalProf += item.profit;
    }
  }

  console.log('\n=== VISIBLE TOTALS ===');
  console.log('Sale Amount:', totalSA.toFixed(2), '(expected: 42885.00)');
  console.log('Consumption:', totalCons.toFixed(2), '(expected: 22230.59)');
  console.log('Profit:', totalProf.toFixed(2), '(expected: 20654.41)');

  // Check for extra items that might be adding to total
  console.log('\n=== Items adding to total that are NOT in the 26 image items ===');
  const IMAGE_NAMES = ['BUDWISER BEER','BLEDERSPRIDE','KINGFISHER ULTRA','KINGFISHER STRONG','COURRIER NAPOLEAN','BREEZER','BUDWISER MAGNUM','RED LABEL','MORPHEUS','VAT 69','KARJURA','ROYAL STAG','MORPHEUS BLUE','MANSION HOUSE','MC WHISKY','KYRON BRANDY','STOCK STRONG','IMPERIAL BLUE','BUDWISER MAGNUM TIN','100 PIPERS','SIGNATURE','MAGIC MOMENTS OR','ABSOLUTE','BACARDI CRANBERRY','BLACK LABEL'];
  for (const item of acItems) {
    if (item.isHidden) continue;
    const name = item.itemName?.toUpperCase() || '';
    const inImage = IMAGE_NAMES.some(n => name.includes(n) || n.includes(name));
    if (!inImage) {
      console.log('EXTRA:', item.itemName, 'SA=', item.saleAmount);
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
