/**
 * One-off script: Fix spelling mistakes and apply smart title case
 * to all KitchenInventoryItem names stored in the database.
 *
 * Dry-run by default — shows what would change without touching the DB.
 * Pass --execute to apply corrections.
 *
 * Usage:
 *   npx tsx dev-scripts/fixIngredientNames.ts
 *   npx tsx dev-scripts/fixIngredientNames.ts --execute
 */

import prisma from '../src/lib/prisma';

// ---------------------------------------------------------------------------
// Words / abbreviations that should stay fully UPPERCASE after title-casing
// ---------------------------------------------------------------------------
const KEEP_UPPER = new Set([
  'PP', 'PVC', 'HDPE', 'LDPE', 'HM', 'LD',
  'B/L',       // Boneless / Bone-in shorthand used in Telugu restaurant menus
]);

// ---------------------------------------------------------------------------
// Spelling-correction map  (all keys MUST be lowercase)
// ---------------------------------------------------------------------------
const SPELLING_MAP: Record<string, string> = {
  // ── General English misspellings ──
  'goldem':      'golden',
  'birayni':     'biryani',
  'biriyani':    'biryani',
  'gorund':      'ground',
  'groud':       'ground',
  'boild':       'boiled',
  'harayali':    'hariyali',
  'manchcurian': 'manchurian',
  'chocklet':    'chocolate',
  'choclate':    'chocolate',
  'choclat':     'chocolate',
  'hydarabad':   'hyderabad',
  'vanila':      'vanilla',
  'butterscoch': 'butterscotch',
  'buttarscotch':'butterscotch',
  'friut':       'fruit',
  'fruite':      'fruit',
  'nepoleon':    'napoleon',
  'britesh':     'british',
  'ballanties':  'ballantines',
  'wiskey':      'whisky',
  'pistha':      'pista',
  'mejestic':    'majestic',
  'mojitho':     'mojito',
  'glod':        'gold',
  'projecter':   'projector',
  'schzwan':     'schezwan',
  'cashewunt':   'cashewnut',
  'granad':      'grand',
  'todat':       'today',
  'peppar':      'pepper',
  'lassi':       'lassi',       // correct – no change
  // ── Telugu dialect / Andhra restaurant terms ──
  'nattu':       'natu',        // natu kodi = country chicken
  'mudhapapu':   'mudda pappu', // splits into two words handled separately
  // ── Packaging supply names common in Telugu restaurants ──
  'laggage':     'luggage',
  'lugage':      'luggage',
  'covver':      'cover',
  'silvar':      'silver',
  'silvur':      'silver',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply word-level spelling corrections (case-insensitive, preserves casing pattern) */
function fixSpelling(str: string): string {
  return str.split(' ').map(token => {
    const lower = token.toLowerCase();
    const fix = SPELLING_MAP[lower];
    if (!fix) return token;

    // Preserve casing style of the original token
    if (token === token.toUpperCase()) {
      return fix.toUpperCase();
    }
    if (token[0] === token[0].toUpperCase()) {
      return fix.charAt(0).toUpperCase() + fix.slice(1);
    }
    return fix;
  }).join(' ');
}

/**
 * Smart title case:
 *  - Capitalises the first letter of every space-delimited word
 *  - Keeps known abbreviations fully UPPERCASE (PP, B/L, …)
 *  - Lowercases unit suffixes embedded in numbers (250ml, 1kg, etc.)
 */
function smartTitleCase(str: string): string {
  if (!str) return str;

  return str
    .toLowerCase()
    .split(' ')
    .map(word => {
      if (!word) return word;

      // Preserve abbreviations that should stay uppercase
      if (KEEP_UPPER.has(word.toUpperCase())) return word.toUpperCase();

      // Capitalise the first character of the word
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/** Full correction pipeline: spelling fix → smart title case */
function correctName(raw: string): string {
  return smartTitleCase(fixSpelling(raw));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const execute = process.argv.includes('--execute');

  console.log(execute
    ? '⚠️  EXECUTE MODE — names WILL be updated in the database'
    : '🔍 DRY RUN — no changes will be made. Pass --execute to apply.'
  );
  console.log('');

  const items = await prisma.kitchenInventoryItem.findMany({
    orderBy: { name: 'asc' },
  });

  console.log(`Found ${items.length} kitchen inventory item(s)\n`);
  console.log('─'.repeat(90));
  console.log('CURRENT NAME'.padEnd(45) + '→  CORRECTED NAME');
  console.log('─'.repeat(90));

  const toUpdate: Array<{ id: string; oldName: string; newName: string }> = [];

  for (const item of items) {
    const corrected = correctName(item.name);
    if (corrected !== item.name) {
      console.log(`  ${item.name.padEnd(43)}→  ${corrected}`);
      toUpdate.push({ id: item.id, oldName: item.name, newName: corrected });
    }
  }

  console.log('─'.repeat(90));

  if (toUpdate.length === 0) {
    console.log('\n✅ All names look correct — no changes needed.');
    return;
  }

  console.log(`\n${toUpdate.length} item(s) need correction out of ${items.length} total.`);

  if (!execute) {
    console.log('\n📋 Review the list above, then run with --execute to save changes.');
    return;
  }

  console.log('\n✏️  Applying corrections…');
  let succeeded = 0;
  let skipped   = 0;

  for (const { id, oldName, newName } of toUpdate) {
    try {
      await prisma.kitchenInventoryItem.update({
        where: { id },
        data:  { name: newName },
      });
      succeeded++;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        console.log(`  ⚠️  SKIP  "${oldName}" → "${newName}"  (corrected name already exists)`);
      } else {
        console.log(`  ❌ FAIL  "${oldName}": ${err?.message ?? err}`);
      }
      skipped++;
    }
  }

  console.log(`\n✅ Done: ${succeeded} updated, ${skipped} skipped/failed.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
