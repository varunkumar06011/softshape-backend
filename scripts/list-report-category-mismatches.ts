/**
 * READ-ONLY diagnostic: List MenuItems where menuType and effective report
 * category disagree, classified into actionable buckets for manual review.
 *
 * Two mismatch cases:
 *   (a) menuType === 'LIQUOR' AND effective report category !== 'Liquor'
 *       (effective report category = reportCategory if set to Food/Beverages/Liquor,
 *        else derived from category.name per getReportCategory() in reports.ts)
 *   (b) menuType === 'FOOD' AND reportCategory === 'Liquor' (explicit admin override)
 *
 * Classification:
 *   SUSPECTED_MENUTYPE_ERROR  — case (b) items, AND case (a) items whose name
 *                                matches a liquor-brand/pour-size pattern.
 *   REVIEW_REPORT_CATEGORY    — everything else in case (a) (likely intentional,
 *                                e.g. breezers/sodas grouped under Beverages).
 *
 * This script makes NO writes to the database. It is strictly informational.
 *
 * Usage: npx tsx scripts/list-report-category-mismatches.ts
 */

import { PrismaClient } from '@prisma/client';
import { getReportCategory } from '../src/routes/reports';

const prisma = new PrismaClient();

// ── Liquor-brand / pour-size detection ──────────────────────────────────────
// Matches standard liquor pour sizes (word-boundary, case-insensitive) and
// known spirit/whisky brand name fragments. Deliberately conservative — does
// NOT match generic beverage words like "soda", "cola", "juice", "breezer".
const POUR_SIZE_PATTERN = /\b(30ml|60ml|90ml|180ml|375ml|750ml|1000ml)\b/i;
const SPIRIT_BRAND_PATTERN = /\b(pipers|antiquity|blenders|pride|jamson|jameson|jack\s*daniels|chivas|royal\s*stag|officer\s*choice|mc\dowell|mcdowell|imperial\s*blue|magic\s*moments|absolut|smirnoff|grey\s*goose|bacardi|jagermeister|hennessy|martell|courvoisier|johnnie\s*walker|red\s*label|black\s*label|ballantine|teachers|100\s*pipers|royal\s*challenge|signature|original\s*choice|bagpiper|hawkins|romanov|white\s*mischief|blue\s*ribbon)\b/i;

function isLiquorBrandOrPourSize(name: string): boolean {
  return POUR_SIZE_PATTERN.test(name) || SPIRIT_BRAND_PATTERN.test(name);
}

interface MismatchRow {
  restaurantId: string;
  restaurantName: string;
  menuItemId: string;
  name: string;
  menuType: string;
  reportCategoryRaw: string | null;
  categoryName: string | null;
  effectiveReportCategory: string;
  last30DaysRevenue: number;
  classification: 'SUSPECTED_MENUTYPE_ERROR' | 'REVIEW_REPORT_CATEGORY';
}

