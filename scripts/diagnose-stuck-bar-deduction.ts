/**
 * READ-ONLY diagnostic: Find all PAID orders with liquor items where
 * barInventoryDeducted is stuck at `true` but no SALE-type inventory
 * transaction exists — meaning the deduction was silently skipped.
 *
 * Usage: npx tsx scripts/diagnose-stuck-bar-deduction.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const results = await prisma.$queryRaw<Array<{
    id: string;
    restaurantId: string;
    paidAt: Date | null;
    settledAt: Date | null;
    createdAt: Date;
    status: string;
    totalAmount: any;
    liquorItemCount: bigint;
  }>>`
    SELECT
      o.id,
      o."restaurantId",
      o."paidAt",
      o."settledAt",
      o."createdAt",
      o.status,
      o."totalAmount",
      COUNT(oi.id) AS "liquorItemCount"
    FROM "Order" o
    JOIN "OrderItem" oi ON oi."orderId" = o.id
    JOIN "MenuItem" mi ON mi.id = oi."menuItemId"
    WHERE o."barInventoryDeducted" = true
      AND o.status != 'CANCELLED'
      AND oi."removedFromBill" = false
      AND oi.quantity > 0
      AND mi."menuType" = 'LIQUOR'
      AND NOT EXISTS (
        SELECT 1 FROM "inventory_transactions" it
        WHERE it."orderId" = o.id AND it.type = 'SALE'
      )
    GROUP BY o.id, o."restaurantId", o."paidAt", o."settledAt", o."createdAt", o.status, o."totalAmount"
    ORDER BY o."createdAt" DESC
  `;

  console.log(`\n=== STUCK BAR DEDUCTION DIAGNOSTIC ===`);
  console.log(`Total affected orders: ${results.length}\n`);

  if (results.length === 0) {
    console.log('✅ No stuck orders found — all liquor orders have been deducted.');
    await prisma.$disconnect();
    return;
  }

  // Group by restaurant
  const byRestaurant = new Map<string, typeof results>();
  for (const r of results) {
    const list = byRestaurant.get(r.restaurantId) || [];
    list.push(r);
    byRestaurant.set(r.restaurantId, list);
  }

  for (const [restaurantId, orders] of byRestaurant) {
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true },
    });
    console.log(`\n--- Outlet: ${outlet?.name || 'Unknown'} (${restaurantId}) ---`);
    console.log(`Affected orders: ${orders.length}`);

    // Date range
    const dates = orders.map(o => o.createdAt).sort((a, b) => a.getTime() - b.getTime());
    const oldest = dates[0];
    const newest = dates[dates.length - 1];
    console.log(`Date range: ${oldest.toISOString()} → ${newest.toISOString()}`);

    // Total amount
    const totalAmount = orders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    console.log(`Total order value: ₹${totalAmount.toFixed(2)}`);

    // Per-day breakdown
    const byDay = new Map<string, number>();
    for (const o of orders) {
      const day = o.createdAt.toISOString().split('T')[0];
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }
    console.log(`\nPer-day breakdown:`);
    for (const [day, count] of [...byDay.entries()].sort()) {
      console.log(`  ${day}: ${count} orders`);
    }

    // Show first 20 order IDs
    console.log(`\nSample order IDs (first 20):`);
    for (const o of orders.slice(0, 20)) {
      console.log(`  ${o.id} | ${o.createdAt.toISOString()} | ₹${Number(o.totalAmount)} | ${o.status} | ${Number(o.liquorItemCount)} liquor items`);
    }
    if (orders.length > 20) {
      console.log(`  ... and ${orders.length - 20} more`);
    }
  }

  console.log(`\n=== END DIAGNOSTIC ===`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review the affected order count and date range with admin.`);
  console.log(`  2. Decide: backfill (reset flag + retry deduction) or re-baseline (fresh stock count).`);
  console.log(`  3. If backfilling: for each order, run:`);
  console.log(`     UPDATE "Order" SET "barInventoryDeducted" = false WHERE id = '<orderId>';`);
  console.log(`     Then call: POST /api/bar/inventory/retry-deduction/<orderId>`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Diagnostic failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
