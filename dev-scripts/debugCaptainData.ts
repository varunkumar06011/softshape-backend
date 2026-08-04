import prisma from '../src/lib/prisma';

async function debugCaptainData() {
  const captains = await prisma.user.findMany({
    where: { role: 'CAPTAIN' },
    select: { id: true, name: true, outletId: true },
  });
  console.log('Captains:', captains);

  const totalOrders = await prisma.order.count();
  const ordersWithCaptain = await prisma.order.count({ where: { captainId: { not: null } } });
  console.log(`Orders: ${totalOrders} total, ${ordersWithCaptain} with captainId`);

  const totalTables = await prisma.table.count();
  const tablesWithCaptain = await prisma.table.count({ where: { captainId: { not: null } } });
  console.log(`Tables: ${totalTables} total, ${tablesWithCaptain} with captainId`);

  const transactions = await prisma.transaction.findMany({
    take: 20,
    orderBy: { paidAt: 'desc' },
    select: {
      id: true,
      captainId: true,
      grandTotal: true,
      paidAt: true,
      orderId: true,
      restaurantId: true,
      order: { select: { captainId: true, tableId: true } },
    },
  });
  console.log('Recent transactions:', transactions.map(t => ({
    id: t.id,
    captainId: t.captainId,
    orderCaptainId: t.order?.captainId,
    tableId: t.order?.tableId,
    restaurantId: t.restaurantId,
    grandTotal: t.grandTotal,
    paidAt: t.paidAt,
  })));

  const captainIdCounts = await prisma.transaction.groupBy({
    by: ['captainId'],
    _count: { captainId: true },
    _sum: { grandTotal: true },
  });
  console.log('Transaction captainId summary:', captainIdCounts);
}

debugCaptainData()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
