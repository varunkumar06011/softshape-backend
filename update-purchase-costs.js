// update-purchase-costs.js
// Updates costPerBottle for all inventory items based on the provided purchase cost list.
//
// Usage:
//   node update-purchase-costs.js --dry-run   (preview only)
//   node update-purchase-costs.js              (apply)

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

// ── LIQUOR PRICES (brand → { 180, 375, 750 }) ──────────────────────────────
// null = "—" (no price provided, skip). 0 = ₹0.00 (set to 0).
const LIQUOR_PRICES = {
  '100 pipers':                 { 180: 678.66, 375: 0,      750: 2540.15 },
  '8pm premium black':          { 180: 233.08, 375: 455.91, 750: 900.99  },
  'absolut vodka':              { 180: 0,      375: 0,      750: 2611.91 },
  'ac premium':                 { 180: null,   375: null,   750: null    },
  'antiquity blue':             { 180: 0,      375: 0,      750: 1221.17 },
  'aristo premium superior':    { 180: null,   375: null,   750: null    },
  'ballantines':                { 180: 0,      375: 0,      750: 2632.79 },
  'black and white':            { 180: 617.41, 375: 1234.90, 750: 2438.43 },
  'black dog':                  { 180: 576.19, 375: 414.46, 750: 2590.17 },
  'black gold vsop':            { 180: null,   375: null,   750: null    },
  'black label':                { 180: 0,      375: 0,      750: 5072.06 },
  'blenders pride':             { 180: 364.40, 375: 718.42, 750: 1416.85 },
  'bols brandy':                { 180: null,   375: null,   750: null    },
  'british empire whisky':      { 180: null,   375: null,   750: null    },
  'british whisky':             { 180: 233.13, 375: 456.03, 750: 632.18  },
  'chivas regal':               { 180: 0,      375: 0,      750: 5294.39 },
  'clovis xo brandy':           { 180: null,   375: null,   750: null    },
  'courrier napoleon green':    { 180: 304.26, 375: 607.49, 750: 1194.02 },
  'courrier napoleon red':      { 180: 233.02, 375: 475.77, 750: 941.59  },
  'dewars':                     { 180: 0,      375: 0,      750: 2107.00 },
  'elite wine':                 { 180: 0,      375: 0,      750: 741.26  },
  'gold label':                 { 180: null,   375: null,   750: null    },
  'hydarabad blue':             { 180: 152.02, 375: 0,      750: 576.78  },
  'imperial blue':              { 180: 182.33, 375: 0,      750: 728.74  },
  'jamson':                     { 180: 0,      375: 0,      750: 2549.87 },
  'johnnie blonde':             { 180: null,   375: null,   750: null    },
  'juno vodka':                 { 180: null,   375: null,   750: null    },
  'kyra wine':                  { 180: 203.18, 375: 404.81, 750: 828.26  },
  'kyron brandy':               { 180: 304.32, 375: 576.85, 750: 1113.44 },
  'legacy whisky':              { 180: 0,      375: 0,      750: 1045.27 },
  'magic moments green':        { 180: 233.13, 375: 455.91, 750: 774.00  },
  'magic moments orange':       { 180: 233.13, 375: 455.91, 750: 774.00  },
  'mansion house':              { 180: 220.67, 375: 384.83, 750: 768.90  },
  'mc brandy':                  { 180: 172.28, 375: 311.82, 750: 798.88  },
  'mc vsop brandy':             { 180: 182.33, 375: 364.25, 750: 728.74  },
  'mc whisky':                  { 180: 132.05, 375: 0,      750: 728.74  },
  'morpheus':                   { 180: 294.11, 375: 566.57, 750: 1083.27 },
  'morpheus blue brandy':       { 180: 152.39, 375: 0,      750: 1161.00 },
  'morpheus xo rare brandy':    { 180: null,   375: null,   750: null    },
  'o c elegant whisky':         { 180: null,   375: null,   750: null    },
  'oab':                        { 180: null,   375: null,   750: null    },
  'oc whisky':                  { 180: null,   375: null,   750: null    },
  'old monk rum':               { 180: 243.49, 375: 0,      750: 961.49  },
  'red label':                  { 180: 0,      375: 0,      750: 2764.14 },
  'royal challenge':            { 180: 197.79, 375: 465.68, 750: 931.59  },
  'royal green premium':        { 180: null,   375: null,   750: null    },
  'royal stag':                 { 180: 233.14, 375: 476.23, 750: 951.22  },
  'royal stag barrel':          { 180: 152.39, 375: 0,      750: 587.20  },
  'sidus wine':                 { 180: 172.29, 375: 324.65, 750: 648.31  },
  'signature':                  { 180: 334.41, 375: 667.90, 750: 1335.63 },
  'smirnoff orange vodka':      { 180: null,   375: null,   750: null    },
  'sterling b10':               { 180: 323.88, 375: 637.71, 750: 1244.68 },
  'sterling b7':                { 180: 233.13, 375: 456.03, 750: 891.04  },
  'teacher higland':            { 180: 708.83, 375: 1295.76, 750: 2459.50 },
  'vat 69':                     { 180: 220.70, 375: 424.53, 750: 849.07  },
  'whytehall':                  { 180: 137.58, 375: 304.79, 750: 597.22  },
  'willian lawson':             { 180: 577.15, 375: 0,      750: 2216.65 },
  'zeus brandy':                { 180: null,   375: null,   750: null    },
};

