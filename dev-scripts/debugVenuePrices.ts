/**
 * debugVenuePrices.ts
 * Checks if menu item IDs match venue price menuItemIds
 */

import prisma from "../src/lib/prisma";

async function main() {
  console.log("[Debug] Checking menu item IDs vs venue price menuItemIds...\n");

  // Get all bar menu items
  const BAR_ID = "bar-001";
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID, isDeleted: false },
    select: { id: true, name: true },
  });

  console.log(`Total bar menu items: ${menuItems.length}`);

  // Get all venue prices
  const venuePrices = await prisma.venuePrice.findMany({
    select: { venueId: true, menuItemId: true, price: true },
  });

  console.log(`Total venue price rows: ${venuePrices.length}`);

  // Check which menu items have venue prices
  const menuItemIds = new Set(menuItems.map(i => i.id));
  const venuePriceMenuItemIds = new Set(venuePrices.map(vp => vp.menuItemId));

  const unmatchedMenuItems = menuItems.filter(i => !venuePriceMenuItemIds.has(i.id));
  const orphanVenuePrices = venuePrices.filter(vp => !menuItemIds.has(vp.menuItemId));

  console.log(`\nMenu items WITHOUT venue prices: ${unmatchedMenuItems.length}`);
  if (unmatchedMenuItems.length > 0) {
    console.log("First 10:");
    unmatchedMenuItems.slice(0, 10).forEach(i => console.log(`  ${i.name} (${i.id})`));
  }

  console.log(`\nVenue prices for NON-EXISTENT menu items: ${orphanVenuePrices.length}`);
  if (orphanVenuePrices.length > 0) {
    console.log("First 10:");
    orphanVenuePrices.slice(0, 10).forEach(vp => console.log(`  ${vp.menuItemId} -> ${vp.venueId}`));
  }

  // Check venue-bar-conference specifically
  const confPrices = venuePrices.filter(vp => vp.venueId === "venue-bar-conference");
  console.log(`\nvenue-bar-conference prices: ${confPrices.length}`);
  if (confPrices.length > 0) {
    console.log("Sample prices:");
    confPrices.slice(0, 5).forEach(vp => {
      const item = menuItems.find(i => i.id === vp.menuItemId);
      console.log(`  ${item?.name || 'UNKNOWN'}: ₹${vp.price}`);
    });
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("[Debug] Fatal error:", err);
  process.exit(1);
});
