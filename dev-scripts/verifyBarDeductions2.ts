import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h'; // Vgrand Lounge (Z3695J)

  // Check what transaction types exist
  const types = await prisma.inventoryTransaction.groupBy({
    by: ['type'],
    where: { restaurantId: outletId },
    _count: { id: true },
  });
  console.log('=== Transaction Types ===');
  for (const t of types) console.log(`  ${t.type}: ${t._count.id} records`);

  // Correct reconciliation: opening + purchases - sales + adjustments = current
  // But first, understand what ADJUSTMENT means
  const allItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId },
    select: { id: true, menuItemId: true, openingStock: true, currentStock: true },
  });

  console.log('\n=== Stock Reconciliation (corrected) ===');
  let mismatchCount = 0;
  let perfectCount = 0;

  for (const item of allItems) {
    const txns = await prisma.inventoryTransaction.findMany({
      where: { itemId: item.id },
      select: { type: true, quantityChange: true, stockBefore: true, stockAfter: true, transactionDate: true },
      orderBy: { transactionDate: 'asc' },
    });

    // Sum by type
    const byType: Record<string, number> = {};
    for (const t of txns) {
      byType[t.type] = (byType[t.type] || 0) + Number(t.quantityChange);
    }

    // Formula: currentStock should equal last transaction's stockAfter
    // Or: openingStock + sum(all quantityChange) = currentStock
    const totalChange = txns.reduce((s, t) => s + Number(t.quantityChange), 0);
    const expected = Number(item.openingStock) + totalChange;
    const current = Number(item.currentStock);

    if (Math.abs(expected - current) > 0.01) {
      mismatchCount++;
      const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } });
      console.log(`  MISMATCH: ${menuItem?.name || item.id.slice(-6)}`);
      console.log(`    opening: ${item.openingStock} + totalChange: ${totalChange} = ${expected} vs current: ${current}`);
      console.log(`    by type: ${JSON.stringify(byType)}`);
    } else {
      perfectCount++;
    }
  }

  console.log(`\n✅ Perfect match: ${perfectCount}/${allItems.length}`);
  console.log(`❌ Mismatches: ${mismatchCount}/${allItems.length}`);

  // Also verify: does the last transaction's stockAfter match currentStock?
  console.log('\n=== Last Transaction stockAfter vs currentStock ===');
  let lastTxnMatch = 0;
  let lastTxnMismatch = 0;
  for (const item of allItems) {
    const lastTxn = await prisma.inventoryTransaction.findFirst({
      where: { itemId: item.id },
      orderBy: { transactionDate: 'desc' },
      select: { stockAfter: true, type: true, quantityChange: true },
    });
    if (!lastTxn) {
      // No transactions — currentStock should equal openingStock
      if (Math.abs(Number(item.openingStock) - Number(item.currentStock)) < 0.01) {
        lastTxnMatch++;
      } else {
        lastTxnMismatch++;
        const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } });
        console.log(`  NO TXN MISMATCH: ${menuItem?.name || item.id.slice(-6)} | opening: ${item.openingStock} vs current: ${item.currentStock}`);
      }
    } else if (Math.abs(Number(lastTxn.stockAfter) - Number(item.currentStock)) < 0.01) {
      lastTxnMatch++;
    } else {
      lastTxnMismatch++;
      const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } });
      console.log(`  LAST TXN MISMATCH: ${menuItem?.name || item.id.slice(-6)} | last stockAfter: ${lastTxn.stockAfter} vs current: ${item.currentStock} (type: ${lastTxn.type}, change: ${lastTxn.quantityChange})`);
    }
  }
  console.log(`\n✅ Last txn matches current: ${lastTxnMatch}/${allItems.length}`);
  console.log(`❌ Last txn mismatches: ${lastTxnMismatch}/${allItems.length}`);

  // Show a sample item's full transaction history
  console.log('\n=== Sample: Mc Whisky full transaction history ===');
  const mcItem = allItems.find(async i => {
    const mi = await prisma.menuItem.findUnique({ where: { id: i.menuItemId }, select: { name: true } });
    return mi?.name === 'Mc Whisky';
  });
  if (mcItem) {
    const txns = await prisma.inventoryTransaction.findMany({
      where: { itemId: mcItem.id },
      orderBy: { transactionDate: 'asc' },
      select: { type: true, quantityChange: true, stockBefore: true, stockAfter: true, transactionDate: true, orderId: true },
    });
    console.log(`  Opening: ${mcItem.openingStock}, Current: ${mcItem.currentStock}`);
    for (const t of txns) {
      console.log(`    ${t.transactionDate.toISOString()} | ${t.type} | change: ${t.quantityChange} | ${t.stockBefore} → ${t.stockAfter} | order: ${t.orderId?.slice(-8) || 'N/A'}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
