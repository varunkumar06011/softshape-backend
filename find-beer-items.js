// Search for items with specific costs and check all beer items
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: OUTLET_ID },
    include: { menuItem: { include: { category: true } } },
    orderBy: { createdAt: 'asc' }
  });

  // Search for items with cost close to 191.19 (S.No 40 KINGFISHER STRONG)
  console.log('=== Items with cost between 190-192 ===');
  const costMatch = items.filter(i => Number(i.costPerBottle) >= 190 && Number(i.costPerBottle) <= 192);
  for (const m of costMatch) {
    console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  }

  // List ALL beer/cider items
  console.log('\n=== ALL beer items ===');
  const beers = items.filter(i => {
    const name = (i.menuItem?.name || '').toUpperCase();
    const cat = (i.menuItem?.category?.name || '').toUpperCase();
    return cat.includes('BEER') || name.includes('BEER') || name.includes('BUD') || name.includes('KING') || name.includes('STOCK') || name.includes('STORM');
  });
  for (const m of beers) {
    console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  }

  // Check COURRIER NAPOLEAN (for COURIER GREEN match)
  console.log('\n=== COURRIER NAPOLEAN items ===');
  const courier = items.filter(i => (i.menuItem?.name || '').toUpperCase().includes('COURRIER'));
  for (const m of courier) {
    console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  }

  // Check Signature 180Ml
  console.log('\n=== Signature items ===');
  const sig = items.filter(i => (i.menuItem?.name || '').toUpperCase().includes('SIGNATURE'));
  for (const m of sig) {
    console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  }

  // Total count
  console.log(`\nTotal items: ${items.length}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
