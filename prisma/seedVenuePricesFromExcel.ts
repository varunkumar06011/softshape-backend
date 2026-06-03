/**
 * seedVenuePricesFromExcel.ts
 *
 * Imports venue pricing from RATES_BAR.xlsx into VenuePrice records.
 * Maps Excel columns to venue IDs and skips items with price 0.
 *
 * Excel column mapping:
 * - Column 4: Bar Ac Hall → venue-bar
 * - Column 5: Conference Hall → venue-conference1
 * - Column 6: CONFERENCE 2 → venue-pdr (PDR)
 * - Column 7: pdr → venue-rooms (Rooms)
 * - Column 8: Specials → skip
 * - Column 9: Vedika Banquet Hall → skip
 * - Column 10: parcel → venue-parcel
 *
 * Run with:
 *   npx ts-node -r tsconfig-paths/register prisma/seedVenuePricesFromExcel.ts
 */

import { PrismaClient } from "@prisma/client";
// @ts-ignore
import * as XLSX from 'xlsx';
// @ts-ignore
import * as path from 'path';

const prisma = new PrismaClient();
const BAR_ID = "bar-001";

// Excel column index to venue ID mapping
const COLUMN_TO_VENUE_ID: Record<number, string> = {
  4: 'venue-bar',
  5: 'venue-conference1',
  6: 'venue-pdr',        // CONFERENCE 2 → PDR
  7: 'venue-rooms',      // pdr → Rooms
  10: 'venue-parcel',
  // Columns 8 (Specials) and 9 (Vedika Banquet Hall) are skipped
};

// Food vs Liquor classification (simplified from seedBar.ts)
function isLiquorItem(itemName: string): boolean {
  const lowerName = itemName.toLowerCase();
  
  // Beverages, soft drinks, water, mixers
  if (/(thumsup|sprite|coca cola|limca|fanta|soda|water|red bull|monster|charged|pulpy orange|mojito|mocktail|moctail|fruit punch|lassi|butter milk|onion ritha)/.test(lowerName)) {
    return true;
  }
  // Beer
  if (/(beer|bira|carlsberg|budweiser|kf|kingfisher|coolberg|stok)/.test(lowerName)) {
    return true;
  }
  // Spirits / Liquor / Wine
  if (/(whisky|brandy|vodka|rum|wine|gin|tequila|label|signature|royal stag|blenders pride|antiquity|smirnoff|magic moments|100 pipers|chivas|mansion house|morpheus|teachers|vat69|vat 69|absolut|mc|legacy|imperial blue|bacardi|brezer|breezer|cocktail|peg|shot|pint|cork|napolean|kyron|oab|bp|cnb|blue|reserve)/.test(lowerName)) {
    return true;
  }
  
  return false;
}

async function main() {
  console.log("Reading RATES_BAR.xlsx...");
  
  const excelPath = path.join(process.cwd(), 'RATES_BAR.xlsx');
  const workbook = XLSX.readFile(excelPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
  
  // Row 2 (index 2) contains venue names
  const venueNames = data[2].slice(4);
  console.log("Venue columns found:", venueNames);
  
  // Row 3 onwards contains item data
  const itemRows = data.slice(3);
  
  let totalCreated = 0;
  let totalSkipped = 0;
  
  // First, get all existing menu items from bar-001 to map by item ID
  const existingMenuItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID },
    select: { id: true, name: true },
  });
  
  const menuItemMap = new Map<string, string>();
  for (const item of existingMenuItems) {
    // Try to match by name (case-insensitive)
    menuItemMap.set(item.name.toLowerCase(), item.id);
  }
  
  console.log(`Found ${existingMenuItems.length} existing menu items in bar-001`);
  
  for (const row of itemRows) {
    const itemId = String(row[0]).trim();
    const itemName = String(row[1]).trim();
    const prices = row.slice(4);
    
    // Find matching menu item in bar-001
    const menuItemId = menuItemMap.get(itemName.toLowerCase());
    
    if (!menuItemId) {
      console.log(`  ⚠ No matching menu item found for: ${itemName} (ID: ${itemId})`);
      continue;
    }
    
    // Determine menuType based on item name
    const isLiquor = isLiquorItem(itemName);
    
    // Create VenuePrice records for each venue column
    for (let colIndex = 4; colIndex < row.length; colIndex++) {
      const venueId = COLUMN_TO_VENUE_ID[colIndex];
      
      // Skip columns that don't map to a venue
      if (!venueId) {
        continue;
      }
      
      const price = Number(prices[colIndex - 4]);
      
      // Skip items with price 0
      if (price === 0 || isNaN(price)) {
        totalSkipped++;
        continue;
      }
      
      // Upsert VenuePrice record
      await (prisma as any).venuePrice.upsert({
        where: {
          venueId_menuItemId: {
            venueId,
            menuItemId,
          },
        },
        create: {
          venueId,
          menuItemId,
          price,
          isActive: true,
        },
        update: {
          price,
          isActive: true,
        },
      });
      
      totalCreated++;
      console.log(`  ✓ ${itemName} → ${venueId}: ₹${price} (${isLiquor ? 'LIQUOR' : 'FOOD'})`);
    }
  }
  
  console.log(`\nDone. Created/updated ${totalCreated} venue price records.`);
  console.log(`Skipped ${totalSkipped} records (price = 0 or invalid).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
