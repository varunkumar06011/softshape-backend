// Fetch the actual API response for 01-09-2026 AC report for Z3695J
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-09-01';

async function main() {
  // 1. Get all AC adjustments
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: OUTLET_ID, entryDate: REPORT_DATE },
  });
  console.log(`=== AC Adjustments: ${adjs.length} ===\n`);

  // 2. For each adjustment, check the inventory item's master values
  for (const adj of adjs) {
    const inv = await prisma.inventoryItem.findUnique({
      where: { id: adj.itemId },
      include: { menuItem: { include: { variants: true } } },
    });
    if (!inv) {
      console.log(`MISSING INV: itemId=${adj.itemId}`);
      continue;
    }
    const adjPurch = adj.adjustedPurchaseCost != null ? Number(adj.adjustedPurchaseCost) : null;
    const adjSell = adj.adjustedSellingPrice != null ? Number(adj.adjustedSellingPrice) : null;
    const adjCons = adj.adjustedConsumption != null ? Number(adj.adjustedConsumption) : null;
    const adjSaleAmt = adj.adjustedSaleAmount != null ? Number(adj.adjustedSaleAmount) : null;
    const adjProfit = adj.adjustedProfit != null ? Number(adj.adjustedProfit) : null;
    const adjSale = adj.adjustedSaleBtl != null ? Number(adj.adjustedSaleBtl) : null;

    const masterPurch = Number(inv.costPerBottle) || 0;
    const masterSell = inv.acSellingPrice ? Number(inv.acSellingPrice) : 0;
    const masterBottleSize = inv.bottleSize || 0;

    // Check if adjustment values match what we expect
    const purchMatch = adjPurch === masterPurch;
    const sellMatch = adjSell === masterSell;

    console.log(`${inv.menuItem?.name} (bottleSize=${masterBottleSize})`);
    console.log(`  ADJ: sale=${adjSale}, purch=${adjPurch}, sell=${adjSell}, cons=${adjCons}, saleAmt=${adjSaleAmt}, profit=${adjProfit}`);
    console.log(`  MASTER: purch=${masterPurch}, sell=${masterSell}`);
    if (!purchMatch) console.log(`  ⚠ PURCHASE COST MISMATCH: adj=${adjPurch} vs master=${masterPurch}`);
    if (!sellMatch) console.log(`  ⚠ SELLING PRICE MISMATCH: adj=${adjSell} vs master=${masterSell}`);

    // Check if the adjustment consumption = sale * purchaseCost
    if (adjSale != null && adjPurch != null && adjCons != null) {
      const expectedCons = Math.round(adjSale * adjPurch * 100) / 100;
      if (Math.abs(expectedCons - adjCons) > 0.01) {
        console.log(`  ⚠ CONSUMPTION CHECK: sale*purch=${expectedCons} vs adjCons=${adjCons} (diff=${expectedCons - adjCons})`);
      }
    }
    // Check if saleAmount = sale * sellingPrice
    if (adjSale != null && adjSell != null && adjSaleAmt != null) {
      const expectedSaleAmt = Math.round(adjSale * adjSell * 100) / 100;
      if (Math.abs(expectedSaleAmt - adjSaleAmt) > 0.01) {
        console.log(`  ⚠ SALE AMOUNT CHECK: sale*sell=${expectedSaleAmt} vs adjSaleAmt=${adjSaleAmt} (diff=${expectedSaleAmt - adjSaleAmt})`);
      }
    }
    // Check if profit = saleAmount - consumption
    if (adjSaleAmt != null && adjCons != null && adjProfit != null) {
      const expectedProfit = Math.round((adjSaleAmt - adjCons) * 100) / 100;
      if (Math.abs(expectedProfit - adjProfit) > 0.01) {
        console.log(`  ⚠ PROFIT CHECK: saleAmt-cons=${expectedProfit} vs adjProfit=${adjProfit} (diff=${expectedProfit - adjProfit})`);
      }
    }
    console.log();
  }

  // 3. Get manual items
  const manuals = await prisma.manualReportItem.findMany({
    where: { restaurantId: OUTLET_ID, reportDate: REPORT_DATE },
  });
  console.log(`=== Manual Items: ${manuals.length} ===`);
  for (const mi of manuals) {
    console.log(`  ${mi.itemName} [${mi.section}]: sale=${mi.sale}, purch=${mi.purchaseCost}, sell=${mi.sellingPrice}, cons=${mi.consumption}, saleAmt=${mi.saleAmount}, profit=${mi.profit}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
