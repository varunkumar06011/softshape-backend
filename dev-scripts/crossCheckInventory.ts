// Cross-check bar inventory: compare currentStock against the sum of all
// InventoryTransaction ledger entries for each item.
//
// This script identifies drift between the tracked ledger and the
// currentStock field on InventoryItem, which can happen if:
//   - Manual adjustments were made outside the ledger
//   - Settlements failed mid-transaction
//   - Purchases were recorded without updating stock
//
// Usage (from softshape-backend directory):
//   npx ts-node dev-scripts/crossCheckInventory.ts          -- dry run (report only)
//   npx ts-node dev-scripts/crossCheckInventory.ts --apply  -- fix currentStock to match ledger

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  const items = await prisma.inventoryItem.findMany({
    include: {
      menuItem: { select: { name: true } },
      transactions: {
        select: { quantityChange: true, type: true },
      },
    },
  });

  console.log(`\n=== Inventory Cross-Check (${items.length} items) ===\n`);
  console.log(`${APPLY ? '[APPLY MODE]' : '[DRY RUN]'}\n`);

  let mismatches = 0;
  let totalDrift = 0;

  for (const item of items) {
    const ledgerSum = item.transactions.reduce(
      (sum, t) => sum + Number(t.quantityChange),
      0
    );
    const currentStock = Number(item.currentStock);
    const drift = currentStock - ledgerSum;

    if (Math.abs(drift) > 0.01) {
      mismatches++;
      totalDrift += Math.abs(drift);
      console.log(
        `  MISMATCH: ${item.menuItem?.name ?? item.id}\n` +
        `    currentStock: ${currentStock}ml\n` +
        `    ledger sum:   ${ledgerSum}ml\n` +
        `    drift:        ${drift > 0 ? '+' : ''}${drift}ml\n` +
        `    transactions: ${item.transactions.length} entries\n`
      );

      if (APPLY) {
        await prisma.inventoryItem.update({
          where: { id: item.id },
          data: { currentStock: ledgerSum },
        });
        console.log(`    → FIXED: currentStock set to ${ledgerSum}ml\n`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Total items checked: ${items.length}`);
  console.log(`  Mismatches found:    ${mismatches}`);
  console.log(`  Total drift (ml):    ${totalDrift.toFixed(2)}`);
  if (APPLY && mismatches > 0) {
    console.log(`  Applied fixes:       ${mismatches}`);
  } else if (!APPLY && mismatches > 0) {
    console.log(`  Run with --apply to fix.`);
  } else {
    console.log(`  ✅ All inventory items match their ledger.`);
  }
}

main()
  .catch((err) => {
    console.error('Cross-check failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
