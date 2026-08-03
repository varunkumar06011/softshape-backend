/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';

  // 1. Check if "Chicken Fry B/L" already exists
  const existing = await prisma.menuItem.findFirst({
    where: {
      restaurantId: outletId,
      name: { contains: 'Chicken Fry', mode: 'insensitive' },
      isDeleted: false,
    },
    include: { recipes: { include: { ingredient: true } }, category: { select: { name: true } } },
  });
  if (existing) {
    console.log(`Existing: ${existing.name} | menuType=${existing.menuType} | category=${existing.category?.name} | printerTarget=${existing.printerTarget}`);
    console.log(`  Recipes (${existing.recipes.length}):`);
    for (const r of existing.recipes) {
      console.log(`    ${r.ingredient.name} — ${r.quantity} ${r.ingredient.unit} (id: ${r.ingredientId})`);
    }
  } else {
    console.log('No existing "Chicken Fry" item found.');
  }

  // 2. Find chicken items WITH recipes
  const chickenWithRecipes = await prisma.menuItem.findMany({
    where: {
      restaurantId: outletId,
      name: { contains: 'chicken', mode: 'insensitive' },
      isDeleted: false,
      recipes: { some: {} },
    },
    include: { recipes: { include: { ingredient: true } }, category: { select: { name: true } } },
  });
  console.log(`\nChicken items WITH recipes (${chickenWithRecipes.length}):`);
  for (const item of chickenWithRecipes) {
    console.log(`  ${item.name} | category=${item.category?.name} | printerTarget=${item.printerTarget}`);
    for (const r of item.recipes) {
      console.log(`    → ${r.ingredient.name} — ${r.quantity} ${r.ingredient.unit}`);
    }
  }

  // 3. Chicken-related kitchen inventory items
  const chickenKitchen = await prisma.kitchenInventoryItem.findMany({
    where: {
      restaurantId: outletId,
      name: { contains: 'chicken', mode: 'insensitive' },
    },
  });
  console.log(`\nChicken kitchen inventory items (${chickenKitchen.length}):`);
  for (const k of chickenKitchen) {
    console.log(`  ${k.id} | ${k.name} | unit=${k.unit} | stock=${k.currentStock}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
