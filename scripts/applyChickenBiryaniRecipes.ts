import prisma from '../src/lib/prisma';
import { applyChickenBiryaniRecipes, isChickenBiryani } from '../src/services/recipeEngine';

async function main() {
  const args = process.argv.slice(2);
  const restaurantIdArg = args.find((a) => a.startsWith('--restaurantId='))?.split('=')[1];
  const dryRun = args.includes('--dry-run') || args.includes('-d');

  if (restaurantIdArg) {
    // Single restaurant mode
    if (dryRun) {
      console.log(`[DRY RUN] Previewing chicken biryani items for restaurant: ${restaurantIdArg}`);
      const items = await prisma.menuItem.findMany({
        where: { restaurantId: restaurantIdArg, isDeleted: false, menuType: 'FOOD' },
        include: { category: true },
        orderBy: { name: 'asc' },
      });
      const matched = items.filter((i) => isChickenBiryani(i.name, i.category?.name ?? '', i.isVeg));
      console.log(`\nMatched ${matched.length} item(s):`);
      matched.forEach((i) => console.log(`  - ${i.name} (${i.id})`));
      return;
    }

    console.log(`Applying chicken biryani recipes for restaurant: ${restaurantIdArg}`);
    const result = await applyChickenBiryaniRecipes(prisma, restaurantIdArg);
    console.log('\nResult:');
    console.log(JSON.stringify(result, null, 2));
  } else {
    // All restaurants mode
    const restaurants = await prisma.outlet.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    if (dryRun) {
      console.log(`[DRY RUN] Previewing chicken biryani items across ${restaurants.length} restaurant(s)...\n`);
      for (const restaurant of restaurants) {
        const items = await prisma.menuItem.findMany({
          where: { restaurantId: restaurant.id, isDeleted: false, menuType: 'FOOD' },
          include: { category: true },
          orderBy: { name: 'asc' },
        });
        const matched = items.filter((i) => isChickenBiryani(i.name, i.category?.name ?? '', i.isVeg));
        console.log(`→ ${restaurant.name} (${restaurant.id}) — ${matched.length} item(s)`);
        matched.forEach((i) => console.log(`    - ${i.name}`));
      }
      return;
    }

    console.log(`Found ${restaurants.length} restaurant(s). Applying chicken biryani recipes to each...\n`);

    const results = [];
    for (const restaurant of restaurants) {
      console.log(`→ ${restaurant.name} (${restaurant.id})`);
      try {
        const result = await applyChickenBiryaniRecipes(prisma, restaurant.id);
        results.push(result);
        console.log(`  Matched ${result.itemsMatched.length} item(s), generated ${result.recipesGenerated} recipe(s)`);
        if (result.warnings.length > 0) {
          console.log(`  Warnings: ${result.warnings.length}`);
          result.warnings.slice(0, 5).forEach((w) => console.log(`    - ${w}`));
          if (result.warnings.length > 5) console.log(`    ... and ${result.warnings.length - 5} more`);
        }
      } catch (err: any) {
        console.error(`  FAILED for ${restaurant.name}:`, err.message);
        results.push({ restaurantId: restaurant.id, error: err.message });
      }
    }

    console.log('\n\n=== Summary ===');
    console.log(`Total restaurants processed: ${results.length}`);
    const totalRecipes = results
      .filter((r: any) => !r.error)
      .reduce((sum: number, r: any) => sum + r.recipesGenerated, 0);
    console.log(`Total recipes generated: ${totalRecipes}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