// ── BEER / BREEZER / TIN PRICES (match by name keyword → price) ────────────
const BEER_PRICES = [
  { match: 'kalyani',            price: 180.00 },
  { match: 'budweiser magnum',   price: 202.72 },
  { match: 'budweiser tin',      price: 180.00 },
  { match: 'bira white small',   price: 242.76 },  // 330ml
  { match: 'stok strong',        price: 220.00 },
  { match: 'stok lite',          price: 220.00 },
  { match: 'budweiser strong',   price: 242.56 },
  { match: 'british ultra',      price: 0 },
  { match: 'karjura',            price: 182.11 },
  { match: 'kf lite',            price: 188.15 },
  { match: 'kf strong',          price: 202.73 },
  { match: 'kf storm',           price: 222.54 },
  { match: 'kf ultra',           price: 223.89 },
  { match: 'british empire strong', price: 383.88 },
  { match: 'carlsberg',          price: 324.72 },
  { match: 'breezer orange',     price: 131.88 },  // Breezer Cranberry → closest match
  { match: 'bacardi cranberry',  price: 131.88 },
  { match: 'breezer platinum',   price: 131.88 },
  { match: 'budweiser beer',     price: 242.56 },  // Budweiser Strong Beer
  { match: 'bira white',         price: 242.76 },  // exclude "small" handled above
  { match: 'bira blonde',        price: 242.76 },
  { match: 'bira glod',          price: 242.76 },
  { match: 'boom beer',          price: 180.00 },
  { match: 'boom rise',          price: 180.00 },
  { match: 'coolberg',           price: 220.00 },
];

