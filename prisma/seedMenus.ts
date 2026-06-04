import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

const BAR_ID = "bar-001";
const RESTAURANT_ID = "restaurant-001";

const BAR_VENUES = [
  { id: "venue-bar-ac-hall", label: "Bar Ac Hall" },
  { id: "venue-bar-conference", label: "Conference Hall" },
  { id: "venue-bar-pdr", label: "PDR" },
  { id: "venue-bar-rooms", label: "Rooms" },
  { id: "venue-bar-parcel", label: "Parcel" },
];

const RESTAURANT_VENUES = [
  { id: "venue-family-restaurant", label: "Family Restaurant" },
  { id: "venue-restaurant-parcel", label: "Parcel" },
];

function inferBarCategory(name: string): string {
  const n = name.toUpperCase();
  if (n.includes("CHARGE") || n.includes("PROJECTOR") || n.includes("OTHER CHARGES") || n.includes("BUFFET")) return "Charges & Services";
  if (n.includes("SOUP")) return "Soups";
  if (n.includes("ICE CREAM") || n.includes("GULABJAMUN")) return "Desserts";
  if (n.includes("WHISK") || n.includes("VODKA") || n.includes("BRANDY") || n.includes("RUM") || n.includes("WINE") || n.includes("BEER") || n.includes("BIRA") || n.includes("COCKTAIL") || n.includes("LABEL") || n.includes("DOG") || n.includes("CHALLENGE") || n.includes("SIGNATURE") || n.includes("BALLANTINE") || n.includes("IMPERIAL") || n.includes("EMPIRE") || n.includes("TEACHERS") || n.includes("CHIVAS") || n.includes("ABSOLUT") || n.includes("MC ") || n.includes("MORPHEUS") || n.includes("LEGACY") || n.includes("STAG") || n.includes("MONK") || n.includes("MAGIC") || n.includes("SMIRNOFF") || n.includes("JAMSON") || n.includes("ANTIQ") || n.includes("JOHNNIE") || n.includes("PIPER") || n.includes("LAWSON") || n.includes("BP ") || n.includes("COURIER") || n.includes("NAPOLEAN") || n.includes("KYRON") || n.includes("ELITE") || n.includes("SIDUS") || n.includes("KYRA") || n.includes("B7 ") || n.includes("B10 ") || n.includes("CNB") || n.includes("OAB") || n.includes("OC ") || n.includes("8PM") || n.includes("ARISTO") || n.includes("BLENDER") || n.includes("STERLING") || n.includes("SEGRAM") || n.includes("ZEUS") || n.includes("BOLS") || n.includes("AC ") || n.includes("AC PREMIUM") || n.includes("JUNO") || n.includes("BLACK & GOLD") || n.includes("BLACK & WHITE") || n.includes("BRITESH") || n.includes("100 PIPERS") || n.includes("GOLD LABEL")) return "Liquor";
  if (n.includes("ORANGE") || n.includes("THUMSUP") || n.includes("THUMS UP") || n.includes("SPRITE") || n.includes("COKE") || n.includes("LIMCA") || n.includes("FANTA") || n.includes("SODA") || n.includes("MOJIT") || n.includes("MOCTAIL") || n.includes("LIME") || n.includes("MONSTER") || n.includes("CHARGED") || n.includes("WATER") || n.includes("MILK SHAKE") || n.includes("MILKSHAKE") || n.includes("FRUIT PUNCH") || n.includes("BUTTERMILK") || n.includes("LASSI") || n.includes("PULPY")) return "Beverages";
  if (n.includes("RICE") || n.includes("BIRYANI") || n.includes("PULAV") || n.includes("PULAO") || n.includes("NOODLE") || n.includes("NOODLES") || n.includes("FRIED RICE") || n.includes("KEEMA")) return "Rice & Noodles";
  if (n.includes("DOSA") || n.includes("ROTI") || n.includes("NAAN") || n.includes("KULCHA") || n.includes("PAROTA") || n.includes("PULKA")) return "Breads";
  return "Food";
}

function parseBarCSV(filePath: string) {
  const text = fs.readFileSync(filePath, "utf-8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = lines[0].split(",").map((h) => h.trim());
  const venueCols = header.slice(1); // Bar Ac Hall, Conference Hall, pdr, rooms, parcel

  const items: { name: string; category: string; prices: number[] }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim());
    if (parts.length < 6) continue;
    const name = parts[0];
    if (!name || name.toUpperCase() === "ITEM") continue;
    const prices = parts.slice(1, 6).map((p) => parseFloat(p) || 0);
    items.push({ name, category: inferBarCategory(name), prices });
  }
  return { venueCols, items };
}

