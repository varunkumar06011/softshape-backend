import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletIds = [
    'cmqy60ci200027dscyj9ubg8h',
    'cmr03m0fa00015ot8jh16grhn',
  ];
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const startIST = new Date(Date.UTC(2026, 7, 22, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(2026, 7, 22, 23, 59, 59, 999) - IST_OFFSET_MS);

  // Get transactions
  const txns = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
    },
    select: {
      orderId: true,
      captainId: true,
      items: true,
      order: {
        select: {
          id: true,
          items: {
            where: { removedFromBill: false, quantity: { gt: 0 } },
            include: { menuItem: { select: { id: true, name: true, isSpecial: true, isDeleted: true } } },
          },
        },
      },
    },
    take: 5,
  });

  console.log(`Sample transactions: ${txns.length}\n`);
  for (const txn of txns as any[]) {
    console.log(`=== Order ${txn.orderId} ===`);
    console.log(`  captainId: ${txn.captainId}`);
    console.log(`  transaction.items (JSON): ${Array.isArray(txn.items) ? txn.items.length : 'not array'} items`);
    if (Array.isArray(txn.items)) {
      for (const item of txn.items.slice(0, 3)) {
        console.log(`    menuItemId=${item.menuItemId || item.id}, name=${item.n || item.name}, q=${item.q || item.quantity}`);
      }
    }
    console.log(`  order.items (relation): ${txn.order?.items?.length || 0} items`);
    if (txn.order?.items) {
      for (const item of txn.order.items.slice(0, 3)) {
        console.log(`    id=${item.id}, menuItemId=${item.menuItemId}, name=${item.name}, menuItem.isSpecial=${item.menuItem?.isSpecial}, menuItem.isDeleted=${item.menuItem?.isDeleted}`);
      }
    }
    console.log('');
  }

  // Check: do the transaction.items menuItemIds match the order.items menuItemIds?
  const allTxns = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
    },
    select: { orderId: true, items: true },
  });

  // Get all special menuItem IDs from transaction.items JSON
  const activeSpecials = await prisma.menuItem.findMany({
    where: { restaurantId: { in: outletIds }, isSpecial: true },
    select: { id: true, name: true },
  });
  const specialIds = new Set(activeSpecials.map(s => s.id));
  console.log(`\nActive special menu item IDs: ${specialIds.size}`);

  // Find transactions that have special items in their JSON
  const txnsWithSpecialsInJSON = allTxns.filter((t: any) => {
    const items = Array.isArray(t.items) ? t.items : [];
    return items.some((item: any) => specialIds.has(item.menuItemId || item.id));
  });
  console.log(`Transactions with specials in JSON: ${txnsWithSpecialsInJSON.length}`);

  // For those transactions, check if the order has OrderItem records with those menuItemIds
  const orderIdsWithSpecials = txnsWithSpecialsInJSON.map((t: any) => t.orderId);
  console.log(`Order IDs with specials: ${orderIdsWithSpecials.length}`);

  const orderItems = await prisma.orderItem.findMany({
    where: { orderId: { in: orderIdsWithSpecials }, removedFromBill: false },
    include: { menuItem: { select: { id: true, name: true, isSpecial: true, isDeleted: true } } },
  });
  console.log(`OrderItem records for those orders: ${orderItems.length}`);

  // Check how many order items have menuItem.isSpecial = true
  const specialOrderItems = orderItems.filter((oi: any) => oi.menuItem?.isSpecial === true);
  console.log(`OrderItems with menuItem.isSpecial=true: ${specialOrderItems.length}`);

  // Check how many order items have menuItemId in specialIds
  const orderItemsWithSpecialMenuId = orderItems.filter((oi: any) => specialIds.has(oi.menuItemId));
  console.log(`OrderItems with menuItemId in specialIds: ${orderItemsWithSpecialMenuId.length}`);

  // Show some examples where menuItemId is in specialIds but isSpecial is false
  const mismatched = orderItemsWithSpecialMenuId.filter((oi: any) => !oi.menuItem?.isSpecial);
  console.log(`\nMismatched (menuItemId in specialIds but isSpecial=false): ${mismatched.length}`);
  for (const oi of mismatched.slice(0, 5)) {
    console.log(`  orderItem.id=${oi.id}, menuItemId=${oi.menuItemId}, menuItem.name=${oi.menuItem?.name}, isSpecial=${oi.menuItem?.isSpecial}, isDeleted=${oi.menuItem?.isDeleted}`);
  }

  // Check: are there OrderItem records at all for these orders?
  const ordersWithNoItems = orderIdsWithSpecials.filter(oid => !orderItems.some((oi: any) => oi.orderId === oid));
  console.log(`\nOrders with specials in JSON but NO OrderItem records: ${ordersWithNoItems.length}`);
  for (const oid of ordersWithNoItems.slice(0, 5)) {
    console.log(`  ${oid}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
