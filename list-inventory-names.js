const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const items = await p.inventoryItem.findMany({
      where: { isActive: true },
      include: { menuItem: { select: { name: true } } },
      orderBy: { menuItem: { name: 'asc' } },
    });
    console.log(`=== Complete Active Inventory List (${items.length} items) ===\n`);
    let prev = '';
    let idx = 1;
    items.forEach(i => {
      const name = i.menuItem?.name || '(unknown)';
      console.log(`${String(idx).padStart(3)}. ${name}  [${i.bottleSize}ml]  stock: ${i.currentStock}`);
      idx++;
    });
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
