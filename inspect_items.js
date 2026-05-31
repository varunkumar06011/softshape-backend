const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("=== Inspecting MenuItems ===");
  const items = await prisma.menuItem.findMany({
    select: { id: true, name: true, restaurantId: true, isDeleted: true }
  });
  console.log(`Total MenuItems: ${items.length}`);
  
  const nameCounts = {};
  for (const item of items) {
    const key = `${item.name.trim().toLowerCase()} @ ${item.restaurantId}`;
    if (!nameCounts[key]) nameCounts[key] = [];
    nameCounts[key].push(item);
  }
  
  console.log("\n=== Duplicate Menu Items (Same Name & Same Restaurant) ===");
  let hasDuplicates = false;
  for (const [key, list] of Object.entries(nameCounts)) {
    if (list.length > 1) {
      console.log(`- "${key}": ${list.length} occurrences`);
      list.forEach(item => console.log(`  * ID: ${item.id}, isDeleted: ${item.isDeleted}`));
      hasDuplicates = true;
    }
  }
  if (!hasDuplicates) {
    console.log("No duplicates found!");
  }
  
  console.log("\n=== Items with Missing or Empty Names ===");
  const missingNames = items.filter(item => !item.name || item.name.trim() === "");
  console.log(`Missing names count: ${missingNames.length}`);
  missingNames.forEach(item => console.log(`  * ID: ${item.id}, Restaurant: ${item.restaurantId}`));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
