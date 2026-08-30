// ─────────────────────────────────────────────────────────────────────────────
// backfill-report-category.ts
//
// Backfills `reportCategory` on existing MenuItem rows that have NULL values.
// Uses the same derivation logic as the creation code:
//   - menuType LIQUOR/BAR → 'Liquor'
//   - category name 'Beverages'/'Beverage' → 'Beverages'
//   - otherwise → 'Food'
//
// Also fixes items where reportCategory contradicts menuType:
//   - menuType LIQUOR but reportCategory = 'Food' → 'Liquor'
//   (Only if --fix-contradictions flag is passed; default is dry-run)
//
// Usage:
//   npx tsx scripts/backfill-report-category.ts              # dry run (default)
//   npx tsx scripts/backfill-report-category.ts --apply      # apply backfill
//   npx tsx scripts/backfill-report-category.ts --apply --fix-contradictions
//
// Safety:
//   - Defaults to dry run (no writes unless --apply)
//   - Only writes reportCategory (and updatedAt) — no other fields
//   - Idempotent: re-running is a no-op once all items have reportCategory
//   - Logs every item that would be/was updated
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const FIX_CONTRADICTIONS = args.has('--fix-contradictions');

function deriveReportCategory(menuType: string | null, categoryName: string | null): 'Food' | 'Beverages' | 'Liquor' {
  const mt = String(menuType || '').toUpperCase();
  if (mt === 'LIQUOR' || mt === 'BAR') return 'Liquor';
  const catName = String(categoryName || '').trim().toLowerCase();
  if (catName === 'liquor') return 'Liquor';
  if (catName === 'beverages' || catName === 'beverage') return 'Beverages';
  return 'Food';
}

async function main() {
  console.log(`\n=== Backfill reportCategory ===`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes will occur)' : 'DRY RUN (no writes)'}`);
  console.log(`Fix contradictions: ${FIX_CONTRADICTIONS ? 'YES' : 'NO'}`);
  console.log();

  // Fetch all non-deleted menu items with their category
  const items = await prisma.menuItem.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      name: true,
      menuType: true,
      reportCategory: true,
      isCombo: true,
      restaurantId: true,
      category: { select: { name: true } },
    },
  });

  console.log(`Total non-deleted menu items: ${items.length}`);

  // Partition into: needs backfill (NULL), contradictions, and already correct
  const needsBackfill: typeof items = [];
  const contradictions: typeof items = [];
  let alreadyCorrect = 0;

  for (const item of items) {
    // Combos use the isCombo flag in getReportCategory(), reportCategory is irrelevant
    if (item.isCombo) {
      alreadyCorrect++;
      continue;
    }

    if (!item.reportCategory) {
      needsBackfill.push(item);
    } else if (FIX_CONTRADICTIONS) {
      const derived = deriveReportCategory(item.menuType, item.category?.name || null);
      // Only flag as contradiction if menuType is LIQUOR but reportCategory is Food
      // (the most common and impactful mismatch). Don't touch Beverages — those
      // are often intentional admin overrides for items like soda/water.
      if (item.menuType === 'LIQUOR' && item.reportCategory === 'Food' && derived === 'Liquor') {
        contradictions.push(item);
      } else {
        alreadyCorrect++;
      }
    } else {
      alreadyCorrect++;
    }
  }

  console.log(`Already have reportCategory (or combo): ${alreadyCorrect}`);
  console.log(`Need backfill (NULL reportCategory): ${needsBackfill.length}`);
  if (FIX_CONTRADICTIONS) {
    console.log(`Contradictions (LIQUOR menuType + Food reportCategory): ${contradictions.length}`);
  }
  console.log();

  // Group by restaurant for summary
  const byRestaurant = new Map<string, { backfill: number; contradictions: number }>();
  for (const item of needsBackfill) {
    const r = byRestaurant.get(item.restaurantId) || { backfill: 0, contradictions: 0 };
    r.backfill++;
    byRestaurant.set(item.restaurantId, r);
  }
  for (const item of contradictions) {
    const r = byRestaurant.get(item.restaurantId) || { backfill: 0, contradictions: 0 };
    r.contradictions++;
    byRestaurant.set(item.restaurantId, r);
  }

  if (byRestaurant.size > 0) {
    console.log('By restaurant:');
    for (const [rid, counts] of byRestaurant) {
      console.log(`  ${rid}: ${counts.backfill} backfill, ${counts.contradictions} contradictions`);
    }
    console.log();
  }

  // Show sample of items that need backfill
  if (needsBackfill.length > 0) {
    console.log('Sample items needing backfill (first 20):');
    for (const item of needsBackfill.slice(0, 20)) {
      const derived = deriveReportCategory(item.menuType, item.category?.name || null);
      console.log(`  [${derived}] ${item.name} (menuType=${item.menuType}, category=${item.category?.name || 'N/A'})`);
    }
    if (needsBackfill.length > 20) {
      console.log(`  ... and ${needsBackfill.length - 20} more`);
    }
    console.log();
  }

  // Show sample of contradictions
  if (contradictions.length > 0) {
    console.log('Contradictions (LIQUOR menuType but Food reportCategory):');
    for (const item of contradictions.slice(0, 20)) {
      console.log(`  ${item.name} (menuType=${item.menuType}, reportCategory=${item.reportCategory})`);
    }
    if (contradictions.length > 20) {
      console.log(`  ... and ${contradictions.length - 20} more`);
    }
    console.log();
  }

  if (!APPLY) {
    console.log('DRY RUN — no changes made. Run with --apply to update.');
    return;
  }

  // Apply backfill
  let updated = 0;
  let errors = 0;

  // Backfill NULL reportCategory
  for (const item of needsBackfill) {
    const derived = deriveReportCategory(item.menuType, item.category?.name || null);
    try {
      await prisma.menuItem.update({
        where: { id: item.id },
        data: { reportCategory: derived },
      });
      updated++;
    } catch (err: any) {
      console.error(`  ERROR updating ${item.name} (${item.id}): ${err.message}`);
      errors++;
    }
  }

  // Fix contradictions
  for (const item of contradictions) {
    const derived = deriveReportCategory(item.menuType, item.category?.name || null);
    try {
      await prisma.menuItem.update({
        where: { id: item.id },
        data: { reportCategory: derived },
      });
      updated++;
    } catch (err: any) {
      console.error(`  ERROR fixing contradiction ${item.name} (${item.id}): ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone. Updated ${updated} items, ${errors} errors.`);
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
