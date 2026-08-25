import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
    orderBy: { menuItem: { name: "asc" } },
  });
  console.log(`Total: ${items.length}\n`);
  console.log("ID | Name | BottleSize | OpeningStock | CurrentStock");
  console.log("-".repeat(120));
  for (const i of items) {
    console.log(`${i.id} | ${i.menuItem?.name || "?"} | ${i.bottleSize || "?"} | ${i.openingStock} | ${i.currentStock}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
