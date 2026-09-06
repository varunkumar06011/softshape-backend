// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Diagnostic — checks the actual state of bar inventory to
// identify why total stock, closing stock, reports, and deductions are wrong.
//
// Run: npx tsx diagnose-bar-inventory.ts
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
});

function pct(n: number, d: number): string {
  if (d === 0) return '0%';
  return `${Math.round((n / d) * 100)}%`;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('  BAR INVENTORY DIAGNOSTIC REPORT');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  // ── 1. Outlets ────────────────────────────────────────────────────────────
  const outlets = await prisma.outlet.findMany({
    select: { id: true, name: true, organizationId: true },
    orderBy: { name: 'asc' },
  });
  console.log(`Outlets: ${outlets.length}`);
  for (const o of outlets) {
    console.log(`  • ${o.name} (${o.id})`);
  }
  console.log();

  for (const outlet of outlets) {
    const rid = outlet.id;
    console.log(`\n─── ${outlet.name} (${rid}) ────────────────────────────────────────────`);

    // ── 2. Liquor menu items ──────────────────────────────────────────────────
    const liquorMenuItems = await prisma.menuItem.findMany({
      where: {
        restaurantId: rid,
        isDeleted: false,
        menuType: 'LIQUOR',
      },
      select: { id: true, name: true, menuType: true, reportCategory: true, categoryId: true },
      orderBy: { name: 'asc' },
    });
    console.log(`  Liquor/BAR menu items: ${liquorMenuItems.length}`);

    // ── 3. InventoryItem records ──────────────────────────────────────────────
    const inventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: rid, isActive: true },
      select: {
        id: true, menuItemId: true, bottleSize: true,
        openingStock: true, currentStock: true, costPerBottle: true,
        menuItem: { select: { name: true, menuType: true } },
      },
      orderBy: { menuItem: { name: 'asc' } },
    });
    console.log(`  Active InventoryItem records: ${inventoryItems.length}`);

    // ── 4. Mapping coverage ───────────────────────────────────────────────────
    const invMenuItemIds = new Set(inventoryItems.map((i) => i.menuItemId));
    const mappedCount = liquorMenuItems.filter((m) => invMenuItemIds.has(m.id)).length;
    const unmappedCount = liquorMenuItems.length - mappedCount;
    console.log(`  Mapped (have InventoryItem): ${mappedCount} / ${liquorMenuItems.length} (${pct(mappedCount, liquorMenuItems.length)})`);
    console.log(`  UNMAPPED: ${unmappedCount}`);

    if (unmappedCount > 0 && unmappedCount <= 30) {
      console.log(`  Unmapped liquor items:`);
      for (const m of liquorMenuItems.filter((m) => !invMenuItemIds.has(m.id))) {
        console.log(`    ✗ ${m.name} (${m.menuType}) reportCategory=${m.reportCategory || 'null'}`);
      }
    }

    // ── 5. BarItemMapping ─────────────────────────────────────────────────────
    const mappings = await prisma.barItemMapping.findMany({
      where: { restaurantId: rid },
      select: { id: true, menuItemId: true, variantPrice: true, mlPerUnit: true, source: true },
    });
    console.log(`  BarItemMapping rows: ${mappings.length}`);

    // ── 6. Deduction status on paid orders ────────────────────────────────────
    const paidOrders = await prisma.order.findMany({
      where: { restaurantId: rid, status: 'PAID' },
      select: { id: true, barInventoryDeducted: true, inventoryDeducted: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const notBarDeducted = paidOrders.filter((o) => !o.barInventoryDeducted);
    console.log(`  Recent paid orders (last 500): ${paidOrders.length}`);
    console.log(`    barInventoryDeducted=false: ${notBarDeducted.length} (${pct(notBarDeducted.length, paidOrders.length)})`);

    // ── 7. BarDeductionLog errors ─────────────────────────────────────────────
    const failedLogs = await prisma.barDeductionLog.findMany({
      where: { restaurantId: rid, status: 'FAILED' },
      select: { id: true, orderId: true, error: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    console.log(`  Failed BarDeductionLogs (recent 20): ${failedLogs.length}`);
    if (failedLogs.length > 0) {
      const errorCounts: Record<string, number> = {};
      for (const l of failedLogs) {
        const key = (l.error || 'unknown').slice(0, 80);
        errorCounts[key] = (errorCounts[key] || 0) + 1;
      }
      for (const [err, count] of Object.entries(errorCounts)) {
        console.log(`    ${count}x: ${err}`);
      }
    }

    // ── 8. currentStock vs snapshot closingStock ──────────────────────────────
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const todaySnapshots = await prisma.dailyInventorySnapshot.findMany({
      where: { restaurantId: rid, snapshotDate: today },
      select: { itemId: true, itemName: true, closingStock: true, openingStock: true, sold: true },
    });
    const snapMap = new Map(todaySnapshots.map((s) => [s.itemId, s]));

    let mismatchCount = 0;
    let negativeStockCount = 0;
    let zeroStockCount = 0;
    const sampleMismatches: string[] = [];

    for (const inv of inventoryItems) {
      const snap = snapMap.get(inv.id);
      const live = Number(inv.currentStock);
      const snapClosing = snap ? Number(snap.closingStock) : null;

      if (live < 0) negativeStockCount++;
      if (live === 0) zeroStockCount++;

      if (snapClosing !== null && Math.abs(live - snapClosing) > 0.01) {
        mismatchCount++;
        if (sampleMismatches.length < 10) {
          sampleMismatches.push(
            `    ${inv.menuItem?.name || inv.id}: live=${live}ml vs snapshot=${snapClosing}ml`,
          );
        }
      }
    }

    console.log(`  Stock health (InventoryItem.currentStock):`);
    console.log(`    Negative stock: ${negativeStockCount} / ${inventoryItems.length}`);
    console.log(`    Zero stock: ${zeroStockCount} / ${inventoryItems.length}`);
    console.log(`    currentStock ≠ snapshot closing (today): ${mismatchCount} / ${todaySnapshots.length}`);
    if (sampleMismatches.length > 0) {
      console.log(`    Sample mismatches:`);
      sampleMismatches.forEach((s) => console.log(s));
    }

    // ── 9. Items with no cost per bottle ──────────────────────────────────────
    const noCost = inventoryItems.filter((i) => !i.costPerBottle || Number(i.costPerBottle) === 0);
    console.log(`    No costPerBottle: ${noCost.length} / ${inventoryItems.length}`);

    // ── 10. Non-AC items ──────────────────────────────────────────────────────
    const nonAcItems = await prisma.nonAcInventoryItem.findMany({
      where: { restaurantId: rid, isActive: true },
      select: { id: true, bottleSize: true, currentBottles: true, purchaseRate: true },
    });
    console.log(`  Non-AC inventory items: ${nonAcItems.length}`);

    // ── 11. Recent inventory transactions ─────────────────────────────────────
    const recentTxns = await prisma.inventoryTransaction.groupBy({
      by: ['type', 'source'],
      where: { restaurantId: rid, transactionDate: { gte: new Date(Date.now() - 7 * 86400000) } },
      _count: { id: true },
      _sum: { quantityChange: true },
    });
    console.log(`  Inventory transactions (last 7 days):`);
    if (recentTxns.length === 0) {
      console.log(`    NONE — no transactions in the last 7 days`);
    } else {
      for (const t of recentTxns) {
        console.log(`    ${t.type}/${t.source}: ${t._count.id} txns, net ${Number(t._sum.quantityChange || 0)}ml`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');
}

main()
  .catch((err) => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
