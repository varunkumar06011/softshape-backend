/**
 * Backfill script: migrates existing kotHistory JSON blob data into
 * the new relational Kot and KotItem tables.
 *
 * Usage: npx tsx dev-scripts/backfillKotHistory.ts
 *
 * For each table that has a non-empty kotHistory JSON array:
 *   1. Find the active order for that table
 *   2. For each KOT entry in kotHistory, create a Kot row + KotItem rows
 *   3. Link KotItem.orderItemId to the matching OrderItem by orderItemId field
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting kotHistory backfill...');

  const tables = await prisma.table.findMany({
    where: {
      kotHistory: { not: [] as any },
    },
    select: {
      id: true,
      restaurantId: true,
      kotHistory: true,
      orders: {
        where: { status: { in: ['PREPARING', 'CONFIRMED', 'BILLING_REQUESTED', 'KOT_SENT'] } },
        select: { id: true, items: { select: { id: true, menuItemId: true, name: true, price: true, quantity: true, notes: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
    },
  });

  console.log(`Found ${tables.length} tables with non-empty kotHistory`);

  let totalKotsCreated = 0;
  let totalKotItemsCreated = 0;
  let skipped = 0;

  for (const table of tables) {
    const kotHistory = table.kotHistory as any[];
    if (!Array.isArray(kotHistory) || kotHistory.length === 0) {
      skipped++;
      continue;
    }

    const activeOrder = table.orders[0];
    if (!activeOrder) {
      console.log(`  Table ${table.id}: no active order, skipping ${kotHistory.length} KOT entries`);
      skipped++;
      continue;
    }

    for (const kotEntry of kotHistory) {
      const kotNumber = parseInt(kotEntry.id, 10);
      if (isNaN(kotNumber)) {
        console.log(`  Table ${table.id}: invalid kotNumber "${kotEntry.id}", skipping`);
        continue;
      }

      // Check if Kot already exists (idempotent)
      const existing = await prisma.kot.findUnique({
        where: { restaurantId_kotNumber: { restaurantId: table.restaurantId, kotNumber } },
      });
      if (existing) {
        continue;
      }

      const kotItems = kotEntry.items || [];
      const kotItemData: any[] = [];

      for (const item of kotItems) {
        // Find matching OrderItem by orderItemId
        const orderItemId = item.orderItemId;
        if (!orderItemId) continue;

        const orderItem = activeOrder.items.find((oi: any) => oi.id === orderItemId);
        if (!orderItem) continue;

        kotItemData.push({
          orderItemId: orderItem.id,
          menuItemId: orderItem.menuItemId,
          name: item.n ?? orderItem.name,
          quantity: item.q ?? orderItem.quantity,
          price: orderItem.price,
          notes: orderItem.notes,
          status: item.s === 'Cancelled' ? 'CANCELLED' : 'SENT',
        });
      }

      if (kotItemData.length === 0) continue;

      await prisma.kot.create({
        data: {
          restaurantId: table.restaurantId,
          tableId: table.id,
          orderId: activeOrder.id,
          kotNumber,
          items: { create: kotItemData },
        },
      });

      totalKotsCreated++;
      totalKotItemsCreated += kotItemData.length;
    }
  }

  console.log(`\nBackfill complete!`);
  console.log(`  KOTs created: ${totalKotsCreated}`);
  console.log(`  KOTItems created: ${totalKotItemsCreated}`);
  console.log(`  Tables skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
