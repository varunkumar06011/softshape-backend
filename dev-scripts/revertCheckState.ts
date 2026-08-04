// Read-only: query current state of beer inventory items and soft-deleted menu items
// to plan the revert. No writes.
import prisma from '../src/lib/prisma';

async function main() {
  const restaurantId = 'cmqy60ci200027dscyj9ubg8h';

  // 1. All current beer inventory items (the NEW ones I created)
  console.log('=== Current beer inventory items (created by merge/fix scripts) ===\n');
  const currentInv = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { name: true, isAvailable: true, isDeleted: true } } },
  });
  for (const inv of currentInv) {
    const name = inv.menuItem?.name || '?';
    if (!name.toLowerCase().includes('beer') && !name.toLowerCase().includes('karjura') && !name.toLowerCase().includes('kalyani')) continue;
    console.log(`  invId=${inv.id}  menuItem="${name}" (id=${inv.menuItemId})`);
    console.log(`    unitOfMeasure=${inv.unitOfMeasure}  bottleSize=${inv.bottleSize}  openingStock=${inv.openingStock}  currentStock=${inv.currentStock}  reorderLevel=${inv.reorderLevel}  costPerBottle=${inv.costPerBottle}  lastRestocked=${inv.lastRestocked}`);
    console.log(`    menuItem isAvailable=${inv.menuItem?.isAvailable}  isDeleted=${inv.menuItem?.isDeleted}`);
  }

  // 2. Soft-deleted beer menu items (the SOURCE ones I deactivated)
  console.log('\n=== Soft-deleted beer menu items (need to restore) ===\n');
  const softDeleted = await prisma.menuItem.findMany({
    where: { restaurantId, isDeleted: true, menuType: 'LIQUOR' },
    select: { id: true, name: true, isAvailable: true, isDeleted: true, deletedAt: true },
  });
  for (const m of softDeleted) {
    console.log(`  id=${m.id}  name="${m.name}"  isAvailable=${m.isAvailable}  deletedAt=${m.deletedAt}`);
  }

  // 3. Check if original inventory IDs still exist or are gone
  console.log('\n=== Original inventory IDs (should be deleted) ===\n');
  const originalInvIds = [
    'cmrdzuq9400054hycr6qqup1w',
    'cmrdzus0j000d4hycn3xbjpim',
    'cmrdzuswt000h4hyc4z2ux0wt',
    'cmrdzuqot00074hyckgcm1pn4',
    'cmrdzutck000j4hycngf8eiwb',
    'cmrdzutse000l4hychid7mh72',
    'cmrdzur4p00094hycyf1rjil4',
    'cmrdzurkj000b4hyc0eyic0z2',
    'cmrdzupdg00014hycr2uyhfai',
    'cmrdzuptd00034hyce7vy1jof',
    'cmrdzuu81000n4hycpwt9qubz',
    'cmrdzusgq000f4hycxdegklrb',
  ];
  for (const id of originalInvIds) {
    const inv = await prisma.inventoryItem.findUnique({ where: { id }, select: { id: true } });
    console.log(`  ${id}: ${inv ? 'STILL EXISTS' : 'deleted (good - will recreate)'}`);
  }

  // 4. Check for ADJUSTMENT transactions created by merge/fix scripts
  console.log('\n=== ADJUSTMENT transactions on new inventory items ===\n');
  const newInvIds = currentInv
    .filter((i) => (i.menuItem?.name || '').toLowerCase().includes('beer') || (i.menuItem?.name || '').toLowerCase().includes('karjura') || (i.menuItem?.name || '').toLowerCase().includes('kalyani'))
    .map((i) => i.id);
  for (const invId of newInvIds) {
    const txns = await prisma.inventoryTransaction.findMany({
      where: { itemId: invId, type: 'ADJUSTMENT' },
      select: { id: true, notes: true, transactionDate: true },
    });
    if (txns.length > 0) {
      console.log(`  invId=${invId}: ${txns.length} ADJUSTMENT txn(s)`);
      for (const t of txns) console.log(`    txnId=${t.id}  notes="${t.notes}"  date=${t.transactionDate}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
