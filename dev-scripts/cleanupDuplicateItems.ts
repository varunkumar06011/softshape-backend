/**
 * One-off audit script: Detect duplicate order items caused by the KOT
 * timeout race condition that existed before the fix.
 *
 * Criteria for "near-duplicate":
 *   - Same orderId
 *   - Same menuItemId
 *   - Same name
 *   - Same price
 *   - createdAt timestamps within 60 seconds of each other
 *   - Not removedFromBill
 *
 * Usage:
 *   npx tsx dev-scripts/cleanupDuplicateItems.ts
 *
 * Dry-run by default — outputs a table for manual review.
 * Pass --execute to auto-remove the later duplicate rows (keeps the earliest).
 */

import prisma from '../src/lib/prisma';

async function main() {
  const execute = process.argv.includes('--execute');

  console.log(execute
    ? '⚠️  EXECUTE MODE — duplicate rows WILL be deleted (earliest kept)'
    : '🔍 DRY RUN — no changes will be made. Pass --execute to apply.'
  );
  console.log('');

  // Fetch all non-removed order items with their order info, ordered by orderId + createdAt
  const items = await prisma.orderItem.findMany({
    where: { removedFromBill: false },
    include: {
      order: {
        select: {
          id: true,
          tableId: true,
          tableNumber: true,
          lastRequestId: true,
          restaurantId: true,
        },
      },
    },
    orderBy: [{ orderId: 'asc' }, { createdAt: 'asc' }],
  });

  console.log(`Total non-removed order items scanned: ${items.length}`);

  // Group by (orderId, menuItemId, name, price) and find near-duplicates within 60s
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.orderId}::${item.menuItemId}::${item.name}::${item.price}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const duplicates: Array<{
    orderId: string;
    tableNumber: string | number | null;
    itemName: string;
    price: number;
    duplicateRows: Array<{ id: string; quantity: number; createdAt: Date }>;
    keepRow: { id: string; quantity: number; createdAt: Date };
    lastRequestId: string | null;
    restaurantId: string;
  }> = [];

  for (const [key, groupItems] of groups) {
    if (groupItems.length < 2) continue;

    // Sort by createdAt ascending
    const sorted = [...groupItems].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Find items within 60s of each other
    const keep = sorted[0];
    const dups: typeof sorted = [];
    for (let i = 1; i < sorted.length; i++) {
      const timeDiff = sorted[i].createdAt.getTime() - keep.createdAt.getTime();
      if (timeDiff <= 60000) {
        dups.push(sorted[i]);
      }
    }

    if (dups.length > 0) {
      duplicates.push({
        orderId: keep.orderId,
        tableNumber: keep.order.tableNumber,
        itemName: keep.name,
        price: Number(keep.price),
        keepRow: { id: keep.id, quantity: keep.quantity, createdAt: keep.createdAt },
        duplicateRows: dups.map(d => ({ id: d.id, quantity: d.quantity, createdAt: d.createdAt })),
        lastRequestId: keep.order.lastRequestId,
        restaurantId: keep.order.restaurantId,
      });
    }
  }

  console.log(`\nFound ${duplicates.length} order(s) with near-duplicate items.\n`);

  if (duplicates.length === 0) {
    console.log('✅ No duplicates detected. Database is clean.');
    return;
  }

  // Print table
  console.log('─'.repeat(120));
  console.log('Order ID'.padEnd(28) + 'Table'.padEnd(10) + 'Item'.padEnd(25) + 'Price'.padEnd(10) + 'Keep Qty'.padEnd(12) + 'Dup Qty'.padEnd(12) + 'Request ID');
  console.log('─'.repeat(120));

  let totalDupQty = 0;
  const idsToDelete: string[] = [];

  for (const dup of duplicates) {
    const keepQty = dup.keepRow.quantity;
    const dupQty = dup.duplicateRows.reduce((sum, d) => sum + d.quantity, 0);
    totalDupQty += dupQty;
    dup.duplicateRows.forEach(d => idsToDelete.push(d.id));

    console.log(
      dup.orderId.padEnd(28) +
      String(dup.tableNumber ?? '?').padEnd(10) +
      dup.itemName.slice(0, 24).padEnd(25) +
      `₹${dup.price}`.padEnd(10) +
      String(keepQty).padEnd(12) +
      String(dupQty).padEnd(12) +
      (dup.lastRequestId ?? 'null')
    );
  }

  console.log('─'.repeat(120));
  console.log(`Total duplicate quantity across all orders: ${totalDupQty}`);
  console.log(`Total duplicate rows to delete: ${idsToDelete.length}`);

  if (execute) {
    console.log('\n🗑️  Deleting duplicate rows...');
    const result = await prisma.orderItem.deleteMany({
      where: { id: { in: idsToDelete } },
    });
    console.log(`✅ Deleted ${result.count} duplicate order item rows.`);

    // Recalculate affected orders' totalAmount
    const affectedOrderIds = [...new Set(duplicates.map(d => d.orderId))];
    console.log(`\n🔄 Recalculating totalAmount for ${affectedOrderIds.length} affected orders...`);
    for (const orderId of affectedOrderIds) {
      const remainingItems = await prisma.orderItem.findMany({
        where: { orderId, removedFromBill: false },
      });
      const newTotal = remainingItems.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
      await prisma.order.update({
        where: { id: orderId },
        data: { totalAmount: newTotal },
      });
      console.log(`  Order ${orderId}: totalAmount updated to ₹${newTotal.toFixed(2)}`);
    }
  } else {
    console.log('\n📋 Review the above table. Run with --execute to delete duplicates and recalculate order totals.');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
