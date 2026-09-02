// cleanup-inventory-sizes.js
// Cleans up inventory to ensure every liquor brand has exactly 180ml, 750ml, 375ml.
// - Removes 30ml items (sets isActive=false to preserve history)
// - Creates missing 750/180/375 for brands that only had 30ml
// - Creates missing sizes for brands missing some
// - Renames 750ml items to include "750ml" in the name
// - Does NOT touch beers (650ml), breezers (275ml), tins (500ml), soft drinks (250ml), water (1000ml)
//
// Usage:
//   node cleanup-inventory-sizes.js --dry-run   (preview only)
//   node cleanup-inventory-sizes.js              (apply)

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

const BEER_KEYWORDS = ['beer', 'bira', 'boom', 'carlsberg', 'kf ', 'kingfisher', 'budweiser', 'stok', 'coolberg', 'corona', 'heineken', 'tuborg', 'kalyani', 'karjura', 'british empire strong', 'british ultra'];
const BREEZER_KEYWORDS = ['breezer', 'bacardi cranberry'];
const TIN_KEYWORDS = ['tin'];
const SOFT_DRINK_KEYWORDS = ['coca cola', 'cola', 'fanta', 'limca', 'maaza', 'monster', 'pulpy', 'rimzim', 'soda', 'sprite', 'thums up', 'thumbs up', 'energy'];
const WATER_KEYWORDS = ['water', 'kinley'];

function isNonLiquor(name) {
  const n = name.toLowerCase();
  return BEER_KEYWORDS.some(k => n.includes(k))
    || BREEZER_KEYWORDS.some(k => n.includes(k))
    || TIN_KEYWORDS.some(k => n.includes(k))
    || SOFT_DRINK_KEYWORDS.some(k => n.includes(k))
    || WATER_KEYWORDS.some(k => n.includes(k));
}

