const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  // Update O C Elegant Whisky 180ml cost → ₹192.41 (Officers Choice Blue)
  const oc = await p.inventoryItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, isActive: true, bottleSize: 180 },
    include: { menuItem: { select: { name: true } } },
  });
  // Find by name match
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  const ocItem = items.find(i => (i.menuItem?.name || '').toLowerCase().includes('o c elegant'));
  if (ocItem) {
    await p.inventoryItem.update({ where: { id: ocItem.id }, data: { costPerBottle: 192.41 } });
    console.log(`✓ Updated "${ocItem.menuItem.name}" [${ocItem.bottleSize}ml] cost → ₹192.41`);
  }

  const smirnoffItem = items.find(i => (i.menuItem?.name || '').toLowerCase().includes('smirnoff') && Number(i.bottleSize) === 750);
  if (smirnoffItem) {
    await p.inventoryItem.update({ where: { id: smirnoffItem.id }, data: { costPerBottle: 1180.00 } });
    console.log(`✓ Updated "${smirnoffItem.name}" [${smirnoffItem.bottleSize}ml] cost → ₹1,180.00`);
  }

  // Now calculate total opening stock value
  const freshItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  let total = 0;
  let itemsWithStock = 0;
  for (const item of freshItems) {
    const stock = Number(item.openingStock);
    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;
    if (stock > 0) {
      total += stock * cost;
      itemsWithStock++;
      console.log(`  ${item.menuItem?.name} [${item.bottleSize}ml]  stock: ${stock}  cost: ₹${cost.toFixed(2)}  value: ₹${(stock * cost).toFixed(2)}`);
    }
  }

  console.log(`\n=== FINAL TOTAL ===`);
  console.log(`Items with stock: ${itemsWithStock}`);
  console.log(`Total Opening Stock Value: ₹${total.toFixed(2)}`);
  console.log(`Expected: ~₹830,000.00`);

  await p.$disconnect();
})();