function parseRestaurantCSV(filePath: string) {
  const text = fs.readFileSync(filePath, "utf-8");
  const rows = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split(",").map((c) => c.trim()));

  const groups = [
    { offset: 0, nameIdx: 1, priceIdx: 2 },
    { offset: 4, nameIdx: 5, priceIdx: 6 },
    { offset: 8, nameIdx: 9, priceIdx: 10 },
    { offset: 12, nameIdx: 13, priceIdx: 14 },
  ];

  const items: { name: string; category: string; price: number }[] = [];
  const categories: Record<number, string> = {};

  for (const row of rows) {
    for (let g = 0; g < groups.length; g++) {
      const { offset, nameIdx, priceIdx } = groups[g];
      if (row.length <= offset) continue;

      const col0 = row[offset] || "";
      const col1 = row.length > nameIdx ? row[nameIdx] : "";
      const col2 = row.length > priceIdx ? row[priceIdx] : "";

      // Detect category: non-empty text in col0 or col1 without a valid price in col2
      const priceNum = parseFloat(col2);
      const hasPrice = !isNaN(priceNum) && priceNum > 0;

      if (!hasPrice && col1 && !col0) {
        // Likely category in col1
        categories[g] = col1;
        continue;
      }
      if (!hasPrice && col0 && !col1 && !col2) {
        // Category in col0 spanning group
        categories[g] = col0;
        continue;
      }
      if (!hasPrice && col0 && col0.length > 2 && !/^\d+$/.test(col0)) {
        // Text in col0 that is not a number → category
        categories[g] = col0;
        continue;
      }

      // Extract item
      const itemName = col1 || col0;
      if (!itemName || itemName === "ITEM NAME" || itemName === "S.NO") continue;
      if (!hasPrice) continue;

      const category = categories[g] || "General";
      items.push({ name: itemName, category, price: priceNum });
    }
  }
  return items;
}