function normalizeBase(name) {
  return String(name).toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(base) {
  return base.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseMl(name) {
  const m = String(name).match(/(\d+)\s*ml/i);
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  console.log(`\n=== Inventory Cleanup Script ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'APPLY'}\n`);

  const items = await p.inventoryItem.findMany({
    include: { menuItem: { select: { name: true, menuType: true, id: true, categoryId: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });
  console.log(`Loaded ${items.length} inventory items\n`);

  // ── STEP 1: Deactivate all 30ml items ──────────────────────────────────────
  console.log('--- STEP 1: Deactivate 30ml items ---');
  const toDeactivate = items.filter(i => Number(i.bottleSize) === 30);
  console.log(`Found ${toDeactivate.length} items at 30ml to deactivate:`);
  toDeactivate.forEach(i => console.log(`  DEACTIVATE: "${i.menuItem?.name}" (stock: ${i.currentStock})`));

  if (!DRY_RUN) {
    for (const i of toDeactivate) {
      await p.inventoryItem.update({ where: { id: i.id }, data: { isActive: false } });
    }
    console.log(`✓ Deactivated ${toDeactivate.length} items`);
  }

  // ── STEP 2: Rename 750ml items that don't have "750ml" in name ─────────────
  console.log('\n--- STEP 2: Rename 750ml items missing size in name ---');
  const toRename = items.filter(i => {
    if (Number(i.bottleSize) !== 750) return false;
    if (isNonLiquor(i.menuItem?.name || '')) return false;
    const nameMl = parseMl(i.menuItem?.name || '');
    return nameMl === null; // no ml in name
  });
  console.log(`Found ${toRename.length} items to rename:`);
  toRename.forEach(i => {
    const newName = `${i.menuItem.name} 750ml`;
    console.log(`  RENAME: "${i.menuItem.name}" → "${newName}"`);
  });

  if (!DRY_RUN) {
    for (const i of toRename) {
      const newName = `${i.menuItem.name} 750ml`;
      await p.menuItem.update({ where: { id: i.menuItemId }, data: { name: newName } });
    }
    console.log(`✓ Renamed ${toRename.length} items`);
  }

  // ── STEP 3: Create missing 180/375/750 for liquor brands ───────────────────
  console.log('\n--- STEP 3: Create missing 180/375/750 variants ---');

  // Reload items (after deactivation + rename)
  const freshItems = DRY_RUN
    ? items.filter(i => Number(i.bottleSize) !== 30)
    : await p.inventoryItem.findMany({
        where: { isActive: true },
        include: { menuItem: { select: { name: true, menuType: true, id: true, categoryId: true } } },
      });

  // Also include deactivated 30ml items as templates for brands that ONLY had 30ml
  const deactivated30ml = items.filter(i => Number(i.bottleSize) === 30);

  // Group by base brand name (liquor only) — include ALL items (active + deactivated 30ml)
  // so brands that only had 30ml still get their 750/180/375 created
  const brandMap = new Map();
  for (const item of [...freshItems, ...deactivated30ml]) {
    const name = item.menuItem?.name || '';
    if (isNonLiquor(name)) continue;
    const base = normalizeBase(name);
    if (!base) continue;
    if (!brandMap.has(base)) brandMap.set(base, { items: [], restaurantId: item.restaurantId });
    brandMap.get(base).items.push({
      id: item.id,
      name,
      bottleSize: Number(item.bottleSize),
      menuItemId: item.menuItemId,
      menuItem: item.menuItem,
    });
  }

  const REQUIRED_SIZES = [750, 180, 375];
  const toCreate = [];

  for (const [brand, data] of brandMap.entries()) {
    const existingSizes = new Set(data.items.map(i => i.bottleSize));
    // Use 750ml as template, or any available item
    const template = data.items.find(i => i.bottleSize === 750) || data.items[0];
    if (!template) continue;

    for (const size of REQUIRED_SIZES) {
      if (!existingSizes.has(size)) {
        toCreate.push({ brand, size, template, restaurantId: data.restaurantId });
      }
    }
  }

  console.log(`Found ${toCreate.length} missing variants to create:`);
  toCreate.forEach(c => console.log(`  CREATE: "${c.brand}" ${c.size}ml (template: "${c.template.name}")`));

  if (!DRY_RUN && toCreate.length > 0) {
    for (const c of toCreate) {
      const newName = `${titleCase(c.brand)} ${c.size}ml`;

      // Check if menu item exists
      const existingMenu = await p.menuItem.findFirst({
        where: { restaurantId: c.restaurantId, name: { equals: newName, mode: 'insensitive' } },
      });

      let menuItemId;
      if (existingMenu) {
        menuItemId = existingMenu.id;
      } else {
        const templateMenu = await p.menuItem.findUnique({
          where: { id: c.template.menuItemId },
          select: { categoryId: true },
        });
        const newMenu = await p.menuItem.create({
          data: {
            restaurantId: c.restaurantId,
            name: newName,
            menuType: 'LIQUOR',
            basePrice: 0,
            isAvailable: true,
            isDeleted: false,
            showInMenu: false,
            categoryId: templateMenu?.categoryId,
          },
        });
        menuItemId = newMenu.id;
      }

      // Check if inventory item already exists for this menu item
      const existingInv = await p.inventoryItem.findUnique({ where: { menuItemId } });
      if (existingInv) {
        // Update bottle size if wrong
        if (Number(existingInv.bottleSize) !== c.size) {
          await p.inventoryItem.update({ where: { id: existingInv.id }, data: { bottleSize: c.size, isActive: true } });
          console.log(`  ✓ Updated existing: ${newName} → ${c.size}ml`);
        }
        continue;
      }

      const newInv = await p.inventoryItem.create({
        data: {
          restaurantId: c.restaurantId,
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
  console.log(`30ml items deactivated: ${toDeactivate.length}`);
  console.log(`750ml items renamed: ${toRename.length}`);
  console.log(`New variants created: ${DRY_RUN ? 0 : toCreate.length}`);
  if (DRY_RUN) console.log('\nThis was a DRY RUN. Run without --dry-run to apply.');
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => p.$disconnect());
