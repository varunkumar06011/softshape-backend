import prisma from "../src/lib/prisma";
import {
  CHICKEN_BIRYANI_ITEMS,
  EGG_BIRYANI_ITEMS,
  FISH_BIRYANI_ITEMS,
  MUTTON_BIRYANI_ITEMS,
  PRAWNS_BIRYANI_ITEMS,
  isChickenBiryani,
} from "../src/services/recipeEngine";

const RESTAURANTS = [
  { id: "cmqy60ci200027dscyj9ubg8h", name: "Vgrand Lounge" },
  { id: "cmr03m0fa00015ot8jh16grhn", name: "Vgrand Family Restaurant" },
];

const BAR_CATEGORIES = ["liquor", "cocktails & mocktails"];
const EXCLUDED_BIRYANI_ITEMS = new Set([
  ...CHICKEN_BIRYANI_ITEMS,
  ...EGG_BIRYANI_ITEMS,
  ...MUTTON_BIRYANI_ITEMS,
  ...PRAWNS_BIRYANI_ITEMS,
  ...FISH_BIRYANI_ITEMS,
].map((n) => n.toLowerCase()));

function isBarCategory(cat: string): boolean {
  return BAR_CATEGORIES.some((b) => cat.toLowerCase().includes(b));
}

function shouldSkip(name: string, category: string, isVeg: boolean): boolean {
  if (isBarCategory(category)) return true;
  if (EXCLUDED_BIRYANI_ITEMS.has(name.toLowerCase())) return true;
  if (isChickenBiryani(name, category, isVeg)) return true;
  return false;
}

async function verify(restaurantId: string, label: string) {
  console.log(`\n=== ${label} ===`);
  const items = await prisma.menuItem.findMany({
    where: { restaurantId, isDeleted: false, menuType: "FOOD" },
    include: { category: true, recipes: { include: { ingredient: true } } },
  });

  let totalFood = 0;
  let withRecipes = 0;
  let withoutRecipes = 0;
  let skippedBiryani = 0;
  let skippedBar = 0;
  const missing: string[] = [];

  for (const item of items) {
    const cat = item.category?.name ?? "";
    totalFood++;
    if (isBarCategory(cat)) { skippedBar++; continue; }
    if (shouldSkip(item.name, cat, item.isVeg)) { skippedBiryani++; continue; }
    if (item.recipes.length > 0) withRecipes++;
    else {
      withoutRecipes++;
      missing.push(`${item.name} (${cat})`);
    }
  }

  console.log(`Total FOOD: ${totalFood}`);
  console.log(`Bar items skipped: ${skippedBar}`);
  console.log(`Biryani items skipped: ${skippedBiryani}`);
  console.log(`Non-biryani FOOD items processed: ${withRecipes + withoutRecipes}`);
  console.log(`With recipes: ${withRecipes}`);
  console.log(`Without recipes: ${withoutRecipes}`);
  if (missing.length > 0) {
    console.log(`\nStill missing recipes (${missing.length}):`);
    missing.forEach((m) => console.log(`  - ${m}`));
  }
}

async function main() {
  for (const r of RESTAURANTS) await verify(r.id, r.name);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); });
