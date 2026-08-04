import prisma from "../src/lib/prisma";
import {
  CHICKEN_BIRYANI_ITEMS,
  EGG_BIRYANI_ITEMS,
  FISH_BIRYANI_ITEMS,
  MASTER_INGREDIENTS,
  MUTTON_BIRYANI_ITEMS,
  PRAWNS_BIRYANI_ITEMS,
  generateRecipe,
  isChickenBiryani,
} from "../src/services/recipeEngine";

async function resolveKitchenRestaurantIdSafe(restaurantId: string): Promise<string> {
  try {
    const { resolveKitchenRestaurantId } = await import("../src/lib/tenantContext");
    return await resolveKitchenRestaurantId(restaurantId);
  } catch {
    return restaurantId;
  }
}

const BAR_CATEGORIES = ["liquor", "cocktails & mocktails"];

const EXCLUDED_BIRYANI_ITEMS = new Set([
  ...CHICKEN_BIRYANI_ITEMS,
  ...EGG_BIRYANI_ITEMS,
  ...MUTTON_BIRYANI_ITEMS,
  ...PRAWNS_BIRYANI_ITEMS,
  ...FISH_BIRYANI_ITEMS,
].map((n) => n.toLowerCase()));

function isBarCategory(cat: string): boolean {
  const lower = cat.toLowerCase().trim();
  return BAR_CATEGORIES.some((b) => lower.includes(b));
}

function shouldSkip(item: { name: string; category?: { name: string } | null; isVeg: boolean }): boolean {
  const catName = item.category?.name ?? "";
  if (isBarCategory(catName)) return true;
  const lowerName = item.name.toLowerCase();
  // Skip protein biryani items that are already correct
  if (EXCLUDED_BIRYANI_ITEMS.has(lowerName)) return true;
  // Also skip any item detected as chicken biryani by fallback (extra safety)
  if (isChickenBiryani(item.name, catName, item.isVeg)) return true;
  return false;
}

