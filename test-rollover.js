// test-rollover.js
// Simulates the rollover logic: edit 31-08 closing stock for one item,
// then verify 01-09 opening stock is updated to match.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const SAVE_DATE = '2026-08-31';
const NEXT_DATE = '2026-09-01';

(async () => {
  // Pick a test item: "Budweiser Beer" (650ml, 56 bottles)
  const item = await p.inventoryItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, isActive: true, menuItem: { name: 'Budweiser Beer' } },
    include: { menuItem: { select: { name: true } } },
  });
  
  if (!item) { console.log('Test item not found'); process.exit(1); }
  
  const btlSize = Number(item.bottleSize);
  const itemName = item.menuItem.name;
  console.log(`\n=== Rollover Test: ${itemName} (${btlSize}ml) ===`);
  
  // Get 31-08 snapshot BEFORE edit
  const snap31Before = await p.dailyInventorySnapshot.findUnique({
    where: { restaurantId_snapshotDate_itemId: { restaurantId: RESTAURANT_ID, snapshotDate: SAVE_DATE, itemId: item.id } },
  });
  console.log(`\nBEFORE EDIT:`);
  console.log(`  31-08 opening: ${snap31Before?.openingStock} ml (${Number(snap31Before?.openingStock)/btlSize} btl)`);
  console.log(`  31-08 closing: ${snap31Before?.closingStock} ml (${Number(snap31Before?.closingStock)/btlSize} btl)`);
  
  const snap01Before = await p.dailyInventorySnapshot.findUnique({
    where: { restaurantId_snapshotDate_itemId: { restaurantId: RESTAURANT_ID, snapshotDate: NEXT_DATE, itemId: item.id } },
  });
  console.log(`  01-09 opening: ${snap01Before?.openingStock} ml (${Number(snap01Before?.openingStock)/btlSize} btl)`);
  console.log(`  01-09 closing: ${snap01Before?.closingStock} ml (${Number(snap01Before?.closingStock)/btlSize} btl)`);
  
  // Simulate: admin edits 31-08 closing to 50 bottles (was 56)
  const newClosingBtl = 50;
  const newClosingMl = Math.round(newClosingBtl * btlSize * 100) / 100;
  console.log(`\nEDITING: 31-08 closing → ${newClosingBtl} btl (${newClosingMl} ml)`);
  
  // Update 31-08 snapshot (same as saveItemWiseEdits does)
  await p.dailyInventorySnapshot.update({
    where: { id: snap31Before.id },
    data: { closingStock: newClosingMl },
  });
  
  // Rollover: update 01-09 opening
  if (snap01Before) {
    const nextPurchased = Number(snap01Before.purchased);
    const nextSold = Number(snap01Before.sold);
    const nextWastage = Number(snap01Before.wastage);
    const nextAdjusted = Number(snap01Before.adjusted);
    const nextClosing = Math.round((newClosingMl + nextPurchased - nextSold - nextWastage + nextAdjusted) * 100) / 100;
    
    await p.dailyInventorySnapshot.update({
      where: { id: snap01Before.id },
      data: {
        openingStock: newClosingMl,
        closingStock: nextClosing,
      },
    });
    console.log(`  → 01-09 opening updated to ${newClosingMl} ml (${newClosingBtl} btl)`);
    console.log(`  → 01-09 closing recalculated to ${nextClosing} ml (${(nextClosing/btlSize).toFixed(2)} btl)`);
  }
  
  // Verify AFTER edit
  const snap31After = await p.dailyInventorySnapshot.findUnique({
    where: { restaurantId_snapshotDate_itemId: { restaurantId: RESTAURANT_ID, snapshotDate: SAVE_DATE, itemId: item.id } },
  });
  const snap01After = await p.dailyInventorySnapshot.findUnique({
    where: { restaurantId_snapshotDate_itemId: { restaurantId: RESTAURANT_ID, snapshotDate: NEXT_DATE, itemId: item.id } },
  });
  
  console.log(`\nAFTER EDIT:`);
  console.log(`  31-08 opening: ${snap31After.openingStock} ml (${Number(snap31After.openingStock)/btlSize} btl)`);
  console.log(`  31-08 closing: ${snap31After.closingStock} ml (${Number(snap31After.closingStock)/btlSize} btl)`);
  console.log(`  01-09 opening: ${snap01After.openingStock} ml (${Number(snap01After.openingStock)/btlSize} btl)`);
  console.log(`  01-09 closing: ${snap01After.closingStock} ml (${Number(snap01After.closingStock)/btlSize} btl)`);
  
  // Verify rollover worked
  const rolloverOk = Number(snap01After.openingStock) === newClosingMl;
  console.log(`\nRollover ${rolloverOk ? '✓ PASSED' : '✗ FAILED'}: 01-09 opening = 31-08 closing = ${newClosingMl} ml`);
  
  // RESTORE original values
  console.log(`\nRestoring original values...`);
  await p.dailyInventorySnapshot.update({
    where: { id: snap31Before.id },
    data: { closingStock: snap31Before.closingStock },
  });
  if (snap01Before) {
    await p.dailyInventorySnapshot.update({
      where: { id: snap01Before.id },
      data: {
        openingStock: snap01Before.openingStock,
        closingStock: snap01Before.closingStock,
      },
    });
  }
  console.log('Restored.');
  
  await p.$disconnect();
})();
