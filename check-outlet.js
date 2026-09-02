const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const dist = await p.inventoryItem.groupBy({ by: ['restaurantId'], _count: true });
    console.log('Inventory by restaurantId:');
    dist.forEach(d => console.log(`  ${d.restaurantId}: ${d._count} items`));

    const outlets = await p.outlet.findMany({ select: { id: true, name: true, slug: true } });
    console.log('\nOutlets:');
    outlets.forEach(o => console.log(`  ${o.id} | ${o.name} | slug: ${o.slug}`));
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
