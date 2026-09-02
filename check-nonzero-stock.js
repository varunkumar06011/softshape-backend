const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true, openingStock: { gt: 0 } },
    include: { menuItem: { select: { name: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });
  console.log(`Items with openingStock > 0: ${items.length}`);
  items.forEach(i => console.log(`  ${i.menuItem.name} | ${i.bottleSize}ml | opening: ${i.openingStock} | cost: ${i.costPerBottle}`));
  await p.$disconnect();
})();
