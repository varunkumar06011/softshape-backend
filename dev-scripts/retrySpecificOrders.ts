// Retry deduction for specific orders that failed due to transaction timeout.
// Uses a longer timeout (60s) to handle orders with many kitchen items.
//
// Usage: npx tsx dev-scripts/retrySpecificOrders.ts <restaurantId> <orderId1> <orderId2> ...

import prisma from '../src/lib/prisma';
import { deductInventoryForOrder } from '../src/services/inventoryService';

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  const orderIds = process.argv.slice(3);

  if (orderIds.length === 0) {
    console.error('Usage: npx tsx dev-scripts/retrySpecificOrders.ts <restaurantId> <orderId1> <orderId2> ...');
    process.exit(1);
  }

  console.log(`\n=== Retrying ${orderIds.length} orders for ${restaurantId} ===\n`);

  for (const orderId of orderIds) {
    console.log(`\nOrder ${orderId}:`);

    // Reset flag
    await prisma.order.update({
      where: { id: orderId },
      data: { barInventoryDeducted: false, inventoryDeducted: false },
    });

    try {
      const result = await prisma.$transaction(async (tx: any) => {
        return await deductInventoryForOrder(orderId, restaurantId, tx, null);
      }, { timeout: 60000, maxWait: 60000 });

      console.log(`  Bar errors: ${result.barDeductionErrors.length}`);
      for (const e of result.barDeductionErrors) console.log(`    - ${e}`);
      console.log(`  Kitchen errors: ${result.kitchenDeductionErrors.length}`);
      for (const e of result.kitchenDeductionErrors) console.log(`    - ${e}`);
      console.log(`  Inventory updates: ${result.inventoryUpdates.length}`);
      for (const u of result.inventoryUpdates) {
        console.log(`    - ${u.name}: ${u.currentStock}ml${u.isLowStock ? ' (LOW)' : ''}`);
      }
    } catch (err: any) {
      console.log(`  FAILED: ${err.message}`);
    }
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
