// Check if Vgrand Lounge has kitchen recipes
import prisma from '../src/lib/prisma';
async function main() {
  const rId = 'cmqy60ci200027dscyj9ubg8h';
  const recipes = await prisma.menuItemRecipe.findMany({
    where: { restaurantId: rId },
    include: { menuItem: true, ingredient: true },
    take: 5,
  });
  console.log(`Vgrand Lounge (${rId}): ${recipes.length} recipes found (showing first 5)`);
  for (const r of recipes) {
    console.log(`  ${r.menuItem.name} → ${r.ingredient.name}: ${r.quantity} ${r.ingredient.unit}`);
  }
  // Also check food menu items with recipes
  const foodWithRecipes = await prisma.menuItem.findFirst({
    where: { restaurantId: rId, menuType: 'FOOD', isDeleted: false },
    include: { recipes: { include: { ingredient: true } } },
  });
  if (foodWithRecipes && foodWithRecipes.recipes.length > 0) {
    console.log(`\nFood item with recipes: ${foodWithRecipes.name}`);
    console.log(`  Recipes: ${foodWithRecipes.recipes.map(r => `${r.ingredient.name}: ${r.quantity} ${r.ingredient.unit}`).join(', ')}`);
  } else {
    console.log(`\nNo food item with recipes found`);
  }
  await prisma.$disconnect();
}
main();
