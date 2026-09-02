// fix-snapshots-31-08-v2.js
// Fixes 31-08 AND 01-09 snapshots:
// - 31-08: openingStock = correct value from inventoryItem, sold/purchased/wastage/adjusted = 0, closing = opening
// - 01-09: openingStock = 31-08 closing, sold/purchased/wastage/adjusted = 0, closing = opening
// Also creates missing snapshots for ALL active items on both dates.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

async function fixDate(targetDate, openingStockSource) {
  console.log(`\n--- Fixing ${targetDate} ---`);

  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  const existingSnaps = await p.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: targetDate },
  });
  const snapMap = new Map();
  existingSnaps.forEach(s => snapMap.set(s.itemId, s));

  let updated = 0, created = 0, skipped = 0;

  for (const item of items) {
    const itemName = item.menuItem?.name || '';
    const correctOpening = openingStockSource.get(item.id) ?? Number(item.openingStock);
    const existing = snapMap.get(item.id);

    if (existing) {
      const oldOpening = Number(existing.openingStock);
      const oldSold = Number(existing.sold);
      const oldPurchased = Number(existing.purchased);
      const needsUpdate = oldOpening !== correctOpening || oldSold !== 0 || oldPurchased !== 0;

      if (needsUpdate) {
        if (!DRY_RUN) {
          await p.dailyInventorySnapshot.update({
            where: { id: existing.id },
            data: {
              openingStock: correctOpening,
              purchased: 0,
              sold: 0,
              wastage: 0,
              adjusted: 0,
              closingStock: correctOpening,
              itemName: itemName,
            },
          });
        }
        updated++;
      } else {
        skipped++;
      }
    } else {
      if (!DRY_RUN) {
        await p.dailyInventorySnapshot.create({
          data: {
            restaurantId: RESTAURANT_ID,
            snapshotDate: targetDate,
            itemId: item.id,
            itemName: itemName,
            openingStock: correctOpening,
            purchased: 0,
            sold: 0,
            wastage: 0,
            adjusted: 0,
            closingStock: correctOpening,
          },
        });
      }
      created++;
    }
  }

  console.log(`  Updated: ${updated}, Created: ${created}, Skipped: ${skipped}`);
  return updated + created;
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);

  // Load all active inventory items
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  // Build opening stock map from inventoryItem.openingStock
  const openingMap = new Map();
  items.forEach(i => openingMap.set(i.id, Number(i.openingStock)));

  // Fix 31-08: opening = inventoryItem.openingStock
  const total31 = await fixDate('2026-08-31', openingMap);

  // For 01-09: opening = 31-08 closing (which = 31-08 opening after our fix)
  // Since we set closing = opening for 31-08, 01-09 opening = same values
  const total01 = await fixDate('2026-09-01', openingMap);

  console.log(`\n=== SUMMARY ===`);
  console.log(`31-08: ${total31} snapshots fixed`);
  console.log(`01-09: ${total01} snapshots fixed`);
  if (DRY_RUN) console.log('\nDRY RUN — run without --dry-run to apply.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
