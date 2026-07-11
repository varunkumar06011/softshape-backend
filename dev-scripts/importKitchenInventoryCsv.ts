/**
 * One-off import: kitchen-inventory CSV into KitchenInventoryItem + InventoryDailyEntry.
 *
 * Usage:
 *   npx ts-node --project tsconfig.dev.json dev-scripts/importKitchenInventoryCsv.ts \
 *     <restaurantId> <csvPath> [date08=2026-07-08] [date09=2026-07-09]
 *
 * The CSV columns are expected (case-insensitive):
 *   ITEM NAME | UNITS | RATE | OPENING | PURCHASE | CLOSING
 *
 * For each row:
 *   - Creates or updates a KitchenInventoryItem (price = RATE, currentStock = CLOSING).
 *   - Creates an InventoryDailyEntry for date08 with opening/added/consumed/closing.
 *   - If a valid closing exists, creates an InventoryDailyEntry for date09 where
 *     openingStock = date08 closingStock.
 *
 * PURCHASE cells may contain simple addition expressions like "20+50" or "150+300".
 */

import fs from 'fs';
import path from 'path';
import { basePrisma } from '../src/lib/prisma';
import { Prisma } from '@prisma/client';

function parseArgs() {
  const [, , restaurantId, csvPath, date08Arg, date09Arg] = process.argv;
  if (!restaurantId || !csvPath) {
    console.error('Usage: ts-node dev-scripts/importKitchenInventoryCsv.ts <restaurantId> <csvPath> [date08=YYYY-MM-DD] [date09=YYYY-MM-DD]');
    process.exit(1);
  }
  return {
    restaurantId,
    csvPath,
    date08: date08Arg || '2026-07-08',
    date09: date09Arg || '2026-07-09',
  };
}

function normalizeHeader(h: string): string {
  return h.trim().toUpperCase().replace(/\s+/g, ' ');
}

function toDecimal(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-') return null;
  // Allow simple addition expressions like "20+50" or "150+300"
  if (/^[\d\s\+\-\*\/\.]+$/.test(trimmed)) {
    try {
      // eslint-disable-next-line no-eval
      const result = eval(trimmed);
      if (typeof result === 'number' && isFinite(result)) return result;
    } catch {
      // fall through
    }
  }
  const parsed = Number(trimmed);
  return isNaN(parsed) ? null : parsed;
}

function isValidNumber(n: number | null): n is number {
  return n !== null && isFinite(n) && n >= 0;
}

interface CsvRow {
  name: string;
  unit: string;
  rate: number | null;
  opening: number | null;
  purchase: number | null;
  closing: number | null;
}

function parseCsv(filePath: string): CsvRow[] {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('CSV is empty');

  const header = lines[0].split(',').map((h) => normalizeHeader(h));
  const idxName = header.findIndex((h) => h.includes('ITEM') && h.includes('NAME'));
  const idxUnit = header.findIndex((h) => h === 'UNITS' || h === 'UNIT');
  const idxRate = header.findIndex((h) => h === 'RATE');
  const idxOpening = header.findIndex((h) => h === 'OPENING');
  const idxPurchase = header.findIndex((h) => h === 'PURCHASE');
  const idxClosing = header.findIndex((h) => h === 'CLOSING' || h === 'BALANCE');

  if (idxName === -1) throw new Error('Could not find ITEM NAME column');

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const name = (cols[idxName] ?? '').trim();
    if (!name) continue;

    rows.push({
      name,
      unit: (cols[idxUnit] ?? '').trim(),
      rate: toDecimal(cols[idxRate]),
      opening: toDecimal(cols[idxOpening]),
      purchase: toDecimal(cols[idxPurchase]),
      closing: toDecimal(cols[idxClosing]),
    });
  }
  return rows;
}

