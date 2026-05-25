import { PrismaClient, TableStatus } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const RESTAURANT_ID = "restaurant-001";

interface MenuEntry {
  name: string;
  price: number;
  category: string;
  isVegetarian: boolean;
  isAvailable: boolean;
  outletId?: string;
}

function parseMenuFile(filePath: string): MenuEntry[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    throw new Error(`Could not parse menu array from ${filePath}`);
  }
  return JSON.parse(arrayMatch[0]) as MenuEntry[];
}

async function main() {
  const menuPath = path.resolve(__dirname, "../menu.txt");
  const entries = parseMenuFile(menuPath);

  console.log(`Seeding ${entries.length} menu items from menu.txt...`);

  await prisma.menuItemAddon.deleteMany({ where: { menuItem: { restaurantId: RESTAURANT_ID } } });
  await prisma.menuItemVariant.deleteMany({ where: { menuItem: { restaurantId: RESTAURANT_ID } } });
  await prisma.menuItem.deleteMany({ where: { restaurantId: RESTAURANT_ID } });
  await prisma.category.deleteMany({ where: { restaurantId: RESTAURANT_ID } });

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
    `Seeded ${categoryOrder.length} categories and ${entries.length} menu items.`
  );

  console.log("Seeding tables...");

  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: RESTAURANT_ID } } });
  await prisma.order.deleteMany({ where: { restaurantId: RESTAURANT_ID } });
  await prisma.table.deleteMany({ where: { restaurantId: RESTAURANT_ID } });
  await prisma.section.deleteMany({ where: { restaurantId: RESTAURANT_ID } });

  const mainHall = await prisma.section.create({
    data: {
      name: "Main Hall",
      restaurantId: RESTAURANT_ID,
    },
  });

  for (let i = 1; i <= 30; i++) {
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

  console.log('Seeded 1 section ("Main Hall") and 30 tables (1-30).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
