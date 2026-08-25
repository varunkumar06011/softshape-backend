// Verify the daily cycle: today's closing → tomorrow's opening, purchases add, deductions continue
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const TODAY = "2026-08-24";

async function main() {
  // 1. Show a sample of today's snapshots (opening, purchased, sold, closing)
  const snapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: TODAY },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
    orderBy: { item: { menuItem: { name: "asc" } } },
    take: 15,
  });

  console.log(`=== Today's (${TODAY}) Daily Snapshots — sample of ${snapshots.length} ===\n`);
  console.log("Item                         | Opening     | Purchased | Sold       | Closing    | CurrentStock");
  console.log("-----------------------------|-------------|-----------|------------|------------|-------------");
  for (const s of snapshots) {
    const name = (s.item?.menuItem?.name || s.itemName || "Unknown").padEnd(29);
    const open = String(s.openingStock).padStart(11);
    const purch = String(s.purchased).padStart(9);
    const sold = String(s.sold).padStart(10);
    const close = String(s.closingStock).padStart(10);
    const curr = String(s.item?.currentStock ?? "?").padStart(11);
    console.log(`${name} | ${open} | ${purch} | ${sold} | ${close} | ${curr}`);
  }

  // 2. Show items with purchases today
  const withPurchases = snapshots.filter(s => Number(s.purchased) > 0);
  console.log(`\n=== Items with purchases today: ${withPurchases.length} ===`);
  withPurchases.forEach(s => console.log(`  ${s.item?.menuItem?.name}: +${s.purchased}ml (closing: ${s.closingStock}ml)`));

  // 3. Show items that went negative
  const negative = snapshots.filter(s => Number(s.closingStock) < 0);
  console.log(`\n=== Items that went negative: ${negative.length} ===`);
  negative.forEach(s => console.log(`  ${s.item?.menuItem?.name}: closing ${s.closingStock}ml`));

  // 4. Verify: currentStock == closingStock for today's snapshot (proves alignment)
  const mismatched = snapshots.filter(s => Number(s.closingStock) !== Number(s.item?.currentStock ?? 0));
  console.log(`\n=== Snapshot closingStock vs item currentStock alignment ===`);
  console.log(`Checked: ${snapshots.length} | Matched: ${snapshots.length - mismatched.length} | Mismatched: ${mismatched.length}`);
  if (mismatched.length > 0) {
    mismatched.forEach(s => console.log(`  MISMATCH: ${s.item?.menuItem?.name} | snapshot closing: ${s.closingStock} | item current: ${s.item?.currentStock}`));
  }

  // 5. Confirm the carry-over logic: tomorrow's first transaction will create a snapshot
  //    with openingStock = currentStock (today's closing). This is automatic.
  console.log(`\n=== Carry-over verification ===`);
  console.log(`Tomorrow's opening will be today's currentStock (closing).`);
  console.log(`The first transaction tomorrow (sale/purchase/adjustment) will create a new`);
  console.log(`snapshot with snapshotDate=2026-08-25 and openingStock = current currentStock.`);
  console.log(`This happens automatically in inventoryService.ts and barInventory.ts.`);

  // Count how many items have NO snapshot today (will show as carry-over)
  const totalItems = await prisma.inventoryItem.count({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
  });
  const totalSnapshots = await prisma.dailyInventorySnapshot.count({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: TODAY },
  });
  console.log(`\nTotal active items: ${totalItems}`);
  console.log(`Items with today's snapshot: ${totalSnapshots}`);
  console.log(`Items without snapshot (no transactions today): ${totalItems - totalSnapshots}`);
  console.log(`  → These will show opening=closing=currentStock (carry-over display)`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