async function main() {
  console.log('=== Report Category vs MenuType Mismatch Diagnostic ===');
  console.log(`Run time: ${new Date().toISOString()}`);
  console.log('READ-ONLY — no writes will be made.\n');

  // Fetch all active menu items with their category relation
  const menuItems = await prisma.menuItem.findMany({
    where: { isDeleted: false },
    include: { category: true },
  });

  // Fetch 30-day revenue per menuItemId in one query
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const revenueRows = await prisma.$queryRaw<Array<{
    menuItemId: string;
    totalRevenue: any;
  }>>`
    SELECT oi."menuItemId", COALESCE(SUM(oi.price * oi.quantity), 0) AS "totalRevenue"
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE oi."removedFromBill" = false
      AND oi.quantity > 0
      AND o.status = 'PAID'
      AND o."paidAt" >= ${thirtyDaysAgo}
    GROUP BY oi."menuItemId"
  `;
  const revenueMap = new Map<string, number>();
  for (const r of revenueRows) {
    revenueMap.set(r.menuItemId, Number(r.totalRevenue));
  }

  // Load outlet names
  const restaurantIds = [...new Set(menuItems.map(m => m.restaurantId))];
  const outlets = await prisma.outlet.findMany({
    where: { id: { in: restaurantIds } },
    select: { id: true, name: true },
  });
  const outletMap = new Map(outlets.map(o => [o.id, o.name]));

  const mismatches: MismatchRow[] = [];

  for (const mi of menuItems) {
    const effectiveReportCategory = getReportCategory(mi);
    const reportCategoryRaw = mi.reportCategory as string | null;
    const menuType = mi.menuType as string;

    let isMismatch = false;
    let isCaseB = false;

    if (menuType === 'LIQUOR' && effectiveReportCategory !== 'Liquor') {
      // Case (a): LIQUOR menuType but effective report category isn't Liquor
      isMismatch = true;
    } else if (
      menuType === 'FOOD'
      && reportCategoryRaw === 'Liquor'
    ) {
      // Case (b): FOOD menuType with explicit reportCategory = 'Liquor'
      // (explicit admin override only, not the category-name fallback)
      isMismatch = true;
      isCaseB = true;
    }

    if (!isMismatch) continue;

    const last30DaysRevenue = revenueMap.get(mi.id) || 0;

    // Classify
    let classification: 'SUSPECTED_MENUTYPE_ERROR' | 'REVIEW_REPORT_CATEGORY';
    if (isCaseB) {
      classification = 'SUSPECTED_MENUTYPE_ERROR';
    } else if (isLiquorBrandOrPourSize(mi.name)) {
      classification = 'SUSPECTED_MENUTYPE_ERROR';
    } else {
      classification = 'REVIEW_REPORT_CATEGORY';
    }

    mismatches.push({
      restaurantId: mi.restaurantId,
      restaurantName: outletMap.get(mi.restaurantId) || 'Unknown',
      menuItemId: mi.id,
      name: mi.name,
      menuType,
      reportCategoryRaw,
      categoryName: mi.category?.name || null,
      effectiveReportCategory,
      last30DaysRevenue,
      classification,
    });
  }

  // Sort by revenue descending within each classification
  mismatches.sort((a, b) => b.last30DaysRevenue - a.last30DaysRevenue);

  // Group by classification
  const suspected = mismatches.filter(m => m.classification === 'SUSPECTED_MENUTYPE_ERROR');
  const review = mismatches.filter(m => m.classification === 'REVIEW_REPORT_CATEGORY');

  // ── Summary ──
  console.log('--- Summary ---');
  console.log(`  SUSPECTED_MENUTYPE_ERROR : ${suspected.length} items`);
  console.log(`  REVIEW_REPORT_CATEGORY   : ${review.length} items`);
  console.log(`  Total mismatches         : ${mismatches.length} items\n`);

  // ── SUSPECTED_MENUTYPE_ERROR ──
  if (suspected.length > 0) {
    console.log(`${'='.repeat(100)}`);
    console.log('SUSPECTED_MENUTYPE_ERROR');
    console.log('  These items are likely miscategorized at the menuType level.');
    console.log('  FOOD items named like liquor brands, or LIQUOR items with pour-size');
    console.log('  names but reportCategory != Liquor. These are the ones currently');
    console.log('  leaking zero or wrong bar deduction. Review menuType first.\n');
    console.log(`${'='.repeat(100)}\n`);

    printTable(suspected);
  }

  // ── REVIEW_REPORT_CATEGORY ──
  if (review.length > 0) {
    console.log(`\n${'='.repeat(100)}`);
    console.log('REVIEW_REPORT_CATEGORY');
    console.log('  These LIQUOR items have reportCategory != Liquor but don\'t match');
    console.log('  liquor-brand/pour-size patterns. Likely intentional (e.g. breezers,');
    console.log('  sodas, fresh lime soda grouped under Beverages). Eyeball each one.\n');
    console.log(`${'='.repeat(100)}\n`);

    printTable(review);
  }

  if (mismatches.length === 0) {
    console.log('✅ No mismatches found — menuType and reportCategory are consistent for all items.');
  }

  await prisma.$disconnect();
}

function printTable(rows: MismatchRow[]) {
  // Group by restaurant
  const byRestaurant = new Map<string, MismatchRow[]>();
  for (const r of rows) {
    const list = byRestaurant.get(r.restaurantId) || [];
    list.push(r);
    byRestaurant.set(r.restaurantId, list);
  }

  for (const [restaurantId, items] of byRestaurant) {
    const name = items[0].restaurantName;
    console.log(`\n--- Outlet: ${name} (${restaurantId}) — ${items.length} items ---\n`);
    console.log(
      '  Name'.padEnd(40)
      + '| menuType'.padEnd(10)
      + '| reportCat'.padEnd(12)
      + '| category'.padEnd(22)
      + '| effCat'.padEnd(10)
      + '| 30d Revenue',
    );
    console.log(`  ${'-'.repeat(38)}|${'-'.repeat(9)}|${'-'.repeat(11)}|${'-'.repeat(21)}|${'-'.repeat(9)}|${'-'.repeat(12)}`);
    for (const i of items) {
      console.log(
        `  ${i.name.padEnd(38)}`
        + `| ${i.menuType.padEnd(8)}`
        + `| ${(i.reportCategoryRaw || 'NULL').padEnd(10)}`
        + `| ${(i.categoryName || '—').padEnd(20)}`
        + `| ${i.effectiveReportCategory.padEnd(8)}`
        + `| ₹${i.last30DaysRevenue.toFixed(2)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
