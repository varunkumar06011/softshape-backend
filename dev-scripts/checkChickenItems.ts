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
    include: { variants: true, category: { select: { name: true } }, recipes: { include: { ingredient: true } } },
  });
  if (existing) {
    console.log(`Existing "Chicken Fry" item: ${existing.id} | ${existing.name} | menuType=${existing.menuType} | category=${existing.category?.name} | printerTarget=${existing.printerTarget}`);
    console.log(`  Recipes:`);
    for (const r of existing.recipes) {
      console.log(`    ${r.ingredient.name} — ${r.quantity} ${r.ingredient.unit}`);
    }
  }

  // 2. Check other chicken items with recipes
  const chickenItems = await prisma.menuItem.findMany({
    where: {
      restaurantId: outletId,
      name: { contains: 'chicken', mode: 'insensitive' },
      isDeleted: false,
    },
    include: { recipes: { include: { ingredient: true } }, category: { select: { name: true } } },
  });
  console.log(`\nAll chicken items (${chickenItems.length}):`);
  for (const item of chickenItems) {
    console.log(`  ${item.name} | menuType=${item.menuType} | category=${item.category?.name} | printerTarget=${item.printerTarget}`);
    if (item.recipes.length > 0) {
      for (const r of item.recipes) {
        console.log(`    → ${r.ingredient.name} — ${r.quantity} ${r.ingredient.unit}`);
      }
    }
  }

  // 3. List kitchen inventory items (chicken-related)
  const kitchenItems = await prisma.kitchenInventoryItem.findMany({
    where: {
      restaurantId: outletId,
      name: { contains: 'chicken', mode: 'insensitive' },
    },
  });
  console.log(`\nKitchen inventory items (chicken-related): ${kitchenItems.length}`);
  for (const k of kitchenItems) {
    console.log(`  ${k.id} | ${k.name} | unit=${k.unit} | stock=${k.currentStock} | category=${k.category}`);
  }

  // 4. List all kitchen inventory items
  const allKitchen = await prisma.kitchenInventoryItem.findMany({
    where: { restaurantId: outletId },
    orderBy: { name: 'asc' },
  });
  console.log(`\nAll kitchen inventory items (${allKitchen.length}):`);
  for (const k of allKitchen) {
    console.log(`  ${k.id} | ${k.name} | unit=${k.unit} | stock=${k.currentStock} | category=${k.category}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
