import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Z3695J = Vgrand Lounge = cmqy60ci200027dscyj9ubg8h
  // 9O3N45 = Vgrand Family Restaurant = cmr03m0fa00015ot8jh16grhn
  const outletIds = [
    'cmqy60ci200027dscyj9ubg8h', // Z3695J — Vgrand Lounge
    'cmr03m0fa00015ot8jh16grhn', // 9O3N45 — Vgrand Family Restaurant
  ];

  // 22-08-2026 in IST = 2026-08-22 00:00:00 IST to 23:59:59 IST
  // IST = UTC + 5:30, so 2026-08-22 00:00 IST = 2026-08-21 18:30 UTC
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
      menuItem: { select: { id: true, name: true, isSpecial: true } },
      order: {
        select: {
          restaurantId: true,
          transactions: { select: { paidAt: true, grandTotal: true, discountPercent: true } },
        },
      },
    },
  });

  console.log('=== Today Special items sold on 2026-08-22 ===');
  console.log(`Outlets: Z3695J (Vgrand Lounge) + 9O3N45 (Vgrand Family Restaurant)`);
  console.log(`Total order item rows: ${result.length}\n`);

  // Group by outlet
  const outletNames: Record<string, string> = {
    'cmqy60ci200027dscyj9ubg8h': 'Z3695J — Vgrand Lounge',
    'cmr03m0fa00015ot8jh16grhn': '9O3N45 — Vgrand Family Restaurant',
  };

  const byOutlet = new Map<string, { items: number; qty: number; revenue: number }>();
  for (const oi of result) {
    const rid = oi.order.restaurantId;
    const qty = oi.quantity - (oi.cancelledQuantity || 0) - (oi.editedQuantity || 0);
    const discountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
    const discountFactor = discountPercent > 0 ? (1 - discountPercent / 100) : 1;
    const revenue = Math.round(Number(oi.price) * qty * discountFactor * 100) / 100;
    if (!byOutlet.has(rid)) byOutlet.set(rid, { items: 0, qty: 0, revenue: 0 });
    const rec = byOutlet.get(rid)!;
    rec.items += 1;
    rec.qty += qty;
    rec.revenue += revenue;
  }

  console.log('--- By Outlet ---');
  for (const [rid, stats] of byOutlet.entries()) {
    console.log(`  ${outletNames[rid] || rid}: ${stats.items} line items, ${stats.qty} qty sold, ₹${stats.revenue.toFixed(2)} revenue`);
  }

  // Group by menu item per outlet
  console.log('\n--- By Menu Item ---');
  const byItemOutlet = new Map<string, Map<string, { name: string; qty: number; revenue: number }>>();
  for (const oi of result) {
    const rid = oi.order.restaurantId;
    const qty = oi.quantity - (oi.cancelledQuantity || 0) - (oi.editedQuantity || 0);
    const discountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
    const discountFactor = discountPercent > 0 ? (1 - discountPercent / 100) : 1;
    const revenue = Math.round(Number(oi.price) * qty * discountFactor * 100) / 100;
    if (!byItemOutlet.has(rid)) byItemOutlet.set(rid, new Map());
    const itemMap = byItemOutlet.get(rid)!;
    if (!itemMap.has(oi.menuItemId)) itemMap.set(oi.menuItemId, { name: oi.menuItem.name, qty: 0, revenue: 0 });
    const rec = itemMap.get(oi.menuItemId)!;
    rec.qty += qty;
    rec.revenue += revenue;
  }

  for (const [rid, itemMap] of byItemOutlet.entries()) {
    console.log(`\n  ${outletNames[rid] || rid}:`);
    const sorted = Array.from(itemMap.entries()).sort((a, b) => b[1].qty - a[1].qty);
    for (const [, stats] of sorted) {
      console.log(`    ${stats.name}: ${stats.qty} qty, ₹${stats.revenue.toFixed(2)}`);
    }
  }

  const totalQty = result.reduce((s, oi) => s + (oi.quantity - (oi.cancelledQuantity || 0) - (oi.editedQuantity || 0)), 0);
  const totalRevenue = result.reduce((s, oi) => {
    const qty = oi.quantity - (oi.cancelledQuantity || 0) - (oi.editedQuantity || 0);
    const discountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
    const discountFactor = discountPercent > 0 ? (1 - discountPercent / 100) : 1;
    return s + Math.round(Number(oi.price) * qty * discountFactor * 100) / 100;
  }, 0);
  console.log(`\n=== GRAND TOTAL: ${totalQty} special items sold, ₹${totalRevenue.toFixed(2)} revenue ===`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
