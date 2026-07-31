// FIX: Correct the Karjura/Kalyani inventory mixup from the merge script.
// The merge script used Kalyani Beer's inventory ID (cmrdzuu81000n4hycpwt9qubz) instead of
// Karjura Beer's actual inventory ID. This script:
// 1. Finds Karjura Beer's actual source inventory (menu item dff26512, should still exist)
// 2. Fixes the Karjura target's stock (15600 -> 16250)
// 3. Recreates Kalyani Beer's inventory (15600ml, was wrongly deleted)
// 4. Deletes Karjura's actual source inventory
//
// Usage: npx tsx dev-scripts/fixKarjuraKalyaniMixup.ts [restaurantId]

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\n=== Fixing Karjura/Kalyani inventory mixup ===\n`);

  // 1. Check current state
  // Karjura source menu item: dff26512 (was soft-deleted, its inventory should still exist)
  const karjuraSourceInv = await prisma.inventoryItem.findUnique({
    where: { menuItemId: 'dff26512-f61b-411b-a9d8-ec2643557005' },
  });
  console.log(`Karjura source inventory (menuItem dff26512): ${karjuraSourceInv ? `EXISTS id=${karjuraSourceInv.id} stock=${karjuraSourceInv.currentStock}` : 'NOT FOUND (already deleted?)'}`);

  // Karjura target: 2406b890 (got 15600ml, should be 16250ml)
  const karjuraTargetInv = await prisma.inventoryItem.findUnique({
    where: { menuItemId: '2406b890-54e8-4167-83d7-6f6616285066' },
  });
  console.log(`Karjura target inventory (menuItem 2406b890): ${karjuraTargetInv ? `EXISTS id=${karjuraTargetInv.id} stock=${karjuraTargetInv.currentStock}` : 'NOT FOUND'}`);

  // Kalyani source menu item: e4fc31f4 (its inventory cmrdzuu81000n4hycpwt9qubz was wrongly deleted)
  const kalyaniInv = await prisma.inventoryItem.findUnique({
    where: { menuItemId: 'e4fc31f4-c96c-4e49-8799-830d74cc3b52' },
  });
  console.log(`Kalyani inventory (menuItem e4fc31f4): ${kalyaniInv ? `EXISTS id=${kalyaniInv.id} stock=${kalyaniInv.currentStock}` : 'NOT FOUND (was wrongly deleted)'}`);

  if (!karjuraSourceInv) {
    console.log('\n!! Karjura source inventory not found. Cannot determine correct stock. Aborting.');
    return;
  }

  const correctKarjuraStock = Number(karjuraSourceInv.currentStock);
  const correctKarjuraOpening = Number(karjuraSourceInv.openingStock);
  console.log(`\nCorrect Karjura stock: ${correctKarjuraStock}ml (opening: ${correctKarjuraOpening}ml)`);

  const result = await prisma.$transaction(async (tx: any) => {
    const log: string[] = [];

    // 2. Fix Karjura target stock: update from 15600 to correct value
    if (karjuraTargetInv) {
      const updated = await tx.inventoryItem.update({
        where: { id: karjuraTargetInv.id },
        data: {
          currentStock: new Prisma.Decimal(correctKarjuraStock),
          openingStock: new Prisma.Decimal(correctKarjuraOpening),
        },
      });
      log.push(`  FIXED: Karjura target ${karjuraTargetInv.id} stock ${karjuraTargetInv.currentStock} -> ${updated.currentStock}ml`);
    }

    // 3. Recreate Kalyani Beer's inventory (was wrongly deleted)
    if (!kalyaniInv) {
      // Use the same values that Kalyani had before (from the dry-run: 15600ml, bottleSize=650)
      const newKalyani = await tx.inventoryItem.create({
        data: {
          menuItemId: 'e4fc31f4-c96c-4e49-8799-830d74cc3b52',
          restaurantId,
          unitOfMeasure: 'ML',
          bottleSize: 650,
          openingStock: new Prisma.Decimal(15600),
          currentStock: new Prisma.Decimal(15600),
          reorderLevel: new Prisma.Decimal(0),
          costPerBottle: null,
          lastRestocked: new Date(),
        },
      });
      log.push(`  RESTORED: Kalyani Beer inventory -> new inv ${newKalyani.id} stock=15600ml`);

      await tx.inventoryTransaction.create({
        data: {
          restaurantId,
          itemId: newKalyani.id,
          type: 'ADJUSTMENT',
          quantityChange: new Prisma.Decimal(15600),
          stockBefore: new Prisma.Decimal(0),
          stockAfter: new Prisma.Decimal(15600),
          notes: 'Restored after accidental deletion during beer merge fix',
          transactionDate: new Date(),
          createdBy: 'System',
        },
      });
    }

    // 4. Delete Karjura's actual source inventory (the one that should have been deleted)
    await tx.inventoryItem.delete({
      where: { id: karjuraSourceInv.id },
    });
    log.push(`  DELETED: Karjura source inventory ${karjuraSourceInv.id} (stock was ${correctKarjuraStock}ml)`);

    return { log };
  }, { timeout: 30000, maxWait: 40000 });

  console.log(`\nFix applied:`);
  for (const line of result.log) console.log(line);

  // Verify
  console.log('\n--- Verification ---');
  const karjuraTargetAfter = await prisma.inventoryItem.findUnique({
    where: { menuItemId: '2406b890-54e8-4167-83d7-6f6616285066' },
  });
  console.log(`Karjura target stock: ${karjuraTargetAfter?.currentStock}ml (should be ${correctKarjuraStock}ml)`);

  const kalyaniAfter = await prisma.inventoryItem.findUnique({
    where: { menuItemId: 'e4fc31f4-c96c-4e49-8799-830d74cc3b52' },
  });
  console.log(`Kalyani inventory: ${kalyaniAfter ? `EXISTS stock=${kalyaniAfter.currentStock}ml` : 'MISSING'}`);

  const karjuraSourceAfter = await prisma.inventoryItem.findUnique({
    where: { menuItemId: 'dff26512-f61b-411b-a9d8-ec2643557005' },
  });
  console.log(`Karjura source inventory: ${karjuraSourceAfter ? 'STILL EXISTS (bad)' : 'DELETED (good)'}`);

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
