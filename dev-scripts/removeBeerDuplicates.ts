// Remove duplicate beer menu items restored by revertBeerMerge.ts.
//
// For each pair:
//   1. Read the SOURCE (Beer/dup) inventory item (stock, bottleSize, etc.)
//   2. If TARGET (Liquor/keep) has no inventory → create one with SOURCE's stock
//      If TARGET already has inventory → ADD SOURCE's stock to it
//   3. Delete the SOURCE inventory item
//   4. Soft-delete the SOURCE menu item (isAvailable=false, isDeleted=true)
//
// Also handles Kalyani Beer: transfer stock from soft-deleted e4fc31f4 to active d738151c.
//
// Usage:
//   npx tsx dev-scripts/removeBeerDuplicates.ts              # DRY RUN (no changes)
//   npx tsx dev-scripts/removeBeerDuplicates.ts --live       # EXECUTE for real

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';

const restaurantId = 'cmqy60ci200027dscyj9ubg8h';

interface Pair {
  sourceMenuItemId: string;
  targetMenuItemId: string;
  note: string;
}

const pairs: Pair[] = [
  { sourceMenuItemId: '0d170caf-aea5-4a0a-b1ba-c8f48235cca1', targetMenuItemId: 'ba7dca4a-e7ab-4179-9232-c650de93aee4', note: 'Budwiser Beer -> Budweiser Beer' },
  { sourceMenuItemId: '6cb5331c-0d1f-4b13-a666-add0419bbdbe', targetMenuItemId: '76f5fc88-d99d-48d2-891f-c8db585a6dcd', note: 'Kf Strong Beer (dup) -> Kf Strong Beer' },
  { sourceMenuItemId: '972382dd-1d33-43e5-a847-9c291f69d69a', targetMenuItemId: '176c3096-cbeb-4281-ae31-9ca8c7f7856e', note: 'Kf Ultra Beer (dup) -> Kf Ultra Beer' },
  { sourceMenuItemId: 'fe914eb2-1727-4711-b6a3-0cc35601b796', targetMenuItemId: '30532388-d0ed-44e5-8a18-bf7afbd1eb8d', note: 'Budwiser Magneum Beer -> Budweiser Magnum Beer' },
  { sourceMenuItemId: '01f59957-bdf3-4f5f-8845-cebe9c9bd72f', targetMenuItemId: '3dce8873-d4ce-450d-a32e-61b69377d731', note: 'Kf Lite Beer (dup) -> Kf Lite Beer' },
  { sourceMenuItemId: 'e4e217bb-5e76-4bce-b6ee-908667cfa801', targetMenuItemId: 'faf0c07c-af6a-455d-a71a-3a62e819335c', note: 'Kf Storm Beer (dup) -> Kf Storm Beer' },
  { sourceMenuItemId: '0a0c7aaa-2a6a-44e3-9acf-c0ea690154ef', targetMenuItemId: '5f0de6aa-1b33-4f65-9d72-2c02d73c13b8', note: 'Stok Lite Beer (dup) -> Stok Lite Beer' },
  { sourceMenuItemId: '89e3a288-9831-405f-acf2-8312bac8753b', targetMenuItemId: 'fe67172b-4869-49ab-b253-b7a6a14bc126', note: 'Stok Storng Beer -> Stok Strong Beer' },
  { sourceMenuItemId: 'c1b5992e-a90c-4647-8065-deba0d450f9c', targetMenuItemId: '5c5ee576-3f65-4211-8779-cb1d554d565b', note: 'British Empire Strong Beer (dup) -> British Empire Strong Beer' },
  { sourceMenuItemId: '66622b0b-db6b-4041-80cb-b8fd4300c920', targetMenuItemId: '6f8a9523-3306-41d8-9602-814bd54b58b5', note: 'Budwiser Tin Beer -> Budweiser Tin Beer' },
  { sourceMenuItemId: 'dff26512-f61b-411b-a9d8-ec2643557005', targetMenuItemId: '2406b890-54e8-4167-83d7-6f6616285066', note: 'Karjura Beer (dup w/stock) -> Karjura Beer' },
];

