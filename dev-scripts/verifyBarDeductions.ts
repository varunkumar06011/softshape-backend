import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h'; // Vgrand Lounge (Z3695J)

  // 1. Recent bar deduction logs
  const recentDeductions = await prisma.barDeductionLog.findMany({
    where: { restaurantId: outletId, status: 'SUCCESS' },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('=== Recent Bar Deduction Logs (last 10 SUCCESS) ===');
  console.log(`Total: ${recentDeductions.length}`);
  for (const d of recentDeductions) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: d.inventoryItemId }, select: { menuItemId: true } });
    const menuItem = item ? await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } }) : null;
    console.log(`  ${d.createdAt.toISOString()} | item: ${menuItem?.name || d.inventoryItemId.slice(-6)} | qty: ${d.quantity} | order: ${d.orderId.slice(-8)}`);
  }

  // 2. Recent inventory transactions
  const recentTxns = await prisma.inventoryTransaction.findMany({
    where: { restaurantId: outletId },
    orderBy: { transactionDate: 'desc' },
    take: 15,
  });
  console.log('\n=== Recent Inventory Transactions (last 15) ===');
  for (const t of recentTxns) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: t.itemId }, select: { menuItemId: true, currentStock: true } });
    const menuItem = item ? await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } }) : null;
    console.log(`  ${t.transactionDate.toISOString()} | ${t.type} | item: ${menuItem?.name || t.itemId.slice(-6)} | change: ${t.quantityChange} | before: ${t.stockBefore} → after: ${t.stockAfter} | current: ${item?.currentStock}`);
  }

  // 3. Today's settled bills and their deduction status
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const today = now.toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const startIST = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS);

  const todayTxns = await prisma.transaction.findMany({
    where: { restaurantId: outletId, status: 'COMPLETED', paidAt: { gte: startIST, lte: endIST } },
    select: { orderId: true, billNumber: true, grandTotal: true, paidAt: true },
  });
  console.log(`\n=== Today's Settled Bills (${today}) ===`);
  console.log(`Total: ${todayTxns.length}`);

  if (todayTxns.length > 0) {
    const orderIds = todayTxns.map(t => t.orderId).filter(Boolean) as string[];
    const todayDeductions = await prisma.barDeductionLog.findMany({
      where: { orderId: { in: orderIds }, restaurantId: outletId },
      select: { orderId: true, status: true, inventoryItemId: true, quantity: true },
    });
    const ordersWithDeductions = new Set(todayDeductions.map(dd => dd.orderId));
    const ordersWithout = orderIds.filter((oid: string) => !ordersWithDeductions.has(oid));
    console.log(`Orders with deduction logs: ${ordersWithDeductions.size}`);
    console.log(`Orders without deduction logs: ${ordersWithout.length} (may have no bar items)`);

    const successCount = todayDeductions.filter(d => d.status === 'SUCCESS').length;
    const failedCount = todayDeductions.filter(d => d.status !== 'SUCCESS').length;
    console.log(`Deduction log status: ${successCount} SUCCESS, ${failedCount} FAILED`);

    // Show sample successful deductions
    const successDeductions = todayDeductions.filter(d => d.status === 'SUCCESS');
    console.log(`\nSample deductions today:`);
    for (const d of successDeductions.slice(0, 10)) {
      const item = await prisma.inventoryItem.findUnique({ where: { id: d.inventoryItemId }, select: { menuItemId: true } });
      const menuItem = item ? await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } }) : null;
      console.log(`  order: ${d.orderId.slice(-8)} | item: ${menuItem?.name || d.inventoryItemId.slice(-6)} | qty: ${d.quantity} | ${d.status}`);
    }
  }

  // 4. Stock reconciliation: opening + purchases - deductions = current
  console.log('\n=== Stock Reconciliation Math ===');
  const allItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId },
    select: { id: true, menuItemId: true, openingStock: true, currentStock: true },
  });

  let mismatchCount = 0;
  for (const item of allItems) {
    const txns = await prisma.inventoryTransaction.findMany({
      where: { itemId: item.id },
      select: { type: true, quantityChange: true },
    });
    const purchases = txns.filter(t => t.type === 'PURCHASE').reduce((s, t) => s + Number(t.quantityChange), 0);
    const deductions = txns.filter(t => t.type === 'DEDUCTION').reduce((s, t) => s + Number(t.quantityChange), 0);
    const adjustments = txns.filter(t => t.type === 'ADJUSTMENT').reduce((s, t) => s + Number(t.quantityChange), 0);
    const expected = Number(item.openingStock) + purchases - deductions + adjustments;
    const current = Number(item.currentStock);
    if (Math.abs(expected - current) > 0.01) {
      mismatchCount++;
      const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } });
      console.log(`  MISMATCH: ${menuItem?.name || item.id.slice(-6)} | opening: ${item.openingStock} + purchases: ${purchases} - deductions: ${deductions} + adj: ${adjustments} = ${expected} vs current: ${current}`);
    }
  }

  if (mismatchCount === 0) {
    console.log(`✅ All ${allItems.length} items: opening + purchases - deductions = current stock (perfect match)`);
  } else {
    console.log(`❌ ${mismatchCount} items have stock mismatches out of ${allItems.length}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
