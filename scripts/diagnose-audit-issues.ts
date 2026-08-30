/**
 * READ-ONLY diagnostic for AC Bar Inventory audit Issues 1, 2, and 3.
 *
 * Issue 1: PAID orders with liquor items where barInventoryDeducted=true
 *   but no SALE-type InventoryTransaction exists — the deduction was
 *   silently skipped (e.g. via the transfer-items bug or schema default).
 *
 * Issue 2: BarDeductionLog rows whose recorded quantity doesn't match
 *   the cumulative SALE-type InventoryTransaction quantity for the same
 *   order + inventory item — catches historical under-logging from the
 *   overwrite (vs increment) bug on multi-price-point bills.
 *
 * Issue 3: MenuItem rows where menuType and reportCategory disagree —
 *   liquor items whose report category isn't "Liquor", or food items
 *   whose report category is "Liquor". These cause the Reports
 *   Food/Beverages/Liquor split to not match the sales that actually
 *   drove AC bar deduction.
 *
 * Usage: npx tsx scripts/diagnose-audit-issues.ts
 *
 * This script is strictly read-only — it makes no writes to the database.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function checkIssue1() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`ISSUE 1: Stuck bar deductions (PAID + liquor + barInventoryDeducted=true + no SALE tx)`);
  console.log(`${"=".repeat(80)}\n`);

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

  console.log(`Total affected orders: ${results.length}\n`);

  if (results.length === 0) {
    console.log(`✅ No stuck orders found — all liquor orders have been deducted.`);
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

    const dates = orders.map(o => o.createdAt).sort((a, b) => a.getTime() - b.getTime());
    console.log(`Date range: ${dates[0].toISOString()} → ${dates[dates.length - 1].toISOString()}`);

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

    console.log(`\nSample order IDs (first 20):`);
    for (const o of orders.slice(0, 20)) {
      console.log(`  ${o.id} | ${o.createdAt.toISOString()} | ₹${Number(o.totalAmount)} | ${o.status} | ${Number(o.liquorItemCount)} liquor items`);
    }
  }
}

async function checkIssue2() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`ISSUE 2: BarDeductionLog quantity vs InventoryTransaction SALE quantity mismatch`);
  console.log(`         (catches historical under-logging from the overwrite bug on multi-price-point bills)`);
  console.log(`${"=".repeat(80)}\n`);

  // For each (orderId, inventoryItemId) pair, compare:
  //   - BarDeductionLog.quantity (what was logged — may be under-recorded)
  //   - SUM(InventoryTransaction.quantityChange) where type='SALE' (what was actually deducted)
  const results = await prisma.$queryRaw<Array<{
    orderId: string;
    inventoryItemId: string;
    logQuantity: any;
    txQuantity: any;
    mismatchMl: any;
  }>>`
    SELECT
      bdl."orderId",
      bdl."inventoryItemId",
      bdl.quantity AS "logQuantity",
      ABS(COALESCE(SUM(it."quantityChange"), 0)) AS "txQuantity",
      ABS(COALESCE(SUM(it."quantityChange"), 0)) - bdl.quantity AS "mismatchMl"
    FROM "BarDeductionLog" bdl
    LEFT JOIN "inventory_transactions" it
      ON it."orderId" = bdl."orderId"
      AND it."itemId" = bdl."inventoryItemId"
      AND it.type = 'SALE'
    WHERE bdl.status = 'SUCCESS'
    GROUP BY bdl."orderId", bdl."inventoryItemId", bdl.quantity
    HAVING ABS(COALESCE(SUM(it."quantityChange"), 0)) - bdl.quantity != 0
    ORDER BY ABS(ABS(COALESCE(SUM(it."quantityChange"), 0)) - bdl.quantity) DESC
  `;

  console.log(`Total mismatched log rows: ${results.length}\n`);

  if (results.length === 0) {
    console.log(`✅ No mismatches found — all BarDeductionLog quantities match actual SALE transactions.`);
    return;
  }

  // Group by order to see which orders are affected
  const byOrder = new Map<string, typeof results>();
  for (const r of results) {
    const list = byOrder.get(r.orderId) || [];
    list.push(r);
    byOrder.set(r.orderId, list);
  }

  console.log(`Affected orders: ${byOrder.size}`);
  console.log(`Total under-logged quantity: ${results.reduce((s, r) => s + Number(r.mismatchMl), 0).toFixed(2)} ml\n`);

  console.log(`Sample mismatches (first 30):`);
  console.log(`  Order ID                              | Inventory Item ID                     | Log Qty (ml) | Actual Tx (ml) | Mismatch (ml)`);
  console.log(`  ${"-".repeat(38)}|${"-".repeat(39)}|${"-".repeat(13)}|${"-".repeat(15)}|${"-".repeat(14)}`);
  for (const r of results.slice(0, 30)) {
    console.log(
      `  ${r.orderId} | ${r.inventoryItemId} | ${String(Number(r.logQuantity)).padStart(12)} | ${String(Number(r.txQuantity)).padStart(13)} | ${String(Number(r.mismatchMl)).padStart(12)}`,
    );
  }

  // Also check if any of these orders have been voided (status=CANCELLED)
  // — if so, the void under-restored stock
  const voidedOrderIds = [...byOrder.keys()];
  const voidedOrders = await prisma.order.findMany({
    where: { id: { in: voidedOrderIds }, status: 'CANCELLED' },
    select: { id: true, status: true, paidAt: true, settledAt: true },
  });
  if (voidedOrders.length > 0) {
    console.log(`\n⚠️  ${voidedOrders.length} of these mismatched orders have been VOIDED (status=CANCELLED).`);
    console.log(`   These voids under-restored stock by the mismatch amount. Manual stock correction may be needed.`);
    for (const v of voidedOrders.slice(0, 10)) {
      console.log(`   ${v.id} | paid: ${v.paidAt?.toISOString() || '—'} | settled: ${v.settledAt?.toISOString() || '—'}`);
    }
  }
}

async function checkIssue3() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`ISSUE 3: MenuItem menuType vs reportCategory mismatches`);
  console.log(`         (causes Reports category split to not match sales that drove AC bar deduction)`);
  console.log(`${"=".repeat(80)}\n`);

  // Find items where menuType and reportCategory disagree:
  //   - menuType=LIQUOR/BAR but reportCategory != 'Liquor'
  //   - menuType=FOOD but reportCategory = 'Liquor'
  const mismatches = await prisma.$queryRaw<Array<{
    id: string;
    name: string;
    menuType: string;
    reportCategory: string | null;
    categoryName: string | null;
    restaurantId: string;
    isDeleted: boolean;
  }>>`
    SELECT
      mi.id,
      mi.name,
      mi."menuType",
      mi."reportCategory",
      c.name AS "categoryName",
      mi."restaurantId",
      mi."isDeleted"
    FROM "MenuItem" mi
    LEFT JOIN "Category" c ON c.id = mi."categoryId"
    WHERE mi."isDeleted" = false
      AND (
        (mi."menuType" = 'LIQUOR'
          AND COALESCE(mi."reportCategory", c.name, 'Food') != 'Liquor')
        OR
        (mi."menuType" = 'FOOD'
          AND COALESCE(mi."reportCategory", c.name, 'Food') = 'Liquor')
      )
    ORDER BY mi."restaurantId", mi."menuType", mi.name
  `;

  console.log(`Total mismatched menu items: ${mismatches.length}\n`);

  if (mismatches.length === 0) {
    console.log(`✅ No mismatches found — menuType and reportCategory are consistent for all items.`);
    return;
  }

  // Group by restaurant
  const byRestaurant = new Map<string, typeof mismatches>();
  for (const m of mismatches) {
    const list = byRestaurant.get(m.restaurantId) || [];
    list.push(m);
    byRestaurant.set(m.restaurantId, list);
  }

  for (const [restaurantId, items] of byRestaurant) {
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true },
    });
    console.log(`\n--- Outlet: ${outlet?.name || 'Unknown'} (${restaurantId}) ---`);
    console.log(`Mismatched items: ${items.length}`);

    // Categorize the mismatch types
    const liquorNotLiquorReport = items.filter(i => i.menuType === 'LIQUOR' && i.reportCategory !== 'Liquor');
    const foodButLiquorReport = items.filter(i => i.menuType === 'FOOD' && i.reportCategory === 'Liquor');

    console.log(`  LIQUOR/BAR menuType but reportCategory != 'Liquor': ${liquorNotLiquorReport.length}`);
    console.log(`  FOOD menuType but reportCategory = 'Liquor': ${foodButLiquorReport.length}`);

    console.log(`\n  Sample items (first 20):`);
    console.log(`  Name                                    | menuType | reportCategory | category`);
    console.log(`  ${"-".repeat(40)}|${"-".repeat(9)}|${"-".repeat(15)}|${"-".repeat(20)}`);
    for (const i of items.slice(0, 20)) {
      console.log(`  ${i.name.padEnd(40)}| ${i.menuType.padEnd(8)}| ${(i.reportCategory || 'NULL').padEnd(14)}| ${i.categoryName || '—'}`);
    }
  }

  // Also compute the sales impact: total revenue for mismatched items in the last 30 days
  console.log(`\n\nSales impact (last 30 days, all outlets):`);
  const salesImpact = await prisma.$queryRaw<Array<{
    menuType: string;
    reportCategory: string | null;
    itemCount: bigint;
    totalRevenue: any;
  }>>`
    SELECT
      mi."menuType",
      mi."reportCategory",
      COUNT(DISTINCT mi.id) AS "itemCount",
      COALESCE(SUM(oi.price * oi.quantity), 0) AS "totalRevenue"
    FROM "MenuItem" mi
    JOIN "OrderItem" oi ON oi."menuItemId" = mi.id
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE mi."isDeleted" = false
      AND oi."removedFromBill" = false
      AND oi.quantity > 0
      AND o.status = 'PAID'
      AND o."paidAt" >= NOW() - INTERVAL '30 days'
      AND (
        (mi."menuType" = 'LIQUOR'
          AND COALESCE(mi."reportCategory", (SELECT name FROM "Category" WHERE id = mi."categoryId"), 'Food') != 'Liquor')
        OR
        (mi."menuType" = 'FOOD'
          AND COALESCE(mi."reportCategory", (SELECT name FROM "Category" WHERE id = mi."categoryId"), 'Food') = 'Liquor')
      )
    GROUP BY mi."menuType", mi."reportCategory"
    ORDER BY "totalRevenue" DESC
  `;

  if (salesImpact.length === 0) {
    console.log(`  No paid sales for mismatched items in the last 30 days.`);
  } else {
    console.log(`  menuType | reportCategory | Item count | Total revenue (30d)`);
    console.log(`  ${"-".repeat(9)}|${"-".repeat(15)}|${"-".repeat(12)}|${"-".repeat(20)}`);
    for (const s of salesImpact) {
      console.log(`  ${s.menuType.padEnd(8)}| ${(s.reportCategory || 'NULL').padEnd(14)}| ${String(Number(s.itemCount)).padStart(11)}| ₹${Number(s.totalRevenue).toFixed(2)}`);
    }
  }
}

async function main() {
  console.log(`AC Bar Inventory — Audit Diagnostic Script`);
  console.log(`Database: ${process.env.DATABASE_URL ? '(from env)' : '(default)'}`);
  console.log(`Run time: ${new Date().toISOString()}`);
  console.log(`⚠️  READ-ONLY — no writes will be made.`);

  await checkIssue1();
  await checkIssue2();
  await checkIssue3();

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Diagnostic complete.`);
  console.log(`${"=".repeat(80)}\n`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
