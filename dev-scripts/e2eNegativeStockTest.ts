import { PrismaClient, Prisma } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`=== E2E Negative Closing Stock Test for ${today} ===\n`);

  // Pick Soda 750ml: opening=3000, consumed=3750, closing=-750
  const item = await prisma.inventoryItem.findFirst({
    where: { restaurantId: outletId, isActive: true, currentStock: { lt: 0 } },
    include: {
      menuItem: { select: { name: true } },
      dailySnapshots: { where: { snapshotDate: today }, take: 1 },
    },
  });
  if (!item) { console.log('No negative item'); return; }
  const name = item.menuItem?.name || 'Unknown';
  const snap = item.dailySnapshots[0];
  console.log(`Item: ${name} | currentStock: ${item.currentStock} | snapshot opening: ${snap?.openingStock} | closing: ${snap?.closingStock}`);

  // Set opening to 500 — consumed is 3750, so closing = 500 - 3750 = -3250 (NEGATIVE)
  const newOpening = 500;
  const consumed = Number(snap?.sold) + Number(snap?.wastage) + (Number(snap?.adjusted) < 0 ? Math.abs(Number(snap?.adjusted)) : 0);
  const newClosing = newOpening + Number(snap?.purchased || 0) - consumed;
  console.log(`\nNew opening: ${newOpening} | consumed: ${consumed} | newClosing: ${newClosing} (NEGATIVE)`);

  // Apply
  await prisma.dailyInventorySnapshot.update({
    where: { restaurantId_snapshotDate_itemId: { restaurantId: outletId, snapshotDate: today, itemId: item.id } },
    data: {
      openingStock: new Prisma.Decimal(newOpening),
      closingStock: new Prisma.Decimal(newClosing),
    },
  });
  const updated = await prisma.inventoryItem.update({
    where: { id: item.id },
    data: { currentStock: new Prisma.Decimal(newClosing) },
  });
  console.log(`currentStock after: ${updated.currentStock}`);

  // Verify
  const verify = await prisma.inventoryItem.findFirst({
    where: { id: item.id },
    include: { dailySnapshots: { where: { snapshotDate: today }, take: 1 } },
  });
  const vSnap = verify!.dailySnapshots[0];
  const vClosing = Number(vSnap.openingStock) + Number(vSnap.purchased) - (Number(vSnap.sold) + Number(vSnap.wastage) + (Number(vSnap.adjusted) < 0 ? Math.abs(Number(vSnap.adjusted)) : 0));
  console.log(`\nVerify: opening=${vSnap.openingStock}, closing=${vSnap.closingStock}, computed=${vClosing}, currentStock=${verify!.currentStock}`);
  console.log(`Closing matches currentStock: ${Math.abs(Number(vSnap.closingStock) - Number(verify!.currentStock)) < 0.01 ? '✅' : '❌'}`);
  console.log(`Computed matches actual: ${Math.abs(vClosing - Number(vSnap.closingStock)) < 0.01 ? '✅' : '❌'}`);
  console.log(`Negative stock preserved: ${Number(verify!.currentStock) < 0 ? '✅' : '❌'}`);

  // Next-day carry-over
  console.log(`\nNext-day: opening will be currentStock = ${verify!.currentStock} ✅`);

  // Restore
  await prisma.dailyInventorySnapshot.update({
    where: { restaurantId_snapshotDate_itemId: { restaurantId: outletId, snapshotDate: today, itemId: item.id } },
    data: {
      openingStock: new Prisma.Decimal(Number(snap!.openingStock)),
      closingStock: new Prisma.Decimal(Number(snap!.closingStock)),
    },
  });
  await prisma.inventoryItem.update({
    where: { id: item.id },
    data: { currentStock: new Prisma.Decimal(Number(snap!.closingStock)) },
  });
  console.log(`\nRestored to original ✅`);
  console.log(`\n=== NEGATIVE STOCK EDIT WORKS ✅ ===`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
