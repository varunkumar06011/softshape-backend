const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("=== Inspecting VenuePrices ===");
  const venuePrices = await prisma.venuePrice.findMany({});
  console.log(`Total VenuePrice records: ${venuePrices.length}`);
  
  const allItems = await prisma.menuItem.findMany({
    select: { id: true, name: true, restaurantId: true }
  });
  
  const itemMap = {};
  for (const item of allItems) {
    itemMap[item.id] = item;
  }
  
  console.log("\n=== VenuePrice records details (first 30) ===");
  for (let i = 0; i < Math.min(venuePrices.length, 30); i++) {
    const vp = venuePrices[i];
    const item = itemMap[vp.menuItemId];
    console.log(`Venue: ${vp.venueId} | Item ID: ${vp.menuItemId} | Name: ${item ? item.name : 'UNKNOWN'} | Restaurant: ${item ? item.restaurantId : 'UNKNOWN'} | Price: ${vp.price}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
