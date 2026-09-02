const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });

  // Items with stock > 0 but cost = 0 or null
  console.log('=== Items with stock > 0 but NO purchase cost (₹0 or null) ===\n');
  let missingValue = 0;
  for (const item of items) {
    const stock = Number(item.openingStock);
    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;
    if (stock > 0 && cost === 0) {
      console.log(`  ${item.menuItem?.name} [${item.bottleSize}ml]  stock: ${stock}  cost: ${item.costPerBottle === null ? 'NULL' : '₹0'}`);
      missingValue++;
    }
  }
  console.log(`\nTotal items with missing cost: ${missingValue}`);

  // Full calculation with all items that have stock
  console.log('\n=== Full stock value calculation ===\n');
  let total = 0;
  let totalWithStock = 0;
  for (const item of items) {
    const stock = Number(item.openingStock);
    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;
    if (stock > 0) {
      const value = stock * cost;
      total += value;
      totalWithStock++;
      if (cost === 0) {
        console.log(`  MISSING COST: ${item.menuItem?.name} [${item.bottleSize}ml]  stock: ${stock}  cost: ₹0  value: ₹0`);
      }
    }
  }
  console.log(`\nItems with stock > 0: ${totalWithStock}`);
  console.log(`Total stock value (with ₹0 costs): ₹${total.toFixed(2)}`);
  console.log(`Expected: ~₹830,000.00`);
  console.log(`Gap: ₹${(830000 - total).toFixed(2)}`);

  await p.$disconnect();
})();
