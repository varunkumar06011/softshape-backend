// Deep check: for today's Kf Ultra Beer orders, trace exactly why deduction didn't happen.
// Check: order flags, existing bar deduction logs, and whether the retry job would pick it up.
import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = 'cmqy60ci200027dscyj9ubg8h';

  // The Kf Ultra Beer orders from today
  const orderIds = [
    'bb1c1d6a-20d9-45c3-8021-4e31447baee4',
    '70caec6b-70da-424c-949f-8fc6681014b2',
    'ff1ec8f8-cbd8-4b52-a962-1944c99baf67',
    '3b82b1b2-4669-4616-8a74-0d0533293836',
  ];

  for (const orderId of orderIds) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        barInventoryDeducted: true,
        inventoryDeducted: true,
        paidAt: true,
        createdAt: true,
        platform: true,
      },
    });

    const logs = await prisma.barDeductionLog.findMany({
      where: { orderId },
      select: { id: true, inventoryItemId: true, status: true, error: true, quantity: true },
    });

    console.log(`\n=== Order ${orderId} ===`);
    console.log(`  status: ${order?.status}  barInventoryDeducted: ${order?.barInventoryDeducted}  inventoryDeducted: ${order?.inventoryDeducted}`);
    console.log(`  paidAt: ${order?.paidAt ?? '(null)'}  platform: ${order?.platform}`);
    console.log(`  barDeductionLogs: ${logs.length}`);
    for (const l of logs) {
      console.log(`    - invId=${l.inventoryItemId}  status=${l.status}  qty=${l.quantity}  err=${l.error ?? '(none)'}`);
    }

    // Check: since barInventoryDeducted=true, the retry job WON'T pick this up.
    // The deduction function checks: if (lockedRow.barInventoryDeducted) return early.
    // So even if we fix the code, these orders won't be re-processed unless the flag is reset.
  }

  // Also check: what menu items do these orders actually reference for Kf Ultra Beer?
  console.log('\n\n=== Order item menuItemIds for Kf Ultra Beer ===\n');
  for (const orderId of orderIds) {
    const items = await prisma.orderItem.findMany({
      where: { orderId, removedFromBill: false, quantity: { gt: 0 } },
      include: { menuItem: { select: { id: true, name: true, menuType: true } } },
    });
    const beerItems = items.filter((i) => {
      const n = (i.menuItem?.name || '').toLowerCase();
      return n.includes('ultra') || n.includes('budweiser') || n.includes('storm') || n.includes('strong');
    });
    for (const it of beerItems) {
      console.log(`  Order ${orderId.slice(0, 8)}: "${it.menuItem?.name}"  menuItemId=${it.menuItemId}  menuType=${it.menuItem?.menuType}  price=₹${it.price}  qty=${it.quantity}`);
    }
  }

  // Check: does the Kf Ultra Beer inventory menuItem match the ordered menuItemId?
  console.log('\n\n=== Inventory vs ordered menuItemId check ===\n');
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { id: true, name: true } } },
  });
  const beerInv = invItems.filter((i) => (i.menuItem?.name || '').toLowerCase().includes('ultra') || (i.menuItem?.name || '').toLowerCase().includes('storm') || (i.menuItem?.name || '').toLowerCase().includes('strong'));

  for (const inv of beerInv) {
    console.log(`  Inventory: "${inv.menuItem?.name}"  menuItemId=${inv.menuItem?.id}  invId=${inv.id}  stock=${inv.currentStock}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
