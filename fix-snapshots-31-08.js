// fix-snapshots-31-08.js
// Updates DailyInventorySnapshot records for 2026-08-31 to match the correct opening stock.
// Also creates missing snapshots for items with openingStock > 0 but no 31-08 snapshot.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const TARGET_DATE = '2026-08-31';

async function main() {
  console.log(`\n=== Fix DailyInventorySnapshots for ${TARGET_DATE} ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}\n`);

  // Load all active inventory items with their correct openingStock
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  console.log(`Loaded ${items.length} active inventory items`);

  // Load existing snapshots for 31-08
  const existingSnaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: TARGET_DATE },
  });
  console.log(`Existing snapshots for ${TARGET_DATE}: ${existingSnaps.length}`);

  // Build map: itemId → snapshot
  const snapMap = new Map();
  existingSnaps.forEach(s => snapMap.set(s.itemId, s));

  let updated = 0;
  let created = 0;
  let skipped = 0;
  const log = [];

  for (const item of items) {
    const correctOpening = Number(item.openingStock);
    const itemName = item.menuItem?.name || '';
    const existing = snapMap.get(item.id);

    if (existing) {
      const oldOpening = Number(existing.openingStock);
      if (oldOpening !== correctOpening) {
        // Update: set openingStock to correct value
        // Keep purchased/sold/wastage/adjusted as-is
        // Recalculate closingStock = openingStock + purchased - sold - wastage + adjusted
        const purchased = Number(existing.purchased);
        const sold = Number(existing.sold);
        const wastage = Number(existing.wastage);
        const adjusted = Number(existing.adjusted);
        const newClosing = correctOpening + purchased - sold - wastage + adjusted;

        log.push({
          action: 'UPDATE',
          name: itemName,
          oldOpening,
          newOpening: correctOpening,
          purchased,
          sold,
          newClosing,
          id: existing.id,
        });

        if (!DRY_RUN) {
          await p.dailyInventorySnapshot.update({
            where: { id: existing.id },
            data: {
              openingStock: correctOpening,
              closingStock: newClosing,
              itemName: itemName, // fix name too
            },
          });
        }
        updated++;
      } else {
        skipped++;
      }
    } else {
      // No snapshot exists for this item on 31-08 — create one
      if (correctOpening > 0 || true) {
        // Create snapshot for ALL items (even 0 stock) so the UI shows them
        const closing = correctOpening; // no transactions on 31-08 after reset

        log.push({
          action: 'CREATE',
          name: itemName,
          newOpening: correctOpening,
          newClosing: closing,
          itemId: item.id,
        });

        if (!DRY_RUN) {
          await p.dailyInventorySnapshot.create({
            data: {
              restaurantId: RESTAURANT_ID,
              snapshotDate: TARGET_DATE,
              itemId: item.id,
              itemName: itemName,
              openingStock: correctOpening,
              purchased: 0,
              sold: 0,
              wastage: 0,
              adjusted: 0,
              closingStock: closing,
            },
          });
        }
        created++;
      }
    }
  }

  // Print log
  console.log('\n--- Changes ---');
  log.forEach(l => {
    if (l.action === 'UPDATE') {
      console.log(`  UPDATE: ${l.name}  opening: ${l.oldOpening} → ${l.newOpening}  closing: ${l.newClosing}  (purchased: ${l.purchased}, sold: ${l.sold})`);
    } else {
      console.log(`  CREATE: ${l.name}  opening: ${l.newOpening}  closing: ${l.newClosing}`);
    }
  });

  console.log(`\n=== SUMMARY ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Created: ${created}`);
  console.log(`Skipped (already correct): ${skipped}`);
  if (DRY_RUN) console.log('\nDRY RUN — run without --dry-run to apply.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
