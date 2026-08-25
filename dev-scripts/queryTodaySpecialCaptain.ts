import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletIds = [
    'cmqy60ci200027dscyj9ubg8h', // Z3695J — Vgrand Lounge
    'cmr03m0fa00015ot8jh16grhn', // 9O3N45 — Vgrand Family Restaurant
  ];

  const startIST = new Date('2026-08-21T18:30:00.000Z');
  const endIST = new Date('2026-08-22T18:29:59.999Z');

  const result = await prisma.orderItem.findMany({
    where: {
      removedFromBill: false,
      menuItem: { isSpecial: true },
      order: {
        status: 'PAID',
        isDeleted: false,
        restaurantId: { in: outletIds },
        transactions: {
          status: 'COMPLETED',
          paidAt: { gte: startIST, lte: endIST },
        },
      },
    },
    include: {
      menuItem: { select: { id: true, name: true } },
      order: {
        select: {
          restaurantId: true,
          captainId: true,
          transactions: { select: { paidAt: true, grandTotal: true, discountPercent: true } },
        },
      },
    },
  });

  const outletNames: Record<string, string> = {
    'cmqy60ci200027dscyj9ubg8h': 'Z3695J — Vgrand Lounge',
    'cmr03m0fa00015ot8jh16grhn': '9O3N45 — Vgrand Family Restaurant',
  };

  // Fetch captain names
  const captainIds = [...new Set(result.map(oi => oi.order.captainId).filter(Boolean))] as string[];
  const captains = await prisma.user.findMany({
    where: { id: { in: captainIds } },
    select: { id: true, name: true },
  });
  const captainNames: Record<string, string> = {};
  for (const c of captains) captainNames[c.id] = c.name;

  // Group by outlet → captain → item
  type CaptainStats = { name: string; items: number; qty: number; revenue: number; byItem: Map<string, { name: string; qty: number; revenue: number }> };
  const byOutletCaptain = new Map<string, Map<string, CaptainStats>>();

  for (const oi of result) {
    const rid = oi.order.restaurantId;
    const capId = oi.order.captainId || 'UNKNOWN';
    const qty = oi.quantity - (oi.cancelledQuantity || 0) - (oi.editedQuantity || 0);
    const discountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
    const discountFactor = discountPercent > 0 ? (1 - discountPercent / 100) : 1;
    const revenue = Math.round(Number(oi.price) * qty * discountFactor * 100) / 100;

    if (!byOutletCaptain.has(rid)) byOutletCaptain.set(rid, new Map());
    const capMap = byOutletCaptain.get(rid)!;
    if (!capMap.has(capId)) capMap.set(capId, { name: captainNames[capId] || `Unknown (${capId.slice(-6)})`, items: 0, qty: 0, revenue: 0, byItem: new Map() });
    const rec = capMap.get(capId)!;
    rec.items += 1;
    rec.qty += qty;
    rec.revenue += revenue;

    if (!rec.byItem.has(oi.menuItemId)) rec.byItem.set(oi.menuItemId, { name: oi.menuItem.name, qty: 0, revenue: 0 });
    const itemRec = rec.byItem.get(oi.menuItemId)!;
    itemRec.qty += qty;
    itemRec.revenue += revenue;
  }

  console.log('=== Today Special items sold on 2026-08-22 — Captain-wise ===\n');

  let grandQty = 0, grandRevenue = 0;

  for (const [rid, capMap] of byOutletCaptain.entries()) {
    console.log(`━━━ ${outletNames[rid] || rid} ━━━`);
    const sortedCaptains = Array.from(capMap.entries()).sort((a, b) => b[1].revenue - a[1].revenue);
    for (const [, stats] of sortedCaptains) {
      console.log(`\n  Captain: ${stats.name}`);
      console.log(`  Total: ${stats.qty} qty, ₹${stats.revenue.toFixed(2)} revenue`);
      const sortedItems = Array.from(stats.byItem.entries()).sort((a, b) => b[1].qty - a[1].qty);
      for (const [, item] of sortedItems) {
        console.log(`    ${item.name}: ${item.qty} qty, ₹${item.revenue.toFixed(2)}`);
      }
      grandQty += stats.qty;
      grandRevenue += stats.revenue;
    }
    console.log('');
  }

  console.log(`=== GRAND TOTAL: ${grandQty} special items sold, ₹${grandRevenue.toFixed(2)} revenue ===`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
