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

  // Get the 24 order IDs that have specials in their transaction JSON
  const activeSpecials = await prisma.menuItem.findMany({
    where: { restaurantId: { in: outletIds }, isSpecial: true },
    select: { id: true, name: true },
  });
  const specialIds = new Set(activeSpecials.map(s => s.id));

  const txns = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
    },
    select: { orderId: true, items: true },
  });

  const orderIdsWithSpecials = txns
    .filter((t: any) => {
      const items = Array.isArray(t.items) ? t.items : [];
      return items.some((item: any) => specialIds.has(item.menuItemId || item.id));
    })
    .map((t: any) => t.orderId);

  console.log(`Order IDs with specials in JSON: ${orderIdsWithSpecials.length}`);

  // Method 1: Direct orderItem.findMany (like the debug script)
  const directOrderItems = await prisma.orderItem.findMany({
    where: { orderId: { in: orderIdsWithSpecials }, removedFromBill: false },
    include: { menuItem: { select: { id: true, name: true, isSpecial: true, isDeleted: true } } },
  });
  const directSpecials = directOrderItems.filter((oi: any) => oi.menuItem?.isSpecial === true);
  console.log(`\nMethod 1 (direct orderItem.findMany):`);
  console.log(`  Total order items: ${directOrderItems.length}`);
  console.log(`  Special items: ${directSpecials.length}`);
  for (const oi of directSpecials.slice(0, 5)) {
    console.log(`    id=${oi.id}, orderId=${oi.orderId}, menuItemId=${oi.menuItemId}, name=${oi.menuItem?.name}, isSpecial=${oi.menuItem?.isSpecial}, qty=${oi.quantity}, removedFromBill=${oi.removedFromBill}`);
  }

  // Method 2: Nested transaction → order → items (like the backend endpoint)
  const nestedTxns = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
      orderId: { in: orderIdsWithSpecials },
    },
    select: {
      orderId: true,
      captainId: true,
      order: {
        select: {
          id: true,
          items: {
            where: { removedFromBill: false, quantity: { gt: 0 } },
            include: { menuItem: { select: { id: true, name: true, basePrice: true, isSpecial: true, isDeleted: true } } },
          },
        },
      },
    },
  });

  console.log(`\nMethod 2 (nested transaction → order → items):`);
  console.log(`  Transactions: ${nestedTxns.length}`);
  let nestedTotalItems = 0;
  let nestedSpecials = 0;
  for (const txn of nestedTxns as any[]) {
    const items = txn.order?.items || [];
    for (const item of items) {
      nestedTotalItems++;
      if (item.menuItem?.isSpecial === true) {
        nestedSpecials++;
        console.log(`    id=${item.id}, orderId=${txn.orderId}, menuItemId=${item.menuItemId}, name=${item.menuItem?.name}, isSpecial=${item.menuItem?.isSpecial}, qty=${item.quantity}`);
      }
    }
  }
  console.log(`  Total order items: ${nestedTotalItems}`);
  console.log(`  Special items: ${nestedSpecials}`);

  // Method 3: Same as method 2 but WITHOUT the quantity filter
  const nestedTxnsNoQtyFilter = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
      orderId: { in: orderIdsWithSpecials },
    },
    select: {
      orderId: true,
      order: {
        select: {
          id: true,
          items: {
            where: { removedFromBill: false },
            include: { menuItem: { select: { id: true, name: true, isSpecial: true, isDeleted: true } } },
          },
        },
      },
    },
  });

  console.log(`\nMethod 3 (nested, no quantity filter):`);
  let noQtyTotalItems = 0;
  let noQtySpecials = 0;
  for (const txn of nestedTxnsNoQtyFilter as any[]) {
    const items = txn.order?.items || [];
    for (const item of items) {
      noQtyTotalItems++;
      if (item.menuItem?.isSpecial === true) {
        noQtySpecials++;
        if (noQtySpecials <= 5) {
          console.log(`    id=${item.id}, orderId=${txn.orderId}, menuItemId=${item.menuItemId}, name=${item.menuItem?.name}, isSpecial=${item.menuItem?.isSpecial}, qty=${item.quantity}`);
        }
      }
    }
  }
  console.log(`  Total order items: ${noQtyTotalItems}`);
  console.log(`  Special items: ${noQtySpecials}`);

  // Check: do the direct order items have quantity > 0?
  const directSpecialsWithQty = directSpecials.filter((oi: any) => oi.quantity > 0);
  console.log(`\nDirect specials with quantity > 0: ${directSpecialsWithQty.length}`);
  const directSpecialsWithZeroQty = directSpecials.filter((oi: any) => oi.quantity <= 0);
  console.log(`Direct specials with quantity <= 0: ${directSpecialsWithZeroQty.length}`);
  for (const oi of directSpecialsWithZeroQty.slice(0, 5)) {
    console.log(`    id=${oi.id}, orderId=${oi.orderId}, name=${oi.menuItem?.name}, qty=${oi.quantity}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
