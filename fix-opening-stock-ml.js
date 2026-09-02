// fix-opening-stock-ml.js
// Converts openingStock from bottle count to ML for all items.
// The stock sheet values are BOTTLE COUNTS, but openingStock field must be in ML
// because the bar inventory system deducts in ml.
//
// Formula: openingStock_ml = bottleCount * bottleSize_ml
// Value:   stockValue = bottleCount * costPerBottle  (= openingStock_ml / bottleSize * costPerBottle)
//
// Also updates DailyInventorySnapshot for 2026-08-31 and 2026-09-01.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

// Stock sheet data: [brandBaseName, bottleSize_ml, bottleCount]
const STOCK_DATA = [
  ['mansion house',          750, 21],
  ['mansion house',          180, 54],
  ['morpheus xo rare brandy',750, 16],   // "Morpheus" → Morpheus XO Rare Brandy
  ['morpheus blue brandy',   180, 46],   // "Morpheus" 180ml → Morpheus Blue Brandy 180ml
  ['kyron brandy',           750, 5],
  ['courrier napoleon green',750, 7],
  ['whytehall',              750, 4],
  ['whytehall',              180, 24],
  ['mc brandy',              375, 7],
  ['morpheus blue brandy',   750, 13],
  ['mc vsop brandy',         750, 1],
  ['black gold vsop',        750, 1],
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
  ['teacher higland',        750, 3],
  ['royal stag',             750, 21],
  ['royal stag',             180, 58],
  ['o c elegant whisky',     180, 315],
  ['black label',            750, 8],
  ['legacy whisky',          750, 8],
  ['willian lawson',         750, 4],
  ['mc whisky',              750, 22],
  ['mc whisky',              180, 77],
  ['black and white',        750, 9],
  ['red label',              750, 5],
  ['vat 69',                 750, 5],
  ['jamson',                 750, 3],
  ['british whisky',         750, 58],
  ['dewars',                 750, 10],
  ['smirnoff orange vodka',  750, 3],
  ['magic moments orange',   750, 10],
  ['absolut vodka',          750, 6],
  ['magic moments green',    750, 11],
  ['kyra wine',              750, 7],
  ['elite wine',             750, 1],
  ['breezer orange',         275, 2],
  ['old monk rum',           750, 10],
  ['karjura beer',           650, 24],
  ['kalyani beer',           650, 0],
  ['british empire strong beer', 650, 18],
  ['budweiser beer',         650, 56],
  ['kf ultra beer',          650, 93],
  ['kf strong beer',         650, 71],
  ['kf lite beer',           650, 39],
  ['kf storm beer',          650, 276],
  ['budweiser magnum beer',  650, 1],
  ['stok lite beer',         650, 111],
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
  console.log(`\n=== Fix Opening Stock (convert to ML) ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}\n`);

  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  console.log(`Loaded ${items.length} active inventory items`);

  // Build lookup: normalizedBase → { size → item }
  const lookup = new Map();
  for (const item of items) {
    const base = normalizeBase(item.menuItem?.name || '');
    if (!lookup.has(base)) lookup.set(base, new Map());
    lookup.get(base).set(Number(item.bottleSize), item);
  }

  let updated = 0;
  let notFound = 0;
  let totalValue = 0;
  const changes = [];

  for (const [brand, size, bottleCount] of STOCK_DATA) {
    const brandLookup = lookup.get(brand);
    if (!brandLookup) {
      console.log(`  NOT FOUND: brand "${brand}"`);
      notFound++;
      continue;
    }

    const item = brandLookup.get(size);
    if (!item) {
      console.log(`  NOT FOUND: "${brand}" ${size}ml`);
      notFound++;
      continue;
    }

    const cost = item.costPerBottle ? Number(item.costPerBottle) : 0;
    const openingMl = bottleCount * size; // Convert bottles to ml
    const stockValue = bottleCount * cost;
    totalValue += stockValue;
    const oldOpening = Number(item.openingStock);

    changes.push({
      name: item.menuItem?.name,
      size,
      bottleCount,
      oldOpeningMl: oldOpening,
      newOpeningMl: openingMl,
      cost,
      stockValue,
      itemId: item.id,
    });

    if (!DRY_RUN) {
      await p.inventoryItem.update({
        where: { id: item.id },
        data: {
          openingStock: openingMl,
          currentStock: openingMl,
        },
      });
    }
    updated++;
  }

  // Zero out items NOT in the stock sheet
  const stockKeys = new Set(STOCK_DATA.map(([b, s]) => `${b}|${s}`));
  let zeroed = 0;
  for (const item of items) {
    const base = normalizeBase(item.menuItem?.name || '');
    const key = `${base}|${Number(item.bottleSize)}`;
    if (!stockKeys.has(key) && Number(item.openingStock) !== 0) {
      changes.push({
        name: item.menuItem?.name,
        size: Number(item.bottleSize),
        bottleCount: 0,
        oldOpeningMl: Number(item.openingStock),
        newOpeningMl: 0,
        cost: Number(item.costPerBottle || 0),
        stockValue: 0,
        itemId: item.id,
      });
      if (!DRY_RUN) {
        await p.inventoryItem.update({
          where: { id: item.id },
          data: { openingStock: 0, currentStock: 0 },
        });
      }
      zeroed++;
    }
  }

  // Print changes
  console.log('\n--- Changes ---');
  console.log('Name | Size | Bottles | OldOpening | NewOpening(ml) | Cost | Value');
  console.log('-'.repeat(100));
  for (const c of changes) {
    const ch = c.oldOpeningMl !== c.newOpeningMl ? ' ← CHANGED' : '';
    console.log(`  ${c.name} | ${c.size}ml | ${c.bottleCount} | ${c.oldOpeningMl} → ${c.newOpeningMl} | Rs ${c.cost.toFixed(2)} | Rs ${c.stockValue.toFixed(2)}${ch}`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Updated from stock sheet: ${updated}`);
  console.log(`Zeroed (not in sheet): ${zeroed}`);
  console.log(`Not found: ${notFound}`);
  console.log(`Total opening stock value: Rs ${totalValue.toFixed(2)}`);

  // Now update DailyInventorySnapshot for 31-08 and 01-09
  if (!DRY_RUN) {
    console.log('\n--- Updating DailyInventorySnapshots ---');
    for (const date of ['2026-08-31', '2026-09-01']) {
      // Reload items with updated openingStock
      const updatedItems = await p.inventoryItem.findMany({
        where: { restaurantId: RESTAURANT_ID, isActive: true },
        include: { menuItem: { select: { name: true } } },
      });

      const existingSnaps = await p.dailyInventorySnapshot.findMany({
        where: { restaurantId: RESTAURANT_ID, snapshotDate: date },
      });
      const snapMap = new Map();
      existingSnaps.forEach(s => snapMap.set(s.itemId, s));

      let snapUpdated = 0, snapCreated = 0;
      for (const item of updatedItems) {
        const openingMl = Number(item.openingStock);
        const itemName = item.menuItem?.name || '';
        const existing = snapMap.get(item.id);

        if (existing) {
          await p.dailyInventorySnapshot.update({
            where: { id: existing.id },
            data: {
              openingStock: openingMl,
              purchased: 0,
              sold: 0,
              wastage: 0,
              adjusted: 0,
              closingStock: openingMl,
              itemName: itemName,
            },
          });
          snapUpdated++;
        } else {
          await p.dailyInventorySnapshot.create({
            data: {
              restaurantId: RESTAURANT_ID,
              snapshotDate: date,
              itemId: item.id,
              itemName: itemName,
              openingStock: openingMl,
              purchased: 0,
              sold: 0,
              wastage: 0,
              adjusted: 0,
              closingStock: openingMl,
            },
          });
          snapCreated++;
        }
      }
      console.log(`  ${date}: ${snapUpdated} updated, ${snapCreated} created`);
    }
  }

  if (DRY_RUN) console.log('\nDRY RUN — run without --dry-run to apply.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
