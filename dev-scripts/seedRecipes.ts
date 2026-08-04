import prisma from "../src/lib/prisma";
import { runAutoGenerate } from "../src/services/recipeEngine";

async function main() {
  const restaurantId = process.env.SEED_RESTAURANT_ID;
  if (!restaurantId) {
    throw new Error(
      "SEED_RESTAURANT_ID environment variable is required.\n" +
      "Usage: SEED_RESTAURANT_ID=your-restaurant-id ts-node dev-scripts/seedRecipes.ts",
    );
  }

  console.log(`\n=== Auto-Generating Recipes for Restaurant: ${restaurantId} ===\n`);

  const result = await runAutoGenerate(prisma, restaurantId);

  // Print summary counts
  console.log("\n--- Summary ---");
  console.log(`  Ingredients Created:       ${result.ingredientsCreated}`);
  console.log(`  Recipes Generated:         ${result.recipesGenerated}`);
  console.log(`  Items Skipped (existing):  ${result.itemsSkippedExistingRecipe}`);

  // Print detailed recipe table: item → ingredients with quantities
  console.log("\n--- Recipe Details ---");
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId, isDeleted: false, menuType: "FOOD" },
    include: {
      category: true,
      recipes: { include: { ingredient: true } },
    },
    orderBy: { name: "asc" },
  });

  for (const item of menuItems) {
    const cat = item.category?.name ?? "Unknown";
    if (item.recipes.length === 0) {
      console.log(`  ${item.name} (${cat}): [no recipe]`);
      continue;
    }
    const ingredients = item.recipes
      .map((r) => `${r.ingredient.name} ${r.quantity}${r.ingredient.unit}`)
      .join(", ");
    console.log(`  ${item.name} (${cat}): ${ingredients}`);
  }

  // Print full warnings list
  if (result.warnings.length > 0) {
    console.log(`\n--- Warnings (${result.warnings.length}) ---`);
    for (const w of result.warnings) {
      console.log(`  WARNING: ${w}`);
    }
  } else {
    console.log("\n--- No warnings ---");
  }

  // Exit logic: non-zero only on total failure (warnings AND zero recipes generated)
  if (result.warnings.length > 0 && result.recipesGenerated === 0) {
    console.error("\nTOTAL FAILURE: no recipes generated and warnings present.");
    process.exit(1);
  }

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
