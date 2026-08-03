/// <reference types="node" />
/**
 * Adds "Chicken Fry B/L" bar menu item at ₹400 across ALL venues
 * with kitchen ingredient recipes for deduction.
 *
 * Usage:
 *   npx tsx dev-scripts/addChickenFryBL.ts --dry-run
 *   npx tsx dev-scripts/addChickenFryBL.ts
 */
import { PrismaClient, MenuType } from '@prisma/client';

const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';
const ITEM_NAME = 'Chicken Fry B/L';
const PRICE = 400;
const CATEGORY_NAME = 'Liquor';
const PRINTER_TARGET = 'BAR_PRINTER';

// Recipe ingredients: [name, quantity, unit]
const RECIPE: Array<[string, number, string]> = [
  ['Chicken',           0.18, 'KG'],
  ['Onion',             50,   'g'],
  ['Ginger',            10,   'g'],
  ['Garlic',            10,   'g'],
  ['Green Chilli',      5,    'g'],
  ['Cooking Oil',       30,   'ml'],
  ['Red Chilli Powder', 5,    'g'],
  ['Turmeric Powder',   3,    'g'],
  ['Coriander Powder',  5,    'g'],
  ['Cornflour',         15,   'g'],
  ['Salt',              0.01, 'KG'],
  ['Curry Leaves',      5,    'g'],
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(dryRun ? '=== DRY RUN ===' : '=== LIVE RUN ===');
  console.log(`Outlet: ${OUTLET_ID}`);
  console.log(`Item: "${ITEM_NAME}" at ₹${PRICE} (all venues)`);

  // 1. Find or create category
  let category = await prisma.category.findFirst({
    where: { restaurantId: OUTLET_ID, name: { equals: CATEGORY_NAME, mode: 'insensitive' } },
  });
  if (!category) {
    if (dryRun) { console.log(`  [DRY] Would create category "${CATEGORY_NAME}"`); return; }
    category = await prisma.category.create({
      data: { name: CATEGORY_NAME, restaurantId: OUTLET_ID, sortOrder: 999, printerTarget: PRINTER_TARGET },
    });
    console.log(`  Created category "${CATEGORY_NAME}" (${category.id})`);
  } else {
    console.log(`  Category "${CATEGORY_NAME}" already exists (${category.id})`);
  }

  // 2. Check if menu item exists
  const existing = await prisma.menuItem.findFirst({
    where: { restaurantId: OUTLET_ID, name: { equals: ITEM_NAME, mode: 'insensitive' }, isDeleted: false },
    include: { variants: true, recipes: true },
  });

  let menuItemId: string;

  if (existing) {
    console.log(`  Menu item "${ITEM_NAME}" already exists (${existing.id}) — skipping creation.`);
    menuItemId = existing.id;
  } else if (dryRun) {
    console.log(`  [DRY] Would create menu item "${ITEM_NAME}" at ₹${PRICE}`);
    menuItemId = '__DRY__';
  } else {
    const created = await prisma.menuItem.create({
      data: {
        name: ITEM_NAME,
        isVeg: false,
        isAvailable: true,
        menuType: MenuType.LIQUOR,
        basePrice: PRICE,
        unit: 'pcs',
        printerTarget: PRINTER_TARGET,
        gstEnabled: false,
        restaurantId: OUTLET_ID,
        categoryId: category!.id,
        isDeleted: false,
        variants: {
          create: { name: 'Regular', price: PRICE, isDefault: true, restaurantId: OUTLET_ID },
        },
      },
    });
    console.log(`  Created menu item "${ITEM_NAME}" (${created.id})`);
    menuItemId = created.id;
  }

  // 3. Set venue prices for ALL venues
  const venues = await prisma.venue.findMany({
    where: { restaurantId: OUTLET_ID, isDeleted: false },
  });
  console.log(`  Found ${venues.length} venue(s)`);

  for (const venue of venues) {
    await ensureVenuePrice(menuItemId, venue, OUTLET_ID, dryRun);
  }

  // 4. Add recipe ingredients
  console.log(`\n  Recipe ingredients (${RECIPE.length}):`);
  for (const [ingName, qty, unit] of RECIPE) {
    console.log(`    ${ingName} — ${qty} ${unit}`);
  }

  if (menuItemId !== '__DRY__') {
    // Find kitchen inventory items by name
    for (const [ingName, qty, _unit] of RECIPE) {
      const ingredient = await prisma.kitchenInventoryItem.findFirst({
        where: {
          restaurantId: OUTLET_ID,
          name: { equals: ingName, mode: 'insensitive' },
        },
      });
      if (!ingredient) {
        console.log(`    ⚠ Ingredient "${ingName}" not found in kitchen inventory — skipping.`);
        continue;
      }

      // Check if recipe entry already exists
      const existingRecipe = await prisma.menuItemRecipe.findUnique({
        where: { menuItemId_ingredientId: { menuItemId, ingredientId: ingredient.id } },
      });
      if (existingRecipe) {
        if (Number(existingRecipe.quantity) === qty) {
          console.log(`    ✓ ${ingName} already set to ${qty} — no change.`);
        } else if (!dryRun) {
          await prisma.menuItemRecipe.update({
            where: { id: existingRecipe.id },
            data: { quantity: qty },
          });
          console.log(`    ✓ Updated ${ingName} → ${qty}`);
        } else {
          console.log(`    [DRY] Would update ${ingName} → ${qty}`);
        }
      } else if (!dryRun) {
        await prisma.menuItemRecipe.create({
          data: { menuItemId, ingredientId: ingredient.id, quantity: qty, restaurantId: OUTLET_ID },
        });
        console.log(`    ✓ Added ${ingName} — ${qty} ${ingredient.unit}`);
      } else {
        console.log(`    [DRY] Would add ${ingName} — ${qty}`);
      }
    }
  }

  console.log('\nDone!');
}

async function ensureVenuePrice(
  menuItemId: string,
  venue: { id: string; name: string; priceProfileId: string | null },
  restaurantId: string,
  dryRun: boolean,
) {
  if (menuItemId === '__DRY__') {
    console.log(`    [DRY] Would set venue price ₹${PRICE} for "${venue.name}"`);
    return;
  }
  let ppId = venue.priceProfileId;
  if (!ppId) {
    if (dryRun) { console.log(`    [DRY] Would create PriceProfile for "${venue.name}"`); return; }
    const pp = await prisma.priceProfile.create({ data: { restaurantId, name: venue.name } });
    await prisma.venue.update({ where: { id: venue.id }, data: { priceProfileId: pp.id } });
    ppId = pp.id;
    console.log(`    Created PriceProfile for "${venue.name}" (${ppId})`);
  }

  const existing = await prisma.priceProfileItem.findUnique({
    where: { priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId } },
  });
  if (existing) {
    if (Number(existing.price) === PRICE) {
      console.log(`    "${venue.name}" price already ₹${PRICE} — no change.`);
      return;
    }
    if (dryRun) { console.log(`    [DRY] Would update "${venue.name}" price → ₹${PRICE}`); return; }
    await prisma.priceProfileItem.update({ where: { id: existing.id }, data: { price: PRICE } });
    console.log(`    Updated "${venue.name}" price → ₹${PRICE}`);
  } else {
    if (dryRun) { console.log(`    [DRY] Would set price ₹${PRICE} for "${venue.name}"`); return; }
    await prisma.priceProfileItem.create({ data: { priceProfileId: ppId, menuItemId, price: PRICE, restaurantId } });
    console.log(`    Set price ₹${PRICE} for "${venue.name}"`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
