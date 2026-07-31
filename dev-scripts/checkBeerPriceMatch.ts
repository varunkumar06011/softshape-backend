// Quick check: compare ordered beer prices vs inventory variant prices
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

  // Get beer inventory with variants
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { include: { variants: true, category: { select: { name: true } } } } },
  });
  const beerInv = invItems.filter((i) => isBeerItem(i.menuItem));

  // Get today's beer order items
  const today = '2026-07-31';
  const todayStart = new Date(today + 'T00:00:00+05:30');
  const todayEnd = new Date(today + 'T23:59:59+05:30');
  const todayOrders = await prisma.order.findMany({
    where: { restaurantId, createdAt: { gte: todayStart, lte: todayEnd } },
    include: { items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: { include: { category: { select: { name: true } } } } } } },
  });

  const orderedBeerItems: Array<{ name: string; price: number; quantity: number; orderId: string }> = [];
  for (const o of todayOrders) {
    for (const it of o.items) {
      if (isBeerItem((it as any).menuItem)) {
        orderedBeerItems.push({ name: (it as any).menuItem.name, price: Number(it.price), quantity: it.quantity, orderId: o.id });
      }
    }
  }

  console.log('=== Ordered beer prices today vs inventory variant prices ===\n');
  for (const ordered of orderedBeerItems) {
    // Find matching inventory by exact name
    const matchedInv = beerInv.find((i) => i.menuItem.name.toLowerCase().trim() === ordered.name.toLowerCase().trim());
    console.log(`Ordered: "${ordered.name}" @ ₹${ordered.price} x${ordered.quantity}  (order ${ordered.orderId.slice(0, 8)})`);
    if (!matchedInv) {
      console.log(`  -> NO inventory match by name. Available inventory names:`);
      for (const inv of beerInv) console.log(`     "${inv.menuItem.name}"`);
    } else {
      console.log(`  -> Matched inventory: "${matchedInv.menuItem.name}"  stock=${matchedInv.currentStock}ml`);
      console.log(`     Inventory variants:`);
      for (const v of (matchedInv.menuItem as any).variants) {
        const matches = Number(v.price) === ordered.price;
        console.log(`       - "${v.name}" @ ₹${v.price}  ${matches ? '<<< PRICE MATCHES' : ''}`);
      }
      // Check what mlPerUnit the deduction logic would compute
      const variants = (matchedInv.menuItem as any).variants as Array<{ name: string; price: any }>;
      const matchedVariant = variants.find(v => Number(v.price) === ordered.price);
      if (matchedVariant) {
        const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
        const mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? 650 : parsedMl;
        console.log(`     -> mlPerUnit would be: ${mlPerUnit}ml  (totalMl = ${mlPerUnit * ordered.quantity})`);
      } else {
        console.log(`     -> NO variant price match -> defaults to 650ml per unit`);
        console.log(`     -> mlPerUnit would be: 650ml  (totalMl = ${650 * ordered.quantity})`);
      }
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
