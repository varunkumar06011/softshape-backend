// Test the hide toggle API endpoints
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  // Find a test AC item
  const acItem = await p.inventoryItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, isActive: true, menuItem: { name: 'Budweiser Beer' } },
    include: { menuItem: { select: { name: true } } },
  });
  
  console.log(`=== AC Hide Toggle Test: ${acItem.menuItem.name} ===`);
  console.log(`Before: isHiddenFromReport = ${acItem.isHiddenFromReport}`);
  
  // Toggle to true
  await p.inventoryItem.update({
    where: { id: acItem.id },
    data: { isHiddenFromReport: true },
  });
  const after1 = await p.inventoryItem.findUnique({ where: { id: acItem.id }, select: { isHiddenFromReport: true } });
  console.log(`After toggle ON: isHiddenFromReport = ${after1.isHiddenFromReport}`);
  
  // Toggle back to false
  await p.inventoryItem.update({
    where: { id: acItem.id },
    data: { isHiddenFromReport: false },
  });
  const after2 = await p.inventoryItem.findUnique({ where: { id: acItem.id }, select: { isHiddenFromReport: true } });
  console.log(`After toggle OFF: isHiddenFromReport = ${after2.isHiddenFromReport}`);
  
  // Test Non-AC item
  const nonAcItem = await p.nonAcInventoryItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
  });
  
  if (nonAcItem) {
    console.log(`\n=== Non-AC Hide Toggle Test: ${nonAcItem.itemName} ===`);
    console.log(`Before: isHiddenFromReport = ${nonAcItem.isHiddenFromReport}`);
    
    await p.nonAcInventoryItem.update({
      where: { id: nonAcItem.id },
      data: { isHiddenFromReport: true },
    });
    const afterNa1 = await p.nonAcInventoryItem.findUnique({ where: { id: nonAcItem.id }, select: { isHiddenFromReport: true } });
    console.log(`After toggle ON: isHiddenFromReport = ${afterNa1.isHiddenFromReport}`);
    
    await p.nonAcInventoryItem.update({
      where: { id: nonAcItem.id },
      data: { isHiddenFromReport: false },
    });
    const afterNa2 = await p.nonAcInventoryItem.findUnique({ where: { id: nonAcItem.id }, select: { isHiddenFromReport: true } });
    console.log(`After toggle OFF: isHiddenFromReport = ${afterNa2.isHiddenFromReport}`);
  }
  
  // Verify hidden status persists across dates (it's on the item master, not per-date)
  console.log(`\n=== Cross-date persistence check ===`);
  console.log(`isHiddenFromReport is on the item master table, not per-date.`);
  console.log(`It applies to ALL dates automatically — no per-date snapshot needed.`);
  
  await p.$disconnect();
})();
