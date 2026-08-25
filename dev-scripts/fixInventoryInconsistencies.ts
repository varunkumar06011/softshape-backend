import { PrismaClient, Prisma } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`=== Fixing data inconsistencies for ${today} ===\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // FIX 1: Items where currentStock ≠ last txn stockAfter
  // Set currentStock = last txn stockAfter
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`── FIX 1: Sync currentStock = last txn stockAfter ──`);
  const allItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId, isActive: true },
    select: { id: true, menuItemId: true, currentStock: true },
  });

  let fixed1 = 0;
  for (const item of allItems) {
    const lastTxn = await prisma.inventoryTransaction.findFirst({
      where: { itemId: item.id },
      orderBy: { transactionDate: 'desc' },
      select: { stockAfter: true, type: true },
    });
    if (!lastTxn) continue;
    const lastStockAfter = Number(lastTxn.stockAfter);
    const current = Number(item.currentStock);
    if (Math.abs(lastStockAfter - current) > 0.01) {
      const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } });
      console.log(`  FIXING: ${menuItem?.name} | currentStock: ${current} → ${lastStockAfter} (last txn: ${lastTxn.type})`);
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { currentStock: new Prisma.Decimal(lastStockAfter) },
      });
      fixed1++;
    }
  }
  console.log(`  Fixed: ${fixed1} items\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // FIX 2: Today's snapshot openingStock should match the ADJUSTMENT baseline
  // The physical snapshot script sets openingStock on the InventoryItem and
  // creates an ADJUSTMENT transaction. If today's snapshot was created BEFORE
  // the physical snapshot ran, the snapshot's openingStock is stale.
  // Fix: set snapshot.openingStock = InventoryItem.openingStock when there's
  // an ADJUSTMENT transaction with "Physical snapshot" notes today.
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`── FIX 2: Sync snapshot openingStock with physical baseline ──`);
  const physicalAdjTxns = await prisma.inventoryTransaction.findMany({
    where: {
      restaurantId: outletId,
      type: 'ADJUSTMENT',
      notes: { contains: 'Physical snapshot' },
      transactionDate: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    select: { itemId: true, stockAfter: true, notes: true },
  });

  let fixed2 = 0;
  for (const txn of physicalAdjTxns) {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: txn.itemId },
      select: { id: true, menuItemId: true, openingStock: true, currentStock: true },
    });
    if (!item) continue;

    const snap = await prisma.dailyInventorySnapshot.findFirst({
      where: { itemId: item.id, snapshotDate: today },
    });
    if (!snap) continue;

    const baselineOpening = Number(item.openingStock);
    const snapOpening = Number(snap.openingStock);
    if (Math.abs(baselineOpening - snapOpening) > 0.01) {
      const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } });
      console.log(`  FIXING: ${menuItem?.name} | snapshot opening: ${snapOpening} → ${baselineOpening}`);

      // Recalculate closing with the correct opening
      const purchased = Number(snap.purchased);
      const sold = Number(snap.sold);
      const wastage = Number(snap.wastage);
      const adjusted = Number(snap.adjusted);
      const adjustedOut = adjusted < 0 ? Math.abs(adjusted) : 0;
      const newClosing = baselineOpening + purchased - sold - wastage - adjustedOut;

      // But DON'T overwrite closingStock if it matches currentStock
      // (currentStock is the source of truth for live stock)
      const currentStock = Number(item.currentStock);
      const finalClosing = Math.abs(newClosing - currentStock) < 0.01 ? currentStock : newClosing;

      await prisma.dailyInventorySnapshot.update({
        where: { id: snap.id },
        data: {
          openingStock: new Prisma.Decimal(baselineOpening),
          closingStock: new Prisma.Decimal(finalClosing),
        },
      });
      fixed2++;
    }
  }
  console.log(`  Fixed: ${fixed2} snapshots\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // FIX 3: Verify all snapshots now have consistent computed closing
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`── FIX 3: Verify snapshot consistency after fixes ──`);
  const todaySnaps = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId: outletId, snapshotDate: today },
  });

  let consistent = 0;
  let inconsistent = 0;
  for (const snap of todaySnaps) {
    const item = allItems.find(i => i.id === snap.itemId);
    if (!item) continue;
    const consumed = Number(snap.sold) + Number(snap.wastage) + (Number(snap.adjusted) < 0 ? Math.abs(Number(snap.adjusted)) : 0);
    const computed = Number(snap.openingStock) + Number(snap.purchased) - consumed;
    const actual = Number(snap.closingStock);
    const current = Number(item.currentStock);
    if (Math.abs(computed - actual) < 0.01 && Math.abs(actual - current) < 0.01) {
      consistent++;
    } else {
      inconsistent++;
      const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { name: true } });
      console.log(`  STILL INCONSISTENT: ${menuItem?.name} | opening=${snap.openingStock} purchased=${snap.purchased} sold=${snap.sold} closing=${snap.closingStock} | computed=${computed.toFixed(2)} current=${current}`);
    }
  }
  console.log(`  Consistent: ${consistent}/${todaySnaps.length}, Inconsistent: ${inconsistent}/${todaySnaps.length}\n`);

  console.log(`=== FIX SUMMARY ===`);
  console.log(`  currentStock synced: ${fixed1} items`);
  console.log(`  snapshot openingStock synced: ${fixed2} snapshots`);
  console.log(`  Final consistency: ${consistent}/${todaySnaps.length} snapshots OK`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
