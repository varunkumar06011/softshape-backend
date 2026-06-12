/**
 * debugMenuItemIds.ts
 * Checks if bar menu item IDs match the venue price menuItemIds
 */

import prisma from "../lib/prisma";

async function main() {
  console.log("[Debug] Checking bar menu item IDs vs venue price keys...\n");

  // Get first 10 bar menu items
  const BAR_ID = "bar-001";
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID, isDeleted: false },
    select: { id: true, name: true },
    take: 10,
  });

  console.log("First 10 bar menu items:");
  for (const item of menuItems) {
    console.log(`  ${item.name}: ${item.id}`);
  }

  // Get venue-bar-conference prices
  const venuePrices = await prisma.venuePrice.findMany({
    where: { venueId: "venue-bar-conference", isActive: true },
    select: { menuItemId: true, price: true },
    take: 10,
  });

  console.log("\nFirst 10 venue-bar-conference prices:");
  for (const vp of venuePrices) {
    const item = menuItems.find(i => i.id === vp.menuItemId);
    console.log(`  ${item?.name || 'UNKNOWN'} (${vp.menuItemId}): ₹${vp.price}`);
  }

  // Check if any menu items don't have venue prices
  const allVenuePriceIds = await prisma.venuePrice.findMany({
    where: { venueId: "venue-bar-conference", isActive: true },
    select: { menuItemId: true },
  });
  const venuePriceIdSet = new Set(allVenuePriceIds.map(vp => vp.menuItemId));

  const itemsWithoutPrice = menuItems.filter(item => !venuePriceIdSet.has(item.id));
  console.log(`\nMenu items without venue-bar-conference price: ${itemsWithoutPrice.length}`);
  itemsWithoutPrice.forEach(item => {
    console.log(`  ${item.name}: ${item.id}`);
  });

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("[Debug] Fatal error:", err);
  process.exit(1);
});