async function applyForRestaurant(restaurantId: string, dryRun: boolean, categoryFilter?: string) {
  const kitchenRestaurantId = await resolveKitchenRestaurantIdSafe(restaurantId);
  console.log(`\n=== Restaurant: ${restaurantId} (Kitchen: ${kitchenRestaurantId}) ===`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);

  // Upsert master ingredients
  const existingItems = await prisma.kitchenInventoryItem.findMany({
    where: { restaurantId: kitchenRestaurantId, name: { in: MASTER_INGREDIENTS.map((i) => i.name) } },
    select: { name: true },
  });
  const existingNames = new Set(existingItems.map((i) => i.name));
  console.log(`Master ingredients: ${existingNames.size} already exist, ${MASTER_INGREDIENTS.length - existingNames.size} to create.`);

  if (!dryRun) {
    for (const ing of MASTER_INGREDIENTS) {
      await prisma.kitchenInventoryItem.upsert({
        where: { restaurantId_name: { restaurantId: kitchenRestaurantId, name: ing.name } },
        create: {
          restaurantId: kitchenRestaurantId,
          name: ing.name,
          unit: ing.unit,
          currentStock: ing.defaultStock,
          reorderLevel: ing.reorderLevel,
          price: 0,
        },
        update: {},
      });
    }
  }

  const allInventory = await prisma.kitchenInventoryItem.findMany({
    where: { restaurantId: kitchenRestaurantId, name: { in: MASTER_INGREDIENTS.map((i) => i.name) } },
    select: { id: true, name: true, unit: true },
  });
  const inventoryByName = new Map(allInventory.map((i) => [i.name, { id: i.id, unit: i.unit }]));

  const where: any = { restaurantId, isDeleted: false, menuType: "FOOD" };
  if (categoryFilter) {
    where.category = { name: { contains: categoryFilter, mode: "insensitive" } };
  }

  const allMenuItems = await prisma.menuItem.findMany({
    where,
    include: { category: true },
    orderBy: { name: "asc" },
  });

  const targetItems = allMenuItems.filter((item) => !shouldSkip(item));
  console.log(`\nFOOD items considered: ${allMenuItems.length}`);
  console.log(`Items to process (after excluding biryani/bar): ${targetItems.length}`);

  const recipesToCreate: { menuItemId: string; ingredientId: string; quantity: number }[] = [];
  const itemsWithValidRecipes = new Set<string>();
  const warnings: string[] = [];

  for (const item of targetItems) {
    const categoryName = item.category?.name ?? "";
    const generated = generateRecipe(item.name, categoryName, item.isVeg);
    const validLines: { ingredientId: string; quantity: number }[] = [];

    if (generated.length > 0) {
      console.log(`\n${item.name} (${categoryName || "no category"})`);
    }

    for (const line of generated) {
      const liveItem = inventoryByName.get(line.ingredientName);
      if (!liveItem) {
        warnings.push(`Ingredient "${line.ingredientName}" not found in inventory for item "${item.name}" — skipped.`);
        continue;
      }
      let adjustedQty = line.quantity;
      if (liveItem.unit !== line.unit) {
        const invUnit = liveItem.unit.toUpperCase();
        const recipeUnit = line.unit.toUpperCase();
        if (recipeUnit === "G" && invUnit === "KG") adjustedQty = line.quantity / 1000;
        else if (recipeUnit === "ML" && invUnit === "L") adjustedQty = line.quantity / 1000;
        else if (recipeUnit === "KG" && invUnit === "G") adjustedQty = line.quantity * 1000;
        else if (recipeUnit === "L" && invUnit === "ML") adjustedQty = line.quantity * 1000;
        else {
          warnings.push(`Unit mismatch for "${line.ingredientName}" on item "${item.name}": inventory uses "${liveItem.unit}", recipe expects "${line.unit}" — skipped.`);
          continue;
        }
        console.log(`  - ${line.ingredientName}: ${adjustedQty}${liveItem.unit} (converted from ${line.quantity}${line.unit})`);
      } else {
        console.log(`  - ${line.ingredientName}: ${adjustedQty}${line.unit}`);
      }
      validLines.push({ ingredientId: liveItem.id, quantity: adjustedQty });
    }

    const seenIngredientIds = new Set<string>();
    const dedupedValidLines = validLines.filter((v) => {
      if (seenIngredientIds.has(v.ingredientId)) return false;
      seenIngredientIds.add(v.ingredientId);
      return true;
    });

    if (dedupedValidLines.length > 0) {
      itemsWithValidRecipes.add(item.id);
      for (const v of dedupedValidLines) {
        recipesToCreate.push({ menuItemId: item.id, ingredientId: v.ingredientId, quantity: v.quantity });
      }
    }
  }

  // Global deduplication
  const recipeKeySet = new Set<string>();
  const dedupedRecipesToCreate = recipesToCreate.filter((r) => {
    const key = `${r.menuItemId}|${r.ingredientId}`;
    if (recipeKeySet.has(key)) return false;
    recipeKeySet.add(key);
    return true;
  });

  if (!dryRun && itemsWithValidRecipes.size > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.menuItemRecipe.deleteMany({
        where: { restaurantId, menuItemId: { in: Array.from(itemsWithValidRecipes) } },
      });
      await tx.menuItemRecipe.createMany({
        data: dedupedRecipesToCreate.map((r) => ({ ...r, restaurantId })),
      });
    });
  }

  console.log(`\n=== Summary for ${restaurantId} ===`);
  console.log(`Items with valid recipes: ${itemsWithValidRecipes.size}`);
  console.log(`Recipe lines to create: ${dedupedRecipesToCreate.length}`);
  if (dryRun) console.log("No database writes were performed (DRY_RUN=true).");
  else console.log("Recipes written to database.");

  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    warnings.slice(0, 20).forEach((w) => console.log(`  - ${w}`));
    if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more`);
  }
}

async function main() {
  const restaurantIds = process.env.RESTAURANT_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!restaurantIds || restaurantIds.length === 0) {
    throw new Error("RESTAURANT_IDS env var required");
  }
  const dryRun = process.env.DRY_RUN === "true";
  const categoryFilter = process.env.CATEGORY;

  console.log(`\n=== Apply All Recipes (non-biryani FOOD items) ===`);
  console.log(`Restaurants: ${restaurantIds.join(", ")}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  if (categoryFilter) console.log(`Category filter: ${categoryFilter}`);

  for (const id of restaurantIds) {
    await applyForRestaurant(id, dryRun, categoryFilter);
  }
  console.log("\nAll restaurants processed.");
}

main()
  .catch((err) => { console.error("Apply failed:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
