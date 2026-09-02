const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const item = await p.inventoryItem.findFirst({
      where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true, bottleSize: 750 },
      include: { menuItem: { select: { name: true } } },
    });
    // Find Ballantines by checking each 750ml item
    const items = await p.inventoryItem.findMany({
      where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true, bottleSize: 750 },
      include: { menuItem: { select: { name: true } } },
    });
    const ballantines = items.find(i => (i.menuItem?.name || '').toLowerCase().includes('ballan'));
    if (ballantines) {
      const name = ballantines.menuItem.name;
      console.log('Ballantines name:', JSON.stringify(name));
      console.log('Char codes:', [...name].map(c => `${c}(${c.charCodeAt(0)})`).join(' '));
    } else {
      console.log('Ballantines not found');
    }
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
