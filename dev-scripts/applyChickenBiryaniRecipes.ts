import prisma from "../src/lib/prisma";
import {
  CHICKEN_BIRYANI_ITEMS,
  CHICKEN_BIRYANI_RECIPE,
  MASTER_INGREDIENTS,
  generateRecipe,
} from "../src/services/recipeEngine";

async function resolveKitchenRestaurantIdSafe(restaurantId: string): Promise<string> {
  try {
    const { resolveKitchenRestaurantId } = await import("../src/lib/tenantContext");
    return await resolveKitchenRestaurantId(restaurantId);
  } catch {
    return restaurantId;
  }
}

async function main() {
  const restaurantId = process.env.SEED_RESTAURANT_ID;
  if (!restaurantId) {
    throw new Error(
      "SEED_RESTAURANT_ID environment variable is required.\n" +
      "Usage: SEED_RESTAURANT_ID=your-restaurant-id DRY_RUN=true npx ts-node dev-scripts/applyChickenBiryaniRecipes.ts",
    );
  }

  const dryRun = process.env.DRY_RUN === "true";
  const curatedSet = new Set(CHICKEN_BIRYANI_ITEMS.map((n) => n.toLowerCase()));
  const kitchenRestaurantId = await resolveKitchenRestaurantIdSafe(restaurantId);

  console.log(`\n=== Curated Chicken Biryani Recipe Application ===`);
  console.log(`Restaurant ID: ${restaurantId}`);
  console.log(`Kitchen Restaurant ID: ${kitchenRestaurantId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}\n`);

  // 1. Upsert all master ingredients (so Biryani Masala gets created, etc.)
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

  // 2. Find menu items whose name is in the curated list
  const allMenuItems = await prisma.menuItem.findMany({
    where: { restaurantId, isDeleted: false, menuType: "FOOD" },
    include: { category: true },
    orderBy: { name: "asc" },
  });

  const matchedItems = allMenuItems.filter((item) =>
    curatedSet.has(item.name.toLowerCase()),
  );
  const matchedNames = new Set(matchedItems.map((i) => i.name.toLowerCase()));

  // 3. Print ✓/✗ checklist for the 18 curated names
  console.log("Curated name checklist:");
  for (const name of CHICKEN_BIRYANI_ITEMS) {
    const found = matchedNames.has(name.toLowerCase());
    console.log(`  ${found ? "✓" : "✗"} ${name}`);
  }
  console.log(`\nMatched ${matchedItems.length} of ${CHICKEN_BIRYANI_ITEMS.length} curated item(s).\n`);

  if (matchedItems.length === 0) {
    console.log("No curated chicken biryani items found. Nothing to do.");
    return;
  }

  // 4. Fetch inventory for validation
  const allInventory = await prisma.kitchenInventoryItem.findMany({
    where: { restaurantId: kitchenRestaurantId, name: { in: MASTER_INGREDIENTS.map((i) => i.name) } },
    select: { id: true, name: true, unit: true },
  });
  const inventoryByName = new Map(
    allInventory.map((i) => [i.name, { id: i.id, unit: i.unit }]),
  );

  // 5. Generate and (optionally) persist recipes for matched items only
  const recipesToCreate: { menuItemId: string; ingredientId: string; quantity: number }[] = [];
  const itemsWithValidRecipes = new Set<string>();
  const warnings: string[] = [];

  for (const item of matchedItems) {
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
      if (liveItem.unit !== line.unit) {
        warnings.push(`Unit mismatch for "${line.ingredientName}" on item "${item.name}": inventory uses "${liveItem.unit}", recipe expects "${line.unit}" — skipped.`);
        continue;
      }
      validLines.push({ ingredientId: liveItem.id, quantity: line.quantity });
      console.log(`  - ${line.ingredientName}: ${line.quantity}${line.unit}`);
    }

    if (validLines.length > 0) {
      itemsWithValidRecipes.add(item.id);
      for (const v of validLines) {
        recipesToCreate.push({ menuItemId: item.id, ingredientId: v.ingredientId, quantity: v.quantity });
      }
    }
  }

  if (!dryRun && itemsWithValidRecipes.size > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.menuItemRecipe.deleteMany({
        where: { restaurantId, menuItemId: { in: Array.from(itemsWithValidRecipes) } },
      });
      await tx.menuItemRecipe.createMany({
        data: recipesToCreate.map((r) => ({ ...r, restaurantId })),
      });
    });
  }

  console.log(`\n=== Summary ===`);
  console.log(`Items with valid recipes: ${itemsWithValidRecipes.size}`);
  console.log(`Recipe lines to create: ${recipesToCreate.length}`);
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

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error("Apply failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
