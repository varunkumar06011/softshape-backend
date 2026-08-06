/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // List all outlets
  const outlets = await prisma.outlet.findMany({
    select: { id: true, name: true, restaurantType: true },
  });
  console.log('All outlets:');
  for (const o of outlets) {
    console.log(`  ${o.id} | ${o.name} | type=${o.restaurantType}`);
  }

  // Find "Family Restaurant" outlet
  const familyOutlet = outlets.find(o => o.name.toLowerCase().includes('family'));
  if (!familyOutlet) {
    console.log('\n⚠ No "Family Restaurant" outlet found');
    return;
  }

  console.log(`\nFamily Restaurant outlet: ${familyOutlet.id}`);

  // List venues for this outlet
  const venues = await prisma.venue.findMany({
    where: { restaurantId: familyOutlet.id, isDeleted: false },
    select: { id: true, name: true, priceProfileId: true },
  });
  console.log(`\nVenues (${venues.length}):`);
  for (const v of venues) {
    console.log(`  ${v.id} | ${v.name} | pp=${v.priceProfileId}`);
  }

  // Check if "Green Salad" already exists
  const existing = await prisma.menuItem.findFirst({
    where: {
      restaurantId: familyOutlet.id,
      name: { equals: 'Green salad', mode: 'insensitive' },
      isDeleted: false,
    },
    include: { category: { select: { name: true, printerTarget: true } }, recipes: { include: { ingredient: true } } },
  });
  if (existing) {
    console.log(`\nExisting "Green Salad": ${existing.id} | menuType=${existing.menuType} | category=${existing.category?.name} | printerTarget=${existing.printerTarget}`);
    console.log(`  Recipes (${existing.recipes.length}):`);
    for (const r of existing.recipes) {
      console.log(`    ${r.ingredient.name} — ${r.quantity} ${r.ingredient.unit}`);
    }
  } else {
    console.log('\nNo existing "Green Salad" item found.');
  }

  // Check for similar salad items with recipes
  const saladItems = await prisma.menuItem.findMany({
    where: {
      restaurantId: familyOutlet.id,
      name: { contains: 'salad', mode: 'insensitive' },
      isDeleted: false,
      recipes: { some: {} },
    },
    include: { recipes: { include: { ingredient: true } }, category: { select: { name: true, printerTarget: true } } },
  });
  console.log(`\nSalad items WITH recipes (${saladItems.length}):`);
  for (const item of saladItems) {
    console.log(`  ${item.name} | category=${item.category?.name} | printerTarget=${item.printerTarget}`);
    for (const r of item.recipes) {
      console.log(`    → ${r.ingredient.name} — ${r.quantity} ${r.ingredient.unit}`);
    }
  }

  // Check kitchen inventory items (salad/vegetable related)
  const vegItems = await prisma.kitchenInventoryItem.findMany({
    where: {
      restaurantId: familyOutlet.id,
      OR: [
        { name: { contains: 'onion', mode: 'insensitive' } },
        { name: { contains: 'tomato', mode: 'insensitive' } },
        { name: { contains: 'cucumber', mode: 'insensitive' } },
        { name: { contains: 'carrot', mode: 'insensitive' } },
        { name: { contains: 'lemon', mode: 'insensitive' } },
        { name: { contains: 'coriander', mode: 'insensitive' } },
        { name: { contains: 'curry', mode: 'insensitive' } },
        { name: { contains: 'green chilli', mode: 'insensitive' } },
        { name: { contains: 'salt', mode: 'insensitive' } },
        { name: { contains: 'oil', mode: 'insensitive' } },
        { name: { contains: 'cabbage', mode: 'insensitive' } },
        { name: { contains: 'capsicum', mode: 'insensitive' } },
        { name: { contains: 'spinach', mode: 'insensitive' } },
      ],
    },
  });
  console.log(`\nRelevant kitchen inventory items (${vegItems.length}):`);
  for (const k of vegItems) {
    console.log(`  ${k.id} | ${k.name} | unit=${k.unit} | stock=${k.currentStock}`);
  }

  // Check categories
  const categories = await prisma.category.findMany({
    where: { restaurantId: familyOutlet.id },
    select: { id: true, name: true, printerTarget: true },
  });
  console.log(`\nCategories (${categories.length}):`);
  for (const c of categories) {
    console.log(`  ${c.id} | ${c.name} | printerTarget=${c.printerTarget}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
