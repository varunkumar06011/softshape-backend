const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const invCount = await p.inventoryItem.count();
    console.log('InventoryItem count:', invCount);

    const menuCount = await p.menuItem.count();
    console.log('MenuItem count:', menuCount);

    // Check bottle sizes distribution
    const sizes = await p.inventoryItem.groupBy({
      by: ['bottleSize'],
      _count: true,
      orderBy: { bottleSize: 'asc' },
    });
    console.log('\nBottle size distribution:');
    sizes.forEach(s => console.log(`  ${s.bottleSize}ml: ${s._count} items`));

    // Sample some items
    const sample = await p.inventoryItem.findMany({
      take: 10,
      include: { menuItem: { select: { name: true, menuType: true } } },
      orderBy: { createdAt: 'desc' },
    });
    console.log('\nRecent 10 inventory items:');
    sample.forEach(i => console.log(`  - ${i.menuItem?.name} | bottleSize: ${i.bottleSize}ml | stock: ${i.currentStock} | active: ${i.isActive}`));

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
