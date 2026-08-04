// REVERT: Undo all changes made by mergeDuplicateBeers.ts and fixKarjuraKalyaniMixup.ts.
// Restores the original state:
//   1. Delete the 13 new inventory items created by merge/fix scripts
//   2. Delete the 12 ADJUSTMENT transactions created by merge/fix scripts
//   3. Recreate the 12 original inventory items with their original IDs and stock values
//   4. Restore the 11 soft-deleted source menu items (isAvailable=true, isDeleted=false, deletedAt=null)
//
// Usage: npx tsx dev-scripts/revertBeerMerge.ts [restaurantId]

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\n=== REVERTING beer merge for ${restaurantId} ===\n`);

  // ── Step 1: Read values from new inventory items (created by merge script) ──
  // These have the original stock values copied from the source items.
  const newInvItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { name: true } } },
  });

  // Filter to only beer-related items created by my scripts (IDs start with 'cms8')
  const myNewInvItems = newInvItems.filter((i) => i.id.startsWith('cms8'));
  console.log(`New inventory items to delete: ${myNewInvItems.length}`);

  // Build a map of new inv ID -> values (for recreating originals)
  const newInvMap = new Map<string, any>();
  for (const inv of myNewInvItems) {
    newInvMap.set(inv.id, inv);
  }

  // ── Step 2: Define what to recreate and what to delete ──

  // New inventory IDs to delete (13 total)
  const newInvIdsToDelete = myNewInvItems.map((i) => i.id);

  // Original inventory items to recreate (12 total)
  // For items 1-10, values are read from the corresponding new items.
  // For Kalyani and Karjura, values are reconstructed from known data.
  interface OriginalInv {
    id: string;
    menuItemId: string;
    unitOfMeasure: string;
    bottleSize: number;
    openingStock: number;
    currentStock: number;
    reorderLevel: number;
    costPerBottle: number | null;
    lastRestocked: Date;
  }

  // Map: new inv ID -> original inv to recreate
  // (the new item was created from the original's values)
  const recreatePairs: Array<{ newInvId: string; original: OriginalInv }> = [
    { newInvId: 'cms8pkw3g00021083a8hjg7nx', original: { id: 'cmrdzuq9400054hycr6qqup1w', menuItemId: '0d170caf-aea5-4a0a-b1ba-c8f48235cca1', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 42250, reorderLevel: 0, costPerBottle: 270, lastRestocked: new Date('2026-07-10T02:33:33+05:30') } },
    { newInvId: 'cms8pkx7600061083yl450gfl', original: { id: 'cmrdzus0j000d4hycn3xbjpim', menuItemId: '6cb5331c-0d1f-4b13-a666-add0419bbdbe', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 118300, reorderLevel: 0, costPerBottle: 200, lastRestocked: new Date('2026-07-10T02:33:36+05:30') } },
    { newInvId: 'cms8pkyuy000a1083u5hzqact', original: { id: 'cmrdzuswt000h4hyc4z2ux0wt', menuItemId: '972382dd-1d33-43e5-a847-9c291f69d69a', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 118950, reorderLevel: 0, costPerBottle: 220, lastRestocked: new Date('2026-07-10T02:33:37+05:30') } },
    { newInvId: 'cms8pkzoi000e10834acpsiji', original: { id: 'cmrdzuqot00074hyckgcm1pn4', menuItemId: 'fe914eb2-1727-4711-b6a3-0cc35601b796', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 34450, reorderLevel: 0, costPerBottle: 300, lastRestocked: new Date('2026-07-10T02:33:34+05:30') } },
    { newInvId: 'cms8pl172000i108355dk101q', original: { id: 'cmrdzutck000j4hycngf8eiwb', menuItemId: '01f59957-bdf3-4f5f-8845-cebe9c9bd72f', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 40300, reorderLevel: 0, costPerBottle: 180, lastRestocked: new Date('2026-07-10T02:33:37+05:30') } },
    { newInvId: 'cms8pl3km000m1083wmllvyy5', original: { id: 'cmrdzutse000l4hychid7mh72', menuItemId: 'e4e217bb-5e76-4bce-b6ee-908667cfa801', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 37050, reorderLevel: 0, costPerBottle: 220, lastRestocked: new Date('2026-07-10T02:33:38+05:30') } },
    { newInvId: 'cms8pl56m000q1083qb4mfgxo', original: { id: 'cmrdzur4p00094hycyf1rjil4', menuItemId: '0a0c7aaa-2a6a-44e3-9acf-c0ea690154ef', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 98800, reorderLevel: 0, costPerBottle: 220, lastRestocked: new Date('2026-07-10T02:33:34+05:30') } },
    { newInvId: 'cms8pl778000u10833vwfb6w4', original: { id: 'cmrdzurkj000b4hyc0eyic0z2', menuItemId: '89e3a288-9831-405f-acf2-8312bac8753b', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 13000, reorderLevel: 0, costPerBottle: 220, lastRestocked: new Date('2026-07-10T02:33:35+05:30') } },
    { newInvId: 'cms8pl93i000y1083362gyjd4', original: { id: 'cmrdzupdg00014hycr2uyhfai', menuItemId: 'c1b5992e-a90c-4647-8065-deba0d450f9c', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 650, reorderLevel: 0, costPerBottle: 200, lastRestocked: new Date('2026-07-10T02:33:32+05:30') } },
    { newInvId: 'cms8plaop00121083fxr4b5m2', original: { id: 'cmrdzuptd00034hyce7vy1jof', menuItemId: '66622b0b-db6b-4041-80cb-b8fd4300c920', unitOfMeasure: 'BOTTLE', bottleSize: 500, openingStock: 0, currentStock: 0, reorderLevel: 0, costPerBottle: 180, lastRestocked: new Date('2026-07-10T02:33:33+05:30') } },
    // Kalyani: values from the new Karjura target (which was copied from Kalyani by the merge script)
    { newInvId: 'cms8pmhpb0002d45deqcqj6rq', original: { id: 'cmrdzuu81000n4hycpwt9qubz', menuItemId: 'e4fc31f4-c96c-4e49-8799-830d74cc3b52', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 15600, reorderLevel: 0, costPerBottle: 180, lastRestocked: new Date('2026-07-10T02:33:38+05:30') } },
    // Karjura source: values reconstructed from first check run (openingStock=0, currentStock=16250, bottleSize=650)
    // costPerBottle=350 matches the empty variant price (following the pattern of all other beer items)
    { newInvId: 'cms8plbsa00161083ui5wouyy', original: { id: 'cmrdzusgq000f4hycxdegklrb', menuItemId: 'dff26512-f61b-411b-a9d8-ec2643557005', unitOfMeasure: 'BOTTLE', bottleSize: 650, openingStock: 0, currentStock: 16250, reorderLevel: 0, costPerBottle: 350, lastRestocked: new Date('2026-07-10T02:33:38+05:30') } },
  ];

  // The 13th new inv (cms8pld4v001a1083y1dx346g on b4b0f431) has no original to recreate
  // (b4b0f431 never had inventory before). Just delete it.

  // Menu items to restore (11 that I soft-deleted, identified by deletedAt on Jul 31)
  const menuItemsToRestore = [
    '0d170caf-aea5-4a0a-b1ba-c8f48235cca1', // Budwiser Beer
    '6cb5331c-0d1f-4b13-a666-add0419bbdbe', // Kf Strong Beer
    '972382dd-1d33-43e5-a847-9c291f69d69a', // Kf Ultra Beer
    'fe914eb2-1727-4711-b6a3-0cc35601b796', // Budwiser Magneum Beer
    '01f59957-bdf3-4f5f-8845-cebe9c9bd72f', // Kf Lite Beer
    'e4e217bb-5e76-4bce-b6ee-908667cfa801', // Kf Storm Beer
    '0a0c7aaa-2a6a-44e3-9acf-c0ea690154ef', // Stok Lite Beer
    '89e3a288-9831-405f-acf2-8312bac8753b', // Stok Storng Beer
    'c1b5992e-a90c-4647-8065-deba0d450f9c', // British Empire Strong Beer
    '66622b0b-db6b-4041-80cb-b8fd4300c920', // Budwiser Tin Beer
    'dff26512-f61b-411b-a9d8-ec2643557005', // Karjura Beer
  ];

  // ── Step 3: Execute revert in a transaction ──
  const result = await prisma.$transaction(async (tx: any) => {
    const log: string[] = [];

    // 3a. Delete ADJUSTMENT transactions created by merge/fix scripts
    const adjustmentTxns = await tx.inventoryTransaction.findMany({
      where: {
        itemId: { in: newInvIdsToDelete },
        type: 'ADJUSTMENT',
        notes: { contains: 'Stock transferred from duplicate menu item' },
      },
      select: { id: true },
    });
    const fixTxns = await tx.inventoryTransaction.findMany({
      where: {
        itemId: { in: newInvIdsToDelete },
        type: 'ADJUSTMENT',
        notes: { contains: 'Restored after accidental deletion' },
      },
      select: { id: true },
    });
    const allTxnsToDelete = [...adjustmentTxns, ...fixTxns];
    if (allTxnsToDelete.length > 0) {
      await tx.inventoryTransaction.deleteMany({
        where: { id: { in: allTxnsToDelete.map((t: any) => t.id) } },
      });
      log.push(`  Deleted ${allTxnsToDelete.length} ADJUSTMENT transactions`);
    }

    // 3b. Delete new inventory items
    for (const invId of newInvIdsToDelete) {
      const inv = newInvMap.get(invId);
      await tx.inventoryItem.delete({ where: { id: invId } });
      log.push(`  Deleted new inv ${invId} (was on "${inv?.menuItem?.name}")`);
    }

    // 3c. Recreate original inventory items with original IDs
    for (const { original } of recreatePairs) {
      // Check if it already exists (shouldn't, but safety check)
      const existing = await tx.inventoryItem.findUnique({ where: { id: original.id } });
      if (existing) {
        log.push(`  SKIP recreate: ${original.id} already exists`);
        continue;
      }

      await tx.inventoryItem.create({
        data: {
          id: original.id,
          menuItemId: original.menuItemId,
          restaurantId,
          unitOfMeasure: original.unitOfMeasure,
          bottleSize: original.bottleSize,
          openingStock: new Prisma.Decimal(original.openingStock),
          currentStock: new Prisma.Decimal(original.currentStock),
          reorderLevel: new Prisma.Decimal(original.reorderLevel),
          costPerBottle: original.costPerBottle !== null ? new Prisma.Decimal(original.costPerBottle) : null,
          lastRestocked: original.lastRestocked,
        },
      });
      log.push(`  Recreated inv ${original.id} on menuItem ${original.menuItemId}  stock=${original.currentStock}ml`);
    }

    // 3d. Restore soft-deleted menu items
    for (const menuItemId of menuItemsToRestore) {
      await tx.menuItem.update({
        where: { id: menuItemId },
        data: { isAvailable: true, isDeleted: false, deletedAt: null },
      });
      log.push(`  Restored menu item ${menuItemId}`);
    }

    return { log };
  }, { timeout: 30000, maxWait: 40000 });

  console.log(`\nRevert complete:`);
  for (const line of result.log) console.log(line);

  // ── Step 4: Verify ──
  console.log('\n--- Verification ---');

  // Check original inventory items exist
  let allOriginalsExist = true;
  for (const { original } of recreatePairs) {
    const inv = await prisma.inventoryItem.findUnique({
      where: { id: original.id },
      select: { currentStock: true, menuItem: { select: { name: true, isAvailable: true, isDeleted: true } } },
    });
    if (!inv) {
      console.log(`  !! MISSING: ${original.id}`);
      allOriginalsExist = false;
    } else {
      console.log(`  OK: ${original.id}  stock=${inv.currentStock}ml  menuItem="${inv.menuItem?.name}"  available=${inv.menuItem?.isAvailable}  deleted=${inv.menuItem?.isDeleted}`);
    }
  }

  // Check no new items remain
  const remainingNew = await prisma.inventoryItem.findMany({
    where: { id: { startsWith: 'cms8' } },
    select: { id: true },
  });
  console.log(`\n  Remaining 'cms8' inventory items: ${remainingNew.length} (should be 0)`);

  console.log('\n=== Revert Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
