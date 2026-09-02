// Final end-to-end verification: simulate the exact API response
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-09-01';

const SPIRIT_CATEGORIES = ['brandy', 'whisky', 'whiskey', 'rum', 'vodka', 'wine', 'gin', 'tequila', 'scotch', 'liquor', 'spirit'];

function isBeerItem(item) {
  if (!item) return false;
  const categoryObj = item.category;
  let category = '';
  if (categoryObj && typeof categoryObj === 'object' && 'name' in categoryObj) {
    category = String(categoryObj.name || '').toLowerCase();
  }
  if (category.includes('beer')) return true;
  const name = String(item.name || '').toLowerCase();
  const beerKeywords = ['beer', 'lager', 'ale', 'bira', 'carlsberg', 'budweiser', 'kingfisher', 'kf', 'coolberg', 'stok', 'draught'];
  return beerKeywords.some(keyword => name.includes(keyword));
}

function isSpiritItem(item, bottleSize) {
  if (!item) return false;
  if (isBeerItem(item)) return false;
  if (bottleSize != null && bottleSize === 180) return false;
  const variants = item.variants || [];
  if (variants.some(v => v.name.trim().toLowerCase() === '30ml')) return true;
  if (bottleSize != null && bottleSize <= 60) return true;
  const categoryObj = item.category;
  let category = '';
  if (categoryObj && typeof categoryObj === 'object' && 'name' in categoryObj) {
    category = String(categoryObj.name || '').toLowerCase();
  }
  if (bottleSize != null && bottleSize < 375 && bottleSize > 60) return false;
  return SPIRIT_CATEGORIES.some(cat => category.includes(cat));
}