function normalizeBase(name) {
  return String(name).toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
    .replace(/\s*\b(full\s+bottle|bottle|tin|can)\b\s*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  console.log(`\n=== Purchase Cost Update Script ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'APPLY'}`);
  console.log(`Restaurant: ${RESTAURANT_ID}\n`);

  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true, id: true, categoryId: true } } },
  });
  console.log(`Loaded ${items.length} active inventory items\n`);

  // ── PRE-STEP: Fix Ballantines (rename + create missing 180/375) ──────────
  const ballantinesItem = items.find(i => (i.menuItem?.name || '').toLowerCase() === 'ballantines');
  if (ballantinesItem && !DRY_RUN) {
    // Rename to "Ballantines 750ml"
    await p.menuItem.update({ where: { id: ballantinesItem.menuItemId }, data: { name: 'Ballantines 750ml' } });
    console.log('✓ Renamed "Ballantines" → "Ballantines 750ml"');

    // Create 180ml and 375ml variants
    const templateMenu = await p.menuItem.findUnique({ where: { id: ballantinesItem.menuItemId }, select: { categoryId: true } });
    for (const size of [180, 375]) {
      const newName = `Ballantines ${size}ml`;
      const existingMenu = await p.menuItem.findFirst({ where: { restaurantId: RESTAURANT_ID, name: { equals: newName, mode: 'insensitive' } } });
      let menuItemId;
      if (existingMenu) {
        menuItemId = existingMenu.id;
      } else {
        const newMenu = await p.menuItem.create({
          data: { restaurantId: RESTAURANT_ID, name: newName, menuType: 'LIQUOR', basePrice: 0, isAvailable: true, isDeleted: false, showInMenu: false, categoryId: templateMenu?.categoryId },
        });
        menuItemId = newMenu.id;
      }
      const existingInv = await p.inventoryItem.findUnique({ where: { menuItemId } });
      if (!existingInv) {
        await p.inventoryItem.create({
          data: { restaurantId: RESTAURANT_ID, menuItemId, bottleSize: size, openingStock: 0, currentStock: 0, reorderLevel: 0, unitOfMeasure: 'BOTTLE', isActive: true },
        });
        console.log(`✓ Created Ballantines ${size}ml`);
      }
    }
    // Reload items
    items.length = 0;
    const freshItems = await p.inventoryItem.findMany({
      where: { restaurantId: RESTAURANT_ID, isActive: true },
      include: { menuItem: { select: { name: true, id: true, categoryId: true } } },
    });
    items.push(...freshItems);
    console.log(`Reloaded ${items.length} items after Ballantines fix\n`);
  }

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  const updatesLog = [];

  for (const item of items) {
    const name = item.menuItem?.name || '';
    const size = Number(item.bottleSize);
    const base = normalizeBase(name);

    let newCost = null;

    // Try liquor price match
    if (LIQUOR_PRICES[base] && LIQUOR_PRICES[base][size] !== undefined && LIQUOR_PRICES[base][size] !== null) {
      newCost = LIQUOR_PRICES[base][size];
    }

    // Try beer/breezer price match (by keyword)
    if (newCost === null) {
      const lowerName = name.toLowerCase();
      for (const bp of BEER_PRICES) {
        if (lowerName.includes(bp.match)) {
          newCost = bp.price;
          break;
        }
      }
    }

    if (newCost !== null) {
      const oldCost = item.costPerBottle ? Number(item.costPerBottle) : null;
      updatesLog.push({
        name,
        size: `${size}ml`,
        oldCost: oldCost !== null ? `₹${oldCost.toFixed(2)}` : 'null',
        newCost: `₹${Number(newCost).toFixed(2)}`,
        itemId: item.id,
      });
      if (!DRY_RUN) {
        await p.inventoryItem.update({
          where: { id: item.id },
          data: { costPerBottle: newCost },
        });
      }
      updated++;
    } else {
      skipped++;
    }
  }

  // Print update log
  console.log('--- Updates ---');
  updatesLog.forEach(u => {
    const changed = u.oldCost !== u.newCost ? ' ← CHANGED' : '';
    console.log(`  ${u.name} [${u.size}]  ${u.oldCost} → ${u.newCost}${changed}`);
  });

  // Check which liquor brands had no match
  console.log('\n--- Liquor brands with no price provided (—) ---');
  for (const [brand, sizes] of Object.entries(LIQUOR_PRICES)) {
    if (sizes[180] === null && sizes[375] === null && sizes[750] === null) {
      console.log(`  ${brand}: no prices provided (skipped)`);
    }
  }

  // Check which items were NOT matched at all
  console.log('\n--- Items NOT matched to any price ---');
  for (const item of items) {
    const name = item.menuItem?.name || '';
    const size = Number(item.bottleSize);
    const base = normalizeBase(name);
    let matched = false;
    if (LIQUOR_PRICES[base] && LIQUOR_PRICES[base][size] !== undefined && LIQUOR_PRICES[base][size] !== null) {
      matched = true;
    }
    if (!matched) {
      const lowerName = name.toLowerCase();
      for (const bp of BEER_PRICES) {
        if (lowerName.includes(bp.match)) { matched = true; break; }
      }
    }
    if (!matched) {
      console.log(`  ${name} [${size}ml]`);
      notFound++;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped (no price): ${skipped}`);
  console.log(`Not matched: ${notFound}`);
  if (DRY_RUN) console.log('\nThis was a DRY RUN. Run without --dry-run to apply.');
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => p.$disconnect());
