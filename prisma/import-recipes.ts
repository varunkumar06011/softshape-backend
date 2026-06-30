/**
 * Recipe Import Script
 * 
 * Reads recipe-data.json, matches menu items and ingredients by name
 * (case-insensitive fuzzy match), and writes MenuItemRecipe rows for a
 * specific restaurant tenant.
 *
 * Usage:
 *   npx tsx prisma/import-recipes.ts <restaurantId>
 *
 * If restaurantId is omitted, uses the first restaurant found.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

interface RecipeData {
  [menuItemName: string]: {
    [ingredientName: string]: string;
  };
}

function parseQuantity(qtyStr: string): number {
  const match = qtyStr.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function fuzzyMatch(searchName: string, candidates: string[]): string | null {
  const normalized = normalizeName(searchName);

  // Exact match (case-insensitive)
  for (const c of candidates) {
    if (normalizeName(c) === normalized) return c;
  }

  // Contains match (searchName is substring of candidate or vice versa)
  for (const c of candidates) {
    const cn = normalizeName(c);
    if (cn.includes(normalized) || normalized.includes(cn)) return c;
  }

  // Word-level match: all words in searchName appear in candidate
  const searchWords = normalized.split(' ').filter((w) => w.length > 2);
  for (const c of candidates) {
    const cn = normalizeName(c);
    if (searchWords.every((w) => cn.includes(w))) return c;
  }

  return null;
}

async function main() {
  const restaurantId = process.argv[2];
  const jsonPath1 = path.join(__dirname, 'recipe-data-1.json');
  const jsonPath2 = path.join(__dirname, 'recipe-data-2.json');

  if (!fs.existsSync(jsonPath1) || !fs.existsSync(jsonPath2)) {
    console.error('recipe-data-1.json and recipe-data-2.json must both exist in', __dirname);
    process.exit(1);
  }

  const part1: RecipeData = JSON.parse(fs.readFileSync(jsonPath1, 'utf-8'));
  const part2: RecipeData = JSON.parse(fs.readFileSync(jsonPath2, 'utf-8'));
  const recipeData: RecipeData = { ...part1, ...part2 };

  // Resolve restaurant ID
  let restId = restaurantId;
  if (!restId) {
    const firstRest = await prisma.outlet.findFirst({ select: { id: true, name: true } });
    if (!firstRest) {
      console.error('No restaurant found in database');
      process.exit(1);
    }
    restId = firstRest.id;
    console.log(`No restaurantId provided, using: ${firstRest.name} (${restId})`);
  }

  // Fetch all menu items for this restaurant
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId: restId, isDeleted: false },
    select: { id: true, name: true, menuType: true },
  });

  // Fetch all kitchen inventory items for this restaurant
  const inventoryItems = await prisma.kitchenInventoryItem.findMany({
    where: { restaurantId: restId },
    select: { id: true, name: true, unit: true },
  });

  console.log(`Found ${menuItems.length} menu items and ${inventoryItems.length} inventory items`);

  const menuItemNames = menuItems.map((m) => m.name);
  const inventoryNames = inventoryItems.map((i) => i.name);

  // Build lookup maps
  const menuItemMap = new Map<string, typeof menuItems[0]>();
  for (const m of menuItems) {
    menuItemMap.set(normalizeName(m.name), m);
  }

  const inventoryMap = new Map<string, typeof inventoryItems[0]>();
  for (const i of inventoryItems) {
    inventoryMap.set(normalizeName(i.name), i);
  }

  const recipesToCreate: {
    menuItemId: string;
    ingredientId: string;
    quantity: number;
    restaurantId: string;
  }[] = [];

  let matched = 0;
  let skipped = 0;
  let noRecipe = 0;
  const warnings: string[] = [];

  for (const [menuName, ingredients] of Object.entries(recipeData)) {
    // Match menu item
    let menuItem = menuItemMap.get(normalizeName(menuName));
    if (!menuItem) {
      const matchedName = fuzzyMatch(menuName, menuItemNames);
      if (matchedName) {
        menuItem = menuItemMap.get(normalizeName(matchedName));
      }
    }

    if (!menuItem) {
      warnings.push(`Menu item "${menuName}" not found in database — skipped`);
      skipped++;
      continue;
    }

    // Skip empty recipes (non-food items)
    if (Object.keys(ingredients).length === 0) {
      noRecipe++;
      continue;
    }

    let hasValidIngredients = false;

    for (const [ingName, qtyStr] of Object.entries(ingredients)) {
      // Match ingredient
      let invItem = inventoryMap.get(normalizeName(ingName));
      if (!invItem) {
        const matchedName = fuzzyMatch(ingName, inventoryNames);
        if (matchedName) {
          invItem = inventoryMap.get(normalizeName(matchedName));
        }
      }

      if (!invItem) {
        warnings.push(`Ingredient "${ingName}" not found for item "${menuName}" — skipped`);
        continue;
      }

      const quantity = parseQuantity(qtyStr);
      if (quantity <= 0) {
        warnings.push(`Invalid quantity "${qtyStr}" for "${ingName}" on "${menuName}" — skipped`);
        continue;
      }

      recipesToCreate.push({
        menuItemId: menuItem.id,
        ingredientId: invItem.id,
        quantity,
        restaurantId: restId,
      });
      hasValidIngredients = true;
    }

    if (hasValidIngredients) matched++;
  }

  console.log('\n--- Summary ---');
  console.log(`Menu items matched with recipes: ${matched}`);
  console.log(`Menu items skipped (not found): ${skipped}`);
  console.log(`Menu items with empty recipe (non-food): ${noRecipe}`);
  console.log(`Total recipe rows to create: ${recipesToCreate.length}`);
  console.log(`Warnings: ${warnings.length}`);

  if (warnings.length > 0) {
    const MAX_SHOW = 50;
    console.log('\n--- Warnings (first ' + MAX_SHOW + ') ---');
    warnings.slice(0, MAX_SHOW).forEach((w) => console.log(`  ⚠ ${w}`));
    if (warnings.length > MAX_SHOW) {
      console.log(`  ...and ${warnings.length - MAX_SHOW} more`);
    }
  }

  if (recipesToCreate.length === 0) {
    console.log('\nNo recipes to create. Exiting.');
    return;
  }

  // Delete existing recipes for this restaurant, then create new ones
  console.log('\nDeleting existing recipes for this restaurant...');
  const deleted = await prisma.menuItemRecipe.deleteMany({
    where: { restaurantId: restId },
  });
  console.log(`Deleted ${deleted.count} existing recipe rows`);

  // Batch create
  console.log('Creating new recipe rows...');
  const BATCH_SIZE = 500;
  for (let i = 0; i < recipesToCreate.length; i += BATCH_SIZE) {
    const batch = recipesToCreate.slice(i, i + BATCH_SIZE);
    await prisma.menuItemRecipe.createMany({ data: batch });
    console.log(`  Created batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(recipesToCreate.length / BATCH_SIZE)} (${batch.length} rows)`);
  }

  console.log(`\n✅ Done! Created ${recipesToCreate.length} recipe rows for ${matched} menu items.`);
}

main()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
