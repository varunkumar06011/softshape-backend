import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletIds = [
    'cmqy60ci200027dscyj9ubg8h',
    'cmr03m0fa00015ot8jh16grhn',
  ];
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const startIST = new Date(Date.UTC(2026, 7, 22, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(2026, 7, 22, 23, 59, 59, 999) - IST_OFFSET_MS);

  // Replicate the FIXED today-specials-by-staff logic
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

  // Load KOTs
  const paidOrderIds = new Set((completedTxns as any[]).map((t: any) => t.orderId).filter(Boolean));
  const kots = paidOrderIds.size > 0 ? await prisma.kot.findMany({
    where: { captainId: { not: null }, orderId: { in: Array.from(paidOrderIds) } },
    include: { items: { include: { orderItem: { select: { id: true } } } } },
  }) : [];

  const orderItemKotCaptain = new Map<string, string>();
  const orderKotCaptainLatest = new Map<string, { captainId: string; createdAt: Date }>();
  for (const kot of kots as any[]) {
    const captainId = kot.captainId;
    if (!captainId || captainId === 'N/A') continue;
    const kotCreatedAt = new Date(kot.createdAt || 0);
    const existing = orderKotCaptainLatest.get(kot.orderId);
    if (!existing || kotCreatedAt > existing.createdAt) {
      orderKotCaptainLatest.set(kot.orderId, { captainId, createdAt: kotCreatedAt });
    }
    for (const kotItem of kot.items || []) {
      if (kotItem.orderItem?.id) orderItemKotCaptain.set(kotItem.orderItem.id, captainId);
    }
  }

  // Build staff map — FIXED: no isDeleted check
  const staffMap = new Map<string, any>();
  for (const txn of completedTxns as any[]) {
    const txnCaptainId = txn.captainId;
    const orderKotCaptain = orderKotCaptainLatest.get(txn.orderId)?.captainId || null;
    const items = txn.order?.items || [];
    for (const item of items) {
      const menuItem = item.menuItem;
      // FIXED: removed menuItem.isDeleted check
      if (!menuItem || !menuItem.isSpecial) continue;
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

  console.log(`Staff with special sales (before name lookup): ${staffMap.size}`);
  for (const [id, stats] of staffMap.entries()) {
    console.log(`  ${id}: ${stats.soldCount} sold, ₹${stats.revenue.toFixed(2)}`);
  }

  // Look up user names
  const userIds = Array.from(staffMap.keys()) as string[];
  if (userIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, role: true, employee: { select: { designation: true, role: true } } } as any,
    });
    for (const user of users as any[]) {
      const record = staffMap.get(user.id);
      if (record) {
        record.name = user.name || null;
        record.role = user.role || null;
        const empDesig = (user as any).employee ? ((user as any).employee.designation || (user as any).employee.role || '').toUpperCase() : '';
        (record as any).employeeDesignation = empDesig;
      }
    }
  }

  // Add all active captains with 0 sales
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

  for (const captain of allCaptains) {
    if (!staffMap.has(captain.id)) {
      staffMap.set(captain.id, {
        userId: captain.id, name: captain.name, role: 'CAPTAIN',
        soldCount: 0, revenue: 0, items: new Map(), employeeDesignation: 'CAPTAIN',
      } as any);
    } else {
      const existing = staffMap.get(captain.id) as any;
      if (!existing.employeeDesignation) existing.employeeDesignation = 'CAPTAIN';
    }
  }

  // Filter to captains only
  const CAPTAIN_DESIGNATIONS = new Set(['CAPTAIN', 'CPATION', 'CAPTION']);
  const staff = Array.from(staffMap.values())
    .filter((s: any) => CAPTAIN_DESIGNATIONS.has(((s as any).employeeDesignation || '').toUpperCase()))
    .map((s: any) => ({
      userId: s.userId, name: s.name, role: s.role,
      soldCount: s.soldCount, revenue: s.revenue,
      items: Array.from(s.items.values()).sort((a: any, b: any) => b.soldCount - a.soldCount),
    }))
    .sort((a: any, b: any) => b.soldCount - a.soldCount);

  console.log(`\n=== FIXED Captain Leaderboard for 2026-08-22 ===`);
  console.log(`Total captains: ${staff.length}`);
  for (const s of staff) {
    console.log(`\n  ${s.name || s.userId}: ${s.soldCount} sold, ₹${s.revenue.toFixed(2)} revenue`);
    for (const item of s.items as any[]) {
      console.log(`    ${item.name}: ${item.soldCount}x, ₹${item.revenue.toFixed(2)}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
