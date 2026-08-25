import { PrismaClient, Prisma } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';

  // ═══════════════════════════════════════════════════════════════════════
  // FAILURE 1: 2 items where currentStock ≠ last txn stockAfter
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`=== FAILURE 1: currentStock ≠ last txn stockAfter ===\n`);

  const mismatchedItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId, isActive: true, currentStock: 0 },
    include: { menuItem: { select: { name: true } } },
  });

  for (const item of mismatchedItems) {
    const lastTxn = await prisma.inventoryTransaction.findFirst({
      where: { itemId: item.id },
      orderBy: { transactionDate: 'desc' },
      select: { stockAfter: true, type: true, quantityChange: true, stockBefore: true, transactionDate: true, notes: true },
    });
    if (lastTxn && Number(lastTxn.stockAfter) !== 0) {
      console.log(`  ${item.menuItem?.name}:`);
      console.log(`    currentStock: ${item.currentStock}`);
      console.log(`    last txn: ${lastTxn.type} | ${lastTxn.stockBefore} → ${lastTxn.stockAfter} (${lastTxn.quantityChange}) | ${lastTxn.transactionDate.toISOString()}`);
      console.log(`    notes: ${lastTxn.notes}`);

      // Check if there's a snapshot that set currentStock to 0
      const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const snap = await prisma.dailyInventorySnapshot.findFirst({
        where: { itemId: item.id, snapshotDate: today },
        select: { openingStock: true, closingStock: true, snapshotDate: true },
      });
      console.log(`    today's snapshot: ${snap ? `opening=${snap.openingStock}, closing=${snap.closingStock}` : 'none'}`);

      // Check all transactions
      const allTxns = await prisma.inventoryTransaction.findMany({
        where: { itemId: item.id },
        orderBy: { transactionDate: 'asc' },
        select: { type: true, quantityChange: true, stockBefore: true, stockAfter: true, transactionDate: true, notes: true },
      });
      console.log(`    all transactions (${allTxns.length}):`);
      for (const t of allTxns) {
        console.log(`      ${t.transactionDate.toISOString()} | ${t.type} | ${t.stockBefore} → ${t.stockAfter} (${t.quantityChange}) | ${t.notes || 'N/A'}`);
      }
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FAILURE 3: Kf Strong Beer snapshot inconsistency
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`=== FAILURE 3: Kf Strong Beer snapshot ===\n`);

  const kfItem = await prisma.inventoryItem.findFirst({
    where: { restaurantId: outletId, menuItem: { name: 'Kf Strong Beer' } },
    include: { menuItem: { select: { name: true } } },
  });
  if (kfItem) {
    const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const snap = await prisma.dailyInventorySnapshot.findFirst({
      where: { itemId: kfItem.id, snapshotDate: today },
    });
    console.log(`  currentStock: ${kfItem.currentStock}`);
    console.log(`  openingStock (InventoryItem): ${kfItem.openingStock}`);
    if (snap) {
      console.log(`  snapshot: opening=${snap.openingStock} purchased=${snap.purchased} sold=${snap.sold} wastage=${snap.wastage} adjusted=${snap.adjusted} closing=${snap.closingStock}`);
      const consumed = Number(snap.sold) + Number(snap.wastage) + (Number(snap.adjusted) < 0 ? Math.abs(Number(snap.adjusted)) : 0);
      console.log(`  computed closing: ${Number(snap.openingStock) + Number(snap.purchased) - consumed}`);
    }

    const txns = await prisma.inventoryTransaction.findMany({
      where: { itemId: kfItem.id },
      orderBy: { transactionDate: 'asc' },
      select: { type: true, quantityChange: true, stockBefore: true, stockAfter: true, transactionDate: true, notes: true },
    });
    console.log(`  transactions (${txns.length}):`);
    for (const t of txns) {
      console.log(`    ${t.transactionDate.toISOString()} | ${t.type} | ${t.stockBefore} → ${t.stockAfter} (${t.quantityChange}) | ${t.notes || 'N/A'}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FAILURE 5: Orders with barInventoryDeducted=true but no SUCCESS logs
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n=== FAILURE 5: Orders with flag but no SUCCESS logs ===\n`);

  const flaggedOrders = await prisma.order.findMany({
    where: { restaurantId: outletId, barInventoryDeducted: true },
    select: { id: true, barInventoryDeducted: true },
    take: 10,
  });

  let noLogCount = 0;
  for (const order of flaggedOrders) {
    const logs = await prisma.barDeductionLog.findMany({
      where: { orderId: order.id, status: 'SUCCESS' },
      select: { id: true },
    });
    if (logs.length === 0) {
      noLogCount++;
      // Check if the order has liquor items
      const items = await prisma.orderItem.findMany({
        where: { orderId: order.id, removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: { select: { name: true, menuType: true } } },
      });
      const liquorItems = items.filter(i => (i.menuItem?.menuType as string) === 'LIQUOR' || (i.menuItem?.menuType as string) === 'BAR');
      console.log(`  order ${order.id.slice(-8)}: ${items.length} items, ${liquorItems.length} liquor items`);
      if (liquorItems.length === 0) {
        console.log(`    → Food-only order (no bar items) — flag set but no bar deduction needed ✅`);
      } else {
        console.log(`    → HAS liquor items but no SUCCESS deduction logs ❌`);
        for (const li of liquorItems.slice(0, 3)) {
          console.log(`      ${li.menuItem?.name} x${li.quantity}`);
        }
      }
    }
  }
  console.log(`\n  Total: ${noLogCount} orders with flag but no SUCCESS logs (out of ${flaggedOrders.length} sampled)`);

  // ═══════════════════════════════════════════════════════════════════════
  // FAILURE 12: Today's opening ≠ yesterday's closing — root cause
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n=== FAILURE 12: Opening ≠ yesterday's closing — root cause ===\n`);

  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24*60*60*1000 + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Check a few mismatched items in detail
  const sampleNames = ['Soda 750ml', 'Water Bottle 1ltr', 'Mansion House 750ml', 'Signature'];
  for (const name of sampleNames) {
    const item = await prisma.inventoryItem.findFirst({
      where: { restaurantId: outletId, menuItem: { name } },
      include: { menuItem: { select: { name: true } } },
    });
    if (!item) continue;

    const ySnap = await prisma.dailyInventorySnapshot.findFirst({
      where: { itemId: item.id, snapshotDate: yesterday },
    });
    const tSnap = await prisma.dailyInventorySnapshot.findFirst({
      where: { itemId: item.id, snapshotDate: today },
    });

    console.log(`  ${name}:`);
    console.log(`    currentStock: ${item.currentStock}`);
    console.log(`    InventoryItem.openingStock: ${item.openingStock}`);
    if (ySnap) console.log(`    yesterday snapshot: opening=${ySnap.openingStock} closing=${ySnap.closingStock} adjusted=${ySnap.adjusted}`);
    else console.log(`    yesterday snapshot: NONE`);
    if (tSnap) console.log(`    today snapshot: opening=${tSnap.openingStock} closing=${tSnap.closingStock} adjusted=${tSnap.adjusted}`);
    else console.log(`    today snapshot: NONE`);

    // Check ADJUSTMENT transactions
    const adjTxns = await prisma.inventoryTransaction.findMany({
      where: { itemId: item.id, type: 'ADJUSTMENT' },
      orderBy: { transactionDate: 'asc' },
      select: { quantityChange: true, stockBefore: true, stockAfter: true, transactionDate: true, notes: true },
    });
    console.log(`    ADJUSTMENT transactions (${adjTxns.length}):`);
    for (const t of adjTxns) {
      console.log(`      ${t.transactionDate.toISOString()} | ${t.stockBefore} → ${t.stockAfter} (${t.quantityChange}) | ${t.notes || 'N/A'}`);
    }

    // Check if there's a snapshot for the day BEFORE yesterday
    const dayBefore = new Date(Date.now() - 48*60*60*1000 + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dbSnap = await prisma.dailyInventorySnapshot.findFirst({
      where: { itemId: item.id, snapshotDate: dayBefore },
    });
    if (dbSnap) console.log(`    day-before snapshot: opening=${dbSnap.openingStock} closing=${dbSnap.closingStock}`);
    else console.log(`    day-before snapshot: NONE`);

    console.log();
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
