// ─────────────────────────────────────────────────────────────────────────────
// Auto-Seed Module — Dev/Test Database Initialization
// ─────────────────────────────────────────────────────────────────────────────
// On server startup (non-production only), if the database is completely empty,
// this module creates a placeholder restaurant with 20 tables and seeds menu
// items from a local menu.txt file. This lets developers spin up a working
// environment without manual data entry.
//
// How to use:
//   - Place a menu.txt file in the project root containing a JSON array of
//     MenuEntry objects: [{ name, price, category, isVegetarian, isAvailable }, ...]
//   - Start the server in development mode (NODE_ENV !== 'production')
//   - If the DB has no outlets, seeding runs automatically at boot.
//   - If any outlet already exists, seeding is skipped entirely.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient, TableStatus } from "@prisma/client";
import logger from "./lib/logger";
import * as fs from "fs";
import * as path from "path";

// Generates a random restaurant code like "RESTAURANT-A3F9KQ".
// Used as the unique join code that staff enter during login.
function generateCode(): string {
  return "RESTAURANT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Represents a single menu item entry parsed from the menu.txt seed file.
// Each entry becomes a MenuItem with one default "Regular" variant.
interface MenuEntry {
  name: string;
  price: number;
  category: string;
  isVegetarian: boolean;
  isAvailable: boolean;
}

// Searches for menu.txt in several candidate directories (cwd, relative to __dirname).
// Returns the first match. Throws if the file cannot be found in any location.
function findMenuFile(): string {
  const candidates = [
    path.resolve(process.cwd(), "menu.txt"),
    path.resolve(__dirname, "../menu.txt"),
    path.resolve(__dirname, "../../menu.txt"),
    path.resolve(__dirname, "menu.txt"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `menu.txt not found. Tried: ${candidates.join(", ")}`
  );
}

// Reads menu.txt and extracts the first JSON array from the file content.
// The file may contain non-JSON text around the array — we regex-match the
// first [...] block and parse it. Throws if no array is found or JSON is invalid.
function parseMenuFile(filePath: string): MenuEntry[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    throw new Error(`Could not parse menu array from ${filePath}`);
  }
  return JSON.parse(arrayMatch[0]) as MenuEntry[];
}

// Main auto-seed function. Called from index.ts at server boot.
//
// Steps:
//   1. Skip if NODE_ENV is 'production' (never seed in prod)
//   2. Skip if any outlet already exists in the DB
//   3. Create an Organization + Outlet (placeholder restaurant)
//   4. Create a "Main Hall" section with 20 tables (capacity 4, AVAILABLE)
//   5. Parse menu.txt and create Categories + MenuItems with default variants
//
// All errors are caught and logged — the server continues running even if seeding fails.
export async function autoSeedIfEmpty(prisma: PrismaClient): Promise<void> {
  try {
    // Never auto-seed in production — data must be created via onboarding only
    if (process.env.NODE_ENV === 'production') {
      logger.info('[AutoSeed] Skipped — production environment.');
      return;
    }

    // If any restaurant exists, skip auto-seeding entirely
    const existingRestaurant = await prisma.outlet.findFirst({ orderBy: { createdAt: "asc" } });
    if (existingRestaurant) {
      logger.info("[AutoSeed] Restaurant already exists — skipping seed.");
      return;
    }

    // Create a generic placeholder restaurant with a random join code
    const restaurantCode = generateCode();
    const org = await prisma.organization.create({ data: { name: "My Restaurant", plan: "starter" } });
    const restaurant = await prisma.outlet.create({
      data: {
        name: "My Restaurant",
        restaurantCode,
        slug: restaurantCode.toLowerCase().replace(/[^a-z0-9]/g, ""),
        address: "",
        phone: "",
        organizationId: org.id,
      },
    });
    const RESTAURANT_ID = restaurant.id;
    logger.info(`[AutoSeed] Created placeholder restaurant ${restaurantCode} (${RESTAURANT_ID})`);

    // Seed tables — one section "Main Hall" with 20 tables of capacity 4
    const mainHall = await prisma.section.create({
      data: { name: "Main Hall", restaurantId: RESTAURANT_ID },
    });
    for (let i = 1; i <= 20; i++) {
      await prisma.table.create({
        data: {
          number: i,
          capacity: 4,
          status: TableStatus.AVAILABLE,
          sectionId: mainHall.id,
          restaurantId: RESTAURANT_ID,
        },
      });
    }
    logger.info("[AutoSeed] Seeded 20 tables.");

    // Parse the menu.txt file to get seed entries
    const menuPath = findMenuFile();
    const entries = parseMenuFile(menuPath);
    logger.info(`[AutoSeed] Parsed ${entries.length} items from ${menuPath}`);

    // Seed categories — create one Category per unique category string in menu.txt
    // Categories are ordered by first appearance in the file
    const categoryOrder: string[] = [];
    const categoryMap = new Map<string, string>();

    for (const entry of entries) {
      if (!categoryMap.has(entry.category)) {
        categoryOrder.push(entry.category);
        const category = await prisma.category.create({
          data: {
            name: entry.category,
            sortOrder: categoryOrder.length - 1,
            restaurantId: RESTAURANT_ID,
          },
        });
        categoryMap.set(entry.category, category.id);
      }
    }

    // Seed menu items — each entry becomes a MenuItem with a default "Regular" variant
    // Items within a category are ordered by appearance (sortOrder increments per category)
    const itemCountByCategory = new Map<string, number>();
    for (const entry of entries) {
      const categoryId = categoryMap.get(entry.category)!;
      const sortOrder = itemCountByCategory.get(entry.category) ?? 0;
      itemCountByCategory.set(entry.category, sortOrder + 1);

      await prisma.menuItem.create({
        data: {
          name: entry.name,
          isVeg: entry.isVegetarian,
          isAvailable: entry.isAvailable,
          sortOrder,
          categoryId,
          restaurantId: RESTAURANT_ID,
          variants: {
            create: {
              name: "Regular",
              price: entry.price,
              isDefault: true,
              restaurantId: RESTAURANT_ID,
            },
          },
        },
      });
    }

    logger.info(
      `[AutoSeed] Done — ${categoryOrder.length} categories, ${entries.length} items.`
    );
  } catch (err) {
    logger.error({ err }, "[AutoSeed] Failed:");
    // Don't crash the server if seeding fails — log and continue
  }
}
