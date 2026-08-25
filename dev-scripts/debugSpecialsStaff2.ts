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

  // Exact same query as the today-specials-by-staff endpoint
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

  let totalOrderItems = 0;
  let specialItems = 0;
  let specialItemsWithCaptain = 0;
  let specialItemsWithoutCaptain = 0;

  for (const txn of completedTxns as any[]) {
    const items = txn.order?.items || [];
    for (const item of items) {
      totalOrderItems++;
      const menuItem = item.menuItem;
      if (!menuItem) {
        console.log(`  [WARN] OrderItem ${item.id} has no menuItem`);
        continue;
      }
      if (menuItem.isSpecial && !menuItem.isDeleted) {
        specialItems++;
        const qty = Number(item.quantity || 0);
        if (qty <= 0) continue;
        if (txn.captainId && txn.captainId !== 'N/A') {
          specialItemsWithCaptain++;
        } else {
          specialItemsWithoutCaptain++;
        }
        console.log(`  SPECIAL: order=${txn.orderId}, item=${menuItem.name}, qty=${qty}, captain=${txn.captainId}`);
      }
    }
  }

  console.log(`\nTotal order items: ${totalOrderItems}`);
  console.log(`Special items (isSpecial=true, not deleted): ${specialItems}`);
  console.log(`  With txn captain: ${specialItemsWithCaptain}`);
  console.log(`  Without txn captain: ${specialItemsWithoutCaptain}`);

  // Also check: how many transactions have captainId set at all?
  const withCaptain = completedTxns.filter((t: any) => t.captainId && t.captainId !== 'N/A').length;
  console.log(`\nTransactions with captainId: ${withCaptain} / ${completedTxns.length}`);

  // Check KOTs
  const paidOrderIds = new Set((completedTxns as any[]).map((t: any) => t.orderId).filter(Boolean));
  const kots = await prisma.kot.findMany({
    where: {
      captainId: { not: null },
      orderId: { in: Array.from(paidOrderIds) },
    },
    include: { items: { include: { orderItem: { select: { id: true } } } } },
  });
  console.log(`KOTs with captain: ${kots.length}`);

  // Count KOTs that have items linked to special order items
  const specialOrderItemIds = new Set<string>();
  for (const txn of completedTxns as any[]) {
    const items = txn.order?.items || [];
    for (const item of items) {
      if (item.menuItem?.isSpecial && !item.menuItem?.isDeleted) {
        specialOrderItemIds.add(item.id);
      }
    }
  }
  console.log(`Special order item IDs: ${specialOrderItemIds.size}`);

  let kotsWithSpecialItems = 0;
  for (const kot of kots as any[]) {
    for (const kotItem of kot.items || []) {
      if (kotItem.orderItem?.id && specialOrderItemIds.has(kotItem.orderItem.id)) {
        kotsWithSpecialItems++;
        console.log(`  KOT ${kot.id} for order ${kot.orderId} has special item, captain=${kot.captainId}`);
        break;
      }
    }
  }
  console.log(`KOTs with special items: ${kotsWithSpecialItems}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
