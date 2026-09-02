const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });

  console.log('=== Complete Inventory: Names, Stock, Purchase Rates ===\n');
  console.log('#  Item Name'.padEnd(38) + 'Size'.padEnd(8) + 'Opening'.padStart(8) + 'Current'.padStart(9) + 'Cost/Bottle'.padStart(14) + 'Stock Value'.padStart(14));
  console.log('-'.repeat(91));

  let totalValue = 0;
  let idx = 1;
  for (const item of items) {
    const name = item.menuItem?.name || '(unknown)';
    const size = Number(item.bottleSize);
    const opening = Number(item.openingStock);
    const current = Number(item.currentStock);
    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;
    const value = opening * cost;
    totalValue += value;

    console.log(
      String(idx).padStart(2) + ' ' +
      name.padEnd(35) +
      (size + 'ml').padEnd(8) +
      String(opening).padStart(8) +
      String(current).padStart(9) +
      (cost > 0 ? '₹' + cost.toFixed(2) : '—').padStart(14) +
      (value > 0 ? '₹' + value.toFixed(2) : '—').padStart(14)
    );
    idx++;
  }

  console.log('-'.repeat(91));
  console.log(`Total Items: ${items.length}`);
  console.log(`Total Opening Stock Value: ₹${totalValue.toFixed(2)}`);

  await p.$disconnect();
})();
