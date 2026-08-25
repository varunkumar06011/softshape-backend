// Fix: "Mansion House 30ml" menu item should deduct from the 750ml bottle
// inventory (with spill to 180ml), not the empty "Mansion House 30ml" inventory row.
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";

async function main() {
  const inv750 = await prisma.inventoryItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, menuItem: { name: "Mansion House 750ml" } },
  });
  const inv180 = await prisma.inventoryItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, menuItem: { name: "Mansion House 180ml" } },
  });
  if (!inv750) throw new Error("Mansion House 750ml inventory not found");

  // Update all mappings for menu item "Mansion House 30ml"
  const menuItem = await prisma.menuItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, name: "Mansion House 30ml" },
  });
  if (!menuItem) throw new Error("Menu item Mansion House 30ml not found");

  const result = await prisma.barItemMapping.updateMany({
    where: { restaurantId: RESTAURANT_ID, menuItemId: menuItem.id },
    data: { primaryInvId: inv750.id, secondaryInvId: inv180?.id ?? null },
  });
  console.log(`Updated ${result.count} mapping(s) for "Mansion House 30ml" → 750ml bottle (+180ml spill)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
