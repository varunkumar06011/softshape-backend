import prisma from '../src/lib/prisma';

async function backfillOrderCaptainId() {
  // Step 1: Backfill orders with table captainId
  const orders = await prisma.order.findMany({
    where: { captainId: null },
    include: {
      table: { select: { captainId: true } },
      transactions: { select: { captainId: true } },
    },
  });

  let ordersUpdated = 0;
  for (const order of orders) {
    const txnCaptainId = order.transactions?.captainId;
    const captainId = txnCaptainId && txnCaptainId !== 'N/A'
      ? txnCaptainId
      : order.table?.captainId || null;

    if (captainId) {
      await prisma.order.update({
        where: { id: order.id },
        data: { captainId },
      });
      ordersUpdated++;
    }
  }
  console.log(`Backfilled ${ordersUpdated} of ${orders.length} orders with captainId.`);

  // Step 2: Backfill transactions whose captainId is N/A or null with the order's captainId
  const transactions = await prisma.transaction.findMany({
    where: {
      OR: [
        { captainId: null },
        { captainId: 'N/A' },
      ],
    },
    include: {
      order: { select: { captainId: true } },
    },
  });

  let txnsUpdated = 0;
  for (const txn of transactions) {
    const captainId = txn.order?.captainId;
    if (captainId && captainId !== 'N/A') {
      await prisma.transaction.update({
        where: { id: txn.id },
        data: { captainId },
      });
      txnsUpdated++;
    }
  }
  console.log(`Backfilled ${txnsUpdated} of ${transactions.length} transactions with captainId.`);
}

backfillOrderCaptainId()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
