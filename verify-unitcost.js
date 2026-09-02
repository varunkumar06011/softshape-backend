// Verify unitCost logic matches reference values
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-09-01';

// Replicate the backend's isSpirit/isBeer/unitCost logic
function isBeerItem(menuItem) {
  if (!menuItem) return false;
  const catName = String(menuItem.category?.name || '').toLowerCase();
  const itemName = String(menuItem.name || '').toLowerCase();
  return catName.includes('beer') || itemName.includes('beer') ||
         itemName.includes('bud') || itemName.includes('kingfisher') ||
         itemName.includes('stock') || itemName.includes('storm') ||
         itemName.includes('breezer');
}

async function main() {
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: OUTLET_ID, entryDate: REPORT_DATE },
  });

  console.log('=== Unit Cost Verification ===\n');
  let totalCons = 0, totalSaleAmt = 0, totalProfit = 0;

  for (const adj of adjs) {
    const inv = await prisma.inventoryItem.findUnique({
      where: { id: adj.itemId },
      include: { menuItem: { include: { category: true, variants: true } } },
    });
    if (!inv) continue;

    const bottleSize = inv.bottleSize ? Number(inv.bottleSize) : 0;
    const purchaseCost = adj.adjustedPurchaseCost != null ? Number(adj.adjustedPurchaseCost) : Number(inv.costPerBottle);
    const sellingPrice = adj.adjustedSellingPrice != null ? Number(adj.adjustedSellingPrice) : 0;
    const sale = adj.adjustedSaleBtl != null ? Number(adj.adjustedSaleBtl) : 0;

    const isBeer = isBeerItem(inv.menuItem);
    const isSpirit = !isBeer && (inv.menuItem?.variants?.some(v => v.name.trim().toLowerCase() === '30ml') || bottleSize <= 60);
    const effectiveBottleSize = isSpirit ? (bottleSize <= 60 ? 750 : bottleSize) : bottleSize;
    const unitCost = isSpirit
      ? Math.round((purchaseCost * 30 / effectiveBottleSize) * 1000000) / 1000000
      : purchaseCost;

    const calcConsumption = Math.round(sale * unitCost * 100) / 100;
    const calcSaleAmount = Math.round(sale * sellingPrice * 100) / 100;
    const calcProfit = Math.round((calcSaleAmount - calcConsumption) * 100) / 100;

    const adjConsumption = Number(adj.adjustedConsumption);
    const adjSaleAmount = Number(adj.adjustedSaleAmount);
    const adjProfit = Number(adj.adjustedProfit);

    totalCons += adjConsumption;
    totalSaleAmt += adjSaleAmount;
    totalProfit += adjProfit;

    const consMatch = Math.abs(calcConsumption - adjConsumption) < 0.01;
    const saleMatch = Math.abs(calcSaleAmount - adjSaleAmount) < 0.01;
    const profitMatch = Math.abs(calcProfit - adjProfit) < 0.01;

    const status = (consMatch && saleMatch && profitMatch) ? '✓' : '⚠';
    console.log(`${status} ${inv.menuItem?.name} (btl=${bottleSize}, ${isSpirit ? 'SPIRIT' : isBeer ? 'BEER' : 'OTHER'})`);
    console.log(`  unitCost=${unitCost}, sale=${sale}`);
    console.log(`  calc: cons=${calcConsumption}, saleAmt=${calcSaleAmount}, profit=${calcProfit}`);
    console.log(`  adj:  cons=${adjConsumption}, saleAmt=${adjSaleAmount}, profit=${adjProfit}`);
    if (!consMatch) console.log(`  ⚠ CONSUMPTION DIFF: ${calcConsumption - adjConsumption}`);
    if (!saleMatch) console.log(`  ⚠ SALEAMT DIFF: ${calcSaleAmount - adjSaleAmount}`);
    if (!profitMatch) console.log(`  ⚠ PROFIT DIFF: ${calcProfit - adjProfit}`);
    console.log();
  }

  // Add manual item
  const manuals = await prisma.manualReportItem.findMany({
    where: { restaurantId: OUTLET_ID, reportDate: REPORT_DATE, section: 'AC' },
  });
  for (const mi of manuals) {
    totalCons += Number(mi.consumption);
    totalSaleAmt += Number(mi.saleAmount);
    totalProfit += Number(mi.profit);
    console.log(`✓ ${mi.itemName} [MANUAL]: cons=${mi.consumption}, saleAmt=${mi.saleAmount}, profit=${mi.profit}`);
  }

  console.log(`\n=== TOTALS ===`);
  console.log(`  Consumption: ${Math.round(totalCons * 100) / 100} (expected 14282.99)`);
  console.log(`  Sale Amount:  ${Math.round(totalSaleAmt * 100) / 100} (expected 27971.00)`);
  console.log(`  Profit:       ${Math.round(totalProfit * 100) / 100} (expected 13688.01)`);
  console.log(`  Profit %:     ${Math.round(totalProfit / totalCons * 10000) / 100}% (expected ~96%)`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
