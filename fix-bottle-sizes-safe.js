// fix-bottle-sizes-safe.js
// Fixes mismatched bottle sizes and creates missing 180ml/375ml variants for liquor brands.
// DOES NOT delete anything. DOES NOT touch beers/breezers/tins/soft drinks/water.
// DOES NOT use any destructive commands.
//
// Usage:
//   node fix-bottle-sizes-safe.js --dry-run   (preview only, no changes)
//   node fix-bottle-sizes-safe.js              (apply changes)

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');

// Beer/breezer/tin/soft-drink keywords — these are NOT liquor and should NOT get 180/375ml variants
const BEER_KEYWORDS = ['beer', 'bira', 'boom', 'carlsberg', 'kf ', 'kingfisher', 'budweiser', 'stok', 'coolberg', 'corona', 'heineken', 'tuborg', 'kalyani', 'karjura', 'british empire strong', 'british ultra'];
const BREEZER_KEYWORDS = ['breezer', 'bacardi cranberry'];
const TIN_KEYWORDS = ['tin'];
const SOFT_DRINK_KEYWORDS = ['coca cola', 'cola', 'fanta', 'limca', 'maaza', 'monster', 'pulpy', 'rimzim', 'soda', 'sprite', 'thums up', 'thumbs up', 'energy'];
const WATER_KEYWORDS = ['water', 'kinley'];

function isBeer(name) {
  const n = name.toLowerCase();
  return BEER_KEYWORDS.some(k => n.includes(k));
}
function isBreezer(name) {
  const n = name.toLowerCase();
  return BREEZER_KEYWORDS.some(k => n.includes(k));
}
function isTin(name) {
  const n = name.toLowerCase();
  return TIN_KEYWORDS.some(k => n.includes(k));
}
function isSoftDrink(name) {
  const n = name.toLowerCase();
  return SOFT_DRINK_KEYWORDS.some(k => n.includes(k));
}
function isWater(name) {
  const n = name.toLowerCase();
  return WATER_KEYWORDS.some(k => n.includes(k));
}

