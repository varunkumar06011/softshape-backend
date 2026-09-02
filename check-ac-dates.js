const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // Check multiple dates for AC items with sales
  const dates = ['2026-08-31', '2026-08-30', '2026-08-29', '2026-08-28'];

  const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
  const allItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: { menuItem: { select: { name: true, category: { select: { name: true } } } } },
  });

  const isSoftDrink = (inv) => {
    const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
    const itemName = String(inv.menuItem?.name || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };

  const liquorItems = allItems.filter(inv => !isSoftDrink(inv));
  const itemMap = new Map(liquorItems.map(i => [i.id, i]));

  const basePrisma = new PrismaClient();

  for (const reportDate of dates) {
    const snapshots = await prisma.dailyInventorySnapshot.findMany({
      where: { snapshotDate: reportDate },
    });

    const startUTC = new Date(reportDate + 'T00:00:00+05:30').toISOString();
    const endUTC = new Date(reportDate + 'T23:59:59+05:30').toISOString();

    const posOrderItems = await basePrisma.orderItem.findMany({
      where: {
        removedFromBill: false,
        order: {
          status: 'PAID',
          isDeleted: false,
          transactions: {
            status: 'COMPLETED',
            paidAt: { gte: startUTC, lte: endUTC },
          },
        },
      },
      select: { menuItemId: true, quantity: true, price: true },
    });

    const posRevenueByMenuItem = new Map();
    for (const oi of posOrderItems) {
      if (!oi.menuItemId) continue;
      const rev = Number(oi.price) * (oi.quantity || 0);
      posRevenueByMenuItem.set(oi.menuItemId, (posRevenueByMenuItem.get(oi.menuItemId) || 0) + rev);
    }

    let itemsWithSales = 0;
    let itemsWithRevenue = 0;
    let totalRevenue = 0;
    let totalSoldMl = 0;

    for (const snap of snapshots) {
      const inv = itemMap.get(snap.itemId);
      if (!inv) continue;
      const soldMl = Number(snap.sold) || 0;
      const acRevenue = inv.menuItemId ? (posRevenueByMenuItem.get(inv.menuItemId) || 0) : 0;
      if (soldMl > 0) itemsWithSales++;
      if (acRevenue > 0) itemsWithRevenue++;
      totalRevenue += acRevenue;
      totalSoldMl += soldMl;
    }

    console.log(`${reportDate}: ${snapshots.length} snapshots, ${itemsWithSales} with sold>0, ${itemsWithRevenue} with POS revenue, totalRevenue=Rs${totalRevenue.toFixed(2)}, totalSoldMl=${totalSoldMl}`);
  }

  await prisma.$disconnect();
  await basePrisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
