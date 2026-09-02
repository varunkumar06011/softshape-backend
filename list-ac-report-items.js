const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const reportDate = '2026-08-29';
  console.log('=== AC Bar Detailed Item-wise Report for', reportDate, '===\n');

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

  const snapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { snapshotDate: reportDate },
  });

  const startUTC = new Date(reportDate + 'T00:00:00+05:30').toISOString();
  const endUTC = new Date(reportDate + 'T23:59:59+05:30').toISOString();

  const basePrisma = new PrismaClient();
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

  const acItems = [];
  for (const snap of snapshots) {
    const inv = itemMap.get(snap.itemId);
    if (!inv) continue;
    const soldMl = Number(snap.sold) || 0;
    const acRevenue = inv.menuItemId ? (posRevenueByMenuItem.get(inv.menuItemId) || 0) : 0;
    if (soldMl > 0 || acRevenue > 0) {
      const btlSize = inv.bottleSize || 0;
      acItems.push({
        itemName: inv.menuItem?.name || 'Unknown',
        category: inv.menuItem?.category?.name || 'Uncategorized',
        bottleSize: btlSize,
        openingMl: Number(snap.openingStock),
        purchasedMl: Number(snap.purchased),
        soldMl,
        closingMl: Number(snap.closingStock),
        soldBtl: btlSize > 0 ? (soldMl / btlSize) : 0,
        openingBtl: btlSize > 0 ? (Number(snap.openingStock) / btlSize) : 0,
        closingBtl: btlSize > 0 ? (Number(snap.closingStock) / btlSize) : 0,
        stockBtl: btlSize > 0 ? ((Number(snap.openingStock) + Number(snap.purchased)) / btlSize) : 0,
        acRevenue,
        costPerBottle: inv.costPerBottle ? Number(inv.costPerBottle) : 0,
        isHidden: inv.isHiddenFromReport || false,
      });
    }
  }

  // Also items with POS revenue but no snapshot
  for (const [menuItemId, rev] of posRevenueByMenuItem) {
    const inv = liquorItems.find(i => i.menuItemId === menuItemId);
    if (inv && !acItems.find(a => a.itemName === (inv.menuItem?.name || 'Unknown') && a.category === (inv.menuItem?.category?.name || 'Uncategorized'))) {
      acItems.push({
        itemName: inv.menuItem?.name || 'Unknown',
        category: inv.menuItem?.category?.name || 'Uncategorized',
        bottleSize: inv.bottleSize || 0,
        openingMl: 0, purchasedMl: 0, soldMl: 0, closingMl: 0,
        soldBtl: 0, openingBtl: 0, closingBtl: 0, stockBtl: 0,
        acRevenue: rev,
        costPerBottle: inv.costPerBottle ? Number(inv.costPerBottle) : 0,
        isHidden: inv.isHiddenFromReport || false,
      });
    }
  }

  acItems.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    if (catCmp !== 0) return catCmp;
    return a.itemName.localeCompare(b.itemName);
  });

  console.log('Total AC items in report:', acItems.length);
  console.log('');
  console.log('S.No | Item Name | Category | Qty(ml) | Opening | Stock | Sold | Closing | AC Revenue | Cost/Btl');
  console.log('-----|-----------|----------|---------|---------|-------|------|---------|------------|---------');

  let sno = 1;
  let totalRevenue = 0;
  let totalSoldMl = 0;
  let totalConsumption = 0;
  let totalSaleAmount = 0;
  for (const item of acItems) {
    const hidden = item.isHidden ? ' [HIDDEN]' : '';
    const consumption = item.soldBtl * item.costPerBottle;
    const profit = item.acRevenue - consumption;
    console.log(`${sno} | ${item.itemName}${hidden} | ${item.category} | ${item.bottleSize}ml | ${item.openingBtl.toFixed(2)} | ${item.stockBtl.toFixed(2)} | ${item.soldBtl.toFixed(2)} (${item.soldMl}ml) | ${item.closingBtl.toFixed(2)} (${item.closingMl}ml) | Rs${item.acRevenue.toFixed(2)} | Rs${item.costPerBottle} | Consumption: Rs${consumption.toFixed(2)} | Profit: Rs${profit.toFixed(2)}`);
    totalRevenue += item.acRevenue;
    totalSoldMl += item.soldMl;
    totalConsumption += consumption;
    totalSaleAmount += item.acRevenue;
    sno++;
  }

  console.log('');
  console.log('=== TOTALS ===');
  console.log('Total AC Revenue (Sale Amount): Rs' + totalSaleAmount.toFixed(2));
  console.log('Total Consumption: Rs' + totalConsumption.toFixed(2));
  console.log('Total Profit: Rs' + (totalSaleAmount - totalConsumption).toFixed(2));
  console.log('Total Sold (ml): ' + totalSoldMl);

  await prisma.$disconnect();
  await basePrisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
