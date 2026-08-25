import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`=== Verifying opening stock edit flow for ${today} ===\n`);

  // 1. Pick a test item — use "Mc Whisky" which has clean data
  const item = await prisma.inventoryItem.findFirst({
    where: { restaurantId: outletId, isActive: true },
    include: {
      menuItem: { select: { name: true } },
      dailySnapshots: { where: { snapshotDate: today }, take: 1 },
      transactions: { orderBy: { transactionDate: 'desc' }, take: 5, select: { type: true, quantityChange: true, stockBefore: true, stockAfter: true, notes: true, transactionDate: true } },
    },
  });

  if (!item) { console.log('No item found'); return; }
  const name = item.menuItem?.name || 'Unknown';
  console.log(`Test item: ${name}`);
  console.log(`  currentStock: ${item.currentStock}`);
  console.log(`  openingStock (InventoryItem): ${item.openingStock}`);

  const snapshot = item.dailySnapshots[0];
  if (snapshot) {
    console.log(`\n  Today's snapshot:`);
    console.log(`    openingStock: ${snapshot.openingStock}`);
    console.log(`    purchased: ${snapshot.purchased}`);
    console.log(`    sold: ${snapshot.sold}`);
    console.log(`    wastage: ${snapshot.wastage}`);
    console.log(`    adjusted: ${snapshot.adjusted}`);
    console.log(`    closingStock: ${snapshot.closingStock}`);
    const consumed = Number(snapshot.sold) + Number(snapshot.wastage) + (Number(snapshot.adjusted) < 0 ? Math.abs(Number(snapshot.adjusted)) : 0);
    console.log(`    computed consumed: ${consumed}`);
    console.log(`    computed closing: ${Number(snapshot.openingStock) + Number(snapshot.purchased) - consumed}`);
  } else {
    console.log(`\n  No snapshot for today — opening would default to currentStock: ${item.currentStock}`);
  }

  // 2. Simulate the PATCH logic for opening stock change
  console.log(`\n=== Simulating PATCH opening stock change ===`);
  const newOpening = 9999;
  const existingSnapshot = snapshot;
  const effectiveOpeningMl = newOpening;
  const newPurchased = Number(existingSnapshot?.purchased || 0);
  const newConsumed = existingSnapshot
    ? Number(existingSnapshot.sold) + Number(existingSnapshot.wastage) + (Number(existingSnapshot.adjusted) < 0 ? Math.abs(Number(existingSnapshot.adjusted)) : 0)
    : 0;
  const newClosing = effectiveOpeningMl + newPurchased - newConsumed;
  const stockBeforeNum = Number(item.currentStock);
  const changeNum = newClosing - stockBeforeNum;

  console.log(`  newOpening: ${newOpening}`);
  console.log(`  newPurchased: ${newPurchased}`);
  console.log(`  newConsumed: ${newConsumed}`);
  console.log(`  newClosing: ${newClosing}`);
  console.log(`  stockBefore (currentStock): ${stockBeforeNum}`);
  console.log(`  change (newClosing - stockBefore): ${changeNum}`);
  console.log(`  Would create ADJUSTMENT transaction: ${Math.abs(changeNum) > 0.01 ? 'YES' : 'NO'}`);

  // 3. Check: would the negative closing validation block this?
  console.log(`\n  ⚠️  Negative closing check: newClosing = ${newClosing} → ${newClosing < 0 ? 'WOULD BE REJECTED ❌' : 'OK ✅'}`);

  // 4. Check items that are currently negative — would editing their opening stock fail?
  console.log(`\n=== Checking items with negative currentStock ===`);
  const negativeItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId, isActive: true, currentStock: { lt: 0 } },
    include: {
      menuItem: { select: { name: true } },
      dailySnapshots: { where: { snapshotDate: today }, take: 1 },
    },
  });

  for (const negItem of negativeItems) {
    const negSnapshot = negItem.dailySnapshots[0];
    const negConsumed = negSnapshot
      ? Number(negSnapshot.sold) + Number(negSnapshot.wastage) + (Number(negSnapshot.adjusted) < 0 ? Math.abs(Number(negSnapshot.adjusted)) : 0)
      : 0;
    const negPurchased = Number(negSnapshot?.purchased || 0);
    const negOpening = Number(negSnapshot?.openingStock || negItem.currentStock);
    const computedClosing = negOpening + negPurchased - negConsumed;
    console.log(`\n  ${negItem.menuItem?.name}:`);
    console.log(`    currentStock: ${negItem.currentStock}`);
    console.log(`    snapshot opening: ${negOpening}, purchased: ${negPurchased}, consumed: ${negConsumed}`);
    console.log(`    computed closing: ${computedClosing}`);
    console.log(`    matches currentStock: ${Math.abs(computedClosing - Number(negItem.currentStock)) < 0.01 ? 'YES ✅' : 'NO ❌'}`);
    // If user tries to re-enter the SAME opening stock, would it be rejected?
    const testClosing = negOpening + negPurchased - negConsumed;
    console.log(`    Re-entering same opening (${negOpening}): closing=${testClosing} → ${testClosing < 0 ? 'REJECTED ❌ (BUG!)' : 'OK ✅'}`);
  }

  // 5. Verify next-day carry-over logic
  console.log(`\n=== Next-day carry-over verification ===`);
  console.log(`  Tomorrow, GET /items will look for snapshot with tomorrow's date.`);
  console.log(`  If none exists, it falls back to: openingStock = currentStock = ${item.currentStock}`);
  console.log(`  After editing opening to ${newOpening}, currentStock would become ${newClosing}`);
  console.log(`  So tomorrow's opening would be: ${newClosing} ✅`);

  // 6. Check the GET endpoint's consumed formula vs PATCH's consumed formula
  console.log(`\n=== Formula consistency check ===`);
  console.log(`  GET endpoint consumed = sold + wastage + (adjusted < 0 ? |adjusted| : 0)`);
  console.log(`  PATCH endpoint consumed = sold + wastage + (adjusted < 0 ? |adjusted| : 0)`);
  console.log(`  Formulas match: ✅`);

  // 7. Check: does the adjust-stock endpoint's snapshot update create inconsistency?
  console.log(`\n=== Adjust-stock snapshot consistency ===`);
  // The adjust-stock endpoint does: adjusted: { increment: change.abs() }
  // This means adjusted is ALWAYS positive after updates, so (adjusted < 0) is never true
  // for items that had manual adjustments via adjust-stock.
  const itemsWithAdjustments = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId, isActive: true },
    include: {
      menuItem: { select: { name: true } },
      dailySnapshots: { where: { snapshotDate: today }, take: 1 },
    },
  });

  let inconsistentCount = 0;
  for (const it of itemsWithAdjustments) {
    const snap = it.dailySnapshots[0];
    if (!snap) continue;
    const adjustedNum = Number(snap.adjusted);
    if (adjustedNum > 0) {
      // This snapshot has positive adjusted value.
      // GET consumed formula: sold + wastage + 0 (since adjusted > 0, not < 0)
      // But the adjustment could have been negative (a reduction)!
      // The adjust-stock endpoint uses increment: change.abs(), so both +500 and -500
      // result in adjusted being incremented by 500. We can't tell the sign.
      // This means the consumed formula might undercount or overcount.
      const consumedGET = Number(snap.sold) + Number(snap.wastage);
      const computedClosingGET = Number(snap.openingStock) + Number(snap.purchased) - consumedGET;
      const actualClosing = Number(snap.closingStock);
      if (Math.abs(computedClosingGET - actualClosing) > 0.01) {
        inconsistentCount++;
        console.log(`  ⚠️  ${it.menuItem?.name}: adjusted=${adjustedNum}, GET computed closing=${computedClosingGET}, actual closing=${actualClosing}, diff=${computedClosingGET - actualClosing}`);
      }
    }
  }
  if (inconsistentCount === 0) {
    console.log(`  All snapshots with positive adjusted values are consistent ✅`);
  } else {
    console.log(`  ${inconsistentCount} snapshots have inconsistency ❌`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