// Kalyani Beer: source is already soft-deleted but holds stock; transfer to active target
const kalyaniPair: Pair = {
  sourceMenuItemId: 'e4fc31f4-c96c-4e49-8799-830d74cc3b52',
  targetMenuItemId: 'd738151c-dfd5-49c9-a441-74023e71cb4d',
  note: 'Kalyani Beer (soft-deleted w/stock) -> Kalyani Beer (active)',
};

async function main() {
  const isLive = process.argv.includes('--live');
  console.log(`\n=== ${isLive ? 'LIVE RUN' : 'DRY RUN'} — Remove duplicate beer items ===\n`);
  console.log(`Restaurant: ${restaurantId}\n`);

  const allPairs = [...pairs, kalyaniPair];

  if (!isLive) {
    // Dry run: just show what would happen
    for (const pair of allPairs) {
      const sourceInv = await prisma.inventoryItem.findUnique({
        where: { menuItemId: pair.sourceMenuItemId },
      });
      const targetInv = await prisma.inventoryItem.findUnique({
        where: { menuItemId: pair.targetMenuItemId },
      });
      const sourceMenu = await prisma.menuItem.findUnique({
        where: { id: pair.sourceMenuItemId },
        select: { name: true, isDeleted: true, isAvailable: true },
      });
      const targetMenu = await prisma.menuItem.findUnique({
        where: { id: pair.targetMenuItemId },
        select: { name: true, isDeleted: true, isAvailable: true },
      });

      console.log(`Pair: ${pair.note}`);
      console.log(`  SOURCE: ${sourceMenu?.name || 'NOT FOUND'} (id=${pair.sourceMenuItemId}) isDeleted=${sourceMenu?.isDeleted} isAvailable=${sourceMenu?.isAvailable}`);
      console.log(`    inv: ${sourceInv ? `id=${sourceInv.id} stock=${sourceInv.currentStock}ml bottleSize=${sourceInv.bottleSize} costPerBottle=${sourceInv.costPerBottle}` : 'NONE'}`);
      console.log(`  TARGET: ${targetMenu?.name || 'NOT FOUND'} (id=${pair.targetMenuItemId}) isDeleted=${targetMenu?.isDeleted} isAvailable=${targetMenu?.isAvailable}`);
      console.log(`    inv: ${targetInv ? `id=${targetInv.id} stock=${targetInv.currentStock}ml` : 'NONE'}`);

      if (!sourceInv) {
        console.log(`  ACTION: SKIP — source has no inventory\n`);
        continue;
      }
      if (sourceMenu?.isDeleted && pair !== kalyaniPair) {
        console.log(`  ACTION: SKIP — source already soft-deleted (not an active duplicate)\n`);
        continue;
      }
      if (targetInv) {
        const newStock = Number(targetInv.currentStock) + Number(sourceInv.currentStock);
        console.log(`  ACTION: ADD stock ${sourceInv.currentStock}ml to target (current ${targetInv.currentStock}ml -> ${newStock}ml), delete source inv, soft-delete source menu item\n`);
      } else {
        console.log(`  ACTION: CREATE inv on target with stock=${sourceInv.currentStock}ml, delete source inv, soft-delete source menu item\n`);
      }
    }
    console.log('=== DRY RUN COMPLETE — no changes made. Run with --live to execute. ===\n');
    await prisma.$disconnect();
    return;
  }

  // LIVE RUN
  const result = await prisma.$transaction(async (tx: any) => {
    const log: string[] = [];
    let created = 0, updated = 0, deleted = 0, deactivated = 0;

    for (const pair of allPairs) {
      const sourceInv = await tx.inventoryItem.findUnique({
        where: { menuItemId: pair.sourceMenuItemId },
      });
      const sourceMenu = await tx.menuItem.findUnique({
        where: { id: pair.sourceMenuItemId },
        select: { name: true, isDeleted: true },
      });

      if (!sourceInv) {
        log.push(`SKIP: ${pair.note} — source has no inventory`);
        // Still soft-delete if it's an active duplicate
        if (sourceMenu && !sourceMenu.isDeleted && pair !== kalyaniPair) {
          await tx.menuItem.update({
            where: { id: pair.sourceMenuItemId },
            data: { isAvailable: false, isDeleted: true, deletedAt: new Date() },
          });
          deactivated++;
          log.push(`  SOFT-DELETE: "${sourceMenu.name}" (no inventory to transfer)`);
        }
        continue;
      }

      // Skip if source is already soft-deleted AND it's not the Kalyani case
      // (Kalyani source is soft-deleted but we still want to transfer its stock)
      if (sourceMenu?.isDeleted && pair !== kalyaniPair) {
        log.push(`SKIP: ${pair.note} — source already soft-deleted`);
        continue;
      }

      const targetInv = await tx.inventoryItem.findUnique({
        where: { menuItemId: pair.targetMenuItemId },
      });

      if (targetInv) {
        // Add source stock to existing target inventory
        const newStock = new Prisma.Decimal(Number(targetInv.currentStock) + Number(sourceInv.currentStock));
        await tx.inventoryItem.update({
          where: { id: targetInv.id },
          data: { currentStock: newStock },
        });
        updated++;
        log.push(`UPDATE: ${pair.note} — target inv ${targetInv.id} stock ${targetInv.currentStock}ml -> ${newStock}ml`);

        // Record the transfer
        await tx.inventoryTransaction.create({
          data: {
            restaurantId,
            itemId: targetInv.id,
            type: 'ADJUSTMENT',
            quantityChange: sourceInv.currentStock,
            stockBefore: targetInv.currentStock,
            stockAfter: newStock,
            notes: `Stock transferred from duplicate menu item "${sourceMenu?.name}" (removal)`,
            transactionDate: new Date(),
            createdBy: 'System',
          },
        });
      } else {
        // Create new inventory on target with source's values
        const newInv = await tx.inventoryItem.create({
          data: {
            menuItemId: pair.targetMenuItemId,
            restaurantId,
            unitOfMeasure: sourceInv.unitOfMeasure,
            bottleSize: sourceInv.bottleSize,
            openingStock: sourceInv.openingStock,
            currentStock: sourceInv.currentStock,
            reorderLevel: sourceInv.reorderLevel,
            costPerBottle: sourceInv.costPerBottle,
            lastRestocked: sourceInv.lastRestocked,
          },
        });
        created++;
        log.push(`CREATE: ${pair.note} -> new inv ${newInv.id} stock=${newInv.currentStock}ml`);

        await tx.inventoryTransaction.create({
          data: {
            restaurantId,
            itemId: newInv.id,
            type: 'ADJUSTMENT',
            quantityChange: sourceInv.openingStock,
            stockBefore: new Prisma.Decimal(0),
            stockAfter: sourceInv.openingStock,
            notes: `Stock transferred from duplicate menu item "${sourceMenu?.name}" (removal)`,
            transactionDate: new Date(),
            createdBy: 'System',
          },
        });
      }

      // Delete source inventory item
      await tx.inventoryItem.delete({ where: { id: sourceInv.id } });
      deleted++;
      log.push(`  DELETE: source inv ${sourceInv.id}`);

      // Soft-delete source menu item
      const updated_menu = await tx.menuItem.update({
        where: { id: pair.sourceMenuItemId },
        data: { isAvailable: false, isDeleted: true, deletedAt: new Date() },
      });
      deactivated++;
      log.push(`  SOFT-DELETE: menu item "${updated_menu.name}" (id=${updated_menu.id})`);
    }

    return { created, updated, deleted, deactivated, log };
  }, { timeout: 120000, maxWait: 150000 });

  console.log(`\nRemoval complete:`);
  console.log(`  Inventory items created: ${result.created}`);
  console.log(`  Inventory items updated: ${result.updated}`);
  console.log(`  Inventory items deleted: ${result.deleted}`);
  console.log(`  Menu items soft-deleted: ${result.deactivated}`);
  console.log(`\nDetails:`);
  for (const line of result.log) console.log(line);

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
