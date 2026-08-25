import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletIds = [
    'cmqy60ci200027dscyj9ubg8h', // Z3695J — Vgrand Lounge
    'cmr03m0fa00015ot8jh16grhn', // 9O3N45 — Vgrand Family Restaurant
  ];

  // Simulate parseISTRange('2026-08-22', '2026-08-22')
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const start = '2026-08-22';
  const end = '2026-08-22';
  const [startYear, startMonth, startDay] = start.split('-').map(Number);
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  const startIST = new Date(Date.UTC(startYear, startMonth - 1, startDay, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(endYear, endMonth - 1, endDay, 23, 59, 59, 999) - IST_OFFSET_MS);

  console.log('Date range:');
  console.log(`  startIST: ${startIST.toISOString()}`);
  console.log(`  endIST:   ${endIST.toISOString()}`);

  // 1. Test today-specials-sold endpoint logic
  console.log('\n=== today-specials-sold ===');
  const activeSpecials = await prisma.menuItem.findMany({
    where: { restaurantId: { in: outletIds }, isSpecial: true },
    select: { id: true, name: true, specialChannel: true },
  });
  console.log(`Active specials: ${activeSpecials.length}`);

  const transactions = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
    },
    select: { items: true, orderId: true },
  });
  console.log(`Completed transactions: ${transactions.length}`);

  const specialMap = new Map();
  for (const s of activeSpecials) specialMap.set(s.id, { id: s.id, name: s.name, soldCount: 0 });
  for (const txn of transactions) {
    const items = Array.isArray(txn.items) ? txn.items : [];
    for (const item of items) {
      const menuItemId = (item as any).menuItemId || (item as any).id;
      const quantity = Number((item as any).q || (item as any).quantity || 0);
      if (menuItemId && specialMap.has(menuItemId)) {
        specialMap.get(menuItemId).soldCount += quantity;
      }
    }
  }
  const specialsSold = Array.from(specialMap.values()).filter(s => s.soldCount > 0);
  console.log(`Specials sold: ${specialsSold.length}`);
  for (const s of specialsSold) console.log(`  ${s.name}: ${s.soldCount}`);

  // 2. Test today-specials-by-staff endpoint logic
  console.log('\n=== today-specials-by-staff ===');
  const completedTxns = await prisma.transaction.findMany({
    where: {
      restaurantId: { in: outletIds },
      status: 'COMPLETED',
      paidAt: { gte: startIST, lte: endIST },
    },
    select: {
      orderId: true,
      captainId: true,
      order: {
        select: {
          id: true,
          items: {
            where: { removedFromBill: false, quantity: { gt: 0 } },
            include: { menuItem: { select: { id: true, name: true, basePrice: true, isSpecial: true, isDeleted: true } } },
          },
        },
      },
    },
  });
  console.log(`Completed txns with order data: ${completedTxns.length}`);

  // Count special items in these transactions
  let specialItemCount = 0;
  let itemsWithCaptain = 0;
  let itemsWithoutCaptain = 0;
  for (const txn of completedTxns as any[]) {
    const items = txn.order?.items || [];
    for (const item of items) {
      const menuItem = item.menuItem;
      if (!menuItem || !menuItem.isSpecial || menuItem.isDeleted) continue;
      const quantity = Number(item.quantity || 0);
      if (quantity <= 0) continue;
      specialItemCount++;
      const captainId = txn.captainId;
      if (captainId && captainId !== 'N/A') {
        itemsWithCaptain++;
      } else {
        itemsWithoutCaptain++;
      }
    }
  }
  console.log(`Special item rows: ${specialItemCount}`);
  console.log(`  With transaction captain: ${itemsWithCaptain}`);
  console.log(`  Without any captain: ${itemsWithoutCaptain}`);

  // Check KOTs for captain attribution
  const paidOrderIds = new Set((completedTxns as any[]).map((t: any) => t.orderId).filter(Boolean));
  console.log(`\nPaid order IDs: ${paidOrderIds.size}`);

  const kots = paidOrderIds.size > 0 ? await prisma.kot.findMany({
    where: {
      captainId: { not: null },
      orderId: { in: Array.from(paidOrderIds) },
    },
    include: {
      items: { include: { orderItem: { select: { id: true } } } },
    },
  }) : [];
  console.log(`KOTs with captain: ${kots.length}`);

  const orderItemKotCaptain = new Map();
  const orderKotCaptainLatest = new Map();
  for (const kot of kots as any[]) {
    const captainId = kot.captainId;
    if (!captainId || captainId === 'N/A') continue;
    const kotCreatedAt = new Date(kot.createdAt || 0);
    const existing = orderKotCaptainLatest.get(kot.orderId);
    if (!existing || kotCreatedAt > existing.createdAt) {
      orderKotCaptainLatest.set(kot.orderId, { captainId, createdAt: kotCreatedAt });
    }
    for (const kotItem of kot.items || []) {
      if (kotItem.orderItem?.id) {
        orderItemKotCaptain.set(kotItem.orderItem.id, captainId);
      }
    }
  }
  console.log(`Order-item KOT captain mappings: ${orderItemKotCaptain.size}`);
  console.log(`Order-level KOT captain mappings: ${orderKotCaptainLatest.size}`);

  // Build staff map
  const staffMap = new Map();
  for (const txn of completedTxns as any[]) {
    const txnCaptainId = txn.captainId;
    const orderKotCaptain = orderKotCaptainLatest.get(txn.orderId)?.captainId || null;
    const items = txn.order?.items || [];
    for (const item of items) {
      const menuItem = item.menuItem;
      if (!menuItem || !menuItem.isSpecial || menuItem.isDeleted) continue;
      const quantity = Number(item.quantity || 0);
      if (quantity <= 0) continue;
      const captainId = orderItemKotCaptain.get(item.id) || orderKotCaptain || txnCaptainId;
      if (!captainId || captainId === 'N/A') continue;
      const price = Number(menuItem.basePrice || item.price || 0);
      const name = menuItem.name || item.name || 'Unknown';
      if (!staffMap.has(captainId)) {
        const itemsMap = new Map();
        itemsMap.set(menuItem.id, { name, soldCount: quantity, revenue: quantity * price });
        staffMap.set(captainId, { userId: captainId, name: null, role: null, soldCount: quantity, revenue: quantity * price, items: itemsMap });
      } else {
        const existing = staffMap.get(captainId);
        existing.soldCount += quantity;
        existing.revenue += quantity * price;
        const itemRecord = existing.items.get(menuItem.id);
        if (itemRecord) {
          itemRecord.soldCount += quantity;
          itemRecord.revenue += quantity * price;
        } else {
          existing.items.set(menuItem.id, { name, soldCount: quantity, revenue: quantity * price });
        }
      }
    }
  }
  console.log(`\nStaff with special sales (before captain filter): ${staffMap.size}`);
  for (const [id, stats] of staffMap.entries()) {
    console.log(`  ${id}: ${stats.soldCount} sold, ₹${stats.revenue.toFixed(2)}`);
  }

  // Check which of these are actual captains
  const userIds = Array.from(staffMap.keys());
  if (userIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, role: true, employee: { select: { designation: true, role: true } } } as any,
    });
    for (const user of users) {
      const record = staffMap.get(user.id);
      if (record) {
        record.name = user.name || null;
        record.role = user.role || null;
        const empDesig = (user as any).employee ? ((user as any).employee.designation || (user as any).employee.role || '').toUpperCase() : '';
        (record as any).employeeDesignation = empDesig;
        console.log(`  User ${user.id}: name=${user.name}, role=${user.role}, empDesig=${empDesig}`);
      }
    }
  }

  // Check all active captains
  const allCaptains = await prisma.user.findMany({
    where: {
      isActive: true,
      role: 'CAPTAIN',
      OR: [
        { outletId: { in: outletIds } },
        { outletAccess: { some: { outletId: { in: outletIds } } } },
      ],
      employee: {
        isActive: true,
        OR: [
          { designation: { in: ['CAPTAIN', 'CPATION', 'CAPTION', 'Captain'] } },
          { role: { in: ['CAPTAIN', 'CPATION', 'CAPTION', 'Captain'] } },
        ],
      },
    } as any,
    select: { id: true, name: true },
  });
  console.log(`\nAll active captains in scope: ${allCaptains.length}`);
  for (const c of allCaptains) console.log(`  ${c.id}: ${c.name}`);

  // Apply captain designation filter
  const CAPTAIN_DESIGNATIONS = new Set(['CAPTAIN', 'CPATION', 'CAPTION']);
  const staff = Array.from(staffMap.values())
    .filter(s => {
      const desig = (s as any).employeeDesignation || '';
      return CAPTAIN_DESIGNATIONS.has(desig.toUpperCase());
    })
    .map((s: any) => ({
      userId: s.userId,
      name: s.name,
      role: s.role,
      soldCount: s.soldCount,
      revenue: s.revenue,
      items: Array.from(s.items.values()).sort((a: any, b: any) => b.soldCount - a.soldCount),
    }))
    .sort((a: any, b: any) => b.soldCount - a.soldCount);

  console.log(`\nFinal filtered staff (captains only): ${staff.length}`);
  for (const s of staff) {
    console.log(`  ${s.name || s.userId}: ${s.soldCount} sold, ₹${s.revenue.toFixed(2)}`);
    for (const item of s.items as any[]) {
      console.log(`    ${item.name}: ${item.soldCount}x, ₹${item.revenue.toFixed(2)}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
