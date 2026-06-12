/**
 * checkVenuePrices.ts
 * Quick diagnostic — counts VenuePrice rows per venue and shows sample data
 */

import prisma from "../lib/prisma";

async function main() {
  console.log("[Check] Counting VenuePrice rows per venue...\n");

  const allPrices = await prisma.venuePrice.findMany({
    select: { venueId: true, menuItemId: true, price: true },
  });

  const byVenue = new Map<string, number>();
  for (const vp of allPrices) {
    byVenue.set(vp.venueId, (byVenue.get(vp.venueId) || 0) + 1);
  }

  console.log("Total VenuePrice rows:", allPrices.length);
  console.log("\nRows per venue:");
  for (const [venueId, count] of Array.from(byVenue.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${venueId}: ${count}`);
  }

  console.log("\nSample prices for venue-bar-conference (first 5):");
  const confPrices = allPrices.filter(vp => vp.venueId === "venue-bar-conference").slice(0, 5);
  for (const vp of confPrices) {
    console.log(`  ${vp.menuItemId}: ₹${vp.price}`);
  }

  console.log("\nSample prices for venue-bar-pdr (first 5):");
  const pdrPrices = allPrices.filter(vp => vp.venueId === "venue-bar-pdr").slice(0, 5);
  for (const vp of pdrPrices) {
    console.log(`  ${vp.menuItemId}: ₹${vp.price}`);
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("[Check] Fatal error:", err);
  process.exit(1);
});
