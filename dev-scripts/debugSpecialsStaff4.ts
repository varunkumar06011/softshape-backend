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

  // Query ALL transactions (like the backend does)
  const completedTxns = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
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

  console.log(`Total completed txns: ${completedTxns.length}`);

  // Check first 5 transactions in detail
  let count = 0;
  let totalItems = 0;
  let nullMenuItemCount = 0;
  let isSpecialTrue = 0;
  let isSpecialFalse = 0;
  let isSpecialUndefined = 0;

  for (const txn of completedTxns as any[]) {
    const items = txn.order?.items || [];
    for (const item of items) {
      totalItems++;
      if (!item.menuItem) {
        nullMenuItemCount++;
        if (count < 3) {
          console.log(`  [NULL menuItem] orderItem.id=${item.id}, menuItemId=${item.menuItemId}, orderId=${txn.orderId}`);
          count++;
        }
        continue;
      }
      if (item.menuItem.isSpecial === true) {
        isSpecialTrue++;
        if (isSpecialTrue <= 3) {
          console.log(`  [isSpecial=true] orderItem.id=${item.id}, name=${item.menuItem.name}, orderId=${txn.orderId}`);
        }
      } else if (item.menuItem.isSpecial === false) {
        isSpecialFalse++;
      } else {
        isSpecialUndefined++;
        if (isSpecialUndefined <= 3) {
          console.log(`  [isSpecial=undefined] orderItem.id=${item.id}, menuItemId=${item.menuItemId}, name=${item.menuItem?.name}, keys=${Object.keys(item.menuItem).join(',')}`);
        }
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Total items: ${totalItems}`);
  console.log(`  Null menuItem: ${nullMenuItemCount}`);
  console.log(`  isSpecial=true: ${isSpecialTrue}`);
  console.log(`  isSpecial=false: ${isSpecialFalse}`);
  console.log(`  isSpecial=undefined: ${isSpecialUndefined}`);

  // Now check: does the order relation exist for all transactions?
  const noOrder = completedTxns.filter((t: any) => !t.order);
  console.log(`\nTransactions with no order relation: ${noOrder.length}`);

  // Check: are the 24 orders with specials in this result set?
  const activeSpecials = await prisma.menuItem.findMany({
    where: { restaurantId: { in: outletIds }, isSpecial: true },
    select: { id: true, name: true },
  });
  const specialIds = new Set(activeSpecials.map(s => s.id));

  const txnsWithSpecialItems = completedTxns.filter((t: any) => {
    const items = t.order?.items || [];
    return items.some((item: any) => specialIds.has(item.menuItemId));
  });
  console.log(`Transactions whose order has items with special menuItemId: ${txnsWithSpecialItems.length}`);

  // For those transactions, check if menuItem.isSpecial is loaded
  for (const txn of txnsWithSpecialItems.slice(0, 3) as any[]) {
    const items = txn.order?.items || [];
    const specialItemsInOrder = items.filter((item: any) => specialIds.has(item.menuItemId));
    console.log(`\n  Order ${txn.orderId}:`);
    for (const item of specialItemsInOrder) {
      console.log(`    item.id=${item.id}, menuItemId=${item.menuItemId}, menuItem=${JSON.stringify(item.menuItem)}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
