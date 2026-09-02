// Verify the 01-09-2026 AC report data for outlet Z3695J
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-09-01';

async function main() {
  // 1. Count adjustments
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: OUTLET_ID, entryDate: REPORT_DATE },
  });
  console.log(`AC Report Adjustments for ${REPORT_DATE}: ${adjs.length}`);

  // 2. Count manual items
  const manuals = await prisma.manualReportItem.findMany({
    where: { restaurantId: OUTLET_ID, reportDate: REPORT_DATE },
  });
  console.log(`Manual Report Items for ${REPORT_DATE}: ${manuals.length}`);

  // 3. Total count (should be 21)
  console.log(`Total AC entries: ${adjs.length + manuals.length} (expected 21)\n`);

  // 4. Verify totals
  let totalConsumption = 0;
  let totalSaleAmount = 0;
  let totalProfit = 0;

  console.log('=== AC Adjustments ===');
  for (const adj of adjs) {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: adj.itemId },
      include: { menuItem: true },
    });
    const name = item?.menuItem?.name || 'Unknown';
    const c = Number(adj.adjustedConsumption) || 0;
    const s = Number(adj.adjustedSaleAmount) || 0;
    const p = Number(adj.adjustedProfit) || 0;
    totalConsumption += c;
    totalSaleAmount += s;
    totalProfit += p;
    console.log(`  ${name}: sale=${adj.adjustedSaleBtl}, purchase=${adj.adjustedPurchaseCost}, selling=${adj.adjustedSellingPrice}, consumption=${c}, saleAmount=${s}, profit=${p}`);
  }

  console.log('\n=== Manual Items ===');
  for (const mi of manuals) {
    const c = Number(mi.consumption) || 0;
    const s = Number(mi.saleAmount) || 0;
    const p = Number(mi.profit) || 0;
    totalConsumption += c;
    totalSaleAmount += s;
    totalProfit += p;
    console.log(`  ${mi.itemName} [${mi.section}]: sale=${mi.sale}, purchase=${mi.purchaseCost}, selling=${mi.sellingPrice}, consumption=${c}, saleAmount=${s}, profit=${p}`);
  }

  console.log('\n=== TOTALS ===');
  console.log(`  Consumption: ${Math.round(totalConsumption * 100) / 100} (expected 14282.99)`);
  console.log(`  Sale Amount:  ${Math.round(totalSaleAmount * 100) / 100} (expected 27971.00)`);
  console.log(`  Profit:       ${Math.round(totalProfit * 100) / 100} (expected 13688.01)`);
  const pct = totalConsumption > 0 ? Math.round(totalProfit / totalConsumption * 10000) / 100 : 0;
  console.log(`  Profit %:     ${pct}% (expected ~96%)`);

  // 5. Verify no other outlet is affected
  const otherAdjs = await prisma.acReportAdjustment.findMany({
    where: { entryDate: REPORT_DATE, restaurantId: { not: OUTLET_ID } },
  });
  console.log(`\nOther outlets' adjustments for ${REPORT_DATE}: ${otherAdjs.length} (expected 0)`);

  // 6. Verify inventory master unchanged
  const invCount = await prisma.inventoryItem.count({ where: { restaurantId: OUTLET_ID } });
  console.log(`Inventory items count: ${invCount} (expected 235)`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
