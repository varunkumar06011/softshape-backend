const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const IMAGE_DATA = [
  { name: 'BUDWISER BEER', sale: 12, purchaseCost: 234.46, consumption: 2813.52, sellingPrice: 450, saleAmount: 5400, profit: 2586.48 },
  { name: 'BLEDERSPRIDE', sale: 44, purchaseCost: 46.342, consumption: 2039.05, sellingPrice: 92, saleAmount: 4048, profit: 2008.95 },
  { name: 'KINGFISHER ULTRA', sale: 13, purchaseCost: 191.38, consumption: 2487.94, sellingPrice: 350, saleAmount: 4550, profit: 2062.06 },
  { name: 'KINGFISHER STRONG', sale: 14, purchaseCost: 173.72, consumption: 2432.08, sellingPrice: 350, saleAmount: 4900, profit: 2467.92 },
  { name: 'COURRIER NAPOLEAN', sale: 10, purchaseCost: 41.25, consumption: 412.5, sellingPrice: 62, saleAmount: 620, profit: 207.5 },
  { name: 'BREEZER', sale: 1, purchaseCost: 112.72, consumption: 112.72, sellingPrice: 240, saleAmount: 240, profit: 127.28 },
  { name: 'BUDWISER MAGNUM', sale: 1, purchaseCost: 260.61, consumption: 260.61, sellingPrice: 495, saleAmount: 495, profit: 234.39 },
  { name: 'RED LABEL', sale: 8, purchaseCost: 94.8344, consumption: 758.68, sellingPrice: 183, saleAmount: 1464, profit: 705.32 },
  { name: 'MORPHEUS', sale: 16, purchaseCost: 37.4464, consumption: 599.14, sellingPrice: 71, saleAmount: 1136, profit: 536.86 },
  { name: 'VAT 69', sale: 10, purchaseCost: 67.16, consumption: 671.6, sellingPrice: 146, saleAmount: 1460, profit: 788.4 },
  { name: 'KARJURA', sale: 2, purchaseCost: 156.3, consumption: 312.6, sellingPrice: 350, saleAmount: 700, profit: 387.4 },
  { name: 'ROYAL STAG', sale: 49, purchaseCost: 29.8156, consumption: 1460.96, sellingPrice: 61, saleAmount: 2989, profit: 1528.04 },
  { name: 'MORPHEUS BLUE', sale: 26, purchaseCost: 46.67, consumption: 1213.42, sellingPrice: 90, saleAmount: 2340, profit: 1126.58 },
  { name: 'MANSION HOUSE', sale: 15, purchaseCost: 27.0348, consumption: 405.52, sellingPrice: 51, saleAmount: 765, profit: 359.48 },
  { name: 'MC WHISKY', sale: 1, purchaseCost: 173.42, consumption: 173.42, sellingPrice: 288, saleAmount: 288, profit: 114.58 },
  { name: 'KYRON BRANDY', sale: 16, purchaseCost: 37.4244, consumption: 598.79, sellingPrice: 73, saleAmount: 1168, profit: 569.21 },
  { name: 'STOCK STRONG', sale: 1, purchaseCost: 162.42, consumption: 162.42, sellingPrice: 350, saleAmount: 350, profit: 187.58 },
  { name: 'MC WHISKY', sale: 19, purchaseCost: 25.2872, consumption: 480.46, sellingPrice: 48, saleAmount: 912, profit: 431.54 },
  { name: 'IMPERIAL BLUE', sale: 24, purchaseCost: 25.2872, consumption: 606.89, sellingPrice: 48, saleAmount: 1152, profit: 545.11 },
  { name: 'BUDWISER MAGNUM TIN', sale: 1, purchaseCost: 328.04, consumption: 328.04, sellingPrice: 300, saleAmount: 300, profit: -28.04 },
  { name: '100 PIPERS', sale: 7, purchaseCost: 86.902, consumption: 608.31, sellingPrice: 196, saleAmount: 1372, profit: 763.69 },
  { name: 'SIGNATURE', sale: 44, purchaseCost: 45.9728, consumption: 2022.8, sellingPrice: 94, saleAmount: 4136, profit: 2113.2 },
  { name: 'MAGIC MOMENTS OR', sale: 2, purchaseCost: 216.74, consumption: 433.48, sellingPrice: 250, saleAmount: 500, profit: 66.52 },
  { name: 'ABSOLUTE', sale: 4, purchaseCost: 89.6884, consumption: 358.75, sellingPrice: 170, saleAmount: 680, profit: 321.25 },
  { name: 'BACARDI CRANBERRY', sale: 1, purchaseCost: 129.67, consumption: 129.67, sellingPrice: 260, saleAmount: 260, profit: 130.33 },
  { name: 'BLACK LABEL', sale: 2, purchaseCost: 173.6088, consumption: 347.22, sellingPrice: 330, saleAmount: 660, profit: 312.78 },
];

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true },
    include: { menuItem: { select: { name: true } } }
  });
  const adjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', entryDate: '2026-08-31' },
  });
  
  const itemMap = new Map(items.map(i => [i.id, i]));
  const adjMap = new Map(adjs.map(a => [a.itemId, a]));
  
  console.log('=== VERIFY DATABASE vs IMAGE ===\n');
  let match = 0, mismatch = 0;
  
  for (const img of IMAGE_DATA) {
    // Find matching adjustment
    let found = null;
    for (const [itemId, adj] of adjMap) {
      const item = itemMap.get(itemId);
      const dbName = (item?.menuItem?.name || '').toUpperCase();
      if (dbName === img.name || dbName.includes(img.name) || img.name.includes(dbName)) {
        found = { item, adj };
        break;
      }
    }
    
    if (!found) {
      console.log(img.name.padEnd(25), 'NOT FOUND in database!');
      mismatch++;
      continue;
    }
    
    const { adj } = found;
    const dbSale = Number(adj.adjustedSaleBtl);
    const dbPC = Number(adj.adjustedPurchaseCost);
    const dbCons = Number(adj.adjustedConsumption);
    const dbSP = Number(adj.adjustedSellingPrice);
    const dbSA = Number(adj.adjustedSaleAmount);
    const dbProf = Number(adj.adjustedProfit);
    
    const saleOk = Math.abs(dbSale - img.sale) < 0.01;
    const pcOk = Math.abs(dbPC - img.purchaseCost) < 0.01;
    const consOk = Math.abs(dbCons - img.consumption) < 0.01;
    const spOk = Math.abs(dbSP - img.sellingPrice) < 0.01;
    const saOk = Math.abs(dbSA - img.saleAmount) < 0.01;
    const profOk = Math.abs(dbProf - img.profit) < 0.01;
    
    const allOk = saleOk && pcOk && consOk && spOk && saOk && profOk;
    if (allOk) {
      match++;
    } else {
      mismatch++;
      console.log('MISMATCH:', img.name);
      console.log('  DB: sale=', dbSale, 'pc=', dbPC, 'cons=', dbCons, 'sp=', dbSP, 'sa=', dbSA, 'prof=', dbProf);
      console.log('  IMG: sale=', img.sale, 'pc=', img.purchaseCost, 'cons=', img.consumption, 'sp=', img.sellingPrice, 'sa=', img.saleAmount, 'prof=', img.profit);
    }
  }
  
  console.log('\n=== RESULT ===');
  console.log('Matched:', match, '/', IMAGE_DATA.length);
  console.log('Mismatched:', mismatch);
  
  // Also check for extra adjustments not in image
  console.log('\n=== Extra adjustments (not in image) ===');
  for (const [itemId, adj] of adjMap) {
    const item = itemMap.get(itemId);
    const dbName = (item?.menuItem?.name || '').toUpperCase();
    const inImage = IMAGE_DATA.some(img => dbName === img.name || dbName.includes(img.name) || img.name.includes(dbName));
    if (!inImage) {
      console.log('Extra:', dbName, 'saleAmt=', Number(adj.adjustedSaleAmount));
    }
  }
  
  await prisma.$disconnect();
}
main().catch(console.error);
