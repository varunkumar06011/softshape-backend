const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  // Find O C Elegant Whisky 180ml specifically
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true, bottleSize: 180 },
    include: { menuItem: { select: { name: true } } },
  });

  const oc180 = items.find(i => (i.menuItem?.name || '').toLowerCase().includes('o c elegant') && Number(i.bottleSize) === 180);
  if (oc180) {
    await p.inventoryItem.update({ where: { id: oc180.id }, data: { costPerBottle: 192.41 } });
    console.log(`✓ Fixed: "${oc180.menuItem.name}" [${oc180.bottleSize}ml] cost → ₹192.41 (was ₹${Number(oc180.costPerBottle || 0).toFixed(2)})`);
  } else {
    console.log('O C Elegant Whisky 180ml not found!');
  }

  // Also fix the 375ml — set it back to null (no cost provided for 375ml)
  const oc375 = items.find(i => (i.menuItem?.name || '').toLowerCase().includes('o c elegant') && Number(i.bottleSize) === 375);
  if (oc375) {
    await p.inventoryItem.update({ where: { id: oc375.id }, data: { costPerBottle: null } });
    console.log(`✓ Reset: "${oc375.menuItem.name}" [${oc375.bottleSize}ml] cost → null (was wrongly set)`);
  }

  // Recalculate total
  const freshItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  let total = 0;
  let count = 0;
  for (const item of freshItems) {
    const stock = Number(item.openingStock);
    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;
    if (stock > 0) {
      total += stock * cost;
      count++;
    }
  }

  console.log(`\n=== FINAL TOTAL ===`);
  console.log(`Items with stock: ${count}`);
  console.log(`Total Opening Stock Value: ₹${total.toFixed(2)}`);
  console.log(`Expected: ~₹830,000.00`);
  console.log(`Gap: ₹${(830000 - total).toFixed(2)}`);

  await p.$disconnect();
})();
