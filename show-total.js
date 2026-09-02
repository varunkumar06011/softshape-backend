// Check the previous total of ₹813K - what items were in it that might be different now
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true, openingStock: { gt: 0 } },
    include: { menuItem: { select: { name: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });

  let total = 0;
  console.log('=== All items with opening stock > 0 ===\n');
  items.forEach(item => {
    const btlSize = Number(item.bottleSize) || 0;
    const openingMl = Number(item.openingStock);
    const openingBtl = btlSize > 0 ? openingMl / btlSize : 0;
    const cost = Number(item.costPerBottle) || 0;
    const value = openingBtl * cost;
    total += value;
    console.log(`  ${item.menuItem.name} | ${btlSize}ml | ${openingMl}ml = ${openingBtl} btl | cost=Rs ${cost.toFixed(2)} | value=Rs ${value.toFixed(2)}`);
  });
  console.log(`\nTotal: Rs ${total.toFixed(2)}`);
  console.log(`Total items: ${items.length}`);

  await p.$disconnect();
})();
