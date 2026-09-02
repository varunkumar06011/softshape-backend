// Save 21 AC report adjustments for outlet Z3695J, date 2026-09-01
// Uses the same Prisma operations as the backend save endpoint.
// Does NOT modify inventory master items — only creates AcReportAdjustment records.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-09-01';

// The 21 AC item entries from the reference image
// Fields: itemId, saleBtl, purchaseCost, sellingPrice, consumption, saleAmount, profit, closingBtl, bottleSize
const adjustments = [
  // 1. BUDWISER BEER | 650 | 8 | 234.46 | 234.46 | 1875.68 | 450 | 3600 | 1724.32
  { itemId: 'cms978uzw0002t2gp4tyknaig', saleBtl: 8, purchaseCost: 234.46, sellingPrice: 450, consumption: 1875.68, saleAmount: 3600, profit: 1724.32, bottleSize: 650 },
  // 2. BLEDERSPRIDE | blank | 40 | 1158.55 | 46.342 | 1853.68 | 92 | 3680 | 1826.32
  { itemId: 'cmthi9uf4001ftmkdw4usv3tu', saleBtl: 40, purchaseCost: 1158.55, sellingPrice: 92, consumption: 1853.68, saleAmount: 3680, profit: 1826.32, bottleSize: 750 },
  // 3. KINGFISHER ULTRA | blank | 4 | 191.38 | 191.38 | 765.52 | 350 | 1400 | 634.48
  { itemId: 'cms978yht000at2gptg4ur5c0', saleBtl: 4, purchaseCost: 191.38, sellingPrice: 350, consumption: 765.52, saleAmount: 1400, profit: 634.48, bottleSize: 650 },
  // 4. KINGFISHER STRONG | blank | 5 | 173.72 | 173.72 | 868.60 | 350 | 1750 | 881.40
  { itemId: 'cms978wod0006t2gpf12a9902', saleBtl: 5, purchaseCost: 173.72, sellingPrice: 350, consumption: 868.60, saleAmount: 1750, profit: 881.40, bottleSize: 650 },
  // 8. KINGFISHER LITE | blank | 2 | 156.3 | 156.3 | 312.60 | 310 | 620 | 307.40
  { itemId: 'cms9791i4000it2gptvye5nyh', saleBtl: 2, purchaseCost: 156.3, sellingPrice: 310, consumption: 312.60, saleAmount: 620, profit: 307.40, bottleSize: 650 },
  // 11. VAT 69 | blank | 10 | 1679 | 67.16 | 671.60 | 146 | 1460 | 788.40
  { itemId: 'cmthi14pj003n10j0f8o8qkec', saleBtl: 10, purchaseCost: 1679, sellingPrice: 146, consumption: 671.60, saleAmount: 1460, profit: 788.40, bottleSize: 375 },
  // 13. ROYAL STAG | 750 | 21 | 745.39 | 29.8156 | 626.13 | 61 | 1281 | 654.87
  { itemId: 'cmthia7cz002rtmkd00z84nuw', saleBtl: 21, purchaseCost: 745.39, sellingPrice: 61, consumption: 626.13, saleAmount: 1281, profit: 654.87, bottleSize: 750 },
  // 14. MORPHEUS BLUE | blank | 30 | 1166.75 | 46.67 | 1400.10 | 90 | 2700 | 1299.90
  { itemId: 'cmrdzuzzm00154hycvvilgad4', saleBtl: 30, purchaseCost: 1166.75, sellingPrice: 90, consumption: 1400.10, saleAmount: 2700, profit: 1299.90, bottleSize: 750 },
  // 12. MANSION HOUSE | blank | 32 | 675.87 | 27.0348 | 865.11 | 51 | 1632 | 766.89
  { itemId: 'cmrdzuy0h00114hyclflzsd0m', saleBtl: 32, purchaseCost: 675.87, sellingPrice: 51, consumption: 865.11, saleAmount: 1632, profit: 766.89, bottleSize: 750 },
  // 14. MC WHISKY | 180 | 1 | 173.42 | 173.42 | 173.42 | 288 | 288 | 114.58
  { itemId: 'cmthi0mkx002310j0kcptt01u', saleBtl: 1, purchaseCost: 173.42, sellingPrice: 288, consumption: 173.42, saleAmount: 288, profit: 114.58, bottleSize: 180 },
  // 15. ROYAL STAG | 180 | 1 | 199.35 | 199.35 | 199.35 | 288 | 288 | 88.65
  { itemId: 'cmthia7rn002ttmkd8ens2zxw', saleBtl: 1, purchaseCost: 199.35, sellingPrice: 288, consumption: 199.35, saleAmount: 288, profit: 88.65, bottleSize: 180 },
  // 17. STOCK STRONG | blank | 2 | 162.42 | 162.42 | 324.84 | 350 | 700 | 375.16
  { itemId: 'cms9796nr000ut2gp5b9xfboc', saleBtl: 2, purchaseCost: 162.42, sellingPrice: 350, consumption: 324.84, saleAmount: 700, profit: 375.16, bottleSize: 650 },
  // 20. MC WHISKY | 750 | 9 | 632.18 | 25.2872 | 227.58 | 48 | 432 | 204.42
  { itemId: 'cmrdzv8sj00274hycys5egcuc', saleBtl: 9, purchaseCost: 632.18, sellingPrice: 48, consumption: 227.58, saleAmount: 432, profit: 204.42, bottleSize: 750 },
  // 22. SMIRNOFF ORANGE | blank | 1 | 1032.41 | 41.2964 | 41.30 | 78 | 78 | 36.70
  { itemId: 'cmrdzv2nd001f4hycfm1h58vx', saleBtl: 1, purchaseCost: 1032.41, sellingPrice: 78, consumption: 41.30, saleAmount: 78, profit: 36.70, bottleSize: 30 },
  // 23. BUDWISER MAGNUM TIN | blank | 3 | 135.04 | 135.04 | 405.12 | 310 | 930 | 524.88
  { itemId: 'cms979b6h0012t2gpap8qvyem', saleBtl: 3, purchaseCost: 135.04, sellingPrice: 310, consumption: 405.12, saleAmount: 930, profit: 524.88, bottleSize: 500 },
  // 25. 100 PIPERS | blank | 2 | 2172.55 | 86.902 | 173.80 | 196 | 392 | 218.20
  { itemId: 'cmrdzv3yr001l4hyc7oty9ces', saleBtl: 2, purchaseCost: 2172.55, sellingPrice: 196, consumption: 173.80, saleAmount: 392, profit: 218.20, bottleSize: 30 },
  // 27. SIGNATURE | blank | 20 | 1149.32 | 45.9728 | 919.46 | 94 | 1880 | 960.54
  { itemId: 'cmrdzvccc002n4hycp54g1kn2', saleBtl: 20, purchaseCost: 1149.32, sellingPrice: 94, consumption: 919.46, saleAmount: 1880, profit: 960.54, bottleSize: 750 },
  // 37. ROYAL CHALLENGE | blank | 50 | 735.98 | 29.4392 | 1471.96 | 61 | 3050 | 1578.04
  { itemId: 'cmrdzva42002d4hyccequ7lnm', saleBtl: 50, purchaseCost: 735.98, sellingPrice: 61, consumption: 1471.96, saleAmount: 3050, profit: 1578.04, bottleSize: 750 },
  // 53. COURIER GREEN | 750 | 10 | 1031.25 | 41.25 | 412.50 | 78 | 780 | 367.50
  { itemId: 'cmrdzuvjt000t4hycg37di21y', saleBtl: 10, purchaseCost: 1031.25, sellingPrice: 78, consumption: 412.50, saleAmount: 780, profit: 367.50, bottleSize: 750 },
  // 54. SIGNATURE | 180 | 1 | 312.26 | 312.26 | 312.26 | 330 | 330 | 17.74
  { itemId: 'cmthi0yyj003510j0y17fk1vm', saleBtl: 1, purchaseCost: 312.26, sellingPrice: 330, consumption: 312.26, saleAmount: 330, profit: 17.74, bottleSize: 180 },
];

