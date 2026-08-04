import prisma from "../src/lib/prisma";
import {
  CHICKEN_BIRYANI_ITEMS,
  EGG_BIRYANI_ITEMS,
  FISH_BIRYANI_ITEMS,
  MASTER_INGREDIENTS,
  MIXED_BIRYANI_ITEMS,
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

const PROTEIN_GROUPS: { key: string; label: string; items: string[] }[] = [
  { key: "chicken", label: "Chicken", items: CHICKEN_BIRYANI_ITEMS },
  { key: "egg", label: "Egg", items: EGG_BIRYANI_ITEMS },
  { key: "mutton", label: "Mutton", items: MUTTON_BIRYANI_ITEMS },
  { key: "prawns", label: "Prawns", items: PRAWNS_BIRYANI_ITEMS },
  { key: "fish", label: "Fish", items: FISH_BIRYANI_ITEMS },
  { key: "mixed", label: "Mixed", items: MIXED_BIRYANI_ITEMS },
];

async function applyForRestaurant(
  restaurantId: string,
  dryRun: boolean,
) {
  const kitchenRestaurantId = await resolveKitchenRestaurantIdSafe(restaurantId);

  console.log(`\n=== Restaurant ID: ${restaurantId} (Kitchen: ${kitchenRestaurantId}) ===`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}\n`);

  // 1. Upsert all master ingredients
  const existingItems = await prisma.kitchenInventoryItem.findMany({
    where: {
      restaurantId: kitchenRestaurantId,
      name: { in: MASTER_INGREDIENTS.map((i) => i.name) },
    },
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

  // 2. Fetch all food menu items for this restaurant
  const allMenuItems = await prisma.menuItem.findMany({
    where: { restaurantId, isDeleted: false, menuType: "FOOD" },
    include: { category: true },
    orderBy: { name: "asc" },
  });
  const menuItemByName = new Map<string, typeof allMenuItems>();
  for (const item of allMenuItems) {
    const key = item.name.toLowerCase();
    if (!menuItemByName.has(key)) menuItemByName.set(key, []);
    menuItemByName.get(key)!.push(item);
  }

  // 3. Per-protein checklists + recipe generation
  const recipesToCreate: { menuItemId: string; ingredientId: string; quantity: number }[] = [];
  const itemsWithValidRecipes = new Set<string>();
  const warnings: string[] = [];

  // Fetch inventory for validation
  const allInventory = await prisma.kitchenInventoryItem.findMany({
    where: { restaurantId: kitchenRestaurantId, name: { in: MASTER_INGREDIENTS.map((i) => i.name) } },
    select: { id: true, name: true, unit: true },
  });
  const inventoryByName = new Map(
    allInventory.map((i) => [i.name, { id: i.id, unit: i.unit }]),
  );

  function buildRecipeForItem(item: (typeof allMenuItems)[0]) {
    const categoryName = item.category?.name ?? "";
    const generated = generateRecipe(item.name, categoryName, item.isVeg);
    const validLines: { ingredientId: string; quantity: number }[] = [];

    console.log(`\n${item.name} (${categoryName || "no category"})`);
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
        if (recipeUnit === "G" && invUnit === "KG") {
          adjustedQty = line.quantity / 1000;
        } else if (recipeUnit === "ML" && invUnit === "L") {
          adjustedQty = line.quantity / 1000;
        } else if (recipeUnit === "KG" && invUnit === "G") {
          adjustedQty = line.quantity * 1000;
        } else if (recipeUnit === "L" && invUnit === "ML") {
          adjustedQty = line.quantity * 1000;
        } else if (recipeUnit === "PCS" && invUnit === "PCS") {
          // same unit, no conversion needed
        } else {
          warnings.push(`Unit mismatch for "${line.ingredientName}" on item "${item.name}": inventory uses "${liveItem.unit}", recipe expects "${line.unit}" — skipped.`);
          continue;
        }
        if (recipeUnit !== "PCS" || invUnit !== "PCS") {
          console.log(`  - ${line.ingredientName}: ${adjustedQty}${liveItem.unit} (converted from ${line.quantity}${line.unit})`);
        } else {
          console.log(`  - ${line.ingredientName}: ${adjustedQty}${liveItem.unit}`);
        }
        validLines.push({ ingredientId: liveItem.id, quantity: adjustedQty });
        continue;
      }
      validLines.push({ ingredientId: liveItem.id, quantity: adjustedQty });
      console.log(`  - ${line.ingredientName}: ${adjustedQty}${line.unit}`);
    }

    // Deduplicate ingredient lines for this item.
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

  for (const group of PROTEIN_GROUPS) {
    const matchedItems: { name: string; item: (typeof allMenuItems)[number] }[] = [];
    for (const name of group.items) {
      const items = menuItemByName.get(name.toLowerCase());
      if (items) matchedItems.push(...items.map((item) => ({ name, item })));
    }

    const uniqueFound = group.items.filter((name) => menuItemByName.has(name.toLowerCase())).length;
    const totalMatched = matchedItems.length;

    console.log(`\n-- ${group.label} Biryani (${uniqueFound}/${group.items.length} unique names, ${totalMatched} items) --`);
    for (const name of group.items) {
      const count = menuItemByName.get(name.toLowerCase())?.length ?? 0;
      console.log(`  ${count > 0 ? "✓" : "✗"} ${name}${count > 1 ? ` (${count} duplicates)` : ""}`);
    }

    for (const { item } of matchedItems) {
      buildRecipeForItem(item);
    }
  }

  // Fallback: non-curated chicken biryani items detected by name/category pattern.
  const curatedOrOtherProteinIds = new Set(itemsWithValidRecipes);
  const fallbackChickenItems = allMenuItems.filter(
    (item) =>
      !curatedOrOtherProteinIds.has(item.id) &&
      isChickenBiryani(item.name, item.category?.name ?? "", item.isVeg),
  );

  if (fallbackChickenItems.length > 0) {
    console.log(`\n-- Fallback Chicken Biryani (${fallbackChickenItems.length} detected) --`);
    for (const item of fallbackChickenItems) {
      buildRecipeForItem(item);
    }
  }

  // Global deduplication of (menuItemId, ingredientId) pairs before DB write.
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
  if (dryRun) {
    console.log("No database writes were performed (DRY_RUN=true).");
  } else {
    console.log("Recipes written to database.");
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    warnings.slice(0, 20).forEach((w) => console.log(`  - ${w}`));
    if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more`);
  }
}

async function main() {
  const restaurantIds = process.env.RESTAURANT_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!restaurantIds || restaurantIds.length === 0) {
    throw new Error(
      "RESTAURANT_IDS environment variable is required.\n" +
      "Usage: RESTAURANT_IDS=<lounge-id>,<family-id> DRY_RUN=true npx ts-node dev-scripts/applyBiryaniRecipes.ts",
    );
  }

  const dryRun = process.env.DRY_RUN === "true";
  console.log(`\n=== Multi-Protein Biryani Recipe Application ===`);
  console.log(`Restaurants: ${restaurantIds.join(", ")}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);

  for (const restaurantId of restaurantIds) {
    await applyForRestaurant(restaurantId, dryRun);
  }

  console.log("\nAll restaurants processed.");
}

main()
  .catch((err) => {
    console.error("Apply failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
