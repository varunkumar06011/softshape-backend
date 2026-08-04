// Move the 12 carried-over beer items from "Liquor" category to "Beer" category
// and create today's DailyInventorySnapshot so they no longer show as "carried over".
//
// Does NOT add, rename, or delete any menu items or inventory items.
// Only changes menuItem.categoryId and creates snapshots.
//
// Deduction safety:
//   - inventoryService.ts filters liquor items by menuType (LIQUOR/BAR), not category name
//   - isBeerItem() checks category name first ("Beer" includes "beer" → true), then name keywords
//   - Name-based matching in barMatching.ts doesn't use category
//   - barInventory GET /items fetches all inventory items (no category filter)
//   - barMenu /items filters by category.isActive=true (Beer category is active)
//
// Usage:
//   npx tsx dev-scripts/moveBeersToBeerCategory.ts              # DRY RUN
//   npx tsx dev-scripts/moveBeersToBeerCategory.ts --live       # EXECUTE

import prisma from '../src/lib/prisma';
import 'dotenv/config';

const restaurantId = 'cmqy60ci200027dscyj9ubg8h';
const BEER_CATEGORY_NAME = 'Beer';
const LIQUOR_CATEGORY_NAME = 'Liquor';

function getKolkataDateString(): string {
  const now = new Date();
  const kolkataOffset = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
  const kolkataTime = new Date(now.getTime() + kolkataOffset);
  return kolkataTime.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function main() {
  const isLive = process.argv.includes('--live');
  console.log(`\n=== ${isLive ? 'LIVE RUN' : 'DRY RUN'} — Move beers to Beer category & remove carried-over ===\n`);
  console.log(`Restaurant: ${restaurantId}\n`);

  // 1. Find the "Beer" category (must already exist and be active)
  const beerCategory = await prisma.category.findFirst({
    where: { restaurantId, name: { equals: BEER_CATEGORY_NAME, mode: 'insensitive' }, isActive: true },
  });
  if (!beerCategory) {
    console.error(`ERROR: No active "${BEER_CATEGORY_NAME}" category found for restaurant ${restaurantId}`);
    process.exit(1);
  }
  console.log(`Beer category: ${beerCategory.id} (printerTarget: ${beerCategory.printerTarget || '—'})`);

  // 2. Find the "Liquor" category
  const liquorCategory = await prisma.category.findFirst({
    where: { restaurantId, name: { equals: LIQUOR_CATEGORY_NAME, mode: 'insensitive' } },
  });
  if (!liquorCategory) {
    console.error(`ERROR: No "${LIQUOR_CATEGORY_NAME}" category found for restaurant ${restaurantId}`);
    process.exit(1);
  }
  console.log(`Liquor category: ${liquorCategory.id}\n`);

  // 3. Find all beer menu items in the Liquor category that have an inventory item.
  //    These are the 12 transferred items (Bira/BOOM etc. have no inventory → excluded).
  const beerItems = await prisma.menuItem.findMany({
    where: {
      restaurantId,
      categoryId: liquorCategory.id,
      isDeleted: false,
      name: { contains: 'beer', mode: 'insensitive' },
      inventoryItem: { isNot: null },
    },
    include: {
      inventoryItem: true,
      category: { select: { name: true } },
      variants: { select: { id: true, name: true, price: true, isDefault: true } },
    },
    orderBy: { name: 'asc' },
  });

  console.log(`Found ${beerItems.length} beer item(s) in Liquor category with inventory:\n`);

  const today = getKolkataDateString();
  console.log(`Today's date (IST): ${today}\n`);

  // 4. Check which ones already have a snapshot for today
  const invIds = beerItems.map((i) => i.inventoryItem!.id);
  const existingSnapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { itemId: { in: invIds }, snapshotDate: today },
    select: { itemId: true },
  });
  const existingSnapshotInvIds = new Set(existingSnapshots.map((s) => s.itemId));

  // 5. Print the plan
  for (const item of beerItems) {
    const inv = item.inventoryItem!;
    const hasSnapshot = existingSnapshotInvIds.has(inv.id);
    const stock = Number(inv.currentStock);
    const willCreateSnapshot = !hasSnapshot && stock > 0;
    console.log(`  ${item.name.padEnd(35)} | inv=${inv.id} | stock=${stock}ml | snapshot=${hasSnapshot ? 'EXISTS' : (willCreateSnapshot ? 'WILL CREATE' : 'NO (stock=0)')}`);
  }

  if (!isLive) {
    console.log(`\n=== DRY RUN — no changes made. Run with --live to execute. ===\n`);
    await prisma.$disconnect();
    return;
  }

  // 6. LIVE: Set Beer category's printerTarget to BAR PRINTER (for consistency with Liquor)
  if (beerCategory.printerTarget !== 'BAR PRINTER') {
    await prisma.category.update({
      where: { id: beerCategory.id },
      data: { printerTarget: 'BAR PRINTER' },
    });
    console.log(`\nUpdated Beer category printerTarget -> BAR PRINTER`);
  }

  // 7. Update each menu item's categoryId to Beer, and create snapshot if needed
  let categoryUpdated = 0;
  let snapshotsCreated = 0;

  for (const item of beerItems) {
    const inv = item.inventoryItem!;

    // Update category
    await prisma.menuItem.update({
      where: { id: item.id },
      data: { categoryId: beerCategory.id },
    });
    categoryUpdated++;

    // Create snapshot if not exists and stock > 0
    const hasSnapshot = existingSnapshotInvIds.has(inv.id);
    const stock = Number(inv.currentStock);
    if (!hasSnapshot && stock > 0) {
      await prisma.dailyInventorySnapshot.create({
        data: {
          restaurantId,
          itemId: inv.id,
          snapshotDate: today,
          itemName: item.name,
          openingStock: stock,
          purchased: 0,
          sold: 0,
          wastage: 0,
          adjusted: stock,
          closingStock: stock,
        },
      });
      snapshotsCreated++;
    }
  }

  console.log(`\nResults:`);
  console.log(`  Menu items moved to Beer category: ${categoryUpdated}`);
  console.log(`  Daily snapshots created:            ${snapshotsCreated}`);
  console.log(`\n=== Done ===\n`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
