// ─────────────────────────────────────────────────────────────────────────────
// backfill-category-report-category.ts
//
// Backfills `reportCategory` on existing Category rows based on a normalized
// name → parent-bucket mapping confirmed by the user.
//
// Mapping (case-insensitive, trimmed):
//   Liquor:   beer, brandy, breezer, liquor, rum, vodka, whisky, wine
//   Beverages: beverages, cocktails & mocktails, lassi, lassies, milkshakes,
//              millkshakes, soft drinks
//   Food:     everything else (default)
//
// Usage:
//   npx tsx scripts/backfill-category-report-category.ts              # dry run
//   npx tsx scripts/backfill-category-report-category.ts --apply      # apply
//
// Safety:
//   - Defaults to dry run (no writes unless --apply)
//   - Only writes reportCategory on Category — no other fields
//   - Idempotent: re-running is a no-op once all categories have reportCategory
//   - Logs every category that would be/was updated
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

// Normalized name → parent report category
const LIQUOR_NAMES = new Set([
  'beer', 'brandy', 'breezer', 'liquor', 'rum', 'vodka', 'whisky', 'wine',
]);
const BEVERAGE_NAMES = new Set([
  'beverages', 'beverage',
  'cocktails & mocktails', 'cocktails &mocktails', 'cocktails& mocktails', 'cocktails&mocktails',
  'lassi', 'lassies', 'milkshakes', 'millkshakes', 'milk shakes', 'milkshake',
  'soft drinks', 'softdrinks', 'soft drink',
]);

function normalize(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function deriveReportCategory(name: string): 'Food' | 'Beverages' | 'Liquor' {
  const n = normalize(name);
  if (LIQUOR_NAMES.has(n)) return 'Liquor';
  if (BEVERAGE_NAMES.has(n)) return 'Beverages';
  return 'Food';
}

async function main() {
  const categories = await prisma.category.findMany({
    select: { id: true, name: true, reportCategory: true, restaurantId: true },
  });

  const toUpdate: Array<{ id: string; name: string; oldVal: string | null; newVal: string; restaurantId: string }> = [];

  for (const cat of categories) {
    const derived = deriveReportCategory(cat.name);
    if (cat.reportCategory !== derived) {
      toUpdate.push({
        id: cat.id,
        name: cat.name,
        oldVal: cat.reportCategory,
        newVal: derived,
        restaurantId: cat.restaurantId,
      });
    }
  }

  if (toUpdate.length === 0) {
    console.log('All categories already have the correct reportCategory. No changes needed.');
    return;
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${toUpdate.length} categor${toUpdate.length === 1 ? 'y' : 'ies'} to update:\n`);

  for (const c of toUpdate) {
    console.log(`  [${c.restaurantId.slice(0, 8)}] "${c.name}" — ${c.oldVal || 'NULL'} → ${c.newVal}`);
  }

  if (!APPLY) {
    console.log('\nDry run complete. Run with --apply to write changes.');
    return;
  }

  let updated = 0;
  for (const c of toUpdate) {
    await prisma.category.update({
      where: { id: c.id },
      data: { reportCategory: c.newVal },
    });
    updated++;
  }

  console.log(`\nApplied: ${updated} categor${updated === 1 ? 'y' : 'ies'} updated.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
