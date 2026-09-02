const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const items = await p.inventoryItem.findMany({
      where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true },
      include: { menuItem: { select: { name: true } } },
      orderBy: { menuItem: { name: 'asc' } },
    });

    // Show Ballantines
    const ballantines = items.filter(i => (i.menuItem?.name || '').toLowerCase().includes('ballan'));
    console.log('--- Ballantines ---');
    ballantines.forEach(i => console.log(`  ${i.menuItem.name} [${i.bottleSize}ml] cost: ₹${Number(i.costPerBottle || 0).toFixed(2)} stock: ${i.currentStock}`));

    // Show some key brands
    const keyBrands = ['100 pipers', 'absolut vodka', 'black label', 'chivas regal', 'teacher higland', 'red label', 'signature', 'mansion house'];
    console.log('\n--- Key brand costs ---');
    for (const brand of keyBrands) {
      const brandItems = items.filter(i => (i.menuItem?.name || '').toLowerCase().includes(brand));
      brandItems.forEach(i => console.log(`  ${i.menuItem.name} [${i.bottleSize}ml] cost: ₹${Number(i.costPerBottle || 0).toFixed(2)}`));
    }

    // Show beers
    console.log('\n--- Beer costs ---');
    const beers = items.filter(i => [650, 500, 330].includes(Number(i.bottleSize)) && Number(i.costPerBottle) > 0);
    beers.forEach(i => console.log(`  ${i.menuItem.name} [${i.bottleSize}ml] cost: ₹${Number(i.costPerBottle || 0).toFixed(2)}`));

    // Count items with cost = 0 vs null vs > 0
    const withCost = items.filter(i => i.costPerBottle !== null && Number(i.costPerBottle) > 0);
    const withZero = items.filter(i => i.costPerBottle !== null && Number(i.costPerBottle) === 0);
    const withNull = items.filter(i => i.costPerBottle === null);
    console.log(`\n--- Summary ---`);
    console.log(`Total active items: ${items.length}`);
    console.log(`With cost > 0: ${withCost.length}`);
    console.log(`With cost = 0: ${withZero.length}`);
    console.log(`With cost = null: ${withNull.length}`);

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