async function seed() {
  console.log("[seed] Starting menu seed...");

  // 1. Soft-delete existing menu items for bar and restaurant
  console.log("[seed] Soft-deleting existing menu items...");
  await prisma.menuItem.updateMany({
    where: { restaurantId: { in: [BAR_ID, RESTAURANT_ID] } },
    data: { isDeleted: true, deletedAt: new Date() },
  });

  // 2. Clear old venue prices
  console.log("[seed] Deleting old venue prices...");
  await (prisma as any).venuePrice.deleteMany({});

  // 3. Seed bar menu
  const barPath = path.join(__dirname, "..", "RATES BAR - Sheet1.csv");
  const barData = parseBarCSV(barPath);
  console.log(`[seed] Parsed ${barData.items.length} bar items`);

  // Create bar categories
  const barCategories = new Map<string, string>();
  const uniqueBarCats = [...new Set(barData.items.map((i) => i.category))];
  let sortOrder = 0;
  for (const catName of uniqueBarCats) {
    let cat = await prisma.category.findFirst({
      where: { name: catName, restaurantId: BAR_ID },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: { name: catName, restaurantId: BAR_ID, sortOrder: sortOrder++ },
      });
    } else {
      cat = await prisma.category.update({
        where: { id: cat.id },
        data: { sortOrder: sortOrder++ },
      });
    }
    barCategories.set(catName, cat.id);
  }

  // Create bar items + variants, collect venue prices for batch insert
  const allBarVenuePrices: any[] = [];
  for (const item of barData.items) {
    const created = await prisma.menuItem.create({
      data: {
        name: item.name,
        restaurantId: BAR_ID,
        categoryId: barCategories.get(item.category)!,
        isVeg: inferBarCategory(item.name) === "Liquor" || inferBarCategory(item.name) === "Beverages" ? false : true,
        menuType: inferBarCategory(item.name) === "Liquor" ? "LIQUOR" : "FOOD",
        sortOrder: 0,
        variants: {
          create: [{ name: "Regular", price: item.prices[0], isDefault: true }],
        },
      },
    });

    for (let idx = 0; idx < BAR_VENUES.length; idx++) {
      allBarVenuePrices.push({
        venueId: BAR_VENUES[idx].id,
        menuItemId: created.id,
        price: item.prices[idx] || 0,
        isActive: (item.prices[idx] || 0) > 0,
      });
    }
  }

  // Batch insert bar venue prices in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < allBarVenuePrices.length; i += CHUNK) {
    await (prisma as any).venuePrice.createMany({
      data: allBarVenuePrices.slice(i, i + CHUNK),
      skipDuplicates: true,
    });
  }
  console.log(`[seed] Bar menu seeded (${allBarVenuePrices.length} venue prices).`);

  // 4. Seed restaurant menu
  const restPath = path.join(__dirname, "..", "..", "Softshapeai", "FAMILY & PICK UP MENU ONGOLE.csv");
  const restItems = parseRestaurantCSV(restPath);
  console.log(`[seed] Parsed ${restItems.length} restaurant items`);

  // Create restaurant categories
  const restCategories = new Map<string, string>();
  const uniqueRestCats = [...new Set(restItems.map((i) => i.category))];
  sortOrder = 0;
  for (const catName of uniqueRestCats) {
    let cat = await prisma.category.findFirst({
      where: { name: catName, restaurantId: RESTAURANT_ID },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: { name: catName, restaurantId: RESTAURANT_ID, sortOrder: sortOrder++ },
      });
    } else {
      cat = await prisma.category.update({
        where: { id: cat.id },
        data: { sortOrder: sortOrder++ },
      });
    }
    restCategories.set(catName, cat.id);
  }

  // Create restaurant items + variants, collect venue prices for batch insert
  const allRestVenuePrices: any[] = [];
  for (const item of restItems) {
    const created = await prisma.menuItem.create({
      data: {
        name: item.name,
        restaurantId: RESTAURANT_ID,
        categoryId: restCategories.get(item.category)!,
        isVeg: !item.name.toLowerCase().includes("chicken") && !item.name.toLowerCase().includes("mutton") && !item.name.toLowerCase().includes("fish") && !item.name.toLowerCase().includes("prawn") && !item.name.toLowerCase().includes("egg"),
        menuType: item.category.toLowerCase().includes("drink") || item.category.toLowerCase().includes("milkshake") || item.category.toLowerCase().includes("lassi") || item.category.toLowerCase().includes("butter milk") ? "LIQUOR" : "FOOD",
        sortOrder: 0,
        variants: {
          create: [{ name: "Regular", price: item.price, isDefault: true }],
        },
      },
    });

    for (const v of RESTAURANT_VENUES) {
      allRestVenuePrices.push({
        venueId: v.id,
        menuItemId: created.id,
        price: item.price,
        isActive: true,
      });
    }
  }

  // Batch insert restaurant venue prices in chunks
  for (let i = 0; i < allRestVenuePrices.length; i += CHUNK) {
    await (prisma as any).venuePrice.createMany({
      data: allRestVenuePrices.slice(i, i + CHUNK),
      skipDuplicates: true,
    });
  }
  console.log(`[seed] Restaurant menu seeded (${allRestVenuePrices.length} venue prices).`);

  // 5. Update venue sections
  console.log("[seed] Updating venue sections...");
  const VENUE_ID = "venue-001";
  // Delete orders first (they reference tables via FK), then tables, then sections
  await prisma.order.deleteMany({ where: { restaurantId: VENUE_ID } });
  await prisma.table.deleteMany({ where: { restaurantId: VENUE_ID } });
  await prisma.section.deleteMany({ where: { restaurantId: VENUE_ID } });

  const newSections = [
    { id: "section-family-restaurant", name: "Family Restaurant", tables: Array.from({ length: 40 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
    { id: "section-parcel", name: "Parcel", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 1 })) },
    { id: "section-conference", name: "Conference Hall", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
    { id: "section-pdr", name: "PDR", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
    { id: "section-rooms", name: "Rooms", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 2 })) },
    { id: "section-bar-parcel", name: "Bar Parcel", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 1 })) },
  ];
  for (const sec of newSections) {
    const section = await prisma.section.create({
      data: { id: sec.id, name: sec.name, restaurantId: VENUE_ID },
    });
    for (const tbl of sec.tables) {
      await prisma.table.create({
        data: { number: tbl.number, capacity: tbl.capacity, status: "AVAILABLE", restaurantId: VENUE_ID, sectionId: section.id },
      });
    }
  }
  console.log("[seed] Venue sections updated.");

  console.log("[seed] Done!");
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