async function main() {
  const { restaurantId, csvPath, date08, date09 } = parseArgs();

  const fullPath = path.resolve(csvPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`CSV file not found: ${fullPath}`);
    process.exit(1);
  }

  const outlet = await basePrisma.outlet.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true, sharedKitchenOutletId: true },
  });
  if (!outlet) {
    console.error(`Outlet not found: ${restaurantId}`);
    process.exit(1);
  }

  const kitchenRestaurantId = outlet.sharedKitchenOutletId ?? outlet.id;
  console.log(`Importing into kitchen outlet: ${outlet.name} (${kitchenRestaurantId})\n`);

  const rows = parseCsv(fullPath);
  console.log(`Parsed ${rows.length} rows from ${fullPath}\n`);

  let createdItems = 0;
  let updatedItems = 0;
  let created08 = 0;
  let created09 = 0;
  let skipped = 0;

  // Pre-load existing items keyed by lowercase name for deduplication/merging
  const existingItems = await basePrisma.kitchenInventoryItem.findMany({
    where: { restaurantId: kitchenRestaurantId },
  });
  const itemByName = new Map(existingItems.map((i) => [i.name.toLowerCase(), i]));

  for (const row of rows) {
    try {
      const opening = isValidNumber(row.opening) ? row.opening : null;
      const purchase = isValidNumber(row.purchase) ? row.purchase : null;
      const closing = isValidNumber(row.closing) ? row.closing : null;

      // Effective closing for the 08 entry:
      // 1. Use explicit closing if provided.
      // 2. Else if opening provided, assume no consumption => opening + purchase.
      // 3. Else if purchase provided, closing = purchase (opening = 0).
      // 4. Else all zeros.
      let entryClosing08: number;
      if (closing !== null) {
        entryClosing08 = closing;
      } else if (opening !== null) {
        entryClosing08 = opening + (purchase ?? 0);
      } else if (purchase !== null) {
        entryClosing08 = purchase;
      } else {
        entryClosing08 = 0;
      }

      // Item current stock should reflect the latest known closing (08-07).
      const itemCurrentStock = entryClosing08;

      // Merge with existing item if name already exists.
      const existing = itemByName.get(row.name.toLowerCase());
      let itemId: string;
      if (existing) {
        const updateData: any = {};
        if (row.unit && !existing.unit) updateData.unit = row.unit;
        if (row.unit && existing.unit && existing.unit !== row.unit) updateData.unit = row.unit;
        if (row.rate !== null) updateData.price = new Prisma.Decimal(row.rate);
        if (itemCurrentStock >= 0) updateData.currentStock = new Prisma.Decimal(itemCurrentStock);

        if (Object.keys(updateData).length > 0) {
          await basePrisma.kitchenInventoryItem.update({
            where: { id: existing.id },
            data: updateData,
          });
          updatedItems++;
        }
        itemId = existing.id;
      } else {
        const created = await basePrisma.kitchenInventoryItem.create({
          data: {
            restaurantId: kitchenRestaurantId,
            name: row.name,
            unit: row.unit || '',
            price: new Prisma.Decimal(row.rate ?? 0),
            currentStock: new Prisma.Decimal(itemCurrentStock),
            reorderLevel: new Prisma.Decimal(0),
            category: '',
          },
        });
        createdItems++;
        itemByName.set(row.name.toLowerCase(), created);
        itemId = created.id;
      }

      // Always create 08-07 daily entry from the row data.
      const entryOpening08 = opening ?? 0;
      const entryPurchase08 = purchase ?? 0;
      const entryConsumed08 = Math.max(0, entryOpening08 + entryPurchase08 - entryClosing08);

      await basePrisma.inventoryDailyEntry.upsert({
        where: {
          restaurantId_itemId_entryDate: {
            restaurantId: kitchenRestaurantId,
            itemId,
            entryDate: date08,
          },
        },
        create: {
          restaurantId: kitchenRestaurantId,
          itemId,
          entryDate: date08,
          openingStock: new Prisma.Decimal(entryOpening08),
          addedStock: new Prisma.Decimal(entryPurchase08),
          consumedStock: new Prisma.Decimal(entryConsumed08),
          closingStock: new Prisma.Decimal(entryClosing08),
        },
        update: {
          openingStock: new Prisma.Decimal(entryOpening08),
          addedStock: new Prisma.Decimal(entryPurchase08),
          consumedStock: new Prisma.Decimal(entryConsumed08),
          closingStock: new Prisma.Decimal(entryClosing08),
        },
      });
      created08++;

      // Carry forward 08-07 closing as 09-07 opening; set 09-07 balance to zero.
      await basePrisma.inventoryDailyEntry.upsert({
        where: {
          restaurantId_itemId_entryDate: {
            restaurantId: kitchenRestaurantId,
            itemId,
            entryDate: date09,
          },
        },
        create: {
          restaurantId: kitchenRestaurantId,
          itemId,
          entryDate: date09,
          openingStock: new Prisma.Decimal(entryClosing08),
          addedStock: new Prisma.Decimal(0),
          consumedStock: new Prisma.Decimal(0),
          closingStock: new Prisma.Decimal(0),
        },
        update: {
          openingStock: new Prisma.Decimal(entryClosing08),
          addedStock: new Prisma.Decimal(0),
          consumedStock: new Prisma.Decimal(0),
          closingStock: new Prisma.Decimal(0),
        },
      });
      created09++;
    } catch (err: any) {
      console.error(`  ERROR on row "${row.name}": ${err.message}`);
      skipped++;
    }
  }

  console.log('\n=== Import Summary ===');
  console.log(`  Items created:        ${createdItems}`);
  console.log(`  Items updated:        ${updatedItems}`);
  console.log(`  08-07 entries created/updated: ${created08}`);
  console.log(`  09-07 entries created/updated: ${created09}`);
  console.log(`  Rows skipped/errors:  ${skipped}`);
}

main()
  .catch((err) => {
    console.error('Import failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await basePrisma.$disconnect();
  });
