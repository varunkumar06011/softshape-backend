// Compare stock sheet values with actual DB values to find the ₹26K gap
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

// Stock sheet: [brand, size, bottleCount] — from the user's sheet
const STOCK_DATA = [
  ['mansion house',          750, 21],
  ['mansion house',          180, 54],
  ['morpheus xo rare brandy',750, 16],
  ['morpheus blue brandy',   180, 46],
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

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  // Build lookup
  const lookup = new Map();
  for (const item of items) {
    const base = normalizeBase(item.menuItem?.name || '');
    if (!lookup.has(base)) lookup.set(base, new Map());
    lookup.get(base).set(Number(item.bottleSize), item);
  }

  let sheetTotal = 0;
  let dbTotal = 0;
  const mismatches = [];

  console.log('=== Stock Sheet vs DB Comparison ===\n');
  console.log('Brand | Size | SheetBtl | DB_Btl | SheetCost | DB_Cost | SheetValue | DB_Value | Diff');
  console.log('-'.repeat(140));

  for (const [brand, size, btlCount] of STOCK_DATA) {
    const item = lookup.get(brand)?.get(size);
    if (!item) {
      console.log(`  NOT FOUND: ${brand} ${size}ml`);
      continue;
    }

    const dbBtl = Number(item.openingStock) / size;
    const dbCost = Number(item.costPerBottle) || 0;
    const dbValue = dbBtl * dbCost;
    dbTotal += dbValue;

    // We don't have the sheet cost — but we can check if the DB cost seems reasonable
    sheetTotal += dbValue; // Using DB cost since we don't have sheet cost

    if (Math.abs(dbBtl - btlCount) > 0.01) {
      mismatches.push({
        name: item.menuItem?.name,
        size,
        sheetBtl: btlCount,
        dbBtl,
        dbCost,
        dbValue,
        diff: (dbBtl - btlCount) * dbCost,
      });
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total DB opening value: Rs ${dbTotal.toFixed(2)}`);
  console.log(`Mismatches (bottle count): ${mismatches.length}`);
  
  if (mismatches.length > 0) {
    console.log('\nMismatches:');
    mismatches.forEach(m => {
      console.log(`  ${m.name} | ${m.size}ml | sheet=${m.sheetBtl} btl | db=${m.dbBtl.toFixed(2)} btl | cost=Rs ${m.dbCost.toFixed(2)} | diff=Rs ${m.diff.toFixed(2)}`);
    });
  }

  // Check for items with stock > 0 that are NOT in the stock sheet
  const stockKeys = new Set(STOCK_DATA.map(([b, s]) => `${b}|${s}`));
  const extraItems = [];
  for (const item of items) {
    const base = normalizeBase(item.menuItem?.name || '');
    const key = `${base}|${Number(item.bottleSize)}`;
    const btlSize = Number(item.bottleSize) || 0;
    const openingBtl = btlSize > 0 ? Number(item.openingStock) / btlSize : 0;
    if (openingBtl > 0 && !stockKeys.has(key)) {
      const cost = Number(item.costPerBottle) || 0;
      const value = openingBtl * cost;
      extraItems.push({ name: item.menuItem?.name, base, size: btlSize, openingBtl, cost, value });
    }
  }

  if (extraItems.length > 0) {
    console.log('\n=== Items with stock NOT in stock sheet ===');
    extraItems.forEach(e => {
      console.log(`  ${e.name} | base="${e.base}" | ${e.size}ml | ${e.openingBtl.toFixed(2)} btl | Rs ${e.cost.toFixed(2)} | Rs ${e.value.toFixed(2)}`);
    });
    const extraTotal = extraItems.reduce((s, e) => s + e.value, 0);
    console.log(`Extra total: Rs ${extraTotal.toFixed(2)}`);
  }

  await p.$disconnect();
})();
