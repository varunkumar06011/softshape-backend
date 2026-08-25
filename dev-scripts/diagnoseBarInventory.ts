// Diagnose what's actually in the database for bar inventory
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // 1. List all outlets/restaurants
  console.log("=== ALL OUTLETS ===");
  const outlets = await prisma.outlet.findMany({
    select: { id: true, name: true, isActive: true },
    take: 50,
  });
  outlets.forEach((o) => console.log(`  ${o.id} | ${o.name} | active=${o.isActive}`));
  console.log(`Total outlets: ${outlets.length}\n`);

  // 2. Check if Z3695J exists at all
  const zItem = await prisma.outlet.findUnique({ where: { id: "Z3695J" } });
  console.log(`Z3695J exists: ${zItem ? "YES" : "NO"}\n`);

  // 3. Count ALL inventory items (any restaurantId)
  console.log("=== INVENTORY ITEM COUNTS BY RESTAURANT ===");
  const items = await prisma.inventoryItem.groupBy({
    by: ["restaurantId"],
    _count: { id: true },
    orderBy: { restaurantId: "asc" },
    take: 50,
  });
  items.forEach((i: any) =>
    console.log(`  restaurantId=${i.restaurantId} | count=${i._count.id}`)
  );
  console.log(`Total groups: ${items.length}\n`);

  // 4. For Z3695J specifically — show items regardless of isActive
  console.log("=== INVENTORY ITEMS FOR Z3695J (active + inactive) ===");
  const zItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: "Z3695J" },
    include: { menuItem: { select: { name: true } } },
    take: 10,
  });
  zItems.forEach((i: any) =>
    console.log(`  ${i.id} | ${i.menuItem?.name || "?"} | active=${i.isActive} | stock=${i.currentStock}`)
  );
  console.log(`Total for Z3695J: ${zItems.length}\n`);

  // 5. Sample inventory items from the first restaurant that has them
  if (items.length > 0) {
    const firstResto = items[0].restaurantId;
    console.log(`=== SAMPLE ITEMS FROM ${firstResto} ===`);
    const sample = await prisma.inventoryItem.findMany({
      where: { restaurantId: firstResto, isActive: true },
      include: { menuItem: { select: { name: true } } },
      take: 5,
    });
    sample.forEach((i) =>
      console.log(`  ${i.id} | ${i.menuItem?.name || "?"} | stock=${i.currentStock}`)
    );
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
