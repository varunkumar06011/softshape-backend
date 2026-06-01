const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const RESTAURANT_ID = "restaurant-001";
const BAR_ID = "bar-001";

const CSV_PATH =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
  path.join(process.env.USERPROFILE || "", "Downloads", "RATES BAR (1) - Sheet1 (2).csv");

const VENUES = [
  { key: "conference", venueId: "venue-conference1" },
  { key: "pdr", venueId: "venue-pdr" },
  { key: "rooms", venueId: "venue-rooms" },
  { key: "parcel", venueId: "venue-parcel" },
];

const BAR_ONLY = process.argv.includes("--bar-only");

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function normalize(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/&/g, "and")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ");
}

function money(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function inferMenuType(name, barMatch) {
  if (barMatch?.menuType === "LIQUOR") return "LIQUOR";
  const normalized = normalize(name);
  const alcoholPattern = /\b(beer|whisky|whiskey|vodka|brandy|rum|gin|wine|tequila|breezer)\b/i;
  const softDrinkPattern = /\b(thumsup|thumbs up|sprite|coca cola|coke|limca|fanta|soda|pulpy orange)\b/i;
  if (alcoholPattern.test(normalized) || softDrinkPattern.test(normalized) || /\b30\s*ml\b/i.test(normalized)) {
    return "LIQUOR";
  }
  return "FOOD";
}

function readRows() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  return raw
    .split(/\r?\n/)
    .map(parseCsvLine)
    .filter((row) => row[1] && normalize(row[1]) !== "bar ac hall")
    .map((row, index) => ({
      sourceIndex: index,
      name: row[1].trim(),
      bar: money(row[2]),
      conference: money(row[3]),
      pdr: money(row[4]),
      rooms: money(row[5]),
      parcel: money(row[6]),
    }));
}

async function findOrCreateCategory(restaurantId, name, sortOrder) {
  const existing = await prisma.category.findFirst({
    where: { restaurantId, name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.category.create({
    data: { restaurantId, name, sortOrder },
  });
}

function buildNameMap(items) {
  const byName = new Map();
  for (const item of items) {
    const key = normalize(item.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }
  return byName;
}

async function upsertCsvMenuItem({
  restaurantId,
  byName,
  key,
  usedCount,
  row,
  categoryId,
  menuType,
  isVeg,
  basePrice,
}) {
  const matches = byName.get(key) || [];
  let item = matches[usedCount];
  const defaultPrice = basePrice ?? (row.bar || row.conference || row.pdr || row.rooms || row.parcel || 0);

  if (!item) {
    item = await prisma.menuItem.create({
      data: {
        name: row.name,
        restaurantId,
        categoryId,
        isVeg,
        menuType,
        isAvailable: true,
        isDeleted: false,
        sortOrder: row.sourceIndex,
        variants: {
          create: { name: "Regular", price: defaultPrice, isDefault: true },
        },
      },
      include: { variants: true, category: true },
    });
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
    return { item, created: true };
  }

  const variant = item.variants.find((v) => v.isDefault) || item.variants[0];
  await prisma.menuItem.update({
    where: { id: item.id },
    data: {
      name: row.name,
      menuType,
      isAvailable: true,
      sortOrder: item.sortOrder ?? row.sourceIndex,
    },
  });
  if (variant) {
    await prisma.menuItemVariant.update({
      where: { id: variant.id },
      data: { price: defaultPrice },
    });
  }
  return { item, created: false };
}

async function upsertVenueRows(itemId, row) {
  const venueRows = VENUES
    .map((venue) => ({ ...venue, price: row[venue.key] }))
    .filter((venue) => venue.price > 0);

  await Promise.all(venueRows.map((venue) => prisma.venuePrice.upsert({
    where: { venueId_menuItemId: { venueId: venue.venueId, menuItemId: itemId } },
    create: {
      venueId: venue.venueId,
      menuItemId: itemId,
      price: venue.price,
      isActive: true,
    },
    update: { price: venue.price, isActive: true },
  })));

  return venueRows.length;
}

async function main() {
  const rows = readRows();
  console.log(`CSV rows: ${rows.length}`);

  const restaurantImportedCategory = BAR_ONLY
    ? null
    : await findOrCreateCategory(RESTAURANT_ID, "Imported Menu", 999);
  const barImportedCategory = await findOrCreateCategory(BAR_ID, "Imported Menu", 999);

  const restaurantItems = BAR_ONLY
    ? []
    : await prisma.menuItem.findMany({
        where: { restaurantId: RESTAURANT_ID, isDeleted: false },
        include: { variants: { orderBy: { isDefault: "desc" } }, category: true },
        orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      });
  const barItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID, isDeleted: false },
    include: { variants: { orderBy: { isDefault: "desc" } }, category: true },
  });

  if (!BAR_ONLY) {
    await prisma.venuePrice.deleteMany({
      where: { venueId: { in: VENUES.map((venue) => venue.venueId) } },
    });
    console.log("Cleared existing Conference/PDR/Rooms/Parcel venue prices.");
  } else {
    console.log("Bar-only mode: preserving existing venue prices and upserting bar item prices.");
  }

  const restaurantByName = buildNameMap(restaurantItems);
  const barByName = buildNameMap(barItems);

  const usedByName = new Map();
  let restaurantCreated = 0;
  let restaurantUpdated = 0;
  let barCreated = 0;
  let barUpdated = 0;
  let priceRows = 0;

  for (const row of rows) {
    const key = normalize(row.name);
    const usedCount = usedByName.get(key) || 0;
    usedByName.set(key, usedCount + 1);

    const barMatches = barByName.get(key) || [];
    const barMatch = barMatches[usedCount] || barMatches[0];
    const menuType = inferMenuType(row.name, barMatch);
    const isVeg = barMatch?.isVeg ?? true;

    let restaurantResult = null;
    if (!BAR_ONLY) {
      restaurantResult = await upsertCsvMenuItem({
        restaurantId: RESTAURANT_ID,
        byName: restaurantByName,
        key,
        usedCount,
        row,
        categoryId: restaurantImportedCategory.id,
        menuType,
        isVeg,
      });
      if (restaurantResult.created) restaurantCreated += 1;
      else restaurantUpdated += 1;
    }

    const barResult = await upsertCsvMenuItem({
      restaurantId: BAR_ID,
      byName: barByName,
      key,
      usedCount,
      row,
      categoryId: barImportedCategory.id,
      menuType,
      isVeg,
      basePrice: row.bar,
    });
    if (barResult.created) barCreated += 1;
    else barUpdated += 1;

    if (restaurantResult) {
      priceRows += await upsertVenueRows(restaurantResult.item.id, row);
    }
    priceRows += await upsertVenueRows(barResult.item.id, row);

    const processed = BAR_ONLY ? barCreated + barUpdated : restaurantCreated + restaurantUpdated;
    if (processed % 50 === 0) {
      console.log(`Processed ${processed} / ${rows.length}`);
    }
  }

  console.log(`Restaurant created menu items: ${restaurantCreated}`);
  console.log(`Restaurant updated menu items: ${restaurantUpdated}`);
  console.log(`Bar created menu items: ${barCreated}`);
  console.log(`Bar updated menu items: ${barUpdated}`);
  console.log(`Upserted venue prices: ${priceRows}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
