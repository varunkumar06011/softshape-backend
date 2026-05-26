import { PrismaClient, TableStatus } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const RESTAURANT_ID = "restaurant-001";

interface MenuEntry {
  name: string;
  price: number;
  category: string;
  isVegetarian: boolean;
  isAvailable: boolean;
}

function findMenuFile(): string {
  // Try multiple locations to handle both dev (ts-node) and prod (node dist/)
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
    const tableCount = await prisma.table.count({
      where: { restaurantId: RESTAURANT_ID },
    });
    if (tableCount === 0) {
      let mainHall = await prisma.section.findFirst({
        where: { restaurantId: RESTAURANT_ID, name: "Main Hall" },
      });
      if (!mainHall) {
        mainHall = await prisma.section.create({
          data: { name: "Main Hall", restaurantId: RESTAURANT_ID },
        });
      }
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
    }

    const count = await prisma.menuItem.count({
      where: { restaurantId: RESTAURANT_ID },
    });

    if (count > 0) {
      console.log(
        `[AutoSeed] ${count} menu items already in DB — skipping seed.`
      );
      return;
    }

    console.log("[AutoSeed] Database is empty — seeding from menu.txt...");

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