// Normalize brand base name (strip size suffixes)
function normalizeBase(name) {
  return String(name).toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse ml from name
function parseMl(name) {
  const m = String(name).match(/(\d+)\s*ml/i);
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  console.log(`\n=== Bottle Size Fix Script ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'APPLY'}`);
  console.log('');

  // 1. Load all inventory items
  const items = await p.inventoryItem.findMany({
    include: { menuItem: { select: { name: true, menuType: true, id: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });
  console.log(`Loaded ${items.length} inventory items`);

  // ── STEP 1: Fix mismatched bottle sizes ──────────────────────────────────
  console.log('\n--- STEP 1: Fix mismatched bottle sizes ---');
  const fixes = [];
  for (const item of items) {
    const name = item.menuItem?.name || '';
    const nameMl = parseMl(name);
    if (nameMl && nameMl !== Number(item.bottleSize)) {
      fixes.push({
        id: item.id,
        name,
        oldSize: Number(item.bottleSize),
        newSize: nameMl,
        menuItemId: item.menuItemId,
      });
    }
  }
  console.log(`Found ${fixes.length} items with mismatched bottleSize`);
  for (const f of fixes) {
    console.log(`  FIX: "${f.name}" → ${f.oldSize}ml → ${f.newSize}ml`);
  }

  if (!DRY_RUN) {
    for (const f of fixes) {
      await p.inventoryItem.update({
        where: { id: f.id },
        data: { bottleSize: f.newSize },
      });
    }
    console.log(`✓ Applied ${fixes.length} bottle size fixes`);
  }

  // ── STEP 2: Create missing 180ml and 375ml variants for liquor brands ────
  console.log('\n--- STEP 2: Create missing 180ml/375ml variants for liquor brands ---');

  // Reload items after fixes
  const freshItems = DRY_RUN ? items : await p.inventoryItem.findMany({
    include: { menuItem: { select: { name: true, menuType: true, id: true } } },
  });

  // Group by base brand name
  const brandMap = new Map();
  for (const item of freshItems) {
    const name = item.menuItem?.name || '';
    const base = normalizeBase(name);
    if (!base) continue;

    // Skip non-liquor items
    if (isBeer(name) || isBreezer(name) || isTin(name) || isSoftDrink(name) || isWater(name)) {
      continue;
    }

    // Skip items that are clearly not bottle-size liquor (30ml pegs, 60ml, 90ml)
    const nameMl = parseMl(name);
    if (nameMl && [30, 60, 90].includes(nameMl)) {
      // This is a peg — track it under the brand but don't count it as a bottle size
    }

    if (!brandMap.has(base)) brandMap.set(base, { items: [], restaurantId: item.restaurantId });
    brandMap.get(base).items.push({
      id: item.id,
      name,
      bottleSize: Number(item.bottleSize),
      menuItemId: item.menuItemId,
      currentStock: Number(item.currentStock),
      menuItem: item.menuItem,
    });
  }

  const REQUIRED_SIZES = [750, 180, 375];
  const toCreate = [];

  for (const [brand, data] of brandMap.entries()) {
    const existingSizes = new Set(data.items.map(i => i.bottleSize));

    // Find the 750ml item to use as template
    const template750 = data.items.find(i => i.bottleSize === 750);
    if (!template750) {
      // No 750ml item — skip (can't create variants without a template)
      continue;
    }

    for (const size of REQUIRED_SIZES) {
      if (!existingSizes.has(size)) {
        toCreate.push({
          brand,
          size,
          template: template750,
          restaurantId: data.restaurantId,
        });
      }
    }
  }

  console.log(`Found ${toCreate.length} missing variants to create`);
  for (const c of toCreate) {
    console.log(`  CREATE: "${c.brand}" ${c.size}ml (template: "${c.template.name}")`);
  }

  if (!DRY_RUN && toCreate.length > 0) {
    // Get the restaurant ID from the first item
    const restaurantId = toCreate[0].restaurantId;

    for (const c of toCreate) {
      // Create a new MenuItem for this size
      const newName = c.brand
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ') + ` ${c.size}ml`;

      // Check if a menu item with this name already exists
      const existingMenu = await p.menuItem.findFirst({
        where: { restaurantId, name: { equals: newName, mode: 'insensitive' } },
      });

      let menuItemId;
      if (existingMenu) {
        menuItemId = existingMenu.id;
      } else {
        // Get the template menu item to copy its category
        const templateMenu = await p.menuItem.findUnique({
          where: { id: c.template.menuItemId },
          select: { categoryId: true },
        });

        const newMenu = await p.menuItem.create({
          data: {
            restaurantId,
            name: newName,
            menuType: 'LIQUOR',
            basePrice: 0,
            isAvailable: true,
            isDeleted: false,
            showInMenu: false, // hide from POS menu — these are inventory-only items
            categoryId: templateMenu?.categoryId,
          },
        });
        menuItemId = newMenu.id;
      }

      // Create the inventory item
      const newInv = await p.inventoryItem.create({
        data: {
          restaurantId,
          menuItemId,
          bottleSize: c.size,
          openingStock: 0,
          currentStock: 0,
          reorderLevel: 0,
          unitOfMeasure: 'BOTTLE',
          isActive: true,
        },
      });
      console.log(`  ✓ Created: ${newName} (${c.size}ml) → inv ${newInv.id}`);
    }
    console.log(`✓ Created ${toCreate.length} missing variants`);
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  console.log(`Bottle size fixes: ${fixes.length}`);
  console.log(`New variants created: ${DRY_RUN ? 0 : toCreate.length}`);
  if (DRY_RUN) {
    console.log('\nThis was a DRY RUN. Run without --dry-run to apply changes.');
  }
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => p.$disconnect());
