const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const RESTAURANT_ID = "restaurant-001";
const CSV_PATH =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
  path.join(process.env.USERPROFILE || "", "Downloads", "menu.csv");

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
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, "and")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ");
}

function money(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function bool(value, fallback = true) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function readRows() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const [headerLine, ...dataLines] = lines;
  const headers = parseCsvLine(headerLine).map((h) => normalize(h));

  return dataLines
    .map(parseCsvLine)
    .map((cells, index) => {
      const row = Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""]));
      return {
        sourceIndex: index,
        name: row.name?.trim(),
        price: money(row.price),
        category: row.category?.trim() || "General",
        isVeg: bool(row.isvegetarian, true),
        isAvailable: bool(row.isavailable, true),
      };
    })
    .filter((row) => row.name);
}

async function findOrCreateCategory(name, sortOrder) {
  const existing = await prisma.category.findFirst({
    where: { restaurantId: RESTAURANT_ID, name: { equals: name, mode: "insensitive" } },
  });
  if (existing) {
    if (existing.isActive === false) {
      return prisma.category.update({ where: { id: existing.id }, data: { isActive: true } });
    }
    return existing;
  }
  return prisma.category.create({
    data: { restaurantId: RESTAURANT_ID, name, sortOrder },
  });
}

async function main() {
  const rows = readRows();
  console.log(`Restaurant CSV rows: ${rows.length}`);

  const categoryOrder = new Map();
  for (const row of rows) {
    if (!categoryOrder.has(row.category)) categoryOrder.set(row.category, categoryOrder.size + 1);
  }

  const categories = new Map();
  for (const [name, order] of categoryOrder.entries()) {
    categories.set(name, await findOrCreateCategory(name, order));
  }

  const existingItems = await prisma.menuItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isDeleted: false },
    include: { variants: { orderBy: { isDefault: "desc" } } },
  });

  const byName = new Map();
  for (const item of existingItems) {
    const key = normalize(item.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }

  const csvKeys = new Set();
  const usedByName = new Map();
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const key = normalize(row.name);
    csvKeys.add(key);
    const usedCount = usedByName.get(key) || 0;
    usedByName.set(key, usedCount + 1);

    const item = (byName.get(key) || [])[usedCount];
    const category = categories.get(row.category);

    if (!item) {
      await prisma.menuItem.create({
        data: {
          name: row.name,
          restaurantId: RESTAURANT_ID,
          categoryId: category.id,
          isVeg: row.isVeg,
          isAvailable: row.isAvailable,
          isDeleted: false,
          menuType: "FOOD",
          sortOrder: row.sourceIndex,
          variants: {
            create: { name: "Regular", price: row.price, isDefault: true },
          },
        },
      });
      created += 1;
      continue;
    }

    await prisma.menuItem.update({
      where: { id: item.id },
      data: {
        name: row.name,
        categoryId: category.id,
        isVeg: row.isVeg,
        isAvailable: row.isAvailable,
        isDeleted: false,
        deletedAt: null,
        menuType: "FOOD",
        sortOrder: row.sourceIndex,
      },
    });

    const variant = item.variants.find((v) => v.isDefault) || item.variants[0];
    if (variant) {
      await prisma.menuItemVariant.update({
        where: { id: variant.id },
        data: { price: row.price, isDefault: true, isAvailable: true },
      });
    } else {
      await prisma.menuItemVariant.create({
        data: { menuItemId: item.id, name: "Regular", price: row.price, isDefault: true },
      });
    }
    updated += 1;
  }

  const toHide = existingItems.filter((item) => !csvKeys.has(normalize(item.name)));
  if (toHide.length > 0) {
    await prisma.menuItem.updateMany({
      where: { id: { in: toHide.map((item) => item.id) } },
      data: { isAvailable: false, isDeleted: true, deletedAt: new Date() },
    });
  }

  console.log(`Created restaurant items: ${created}`);
  console.log(`Updated restaurant items: ${updated}`);
  console.log(`Hidden non-CSV restaurant items: ${toHide.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
