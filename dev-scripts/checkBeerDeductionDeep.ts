// Deep dive: for the recent beer orders, check ALL bar deduction logs (not just beer),
// the exact order item names vs inventory item names, and whether the orders have paidAt.
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

  const orders = await prisma.order.findMany({
    where: { restaurantId, status: 'PAID', items: { some: { menuItem: { menuType: 'LIQUOR' } } } },
    include: { items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: { include: { category: { select: { name: true } } } } } } },
    orderBy: { createdAt: 'desc' },
    take: 8,
  });

  // All inventory items for name comparison
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { name: true, menuType: true } } },
  });
  const invNames = invItems.map((i) => i.menuItem?.name).filter(Boolean);

  for (const o of orders) {
    console.log(`\n=== Order ${o.id} ===`);
    console.log(`  status=${o.status}  paidAt=${(o as any).paidAt ?? '(null)'}  createdAt=${o.createdAt.toISOString()}`);
    console.log(`  barInventoryDeducted=${(o as any).barInventoryDeducted}  inventoryDeducted=${(o as any).inventoryDeducted}`);

    const beerItems = o.items.filter((it: any) => isBeerItem(it.menuItem));
    if (beerItems.length === 0) continue;

    console.log(`  Beer items ordered:`);
    for (const it of beerItems) {
      const orderedName = it.menuItem.name;
      // Try to find a match in inventory names (mirrors findInventoryForOrderedItem)
      const normalized = orderedName.toLowerCase().trim();
      const direct = invNames.find((n) => n!.toLowerCase().trim() === normalized);
      const fuzzy = invNames.find((n) => {
        const nn = n!.toLowerCase().trim();
        return nn !== normalized && (nn.startsWith(normalized + ' ') || normalized.startsWith(nn + ' '));
      });
      console.log(`    - "${orderedName}" @ ₹${it.price} x${it.quantity}  -> direct match: ${direct ?? 'NONE'}  fuzzy: ${fuzzy ?? 'NONE'}`);
    }

    // ALL bar deduction logs for this order
    const logs = await prisma.barDeductionLog.findMany({
      where: { orderId: o.id },
      include: { inventoryItem: { include: { menuItem: { select: { name: true } } } } },
    });
    console.log(`  Bar deduction logs (${logs.length}):`);
    if (logs.length === 0) console.log(`    (none — deduction did NOT run or found no matching inventory)`);
    for (const l of logs) {
      console.log(`    - inv="${l.inventoryItem?.menuItem?.name}"  qty=${l.quantity}ml  status=${l.status}${l.error ? `  err=${l.error}` : ''}`);
    }
  }

  // Also: check if there's a time gap between when beer inventory items were created vs when these orders were settled
  console.log('\n\n=== Beer inventory item creation times ===');
  const beerInv = invItems.filter((i) => isBeerItem(i.menuItem));
  for (const bi of beerInv.slice(0, 5)) {
    console.log(`  ${bi.menuItem?.name}: created=${(bi as any).createdAt?.toISOString?.() ?? '?'}  lastRestocked=${(bi as any).lastRestocked?.toISOString?.() ?? '?'}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
