/// <reference types="node" />
/**
 * Fixes "Green salad" in Vgrand Family Restaurant:
 * - Moves to Starters (Veg) category with KOT FAMILY printer
 * - Sets ₹119 price for both venues (Parcel + Family Restaurant)
 * - Adds recipe ingredients for kitchen deduction
 *
 * Usage:
 *   npx tsx dev-scripts/fixGreenSaladFamilyRest.ts --dry-run
 *   npx tsx dev-scripts/fixGreenSaladFamilyRest.ts
 */
import { PrismaClient, MenuType } from '@prisma/client';
const prisma = new PrismaClient();

const OUTLET_ID = 'cmr03m0fa00015ot8jh16grhn';
const ITEM_ID = '92c651c9-1786-46cc-a03f-e6c0fc4ecefa';
const PRICE = 119;
const PRINTER_TARGET = 'KOT FAMILY';

// [ingredientName, quantity]
const RECIPE: Array<[string, number]> = [
  ['Cucumber',          50],
  ['Onion',             30],
  ['Tomato',            40],
  ['Carrot',            20],
  ['Cabbage',           30],
  ['Coriander Leaves',   5],
  ['Lemon',              1],
  ['Salt',               2],
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '=== DRY RUN ===' : '=== LIVE RUN ===');

  // 1. Find or create "Starters (Veg)" category with KOT FAMILY printer
  let category = await prisma.category.findFirst({
    where: { restaurantId: OUTLET_ID, name: { equals: 'Starters (Veg)', mode: 'insensitive' } },
  });
  if (!category) {
    if (dryRun) { console.log('  [DRY] Would create "Starters (Veg)" category'); return; }
    category = await prisma.category.create({
      data: { name: 'Starters (Veg)', restaurantId: OUTLET_ID, sortOrder: 999, printerTarget: PRINTER_TARGET },
    });
    console.log(`  Created category "Starters (Veg)" (${category.id})`);
  } else {
    console.log(`  Category "Starters (Veg)" exists (${category.id}) | printerTarget=${category.printerTarget}`);
    // Ensure printerTarget is set
    if (category.printerTarget !== PRINTER_TARGET && !dryRun) {
      await prisma.category.update({ where: { id: category.id }, data: { printerTarget: PRINTER_TARGET } });
      console.log(`  Updated category printerTarget → ${PRINTER_TARGET}`);
    }
  }

  // 2. Update the menu item: category, menuType, printerTarget
  const item = await prisma.menuItem.findUnique({ where: { id: ITEM_ID } });
  if (!item) { console.log('⚠ Item not found'); return; }

  console.log(`  Item: "${item.name}" (${item.id}) | current: menuType=${item.menuType} | category=${item.categoryId} | printerTarget=${item.printerTarget}`);

  if (!dryRun) {
    await prisma.menuItem.update({
      where: { id: ITEM_ID },
      data: {
        name: 'Green salad',
        menuType: MenuType.FOOD,
        categoryId: category!.id,
        printerTarget: PRINTER_TARGET,
        isAvailable: true,
        isDeleted: false,
        basePrice: PRICE,
      },
    });
    console.log('  ✓ Updated item (name, menuType=FOOD, category=Starters (Veg), printerTarget=KOT FAMILY)');
  } else {
    console.log('  [DRY] Would update item');
  }

  // 3. Set venue prices for all venues
  const venues = await prisma.venue.findMany({
    where: { restaurantId: OUTLET_ID, isDeleted: false },
  });
  console.log(`\n  Venues (${venues.length}):`);
  for (const venue of venues) {
    await ensureVenuePrice(ITEM_ID, venue, OUTLET_ID, dryRun);
  }

  // 4. Add recipe ingredients
  console.log(`\n  Recipe (${RECIPE.length} ingredients):`);
  for (const [name, qty] of RECIPE) {
    console.log(`    ${name} — ${qty}`);
  }

  if (!dryRun) {
    for (const [ingName, qty] of RECIPE) {
      const ingredient = await prisma.kitchenInventoryItem.findFirst({
        where: { restaurantId: OUTLET_ID, name: { equals: ingName, mode: 'insensitive' } },
      });
      if (!ingredient) {
        console.log(`    ⚠ "${ingName}" not found in kitchen inventory — skipping`);
        continue;
      }

      const existingRecipe = await prisma.menuItemRecipe.findUnique({
        where: { menuItemId_ingredientId: { menuItemId: ITEM_ID, ingredientId: ingredient.id } },
      });
      if (existingRecipe) {
        if (Number(existingRecipe.quantity) === qty) {
          console.log(`    ✓ ${ingName} already ${qty} — no change`);
        } else {
          await prisma.menuItemRecipe.update({
            where: { id: existingRecipe.id },
            data: { quantity: qty },
          });
          console.log(`    ✓ Updated ${ingName} → ${qty}`);
        }
      } else {
        await prisma.menuItemRecipe.create({
          data: { menuItemId: ITEM_ID, ingredientId: ingredient.id, quantity: qty, restaurantId: OUTLET_ID },
        });
        console.log(`    ✓ Added ${ingName} — ${qty} ${ingredient.unit}`);
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
  let ppId = venue.priceProfileId;
  if (!ppId) {
    if (dryRun) { console.log(`    [DRY] Would create PriceProfile for "${venue.name}"`); return; }
    const pp = await prisma.priceProfile.create({ data: { restaurantId, name: venue.name } });
    await prisma.venue.update({ where: { id: venue.id }, data: { priceProfileId: pp.id } });
    ppId = pp.id;
    console.log(`    Created PriceProfile for "${venue.name}"`);
  }

  const existing = await prisma.priceProfileItem.findUnique({
    where: { priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId } },
  });
  if (existing) {
    if (Number(existing.price) === PRICE) {
      console.log(`    "${venue.name}" already ₹${PRICE} — no change`);
    } else if (!dryRun) {
      await prisma.priceProfileItem.update({ where: { id: existing.id }, data: { price: PRICE } });
      console.log(`    Updated "${venue.name}": ₹${existing.price} → ₹${PRICE}`);
    } else {
      console.log(`    [DRY] Would update "${venue.name}" → ₹${PRICE}`);
    }
  } else if (!dryRun) {
    await prisma.priceProfileItem.create({ data: { priceProfileId: ppId, menuItemId, price: PRICE, restaurantId } });
    console.log(`    Set "${venue.name}" → ₹${PRICE}`);
  } else {
    console.log(`    [DRY] Would set "${venue.name}" → ₹${PRICE}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
