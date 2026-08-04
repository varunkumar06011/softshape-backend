/**
 * Dev script: Fix barInventoryDeducted flag for existing paid orders.
 *
 * Resets barInventoryDeducted to false for all non-CANCELLED orders that have
 * LIQUOR items but no corresponding inventory SALE transactions — meaning bar
 * stock was never deducted at settlement due to the schema default(true) bug.
 *
 * After running this, use POST /api/bar/inventory/retry-deduction/:orderId
 * for each affected order to actually deduct the bar inventory.
 *
 * Usage: npx tsx dev-scripts/fixBarInventoryDeductedFlag.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('[FixBarInventory] Scanning for affected orders...');

  const affectedOrders = await prisma.$queryRaw<Array<{ id: string; restaurantId: string }>>`
    SELECT o.id, o."restaurantId"
    FROM "Order" o
    WHERE o."barInventoryDeducted" = true
      AND o.status != 'CANCELLED'
      AND EXISTS (
        SELECT 1
        FROM "OrderItem" oi
        JOIN "MenuItem" mi ON mi.id = oi."menuItemId"
        WHERE oi."orderId" = o.id
          AND oi."removedFromBill" = false
          AND oi.quantity > 0
          AND mi."menuType" = 'LIQUOR'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "inventory_transactions" it
        WHERE it."orderId" = o.id
          AND it.type = 'SALE'
      )
  `;

  console.log(`[FixBarInventory] Found ${affectedOrders.length} affected orders.`);

  if (affectedOrders.length === 0) {
    console.log('[FixBarInventory] No orders need fixing. Exiting.');
    return;
  }

  const orderIds = affectedOrders.map(o => o.id);

  const result = await prisma.$executeRaw`
    UPDATE "Order" o
    SET "barInventoryDeducted" = false
    WHERE o.id IN (${Prisma.join(orderIds)})
  `;

  console.log(`[FixBarInventory] Updated ${result} orders. barInventoryDeducted set to false.`);
  console.log('[FixBarInventory] Affected order IDs:');
  for (const order of affectedOrders) {
    console.log(`  - ${order.id} (restaurant: ${order.restaurantId})`);
  }
  console.log('');
  console.log('[FixBarInventory] Next steps:');
  console.log('  For each order above, call: POST /api/bar/inventory/retry-deduction/:orderId');
  console.log('  to actually deduct the bar inventory stock.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
