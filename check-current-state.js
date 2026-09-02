const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-08-31';

async function main() {
  // 1. Check all AC items and their hidden status
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: true },
  });
  
  console.log('=== ALL INVENTORY ITEMS ===');
  console.log('Total items:', items.length);
  
  const visible = items.filter(i => !i.isHiddenFromReport);
  const hidden = items.filter(i => i.isHiddenFromReport);
  
  console.log('Visible:', visible.length);
  console.log('Hidden:', hidden.length);
  
  console.log('\n=== VISIBLE ITEMS ===');
  for (const item of visible) {
    console.log(item.id.slice(-6), item.menuItem?.name || 'Unknown', 'hidden=', item.isHiddenFromReport);
  }
  
  // 2. Check AcReportAdjustment values for visible items
  const adjustments = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: RESTAURANT_ID, entryDate: REPORT_DATE },
  });
  
  console.log('\n=== AC REPORT ADJUSTMENTS ===');
  console.log('Total adjustments:', adjustments.length);
  
  for (const adj of adjustments) {
    const item = items.find(i => i.id === adj.itemId);
    const name = item?.menuItem?.name || adj.itemId.slice(-6);
    let displaySale = null;
    try {
      const n = JSON.parse(adj.notes || '{}');
      displaySale = n.displaySale;
    } catch {}
    console.log(
      name.padEnd(25),
      'saleBtl=', String(Number(adj.adjustedSaleBtl)).padStart(6),
      'displaySale=', String(displaySale).padStart(6),
      'saleAmount=', String(Number(adj.adjustedSaleAmount)).padStart(8),
      'consumption=', String(Number(adj.adjustedConsumption)).padStart(8),
      'profit=', String(Number(adj.adjustedProfit)).padStart(8),
    );
  }
  
  // 3. Check daily snapshots
  const snapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: REPORT_DATE },
  });
  
  console.log('\n=== DAILY SNAPSHOTS ===');
  console.log('Total snapshots:', snapshots.length);
  
  for (const snap of snapshots) {
    const item = items.find(i => i.id === snap.itemId);
    const name = item?.menuItem?.name || snap.itemName || snap.itemId.slice(-6);
    console.log(
      name.padEnd(25),
      'sold=', String(Number(snap.sold)).padStart(6),
      'closing=', String(Number(snap.closingStock)).padStart(8),
    );
  }
  
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
