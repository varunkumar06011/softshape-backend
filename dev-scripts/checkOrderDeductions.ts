import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';

  // Check order dates for orders with flag but no SUCCESS logs
  const flaggedOrders = await prisma.order.findMany({
    where: { restaurantId: outletId, barInventoryDeducted: true },
    select: { id: true, createdAt: true },
    take: 200,
  });

  let noLogCount = 0;
  let noLogWithLiquor = 0;
  const dateBuckets: Record<string, number> = {};

  for (const order of flaggedOrders) {
    const logs = await prisma.barDeductionLog.findMany({
      where: { orderId: order.id, status: 'SUCCESS' },
      select: { id: true },
    });
    if (logs.length === 0) {
      noLogCount++;
      const items = await prisma.orderItem.findMany({
        where: { orderId: order.id, removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: { select: { menuType: true } } },
      });
      const liquorItems = items.filter(i => (i.menuItem?.menuType as string) === 'LIQUOR' || (i.menuItem?.menuType as string) === 'BAR');
      if (liquorItems.length > 0) {
        noLogWithLiquor++;
        const date = order.createdAt.toISOString().slice(0, 10);
        dateBuckets[date] = (dateBuckets[date] || 0) + 1;
      }
    }
  }

  console.log(`=== Orders with flag but no SUCCESS deduction logs ===`);
  console.log(`Total flagged: ${flaggedOrders.length}`);
  console.log(`No SUCCESS logs: ${noLogCount}`);
  console.log(`No SUCCESS logs but HAS liquor items: ${noLogWithLiquor}`);
  console.log(`\nBy date:`);
  for (const [date, count] of Object.entries(dateBuckets).sort()) {
    console.log(`  ${date}: ${count} orders`);
  }

  // Check when bar inventory items were first created
  const firstInvItem = await prisma.inventoryItem.findFirst({
    where: { restaurantId: outletId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, menuItemId: true },
  });
  console.log(`\nFirst inventory item created: ${firstInvItem?.createdAt.toISOString()}`);

  // Check when BarItemMapping was first created
  const firstMapping = await prisma.barItemMapping.findFirst({
    where: { restaurantId: outletId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  console.log(`First BarItemMapping created: ${firstMapping?.createdAt?.toISOString() || 'none'}`);

  // Check a sample order with liquor items but no deduction
  const sampleOrder = flaggedOrders.find(async o => {
    const logs = await prisma.barDeductionLog.findMany({ where: { orderId: o.id, status: 'SUCCESS' } });
    if (logs.length > 0) return false;
    const items = await prisma.orderItem.findMany({
      where: { orderId: o.id, removedFromBill: false, quantity: { gt: 0 } },
      include: { menuItem: { select: { name: true, menuType: true } } },
    });
    return items.some(i => (i.menuItem?.menuType as string) === 'LIQUOR' || (i.menuItem?.menuType as string) === 'BAR');
  });

  if (sampleOrder) {
    const fullOrder = await prisma.order.findUnique({
      where: { id: sampleOrder.id },
      select: { id: true, createdAt: true, barInventoryDeducted: true },
    });
    console.log(`\nSample order: ${fullOrder?.id.slice(-8)} created ${fullOrder?.createdAt.toISOString()}`);

    const orderItems = await prisma.orderItem.findMany({
      where: { orderId: fullOrder!.id, removedFromBill: false, quantity: { gt: 0 } },
      include: { menuItem: { select: { name: true, menuType: true } } },
    });
    const liquorItems = orderItems.filter(i => (i.menuItem?.menuType as string) === 'LIQUOR' || (i.menuItem?.menuType as string) === 'BAR');
    console.log(`  Liquor items: ${liquorItems.length}`);
    for (const li of liquorItems.slice(0, 3)) {
      // Check if this menu item has an inventory item
      const invItem = await prisma.inventoryItem.findFirst({
        where: { menuItemId: li.menuItemId, restaurantId: outletId },
        select: { id: true, isActive: true },
      });
      // Check if there's a BarItemMapping
      const mapping = await prisma.barItemMapping.findFirst({
        where: { menuItemId: li.menuItemId, restaurantId: outletId },
        select: { id: true },
      });
      console.log(`    ${li.menuItem?.name} x${li.quantity} | invItem: ${invItem ? (invItem.isActive ? 'active' : 'archived') : 'NONE'} | mapping: ${mapping ? 'yes' : 'NO'}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
