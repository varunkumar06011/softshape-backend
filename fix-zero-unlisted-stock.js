// fix-zero-unlisted-stock.js
// Sets openingStock=0 and currentStock=0 for all active items NOT in the stock sheet.
// The stock sheet only covers 62 specific items — everything else should be 0.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

// Same stock data as update-opening-stock.js — list of [brand, size] that WERE provided
const STOCK_SHEET_KEYS = new Set([
  'mansion house|750', 'mansion house|180',
  'morpheus|750', 'morpheus|180',
  'kyron brandy|750',
  'courrier napoleon green|750',
  'whytehall|750', 'whytehall|180',
  'mc brandy|375',
  'morpheus blue brandy|750',
  'mc vsop brandy|750',
  'black gold vsop|750',
  'antiquity blue|750',
  'ballantines|750',
  'black dog|750', 'black dog|180',
  'signature|750',
  'chivas regal|750',
  'sterling b7|750', 'sterling b7|180',
  'hydarabad blue|750',
  'sterling b10|750',
  'royal stag barrel|750',
  'blenders pride|750',
  '100 pipers|750',
  'imperial blue|750', 'imperial blue|180',
  'royal challenge|750', 'royal challenge|180',
  'teacher higland|750',
  'royal stag|750', 'royal stag|180',
  'o c elegant whisky|180',
  'black label|750',
  'legacy whisky|750',
  'willian lawson|750',
  'mc whisky|750', 'mc whisky|180',
  'black and white|750',
  'red label|750',
  'vat 69|750',
  'jamson|750',
  'british whisky|750',
  'dewars|750',
  'smirnoff orange vodka|750',
  'magic moments orange|750',
  'absolut vodka|750',
  'magic moments green|750',
  'kyra wine|750',
  'elite wine|750',
  'breezer orange|275',
  'old monk rum|750',
  'karjura beer|650',
  'kalyani beer|650',
  'british empire strong beer|650',
  'budweiser beer|650',
  'kf ultra beer|650',
  'kf strong beer|650',
  'kf lite beer|650',
  'kf storm beer|650',
  'budweiser magnum beer|650',
  'stok lite beer|650',
]);

function normalizeBase(name) {
  return String(name).toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
    .replace(/\s*\b(full\s+bottle|bottle|can)\b\s*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}\n`);

  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  let zeroed = 0;
  let kept = 0;
  let totalValue = 0;

  for (const item of items) {
    const base = normalizeBase(item.menuItem?.name || '');
    const key = `${base}|${Number(item.bottleSize)}`;
    const inSheet = STOCK_SHEET_KEYS.has(key);
    const stock = Number(item.openingStock);
    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;

    if (inSheet) {
      kept++;
      totalValue += stock * cost;
    } else {
      if (stock !== 0) {
        console.log(`  ZERO: ${item.menuItem?.name} [${item.bottleSize}ml]  old opening: ${stock}  old current: ${item.currentStock}`);
        if (!DRY_RUN) {
          await p.inventoryItem.update({
            where: { id: item.id },
            data: { openingStock: 0, currentStock: 0 },
          });
        }
        zeroed++;
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Items in stock sheet (kept): ${kept}`);
  console.log(`Items zeroed (not in sheet): ${zeroed}`);
  console.log(`Total opening stock value (sheet items only): ₹${totalValue.toFixed(2)}`);
  if (DRY_RUN) console.log('\nDRY RUN — run without --dry-run to apply.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
