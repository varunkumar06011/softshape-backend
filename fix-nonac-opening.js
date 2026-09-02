// fix-nonac-opening.js
// Zero out Non-AC opening stock for 31-08 (and 01-09) since the user's stock sheet
// only covers AC (POS) inventory. Non-AC items that are duplicates of AC items
// were double-counting stock value.
//
// Also links duplicate Non-AC items to their AC counterparts where possible.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const DATES = ['2026-08-31', '2026-09-01'];

async function main() {
  console.log(`\n=== Fix Non-AC Opening Stock ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}\n`);

  const nonAcItems = await p.nonAcInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
  });
  console.log(`Non-AC items: ${nonAcItems.length}`);

  // Build AC item lookup for linking duplicates
  const acItems = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });

  function normalizeBase(name) {
    return String(name).toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
      .replace(/\s*\b(full\s+bottle|bottle|tin|can|reserve|select)\b\s*/gi, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Build AC lookup: normalizedBase → { size → acItemId }
  const acLookup = new Map();
  for (const ac of acItems) {
    const base = normalizeBase(ac.menuItem?.name || '');
    if (!base) continue;
    if (!acLookup.has(base)) acLookup.set(base, new Map());
    acLookup.get(base).set(Number(ac.bottleSize), ac.id);
  }

  let zeroed = 0;
  let linked = 0;
  let alreadyLinked = 0;

  for (const item of nonAcItems) {
    const wasLinked = !!item.acInventoryItemId;
    
    if (!wasLinked) {
      // Try to link to AC counterpart
      const base = normalizeBase(item.itemName || '');
      const size = Number(item.bottleSize) || 0;
      const acMatch = acLookup.get(base)?.get(size);
      
      if (acMatch) {
        console.log(`  LINK: "${item.itemName}" → AC item ${acMatch}`);
        if (!DRY_RUN) {
          await p.nonAcInventoryItem.update({
            where: { id: item.id },
            data: { acInventoryItemId: acMatch },
          });
        }
        linked++;
      }
    } else {
      alreadyLinked++;
    }

    // Zero out openingBottles in the master record
    if (Number(item.openingBottles) !== 0) {
      if (!DRY_RUN) {
        await p.nonAcInventoryItem.update({
          where: { id: item.id },
          data: { openingBottles: 0, currentBottles: 0 },
        });
      }
      zeroed++;
    }
  }

  // Zero out Non-AC daily entries for the target dates
  for (const date of DATES) {
    const entries = await p.nonAcDailyEntry.findMany({
      where: { restaurantId: RESTAURANT_ID, entryDate: date },
    });
    console.log(`\n${date}: ${entries.length} Non-AC entries`);
    
    for (const entry of entries) {
      if (Number(entry.openingBottles) !== 0 || Number(entry.closingBottles) !== 0) {
        if (!DRY_RUN) {
          await p.nonAcDailyEntry.update({
            where: { id: entry.id },
            data: {
              openingBottles: 0,
              receivedBottles: 0,
              adminDeduction: 0,
              closingBottles: 0,
            },
          });
        }
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Already linked to AC: ${alreadyLinked}`);
  console.log(`Newly linked to AC: ${linked}`);
  console.log(`Master openingBottles zeroed: ${zeroed}`);
  if (DRY_RUN) console.log('\nDRY RUN — run without --dry-run to apply.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
