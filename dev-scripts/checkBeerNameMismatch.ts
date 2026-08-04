// Compare beer menu item names (source of truth for orders) vs beer inventory item names.
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

  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId, menuType: 'LIQUOR' },
    include: { category: { select: { name: true } }, inventoryItem: { select: { id: true, currentStock: true, openingStock: true } } },
  });
  const beerMenuItems = menuItems.filter((m) => isBeerItem(m));

  console.log('Beer menu items vs their inventory linkage:\n');
  console.log('Menu Item Name (used in orders)'.padEnd(35) + ' | Has Inventory? | Inventory currentStock');
  console.log('-'.repeat(90));
  for (const m of beerMenuItems) {
    const inv = (m as any).inventoryItem;
    console.log(
      m.name.padEnd(35) +
      ' | ' + (inv ? 'YES' : 'NO ').padEnd(14) +
      ' | ' + (inv ? `${inv.currentStock} ml` : '(no inventory item)')
    );
  }

  // Now show inventory item names (these are what findInventoryForOrderedItem searches against)
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { name: true, menuType: true } } },
  });
  const beerInv = invItems.filter((i) => isBeerItem(i.menuItem));

  console.log('\n\nInventory item names (what deduction searches against):\n');
  for (const i of beerInv) {
    console.log(`  "${i.menuItem?.name}"`);
  }

  // Cross-check: which beer menu items have a name that EXACTLY matches their inventory item name?
  console.log('\n\nName match analysis (menu name vs its own inventory item name):\n');
  for (const m of beerMenuItems) {
    const inv = (m as any).inventoryItem;
    if (!inv) {
      console.log(`  "${m.name}" -> NO inventory item created (Opening Stock not added)`);
      continue;
    }
    // The inventory item's menuItem is the SAME menuItem, so names always match.
    // The real question is: when an order is placed, the order item's menuItem.name
    // is used to find the inventory. Since inventory is linked by menuItemId,
    // the names SHOULD match. BUT the deduction code matches by NAME not by menuItemId!
    console.log(`  "${m.name}" -> inventory linked via menuItemId=${m.id} (name match: trivially YES)`);
  }

  // THE REAL ISSUE: orders may contain items whose menuItem was DELETED/RENAMED,
  // or the order item name doesn't match. Let's check actual order item names.
  console.log('\n\nActual beer order item names from recent orders vs inventory names:\n');
  const recentOrders = await prisma.order.findMany({
    where: { restaurantId, status: 'PAID', items: { some: { menuItem: { menuType: 'LIQUOR' } } } },
    include: { items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: { include: { category: { select: { name: true } } } } } } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });

  const orderBeerNames = new Set<string>();
  for (const o of recentOrders) {
    for (const it of o.items) {
      if (isBeerItem((it as any).menuItem)) orderBeerNames.add((it as any).menuItem.name);
    }
  }

  const invBeerNames = new Set(beerInv.map((i) => i.menuItem?.name));

  console.log('Order beer name'.padEnd(35) + ' | Exact match in inventory?');
  console.log('-'.repeat(70));
  for (const name of [...orderBeerNames].sort()) {
    console.log(name.padEnd(35) + ' | ' + (invBeerNames.has(name) ? 'YES' : 'NO  <-- MISMATCH'));
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
