// Final verification: for recent beer orders, confirm that the order item's menuItemId
// now has a matching inventory item (so the new menuItemId-based lookup will find it).
import prisma from '../src/lib/prisma';

function isBeerItem(item: any): boolean {
  if (!item) return false;
  const categoryObj = item.category;
  let category = '';
  if (categoryObj && typeof categoryObj === 'object' && 'name' in categoryObj) {
    category = String(categoryObj.name || '').toLowerCase();
  } else if (typeof categoryObj === 'string') {
    category = categoryObj.toLowerCase();
  }
  if (category.includes('beer')) return true;
  const name = String(item.name || '').toLowerCase();
  const beerKeywords = ['beer', 'lager', 'ale', 'bira', 'carlsberg', 'budweiser', 'kingfisher', 'kf', 'coolberg', 'stok', 'draught'];
  return beerKeywords.some(keyword => name.includes(keyword));
}

async function main() {
  const restaurantId = 'cmqy60ci200027dscyj9ubg8h';

  // Get all beer menu items that have been ordered, and check if they have inventory
  const recentOrders = await prisma.order.findMany({
    where: { restaurantId, items: { some: { menuItem: { menuType: 'LIQUOR' } } } },
    include: { items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: { include: { category: { select: { name: true } } } } } } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });

  // Collect unique beer menuItemIds from orders
  const orderedBeerItems = new Map<string, { name: string; count: number }>();
  for (const o of recentOrders) {
    for (const it of o.items) {
      if (isBeerItem((it as any).menuItem)) {
        const id = it.menuItemId;
        const existing = orderedBeerItems.get(id);
        if (existing) existing.count++;
        else orderedBeerItems.set(id, { name: (it as any).menuItem.name, count: 1 });
      }
    }
  }

  console.log('=== Final verification: ordered beer items → inventory linkage ===\n');
  console.log('Menu Item Name'.padEnd(35) + ' | menuItemId'.padEnd(40) + ' | Has Inventory? | Stock');
  console.log('-'.repeat(110));

  let allGood = true;
  for (const [menuItemId, { name, count }] of orderedBeerItems) {
    const inv = await prisma.inventoryItem.findUnique({
      where: { menuItemId },
      select: { id: true, currentStock: true },
    });
    const status = inv ? `YES (${inv.currentStock}ml)` : 'NO  <-- WILL FAIL';
    if (!inv) allGood = false;
    console.log(name.padEnd(35) + ' | ' + menuItemId.padEnd(40) + ' | ' + status);
  }

  console.log('');
  if (allGood) {
    console.log('✓ ALL ordered beer items now have inventory linked via menuItemId.');
    console.log('  The new menuItemId-based lookup in findInventoryForOrderedItem will find them.');
    console.log('  Going forward, beer deduction WILL work on settlement.');
  } else {
    console.log('✗ Some ordered beer items still lack inventory. These will fail to deduct.');
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
