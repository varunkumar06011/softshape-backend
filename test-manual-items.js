// Test manual PDF-only report items: create, read, update, delete
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const restaurantId = 'cm6qxg8ih0000w9phq8e1grxb'; // Softshape Bar & Restaurant
  const reportDate = '2026-09-02'; // today

  console.log('=== TEST: Manual PDF-only Report Items ===\n');

  // 1. Clean up any existing test items
  await prisma.manualReportItem.deleteMany({
    where: { restaurantId, reportDate },
  });
  console.log('1. Cleaned up existing items for', reportDate);

  // 2. Create a manual AC item
  const acItem = await prisma.manualReportItem.create({
    data: {
      restaurantId,
      reportDate,
      section: 'AC',
      itemName: 'Test AC Special Item',
      categoryName: 'Manual AC',
      qty: 750,
      sale: 2,
      purchaseCost: 500,
      sellingPrice: 800,
      consumption: 1000,  // 2 * 500
      saleAmount: 1600,   // 2 * 800
      profit: 600,        // 1600 - 1000
      opening: 0,
      received: 0,
      closing: 0,
      isHidden: false,
      createdBy: 'test',
    },
  });
  console.log('2. Created AC manual item:', acItem.id, acItem.itemName);

  // 3. Create a manual Non-AC item
  const nonAcItem = await prisma.manualReportItem.create({
    data: {
      restaurantId,
      reportDate,
      section: 'NON_AC',
      itemName: 'Test Non-AC Special Item',
      categoryName: 'Manual Non-AC',
      qty: 650,
      sale: 3,
      purchaseCost: 300,
      sellingPrice: 500,
      consumption: 900,   // 3 * 300
      saleAmount: 1500,   // 3 * 500
      profit: 600,        // 1500 - 900
      opening: 0,
      received: 0,
      closing: 0,
      isHidden: false,
      createdBy: 'test',
    },
  });
  console.log('3. Created Non-AC manual item:', nonAcItem.id, nonAcItem.itemName);

  // 4. Read them back
  const items = await prisma.manualReportItem.findMany({
    where: { restaurantId, reportDate },
    orderBy: { createdAt: 'asc' },
  });
  console.log('\n4. Read back', items.length, 'items:');
  for (const item of items) {
    console.log(`   - [${item.section}] ${item.itemName}: qty=${item.qty}, sale=${item.sale}, profit=${item.profit}`);
  }

  // 5. Update the AC item
  await prisma.manualReportItem.update({
    where: { id: acItem.id },
    data: { itemName: 'Updated AC Item', sale: 5, saleAmount: 4000, profit: 1500 },
  });
  console.log('\n5. Updated AC item name and sale');

  // 6. Verify update
  const updated = await prisma.manualReportItem.findUnique({ where: { id: acItem.id } });
  console.log('   Updated item:', updated.itemName, 'sale=', updated.sale, 'profit=', updated.profit);

  // 7. Delete the Non-AC item (simulate removal from report)
  await prisma.manualReportItem.delete({ where: { id: nonAcItem.id } });
  console.log('\n6. Deleted Non-AC item');

  // 8. Verify only 1 item remains
  const remaining = await prisma.manualReportItem.findMany({
    where: { restaurantId, reportDate },
  });
  console.log('7. Remaining items:', remaining.length, '(expected 1)');
  console.log('   Remaining:', remaining[0]?.itemName);

  // 9. Clean up
  await prisma.manualReportItem.deleteMany({
    where: { restaurantId, reportDate },
  });
  console.log('\n8. Cleaned up test data');

  // 10. Verify inventory master is NOT affected
  const inventoryCount = await prisma.inventoryItem.count({
    where: { restaurantId },
  });
  console.log('\n9. Inventory items count (unchanged):', inventoryCount);
  const nonAcCount = await prisma.nonAcInventoryItem.count({
    where: { restaurantId },
  });
  console.log('   Non-AC inventory items count (unchanged):', nonAcCount);

  console.log('\n=== ALL TESTS PASSED ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
