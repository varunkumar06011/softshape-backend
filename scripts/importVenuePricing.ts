import { PrismaClient } from "@prisma/client";
import * as xlsx from "xlsx";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const FILE_PATH = path.resolve(process.env.EXCEL_FILE_PATH || "C:/Users/kiran/Downloads/git branch/RATES_BAR.xlsx");
const RESTAURANT_ID = "restaurant-001";

async function main() {
  console.log(`Loading Excel file from: ${FILE_PATH}`);
  const wb = xlsx.readFile(FILE_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

  // Map of venues to their index in the row array
  const venueColMap = {
    "venue-bar": 4, // Bar Ac Hall
    "venue-conference1": 5, // Conference Hall
    "venue-conference2": 6, // CONFERENCE 2
    "venue-pdr": 7, // pdr
    "venue-parcel": 10, // parcel
  };

  let importedCategory = await prisma.category.findFirst({
    where: { restaurantId: RESTAURANT_ID, name: "Imported from Excel" }
  });

  if (!importedCategory) {
    importedCategory = await prisma.category.create({
      data: {
        name: "Imported from Excel",
        restaurantId: RESTAURANT_ID,
        sortOrder: 999,
      }
    });
    console.log("Created fallback category 'Imported from Excel'");
  }

  // Fetch all existing items to minimize queries
  const existingItems = await prisma.menuItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isDeleted: false },
    select: { id: true, name: true }
  });
  const itemMap = new Map<string, string>();
  for (const item of existingItems) {
    itemMap.set(item.name.toLowerCase().trim(), item.id);
  }

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[1] || typeof row[1] !== 'string') continue;

    const rawName = row[1].trim();
    if (!rawName || rawName.toLowerCase() === "item") continue;

    let menuItemId = itemMap.get(rawName.toLowerCase());

    if (!menuItemId) {
      // Create missing item
      const newItem = await prisma.menuItem.create({
        data: {
          name: rawName,
          basePrice: Number(row[4]) || 0, // Fallback to Bar price as base if needed, or 0
          restaurantId: RESTAURANT_ID,
          categoryId: importedCategory.id,
          menuType: rawName.toUpperCase().includes("WHISKY") || rawName.toUpperCase().includes("RUM") || rawName.toUpperCase().includes("VODKA") || rawName.toUpperCase().includes("BEER") ? "LIQUOR" : "FOOD",
        }
      });
      menuItemId = newItem.id;
      itemMap.set(rawName.toLowerCase(), menuItemId);
      createdCount++;
      console.log(`Created new item: ${rawName}`);
    }

    // Upsert VenuePrices
    for (const [venueId, colIndex] of Object.entries(venueColMap)) {
      const priceVal = Number(row[colIndex]);
      if (isNaN(priceVal) || priceVal <= 0) continue; // Skip 0 or empty prices

      // Upsert
      let retries = 3;
      while (retries > 0) {
        try {
          await prisma.venuePrice.upsert({
            where: {
              venueId_menuItemId: {
                venueId,
                menuItemId
              }
            },
            create: {
              venueId,
              menuItemId,
              price: priceVal,
              isActive: true
            },
            update: {
              price: priceVal,
              isActive: true
            }
          });
          break; // Success
        } catch (err: any) {
          retries--;
          console.warn(`Upsert failed for ${venueId} ${rawName}, retries left: ${retries} - ${err.message}`);
          if (retries === 0) throw err;
          await new Promise(r => setTimeout(r, 1000)); // wait 1s before retry
        }
      }
      updatedCount++;
    }
  }

  console.log(`Done. Created ${createdCount} items, Upserted ${updatedCount} venue prices, Skipped ${skippedCount} rows.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