// S.No 40: KINGFISHER STRONG (duplicate — same name as S.No 4 but different cost)
// This will be saved as a ManualReportItem since the inventory item is already used
const manualItem = {
  section: 'AC',
  itemName: 'KINGFISHER STRONG',
  categoryName: 'Beer',
  qty: 650, // bottle size
  sale: 2,
  purchaseCost: 191.19,
  sellingPrice: 350,
  consumption: 382.38,
  saleAmount: 700,
  profit: 317.62,
  opening: 0,
  received: 0,
  closing: 0,
  isHidden: false,
};

async function main() {
  console.log('=== Saving 21 AC report adjustments for 2026-09-01 ===\n');

  // 1. Delete existing adjustments for this date (clean slate)
  const deleted = await prisma.acReportAdjustment.deleteMany({
    where: { restaurantId: OUTLET_ID, entryDate: REPORT_DATE },
  });
  console.log(`Deleted ${deleted.count} existing adjustments`);

  // 2. Delete existing manual items for this date
  const deletedManual = await prisma.manualReportItem.deleteMany({
    where: { restaurantId: OUTLET_ID, reportDate: REPORT_DATE },
  });
  console.log(`Deleted ${deletedManual.count} existing manual items`);

  // 3. Save 20 AC report adjustments
  let saved = 0;
  for (const adj of adjustments) {
    await prisma.acReportAdjustment.upsert({
      where: {
        restaurantId_itemId_entryDate: {
          restaurantId: OUTLET_ID,
          itemId: adj.itemId,
          entryDate: REPORT_DATE,
        }
      },
      create: {
        restaurantId: OUTLET_ID,
        itemId: adj.itemId,
        entryDate: REPORT_DATE,
        adjustedSaleBtl: adj.saleBtl,
        adjustedPurchaseCost: adj.purchaseCost,
        adjustedSellingPrice: adj.sellingPrice,
        adjustedConsumption: adj.consumption,
        adjustedSaleAmount: adj.saleAmount,
        adjustedProfit: adj.profit,
        adjustedClosingBtl: 0,
        createdBy: 'system',
      },
      update: {
        adjustedSaleBtl: adj.saleBtl,
        adjustedPurchaseCost: adj.purchaseCost,
        adjustedSellingPrice: adj.sellingPrice,
        adjustedConsumption: adj.consumption,
        adjustedSaleAmount: adj.saleAmount,
        adjustedProfit: adj.profit,
        adjustedClosingBtl: 0,
      },
    });
    saved++;
  }
  console.log(`Saved ${saved} AC report adjustments`);

  // 4. Save 1 manual report item (duplicate KINGFISHER STRONG)
  const manual = await prisma.manualReportItem.create({
    data: {
      restaurantId: OUTLET_ID,
      reportDate: REPORT_DATE,
      section: manualItem.section,
      itemName: manualItem.itemName,
      categoryName: manualItem.categoryName,
      qty: manualItem.qty,
      sale: manualItem.sale,
      purchaseCost: manualItem.purchaseCost,
      sellingPrice: manualItem.sellingPrice,
      consumption: manualItem.consumption,
      saleAmount: manualItem.saleAmount,
      profit: manualItem.profit,
      opening: manualItem.opening,
      received: manualItem.received,
      closing: manualItem.closing,
      isHidden: manualItem.isHidden,
      createdBy: 'system',
    },
  });
  console.log(`Saved 1 manual report item: ${manual.itemName} (id=${manual.id})`);

  // 5. Verify: read back all adjustments
  const verifyAdjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: OUTLET_ID, entryDate: REPORT_DATE },
    include: { },
  });
  console.log(`\n=== Verification: ${verifyAdjs.length} adjustments found ===`);

  let totalConsumption = 0;
  let totalSaleAmount = 0;
  let totalProfit = 0;

  for (const adj of verifyAdjs) {
    // Get item name
    const item = await prisma.inventoryItem.findUnique({
      where: { id: adj.itemId },
      include: { menuItem: true },
    });
    const name = item?.menuItem?.name || 'Unknown';
    const consumption = Number(adj.adjustedConsumption) || 0;
    const saleAmount = Number(adj.adjustedSaleAmount) || 0;
    const profit = Number(adj.adjustedProfit) || 0;
    totalConsumption += consumption;
    totalSaleAmount += saleAmount;
    totalProfit += profit;
    console.log(`  ${name}: sale=${adj.adjustedSaleBtl}, purchase=${adj.adjustedPurchaseCost}, selling=${adj.adjustedSellingPrice}, consumption=${consumption}, saleAmount=${saleAmount}, profit=${profit}`);
  }

  // Add manual item to totals
  totalConsumption += manualItem.consumption;
  totalSaleAmount += manualItem.saleAmount;
  totalProfit += manualItem.profit;

  console.log(`\n=== TOTALS (20 adjustments + 1 manual) ===`);
  console.log(`  Consumption: ${Math.round(totalConsumption * 100) / 100}`);
  console.log(`  Sale Amount:  ${Math.round(totalSaleAmount * 100) / 100}`);
  console.log(`  Profit:       ${Math.round(totalProfit * 100) / 100}`);
  console.log(`  Profit %:     ${totalConsumption > 0 ? Math.round(totalProfit / totalConsumption * 10000) / 100 : 0}%`);

  // Expected totals
  console.log(`\n=== EXPECTED TOTALS ===`);
  console.log(`  Consumption: 14282.99`);
  console.log(`  Sale Amount:  27971.00`);
  console.log(`  Profit:       13688.01`);
  console.log(`  Profit %:     95.81% (≈96%)`);

  // Verify inventory master is NOT modified
  const invCount = await prisma.inventoryItem.count({ where: { restaurantId: OUTLET_ID } });
  console.log(`\nInventory items count (unchanged): ${invCount}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
