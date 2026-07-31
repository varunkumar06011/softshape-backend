// Check: were these orders settled when no inventory items existed?
// Compare order paidAt vs inventory item createdAt
import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = 'cmqy60ci200027dscyj9ubg8h';

  // Get the Kf Ultra Beer inventory item creation time
  const invItem = await prisma.inventoryItem.findUnique({
    where: { menuItemId: '972382dd-1d33-43e5-a847-9c291f69d69a' },
    select: { id: true, createdAt: true, currentStock: true },
  });
  console.log(`Kf Ultra Beer inventory created at: ${invItem?.createdAt?.toISOString()}`);

  // Get all inventory items creation times (to see if any existed when orders were settled)
  const allInv = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    select: { id: true, createdAt: true, menuItem: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\nEarliest inventory item created: ${allInv[0]?.createdAt?.toISOString()} (${allInv[0]?.menuItem?.name})`);
  console.log(`Latest inventory item created:   ${allInv[allInv.length-1]?.createdAt?.toISOString()} (${allInv[allInv.length-1]?.menuItem?.name})`);
  console.log(`Total inventory items: ${allInv.length}`);

  // Check the orders
  const orderIds = [
    'bb1c1d6a-20d9-45c3-8021-4e31447baee4',
    '70caec6b-70da-424c-949f-8fc6681014b2',
    'ff1ec8f8-cbd8-4b52-a962-1944c99baf67',
    '3b82b1b2-4669-4616-8a74-0d0533293836',
  ];

  console.log('\n--- Order settlement times vs inventory creation ---');
  for (const orderId of orderIds) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, createdAt: true, paidAt: true, barInventoryDeducted: true, updatedAt: true },
    });
    console.log(`\nOrder ${orderId.slice(0, 8)}:`);
    console.log(`  createdAt:           ${order?.createdAt.toISOString()}`);
    console.log(`  paidAt:              ${order?.paidAt?.toISOString() ?? '(null)'}`);
    console.log(`  updatedAt:           ${order?.updatedAt.toISOString()}`);
    console.log(`  barInventoryDeducted: ${order?.barInventoryDeducted}`);
    console.log(`  inventory existed at settlement? ${invItem?.createdAt ? (order?.paidAt ? order.paidAt > invItem.createdAt : order?.updatedAt > invItem.createdAt) : '?'}`);
  }

  // KEY QUESTION: How many inventory items existed when the FIRST of these orders was settled?
  // If zero, that explains why barInventoryDeducted was set to true (no items to deduct from)
  const firstOrderPaidAt = await prisma.order.findUnique({
    where: { id: '3b82b1b2-4669-4616-8a74-0d0533293836' },
    select: { paidAt: true, updatedAt: true },
  });
  if (firstOrderPaidAt?.paidAt) {
    const invAtThatTime = await prisma.inventoryItem.count({
      where: { restaurantId, createdAt: { lt: firstOrderPaidAt.paidAt } },
    });
    console.log(`\n\nInventory items existing when first order was settled (${firstOrderPaidAt.paidAt.toISOString()}): ${invAtThatTime}`);
  }

  // Check: was barInventoryDeducted set to true at order CREATION (not settlement)?
  // The createOrder code sets: barInventoryDeducted: !hasLiquorItems
  // If hasLiquorItems was false at creation (items added later), it would be true.
  // But these orders have liquor items, so it should be false at creation.
  // Unless the order was created without items and items were added later...

  // Check order item creation times vs order creation time
  console.log('\n\n--- Order item creation times ---');
  for (const orderId of orderIds.slice(0, 2)) {
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      select: { id: true, menuItemId: true, createdAt: true, price: true, quantity: true },
      orderBy: { createdAt: 'asc' },
    });
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { createdAt: true } });
    console.log(`\nOrder ${orderId.slice(0, 8)} (created ${order?.createdAt.toISOString()}):`);
    for (const it of items) {
      console.log(`  item created ${it.createdAt.toISOString()}  menuItemId=${it.menuItemId.slice(0, 8)}  price=₹${it.price}  qty=${it.quantity}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
