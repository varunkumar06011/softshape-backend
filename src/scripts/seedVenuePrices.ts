/**
 * seedVenuePrices.ts
 * One-time seed script — reads RATES BAR CSV and upserts VenuePrice rows
 * for all 5 bar sections: AC Hall, Conference, PDR, Rooms, Parcel.
 *
 * Run: npx ts-node src/scripts/seedVenuePrices.ts
 */

import prisma from "../lib/prisma";
import * as fs from "fs";
import * as path from "path";

const CSV_PATH = path.resolve(__dirname, "../../../Softshapeai/RATES BAR (1) - Sheet1 (2).csv");

const VENUE_COLS: { venueId: string; colIndex: number }[] = [
  { venueId: "venue-bar-ac-hall",    colIndex: 2 },
  { venueId: "venue-bar-conference", colIndex: 3 },
  { venueId: "venue-bar-pdr",        colIndex: 4 },
  { venueId: "venue-bar-rooms",      colIndex: 5 },
  { venueId: "venue-bar-parcel",     colIndex: 6 },
];

// Normalize a name for fuzzy matching
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  // Parse CSV
  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = raw.split(/\r?\n/).map(line => line.split(","));

  // Find header row (contains "Bar Ac Hall")
  const headerRowIdx = rows.findIndex(r => r.some(c => c.toLowerCase().includes("bar ac hall")));
  if (headerRowIdx < 0) throw new Error("Could not find header row in CSV");

  const dataRows = rows.slice(headerRowIdx + 1).filter(r => {
    const name = (r[1] || "").trim();
    return name.length > 0;
  });

  console.log(`[Seed] Found ${dataRows.length} item rows in CSV`);

  // Load all bar menu items from DB
  const BAR_ID = "bar-001";
  const dbItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID, isDeleted: false },
    select: { id: true, name: true },
  });

  console.log(`[Seed] Found ${dbItems.length} bar menu items in DB`);

  // Build lookup: normalized name → DB item id (first match wins)
  const nameMap = new Map<string, string>();
  for (const item of dbItems) {
    const key = norm(item.name);
    if (!nameMap.has(key)) nameMap.set(key, item.id);
  }

  let upserted = 0;
  let skipped = 0;
  const unmatched: string[] = [];

  for (const row of dataRows) {
    const csvName = (row[1] || "").trim();
    if (!csvName) continue;

    const dbId = nameMap.get(norm(csvName));
    if (!dbId) {
      unmatched.push(csvName);
      continue;
    }

    for (const { venueId, colIndex } of VENUE_COLS) {
      const rawPrice = (row[colIndex] || "").trim();
      const price = parseFloat(rawPrice);
      if (isNaN(price) || price <= 0) {
        skipped++;
        continue; // price = 0 means item not available in this venue
      }

      await prisma.venuePrice.upsert({
        where: { venueId_menuItemId: { venueId, menuItemId: dbId } },
        create: { venueId, menuItemId: dbId, price, isActive: true },
        update: { price, isActive: true },
      });
      upserted++;
    }
  }

  console.log(`\n[Seed] Done.`);
  console.log(`  Upserted : ${upserted} venue price rows`);
  console.log(`  Skipped  : ${skipped} (price = 0 = not available in that venue)`);
  console.log(`  Unmatched: ${unmatched.length} items not found in DB`);

  if (unmatched.length > 0) {
    console.log(`\n[Seed] Unmatched item names (check spelling vs DB):`);
    unmatched.forEach(n => console.log(`  - ${n}`));
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("[Seed] Fatal error:", err);
  process.exit(1);
});
