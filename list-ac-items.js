const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  console.log('Date:', today);

  // Get AC items that appear in the PDF-to-Admin report
  // AC items = inventory items with POS sales (systemConsumption > 0 or acRevenue > 0)
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: {
      menuItem: { select: { name: true, category: { select: { name: true } } } },
    },
    orderBy: { menuItem: { category: { name: 'asc' } } },
  });

  console.log('Total active inventory items:', items.length);
  console.log('');

  let count = 1;
  for (const i of items) {
    const cat = i.menuItem?.category?.name || 'Uncategorized';
    const name = i.menuItem?.name || 'Unknown';
    const btl = i.bottleSize || 0;
    const cost = i.costPerBottle ? Number(i.costPerBottle) : 0;
    const stock = i.currentStock ? Number(i.currentStock) : 0;
    const hidden = i.isHiddenFromReport ? 'HIDDEN' : 'visible';
    console.log(`${count}. [${cat}] ${name} | btl:${btl}ml | cost:Rs${cost} | stock:${stock}ml | ${hidden} | id:${i.id}`);
    count++;
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
