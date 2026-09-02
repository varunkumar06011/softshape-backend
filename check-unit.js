const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  const keywords = ['mc whisky', 'magic moments', 'blenders pride', 'budweiser beer', 'kf ultra', 'bacardi cranberry'];
  for (const item of items) {
    const name = (item.menuItem?.name || '').toLowerCase();
    if (keywords.some(k => name.includes(k))) {
      console.log(name, '| unitOfMeasure:', item.unitOfMeasure, '| bottleSize:', item.bottleSize);
    }
  }
  await prisma.$disconnect();
})();
