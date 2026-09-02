const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-09-01';

// Replicate the updated isSpiritItem logic
const SPIRIT_CATEGORIES = [
  'brandy', 'whisky', 'whiskey', 'rum', 'vodka', 'wine', 'gin',
  'tequila', 'scotch', 'liquor', 'spirit',
];

function isBeerItem(item) {
  if (!item) return false;
  const categoryObj = item.category;
  let category = '';
  if (categoryObj && typeof categoryObj === 'object' && 'name' in categoryObj) {
    category = String(categoryObj.name || '').toLowerCase();
  } else if (typeof categoryObj === 'string') {
    category = categoryObj.toLowerCase();
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

  console.log('=== Unit Cost Verification (with isSpiritItem) ===\n');
  let totalCons = 0, totalSaleAmt = 0, totalProfit = 0;
  let allMatch = true;

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
    const isSpirit = isSpiritItem(inv.menuItem, bottleSize);
    const effectiveBottleSize = isSpirit ? 750 : bottleSize;
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
    if (status === '⚠') allMatch = false;
    const type = isSpirit ? 'SPIRIT' : isBeer ? 'BEER' : 'OTHER';
    console.log(`${status} ${inv.menuItem?.name} (btl=${bottleSize}, ${type}, unitCost=${unitCost})`);
    if (!consMatch) console.log(`  ⚠ CONSUMPTION: calc=${calcConsumption} vs adj=${adjConsumption} (diff=${calcConsumption - adjConsumption})`);
    if (!saleMatch) console.log(`  ⚠ SALEAMT: calc=${calcSaleAmount} vs adj=${adjSaleAmount}`);
    if (!profitMatch) console.log(`  ⚠ PROFIT: calc=${calcProfit} vs adj=${adjProfit}`);
  }

  // Manual item
  const manuals = await prisma.manualReportItem.findMany({
    where: { restaurantId: OUTLET_ID, reportDate: REPORT_DATE, section: 'AC' },
  });
  for (const mi of manuals) {
    totalCons += Number(mi.consumption);
    totalSaleAmt += Number(mi.saleAmount);
    totalProfit += Number(mi.profit);
    console.log(`✓ ${mi.itemName} [MANUAL]`);
  }

  console.log(`\n=== TOTALS ===`);
  console.log(`  Consumption: ${Math.round(totalCons * 100) / 100} (expected 14282.99)`);
  console.log(`  Sale Amount:  ${Math.round(totalSaleAmt * 100) / 100} (expected 27971.00)`);
  console.log(`  Profit:       ${Math.round(totalProfit * 100) / 100} (expected 13688.01)`);
  console.log(`\nAll items match: ${allMatch ? 'YES ✓' : 'NO ⚠'}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
