// EXECUTE: Merge duplicate beer menu items.
// For each pair: create inventory on the TARGET (ordered) menu item with the SOURCE's stock,
// delete the SOURCE inventory item, and soft-delete the SOURCE menu item.
//
// Runs in a single transaction. Prints a summary. No backfill of old orders.
//
// Usage: npx tsx dev-scripts/mergeDuplicateBeers.ts [restaurantId]

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';

interface MergePair {
  sourceMenuItemId: string;
  sourceInventoryId: string;
  targetMenuItemId: string;
  note: string;
}

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\n=== Merging duplicate beers for ${restaurantId} ===\n`);

  // Pairs identified from dry-run. Source = has inventory (misspelled/dup, 0 orders).
  // Target = gets orders (correctly spelled, no inventory).
  const pairs: MergePair[] = [
    { sourceMenuItemId: '0d170caf-aea5-4a0a-b1ba-c8f48235cca1', sourceInventoryId: 'cmrdzuq9400054hycr6qqup1w', targetMenuItemId: 'ba7dca4a-e7ab-4179-9232-c650de93aee4', note: 'Budwiser Beer -> Budweiser Beer' },
    { sourceMenuItemId: '6cb5331c-0d1f-4b13-a666-add0419bbdbe', sourceInventoryId: 'cmrdzus0j000d4hycn3xbjpim', targetMenuItemId: '76f5fc88-d99d-48d2-891f-c8db585a6dcd', note: 'Kf Strong Beer (dup) -> Kf Strong Beer (ordered)' },
    { sourceMenuItemId: '972382dd-1d33-43e5-a847-9c291f69d69a', sourceInventoryId: 'cmrdzuswt000h4hyc4z2ux0wt', targetMenuItemId: '176c3096-cbeb-4281-ae31-9ca8c7f7856e', note: 'Kf Ultra Beer (dup) -> Kf Ultra Beer (ordered)' },
    { sourceMenuItemId: 'fe914eb2-1727-4711-b6a3-0cc35601b796', sourceInventoryId: 'cmrdzuqot00074hyckgcm1pn4', targetMenuItemId: '30532388-d0ed-44e5-8a18-bf7afbd1eb8d', note: 'Budwiser Magneum Beer -> Budweiser Magnum Beer' },
    { sourceMenuItemId: '01f59957-bdf3-4f5f-8845-cebe9c9bd72f', sourceInventoryId: 'cmrdzutck000j4hycngf8eiwb', targetMenuItemId: '3dce8873-d4ce-450d-a32e-61b69377d731', note: 'Kf Lite Beer (dup) -> Kf Lite Beer (ordered)' },
    { sourceMenuItemId: 'e4e217bb-5e76-4bce-b6ee-908667cfa801', sourceInventoryId: 'cmrdzutse000l4hychid7mh72', targetMenuItemId: 'faf0c07c-af6a-455d-a71a-3a62e819335c', note: 'Kf Storm Beer (dup) -> Kf Storm Beer (ordered)' },
    { sourceMenuItemId: '0a0c7aaa-2a6a-44e3-9acf-c0ea690154ef', sourceInventoryId: 'cmrdzur4p00094hycyf1rjil4', targetMenuItemId: '5f0de6aa-1b33-4f65-9d72-2c02d73c13b8', note: 'Stok Lite Beer (dup) -> Stok Lite Beer (ordered)' },
    { sourceMenuItemId: '89e3a288-9831-405f-acf2-8312bac8753b', sourceInventoryId: 'cmrdzurkj000b4hyc0eyic0z2', targetMenuItemId: 'fe67172b-4869-49ab-b253-b7a6a14bc126', note: 'Stok Storng Beer -> Stok Strong Beer' },
    { sourceMenuItemId: 'c1b5992e-a90c-4647-8065-deba0d450f9c', sourceInventoryId: 'cmrdzupdg00014hycr2uyhfai', targetMenuItemId: '5c5ee576-3f65-4211-8779-cb1d554d565b', note: 'British Empire Strong Beer (dup) -> British Empire Strong Beer (ordered)' },
    { sourceMenuItemId: '66622b0b-db6b-4041-80cb-b8fd4300c920', sourceInventoryId: 'cmrdzuptd00034hyce7vy1jof', targetMenuItemId: '6f8a9523-3306-41d8-9602-814bd54b58b5', note: 'Budwiser Tin Beer -> Budweiser Tin Beer' },
    // Karjura Beer: source has 3 orders + 16250ml. Target 2406b890 has 3 orders (most).
    // Also create 0-stock inventory on b4b0f431 (1 order).
    { sourceMenuItemId: 'dff26512-f61b-411b-a9d8-ec2643557005', sourceInventoryId: 'cmrdzuu81000n4hycpwt9qubz', targetMenuItemId: '2406b890-54e8-4167-83d7-6f6616285066', note: 'Karjura Beer (dup w/stock) -> Karjura Beer (3 orders)' },
  ];

  // Extra target that needs a 0-stock inventory (Karjura Beer with 1 order, no merge source)
  const extraZeroStockTargets: Array<{ menuItemId: string; note: string }> = [
    { menuItemId: 'b4b0f431-6221-460a-af4f-d9799bbbc8e0', note: 'Karjura Beer (1 order) — 0 stock inventory' },
  ];

  const result = await prisma.$transaction(async (tx: any) => {
    let created = 0;
    let deleted = 0;
    let deactivated = 0;
    const log: string[] = [];

    for (const pair of pairs) {
      // 1. Fetch the source inventory item (to copy its values)
      const sourceInv = await tx.inventoryItem.findUnique({
        where: { id: pair.sourceInventoryId },
      });
      if (!sourceInv) {
        log.push(`  SKIP: ${pair.note} — source inventory ${pair.sourceInventoryId} not found`);
        continue;
      }

      // 2. Check target doesn't already have an inventory item
      const existingTargetInv = await tx.inventoryItem.findUnique({
        where: { menuItemId: pair.targetMenuItemId },
      });
      if (existingTargetInv) {
        log.push(`  SKIP: ${pair.note} — target already has inventory ${existingTargetInv.id} (stock=${existingTargetInv.currentStock})`);
        continue;
      }

      // 3. Create inventory on the target, copying stock from source
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
      log.push(`  CREATE: ${pair.note} -> new inv ${newInv.id}  stock=${newInv.currentStock}ml  bottleSize=${newInv.bottleSize}`);

      // 4. Create an initial transaction record for the new inventory item
      await tx.inventoryTransaction.create({
        data: {
          restaurantId,
          itemId: newInv.id,
          type: 'ADJUSTMENT',
          quantityChange: sourceInv.openingStock,
          stockBefore: new Prisma.Decimal(0),
          stockAfter: sourceInv.openingStock,
          notes: `Stock transferred from duplicate menu item (merge)`,
          transactionDate: new Date(),
          createdBy: 'System',
        },
      });

      // 5. Delete the source inventory item
      await tx.inventoryItem.delete({
        where: { id: pair.sourceInventoryId },
      });
      deleted++;
      log.push(`  DELETE: source inventory ${pair.sourceInventoryId}`);

      // 6. Soft-delete the source menu item (preserve historical orders)
      const updated = await tx.menuItem.update({
        where: { id: pair.sourceMenuItemId },
        data: { isAvailable: false, isDeleted: true, deletedAt: new Date() },
      });
      deactivated++;
      log.push(`  SOFT-DELETE: menu item "${updated.name}" (id=${updated.id})`);
    }

    // Handle extra zero-stock targets
    for (const extra of extraZeroStockTargets) {
      const existing = await tx.inventoryItem.findUnique({
        where: { menuItemId: extra.menuItemId },
      });
      if (existing) {
        log.push(`  SKIP: ${extra.note} — already has inventory`);
        continue;
      }
      // Find a sibling inventory to copy bottleSize/unitOfMeasure from
      const sibling = await tx.inventoryItem.findFirst({
        where: { restaurantId, menuItem: { menuType: 'LIQUOR' } },
        include: { menuItem: { select: { name: true } } },
      });
      const newInv = await tx.inventoryItem.create({
        data: {
          menuItemId: extra.menuItemId,
          restaurantId,
          unitOfMeasure: sibling?.unitOfMeasure || 'ML',
          bottleSize: sibling?.bottleSize || 650,
          openingStock: new Prisma.Decimal(0),
          currentStock: new Prisma.Decimal(0),
          reorderLevel: new Prisma.Decimal(0),
          costPerBottle: null,
          lastRestocked: new Date(),
        },
      });
      created++;
      log.push(`  CREATE (0-stock): ${extra.note} -> new inv ${newInv.id}`);
    }

    return { created, deleted, deactivated, log };
  }, { timeout: 30000, maxWait: 40000 });

  console.log(`\nMerge complete:`);
  console.log(`  Inventory items created: ${result.created}`);
  console.log(`  Inventory items deleted: ${result.deleted}`);
  console.log(`  Menu items soft-deleted: ${result.deactivated}`);
  console.log(`\nDetails:`);
  for (const line of result.log) console.log(line);

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
