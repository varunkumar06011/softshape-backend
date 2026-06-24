import { PrismaClient, TableStatus } from "@prisma/client";

const prisma = new PrismaClient();
const RESTAURANT_IDS = ["bar-001", "restaurant-001"];

async function main() {
  console.log('WARNING: This will delete ALL transactions for bar-001 and restaurant-001.');
  console.log('Menu, staff, tables structure, and settings are preserved.');
  console.log('Press Ctrl+C within 5 seconds to cancel...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log('Proceeding with deletion...');

  const results = await prisma.$transaction([
    // 1. InventoryTransaction (references InventoryItem, has restaurantId)
    prisma.inventoryTransaction.deleteMany({
      where: { restaurantId: { in: RESTAURANT_IDS } }
    }),

    // 2. OrderItem (references Order, no restaurantId - delete via relation)
    prisma.orderItem.deleteMany({
      where: { order: { restaurantId: { in: RESTAURANT_IDS } } }
    }),

    // 3. Transaction (references Order, has restaurantId)
    prisma.transaction.deleteMany({
      where: { restaurantId: { in: RESTAURANT_IDS } }
    }),

    // 4. DailyCounter (bill/kot counters, has restaurantId)
    prisma.dailyCounter.deleteMany({
      where: { restaurantId: { in: RESTAURANT_IDS } }
    }),

    // 5. Order (references Table, has restaurantId)
    prisma.order.deleteMany({
      where: { restaurantId: { in: RESTAURANT_IDS } }
    }),

    // 6. Reset Table records to free state
    prisma.table.updateMany({
      where: { restaurantId: { in: RESTAURANT_IDS } },
      data: {
        status: TableStatus.AVAILABLE,
        currentBill: 0,
        kotHistory: [],
        captainId: null,
        guests: 0,
        sessionStartedAt: null,
        discount: null,
        workflowStatus: null
      }
    })
  ]);

  const [
    inventoryTxDeleted,
    orderItemsDeleted,
    transactionsDeleted,
    dailyCountersDeleted,
    ordersDeleted,
    tablesReset
  ] = results;

  console.log('\n=== Deletion Summary ===');
  console.log(`InventoryTransaction: ${inventoryTxDeleted.count} deleted`);
  console.log(`OrderItem: ${orderItemsDeleted.count} deleted`);
  console.log(`Transaction: ${transactionsDeleted.count} deleted`);
  console.log(`DailyCounter: ${dailyCountersDeleted.count} deleted`);
  console.log(`Order: ${ordersDeleted.count} deleted`);
  console.log(`Table: ${tablesReset.count} reset to free state`);
  console.log('\nAll transaction data cleared successfully.');
  console.log('Bill No and KOT No counters will restart from 1.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
