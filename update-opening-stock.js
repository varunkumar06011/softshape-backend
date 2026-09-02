// update-opening-stock.js
// Updates openingStock and currentStock for all items in the provided stock sheet.
// Also calculates openingStockValue = costPerBottle × openingStock (stored implicitly).
//
// Usage:
//   node update-opening-stock.js --dry-run   (preview only)
//   node update-opening-stock.js              (apply)

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

// ── STOCK DATA ──────────────────────────────────────────────────────────────
// Format: [brandBaseName, bottleSize, openingStock]
// "—" means 0. Items not listed here are left unchanged.
const STOCK_DATA = [
  // ── Sheet 1 (Items 1-27) ──
  ['mansion house',          750, 21],
  ['mansion house',          180, 54],
  ['morpheus',               750, 16],   // "Morpheus" (not Blue, not XO)
  ['morpheus',               180, 46],
  ['kyron brandy',           750, 5],
  ['courrier napoleon green',750, 7],
  ['whytehall',              750, 4],    // "White Year" → Whytehall
  ['whytehall',              180, 24],
  ['mc brandy',              375, 7],
  // ['old admiral',         ...] — NOT IN INVENTORY (skip, note it)
  ['morpheus blue brandy',   750, 13],
  ['mc vsop brandy',         750, 1],
  ['black gold vsop',        750, 1],    // "Black & Gold" → Black Gold VSOP
  ['antiquity blue',         750, 13],
  ['ballantines',            750, 3],
  ['black dog',              750, 9],
  ['black dog',              180, 26],
  ['signature',              750, 3],
  ['chivas regal',           750, 2],
  ['sterling b7',            750, 12],
  ['sterling b7',            180, 21],
  ['hydarabad blue',         750, 25],
  ['sterling b10',           750, 10],
  ['royal stag barrel',      750, 12],
  ['blenders pride',         750, 21],
  ['100 pipers',             750, 4],
  ['imperial blue',          750, 19],
  ['imperial blue',          180, 70],
  ['royal challenge',        750, 21],
  ['royal challenge',        180, 38],
  ['teacher higland',        750, 3],    // No 180ml stock
  ['royal stag',             750, 21],
  ['royal stag',             180, 58],   // Corrected from 315 to 58
  ['o c elegant whisky',     180, 315],  // "Officer's Choice" → O C Elegant Whisky
  ['black label',            750, 8],

  // ── Sheet 2 (Items 28-54) ──
  ['legacy whisky',          750, 8],
  ['willian lawson',         750, 4],    // "Williamson" → Willian Lawson
  ['mc whisky',              750, 22],
  ['mc whisky',              180, 77],   // Corrected: 77 units in 180ml
  ['black and white',        750, 9],
  ['red label',              750, 5],
  ['vat 69',                 750, 5],
  ['jamson',                 750, 3],    // "Jameson" → Jamson
  ['british whisky',         750, 58],
  ['dewars',                 750, 10],
  ['smirnoff orange vodka',  750, 3],
  ['magic moments orange',   750, 10],
  ['absolut vodka',          750, 6],
  ['magic moments green',    750, 11],
  ['kyra wine',              750, 7],
  ['elite wine',             750, 1],
  ['breezer orange',         275, 2],    // Breezer 275ml
  ['old monk rum',           750, 10],
  ['karjura beer',           650, 24],
  ['kalyani beer',           650, 0],    // Nil
  ['british empire strong beer', 650, 18],  // "British Beer"
  ['budweiser beer',         650, 56],   // Budweiser
  ['kf ultra beer',          650, 93],
  ['kf strong beer',         650, 71],
  ['kf lite beer',           650, 39],
  ['kf storm beer',          650, 276],
  ['budweiser magnum beer',  650, 1],
  ['stok lite beer',         650, 111],  // "Stok Lager" → Stok Lite
];

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
  console.log(`\n=== Opening Stock Update Script ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'APPLY'}`);
  console.log(`Restaurant: ${RESTAURANT_ID}\n`);

  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  console.log(`Loaded ${items.length} active inventory items\n`);

  // Build lookup: normalizedBase → { size → item }
  const lookup = new Map();
  for (const item of items) {
    const base = normalizeBase(item.menuItem?.name || '');
    if (!lookup.has(base)) lookup.set(base, new Map());
    lookup.get(base).set(Number(item.bottleSize), item);
  }

  let updated = 0;
  let notFound = 0;
  const results = [];

  for (const [brand, size, stock] of STOCK_DATA) {
    const brandLookup = lookup.get(brand);
    if (!brandLookup) {
      console.log(`  ✗ NOT FOUND: brand "${brand}" not in inventory`);
      notFound++;
      continue;
    }

    const item = brandLookup.get(size);
    if (!item) {
      console.log(`  ✗ NOT FOUND: "${brand}" ${size}ml not in inventory`);
      notFound++;
      continue;
    }

    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;
    const stockValue = cost * stock;
    const oldStock = Number(item.openingStock);
    const oldCurrent = Number(item.currentStock);

    results.push({
      name: item.menuItem?.name,
      size: `${size}ml`,
      oldOpening: oldStock,
      newOpening: stock,
      oldCurrent: oldCurrent,
      newCurrent: stock,
      cost: cost,
      stockValue: stockValue,
      itemId: item.id,
    });

    if (!DRY_RUN) {
      await p.inventoryItem.update({
        where: { id: item.id },
        data: {
          openingStock: stock,
          currentStock: stock,
        },
      });
    }
    updated++;
  }

  // Print results
  console.log('\n--- Updates ---');
  console.log('Item'.padEnd(35) + 'Size'.padEnd(8) + 'OldOpen'.padEnd(10) + 'NewOpen'.padEnd(10) + 'Cost'.padStart(10) + 'Value'.padStart(12));
  console.log('-'.repeat(85));
  for (const r of results) {
    const changed = r.oldOpening !== r.newOpening ? ' ←' : '';
    console.log(
      r.name.padEnd(35) +
      r.size.padEnd(8) +
      String(r.oldOpening).padEnd(10) +
      String(r.newOpening).padEnd(10) +
      ('₹' + r.cost.toFixed(2)).padStart(10) +
      ('₹' + r.stockValue.toFixed(2)).padStart(12) +
      changed
    );
  }

  // Total stock value
  const totalValue = results.reduce((sum, r) => sum + r.stockValue, 0);
  console.log('-'.repeat(85));
  console.log(`Total Opening Stock Value: ₹${totalValue.toFixed(2)}`);

  // Not found items
  console.log(`\n=== SUMMARY ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Not found: ${notFound}`);
  console.log(`Total opening stock value: ₹${totalValue.toFixed(2)}`);

  // List items NOT in the stock sheet (will keep their current stock)
  const updatedBrands = new Set(STOCK_DATA.map(([b]) => b));
  const notUpdated = items.filter(i => {
    const base = normalizeBase(i.menuItem?.name || '');
    return !updatedBrands.has(base) || !STOCK_DATA.some(([b, s]) => b === base && s === Number(i.bottleSize));
  });
  console.log(`\n--- Items NOT in stock sheet (left unchanged) ---`);
  notUpdated.forEach(i => {
    console.log(`  ${i.menuItem?.name} [${i.bottleSize}ml] opening: ${i.openingStock} current: ${i.currentStock}`);
  });

  if (DRY_RUN) console.log('\nThis was a DRY RUN. Run without --dry-run to apply.');
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => p.$disconnect());
