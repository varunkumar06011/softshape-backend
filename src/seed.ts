import { PrismaClient, TableStatus } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

function generateCode(): string {
  return "RESTAURANT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

interface MenuEntry {
  name: string;
  price: number;
  category: string;
  isVegetarian: boolean;
  isAvailable: boolean;
}

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

function parseMenuFile(filePath: string): MenuEntry[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    throw new Error(`Could not parse menu array from ${filePath}`);
  }
  return JSON.parse(arrayMatch[0]) as MenuEntry[];
}

export async function autoSeedIfEmpty(prisma: PrismaClient): Promise<void> {
  try {
    // If any restaurant exists, skip auto-seeding entirely
    const existingRestaurant = await prisma.restaurant.findFirst({ orderBy: { createdAt: "asc" } });
    if (existingRestaurant) {
      console.log("[AutoSeed] Restaurant already exists — skipping seed.");
      return;
    }

    // Create a generic placeholder restaurant
    const restaurantCode = generateCode();
    const restaurant = await prisma.restaurant.create({
      data: {
        name: "My Restaurant",
        restaurantCode,
        slug: restaurantCode.toLowerCase().replace(/[^a-z0-9]/g, ""),
        address: "",
        phone: "",
      },
    });
    const RESTAURANT_ID = restaurant.id;
    console.log(`[AutoSeed] Created placeholder restaurant ${restaurantCode} (${RESTAURANT_ID})`);

    // Seed tables
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
    console.log("[AutoSeed] Seeded 20 tables.");

    const menuPath = findMenuFile();
    const entries = parseMenuFile(menuPath);
    console.log(`[AutoSeed] Parsed ${entries.length} items from ${menuPath}`);

    // Seed categories
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

    // Seed menu items
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
            },
          },
        },
      });
    }

    console.log(
      `[AutoSeed] Done — ${categoryOrder.length} categories, ${entries.length} items.`
    );
  } catch (err) {
    console.error("[AutoSeed] Failed:", err);
    // Don't crash the server if seeding fails
  }
}
