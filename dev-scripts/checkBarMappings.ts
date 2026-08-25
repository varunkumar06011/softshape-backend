// Check BarItemMapping coverage for this outlet
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";

async function main() {
  const mappings = await prisma.barItemMapping.findMany({
    where: { restaurantId: RESTAURANT_ID },
    include: { menuItem: { select: { name: true, menuType: true } } },
  });
  console.log(`BarItemMapping count for ${RESTAURANT_ID}: ${mappings.length}\n`);
  for (const m of mappings) {
    console.log(`  ${m.menuItem?.name} @ ₹${m.variantPrice} → primary=${m.primaryInvId} mlPerUnit=${m.mlPerUnit}`);
  }

  // Count liquor menu items
  const liquorMenuItems = await prisma.menuItem.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      menuType: "LIQUOR",
      isAvailable: true,
    },
    include: { variants: true },
    take: 100,
  });
  console.log(`\nLiquor menu items (available): ${liquorMenuItems.length}`);

  const mappedIds = new Set(mappings.map((m) => m.menuItemId));
  const unmapped = liquorMenuItems.filter((mi) => !mappedIds.has(mi.id));
  console.log(`Unmapped liquor menu items: ${unmapped.length}\n`);
  for (const mi of unmapped.slice(0, 40)) {
    const prices = (mi as any).variants?.map((v: any) => `₹${v.price} (${v.label || "?"})`).join(", ") || "";
    console.log(`  ${mi.name} | ${prices || "no variants"}`);
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
