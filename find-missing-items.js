// Search for missing items and list all items with their details
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: OUTLET_ID },
    include: { menuItem: { include: { category: true, variants: true } } },
    orderBy: { createdAt: 'asc' }
  });

  // Search for KINGFISHER LITE
  console.log('=== KINGFISHER LITE search ===');
  const lite = items.filter(i => {
    const name = (i.menuItem?.name || '').toUpperCase();
    return name.includes('LITE') || name.includes('LIGHT');
  });
  for (const m of lite) {
    console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  }

  // Search for COURIER GREEN
  console.log('\n=== COURIER GREEN search ===');
  const courier = items.filter(i => {
    const name = (i.menuItem?.name || '').toUpperCase();
    return name.includes('COURIER') || name.includes('GREEN') || name.includes('COURIR');
  });
  for (const m of courier) {
    console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  }

  // List ALL KINGFISHER items
  console.log('\n=== ALL KINGFISHER items ===');
  const kf = items.filter(i => (i.menuItem?.name || '').toUpperCase().includes('KINGFISHER'));
  for (const m of kf) {
    console.log(`  id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  }

  // List ALL items with their index (to check S.No mapping)
  console.log('\n=== ALL items (first 60) with index ===');
  items.slice(0, 60).forEach((m, i) => {
    console.log(`  [${i+1}] id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  });

  // Check items around S.No 40
  console.log('\n=== Items around index 38-42 ===');
  items.slice(37, 42).forEach((m, i) => {
    console.log(`  [${i+38}] id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  });

  // Check items around S.No 53-54
  console.log('\n=== Items around index 52-55 ===');
  items.slice(51, 56).forEach((m, i) => {
    console.log(`  [${i+52}] id=${m.id}, name="${m.menuItem?.name}", bottleSize=${m.bottleSize}, cost=${m.costPerBottle}, selling=${m.acSellingPrice}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