async function main() {
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: OUTLET_ID, entryDate: REPORT_DATE },
  });
  const manuals = await prisma.manualReportItem.findMany({
    where: { restaurantId: OUTLET_ID, reportDate: REPORT_DATE, section: 'AC' },
  });

  console.log('=== FINAL E2E VERIFICATION: API Response Simulation ===\n');
  console.log('S.No | Item Name | Qty | Sale | Purchase | 30ML Purch | Consumption | Selling | Sale Amt | Profit | Type');
  console.log('-'.repeat(140));

  let totalCons = 0, totalSaleAmt = 0, totalProfit = 0;
  const rows = [];

  for (const adj of adjs) {
    const inv = await prisma.inventoryItem.findUnique({
      where: { id: adj.itemId },
      include: { menuItem: { include: { category: true, variants: true } } },
    });
    if (!inv) continue;

    const bottleSize = inv.bottleSize ? Number(inv.bottleSize) : 0;
    const isBeer = isBeerItem(inv.menuItem);
    const isSpirit = isSpiritItem(inv.menuItem, bottleSize);
    const effectiveBottleSize = isSpirit ? 750 : bottleSize;
    const purchaseCost = adj.adjustedPurchaseCost != null ? Number(adj.adjustedPurchaseCost) : 0;
    const unitCost = isSpirit
      ? Math.round((purchaseCost * 30 / effectiveBottleSize) * 1000000) / 1000000
      : purchaseCost;

    // Simulate the API response fields
    const finalSale = adj.adjustedSaleBtl != null ? Number(adj.adjustedSaleBtl) : 0;
    const finalPurchaseCost = purchaseCost;
    const finalSellingPrice = adj.adjustedSellingPrice != null ? Number(adj.adjustedSellingPrice) : 0;
    const finalConsumption = adj.adjustedConsumption != null ? Number(adj.adjustedConsumption) : 0;
    const finalSaleAmount = adj.adjustedSaleAmount != null ? Number(adj.adjustedSaleAmount) : 0;
    const finalProfit = adj.adjustedProfit != null ? Number(adj.adjustedProfit) : 0;
    // With the fix: displaySale = finalSale when adj exists
    const displaySale = finalSale;

    const type = isSpirit ? 'SPIRIT' : isBeer ? 'BEER' : 'OTHER';
    const ml30 = isSpirit ? unitCost : purchaseCost;

    rows.push({
      name: inv.menuItem?.name,
      qty: bottleSize,
      sale: displaySale,
      purchase: finalPurchaseCost,
      ml30: ml30,
      consumption: finalConsumption,
      selling: finalSellingPrice,
      saleAmount: finalSaleAmount,
      profit: finalProfit,
      type,
    });

    totalCons += finalConsumption;
    totalSaleAmt += finalSaleAmount;
    totalProfit += finalProfit;
  }

  // Add manual items
  for (const mi of manuals) {
    rows.push({
      name: mi.itemName + ' [MANUAL]',
      qty: Number(mi.qty) || 0,
      sale: Number(mi.sale) || 0,
      purchase: Number(mi.purchaseCost) || 0,
      ml30: Number(mi.purchaseCost) || 0,
      consumption: Number(mi.consumption) || 0,
      selling: Number(mi.sellingPrice) || 0,
      saleAmount: Number(mi.saleAmount) || 0,
      profit: Number(mi.profit) || 0,
      type: 'MANUAL',
    });
    totalCons += Number(mi.consumption) || 0;
    totalSaleAmt += Number(mi.saleAmount) || 0;
    totalProfit += Number(mi.profit) || 0;
  }

  // Print all rows
  rows.forEach((r, i) => {
    console.log(`${String(i+1).padStart(4)} | ${r.name.padEnd(30)} | ${String(r.qty).padStart(4)} | ${String(r.sale).padStart(5)} | ${String(r.purchase).padStart(10)} | ${String(r.ml30).padStart(10)} | ${String(r.consumption).padStart(11)} | ${String(r.selling).padStart(7)} | ${String(r.saleAmount).padStart(8)} | ${String(r.profit).padStart(8)} | ${r.type}`);
  });

  console.log('-'.repeat(140));
  console.log(`     | ${'TOTALS'.padEnd(30)} |      |       |            |            | ${String(Math.round(totalCons*100)/100).padStart(11)} |         | ${String(Math.round(totalSaleAmt*100)/100).padStart(8)} | ${String(Math.round(totalProfit*100)/100).padStart(8)} |`);
  console.log(`\n  Consumption: ${Math.round(totalCons*100)/100} (expected 14282.99) ${Math.round(totalCons*100)/100 === 14282.99 ? '✓' : '✗'}`);
  console.log(`  Sale Amount:  ${Math.round(totalSaleAmt*100)/100} (expected 27971.00) ${Math.round(totalSaleAmt*100)/100 === 27971 ? '✓' : '✗'}`);
  console.log(`  Profit:       ${Math.round(totalProfit*100)/100} (expected 13688.01) ${Math.round(totalProfit*100)/100 === 13688.01 ? '✓' : '✗'}`);
  const pct = Math.round(totalProfit / totalCons * 10000) / 100;
  console.log(`  Profit %:     ${pct}% (expected ~96%) ${pct >= 95 && pct <= 96 ? '✓' : '✗'}`);

  // Verify: each item's consumption = sale × unitCost (or ml30)
  console.log('\n=== Per-item calculation verification ===');
  let allOk = true;
  rows.forEach((r, i) => {
    const calcCons = Math.round(r.sale * r.ml30 * 100) / 100;
    const calcSaleAmt = Math.round(r.sale * r.selling * 100) / 100;
    const calcProfit = Math.round((calcSaleAmt - calcCons) * 100) / 100;
    const consOk = Math.abs(calcCons - r.consumption) < 0.01;
    const saleOk = Math.abs(calcSaleAmt - r.saleAmount) < 0.01;
    const profitOk = Math.abs(calcProfit - r.profit) < 0.01;
    if (!consOk || !saleOk || !profitOk) {
      allOk = false;
      console.log(`  ✗ ${r.name}: cons=${calcCons} vs ${r.consumption}, saleAmt=${calcSaleAmt} vs ${r.saleAmount}, profit=${calcProfit} vs ${r.profit}`);
    }
  });
  if (allOk) console.log('  All 21 items: consumption = sale × unitCost, saleAmount = sale × sellingPrice, profit = saleAmount − consumption ✓');

  // Verify: no negative values
  const negatives = rows.filter(r => r.consumption < 0 || r.saleAmount < 0 || r.profit < 0);
  console.log(`\n  Negative values: ${negatives.length === 0 ? 'NONE ✓' : negatives.map(r => r.name).join(', ')}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
