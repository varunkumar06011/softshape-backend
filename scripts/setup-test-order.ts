/**
 * Setup: create a test order with an item so we can run the concurrent settle test.
 * Run: npx tsx scripts/setup-test-order.ts
 */
import { PrismaClient, OrderStatus, TableStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find any menu item — use its restaurant
  const menuItem = await prisma.menuItem.findFirst();
  if (!menuItem) {
    console.error('No menu item found in database');
    process.exit(1);
  }

  const restaurantId = menuItem.restaurantId;

  // Find any section for this restaurant
  const section = await prisma.section.findFirst({
    where: { restaurantId },
  });
  if (!section) {
    console.error(`No section found for restaurant ${restaurantId}`);
    process.exit(1);
  }

  // Find or create a table in this section
  let table = await prisma.table.findFirst({
    where: { restaurantId, sectionId: section.id, status: TableStatus.AVAILABLE },
  });

  if (!table) {
    table = await prisma.table.create({
      data: {
        number: 999,
        restaurantId,
        sectionId: section.id,
        status: TableStatus.AVAILABLE,
        workflowStatus: 'Free',
      },
    });
    console.log(`Created test table: ${table.id} (number 999)`);
  }

  // Create order
  const order = await prisma.order.create({
    data: {
      tableId: table.id,
      restaurantId,
      status: OrderStatus.BILLING_REQUESTED,
      billingRequested: true,
      billNumber: 'TEST-CONCURRENT-' + Date.now(),
    },
  });

  // Add an item
  await prisma.orderItem.create({
    data: {
      orderId: order.id,
      menuItemId: menuItem.id,
      name: menuItem.name,
      price: menuItem.basePrice,
      quantity: 1,
      menuType: menuItem.menuType,
    },
  });

  // Set table to OCCUPIED
  await prisma.table.update({
    where: { id: table.id },
    data: { status: TableStatus.OCCUPIED, workflowStatus: 'Running' },
  });

  console.log(`Created test order: ${order.id}`);
  console.log(`Restaurant: ${restaurantId}`);
  console.log(`Table: ${table.id} (number ${table.number})`);
  console.log(`Item: ${menuItem.name} @ ${menuItem.basePrice}`);
  console.log(`\nNow run: npx tsx scripts/test-concurrent-settle.ts`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
