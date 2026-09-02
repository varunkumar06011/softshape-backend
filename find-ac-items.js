// Find all AC inventory items for outlet Z3695J
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-09-01';

async function main() {
  // Get all inventory items for this outlet
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: OUTLET_ID },
    include: {
      menuItem: {
        include: { category: true, variants: true }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`Total inventory items for Z3695J: ${items.length}\n`);

  // The 21 item names we need to match (from the reference image)
  const targetNames = [
    'BUDWISER BEER',
    'BLEDERSPRIDE',
    'KINGFISHER ULTRA',
    'KINGFISHER STRONG',
    'KINGFISHER LITE',
    'VAT 69',
    'ROYAL STAG',
    'MORPHEUS BLUE',
    'MANSION HOUSE',
    'MC WHISKY',
    'STOCK STRONG',
    'SMIRNOFF ORANGE',
    'BUDWISER MAGNUM TIN',
    '100 PIPERS',
    'SIGNATURE',
    'ROYAL CHALLENGE',
    'COURIER GREEN',
  ];

  console.log('=== Matching items ===');
  for (const target of targetNames) {
    const matches = items.filter(i => {
      const name = (i.menuItem?.name || '').toUpperCase().trim();
      return name === target || name.includes(target) || target.includes(name);
    });
    console.log(`\n"${target}": ${matches.length} match(es)`);
    for (const m of matches) {
      const variants = m.menuItem?.variants?.map(v => `${v.name}(${v.price})`).join(', ') || 'none';
      console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, costPerBottle=${m.costPerBottle}, acSellingPrice=${m.acSellingPrice}, variants=[${variants}]`);
    }
  }

  // Also check existing AC report adjustments for this date
  const existingAdjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: OUTLET_ID, entryDate: REPORT_DATE }
  });
  console.log(`\n=== Existing AC adjustments for ${REPORT_DATE}: ${existingAdjs.length} ===`);
  for (const a of existingAdjs) {
    console.log(`  itemId=${a.itemId}, saleBtl=${a.adjustedSaleBtl}, purchaseCost=${a.adjustedPurchaseCost}, sellingPrice=${a.adjustedSellingPrice}, consumption=${a.adjustedConsumption}, saleAmount=${a.adjustedSaleAmount}, profit=${a.adjustedProfit}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
