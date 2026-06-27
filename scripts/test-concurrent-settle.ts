/**
 * Concurrent settle test — bypasses HTTP, directly tests the database-level
 * race condition by spawning two concurrent prisma.$transaction calls that
 * both try to settle the same order.
 *
 * This tests the actual FOR UPDATE row lock + status guard + unique constraint
 * without needing a running server or auth tokens.
 *
 * Usage:
 *   npx tsx scripts/test-concurrent-settle.ts
 *
 * Expected: one transaction succeeds, the other throws "Order is already paid"
 *           or P2002 unique constraint violation. Exactly 1 Transaction row.
 */
import { PrismaClient, Prisma, OrderStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. Find or create a test order in a non-PAID state
  let order = await prisma.order.findFirst({
    where: {
      status: { in: [OrderStatus.BILLING_REQUESTED, OrderStatus.PREPARING, OrderStatus.CONFIRMED] },
      isDeleted: false,
    },
    include: {
      items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: true } },
      table: true,
    },
  });

  if (!order) {
    // Find any table
    const table = await prisma.table.findFirst({
      where: { status: 'OCCUPIED' },
    });

    if (!table) {
      console.error('No suitable order or table found for testing. Create an order first.');
      process.exit(1);
    }

    // Create a minimal order
    order = await prisma.order.create({
      data: {
        tableId: table.id,
        restaurantId: table.restaurantId,
        status: OrderStatus.BILLING_REQUESTED,
        billingRequested: true,
        billNumber: 'TEST-CONCURRENT-' + Date.now(),
      },
      include: {
        items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: true } },
        table: true,
      },
    });

    // Add a test item
    const menuItem = await prisma.menuItem.findFirst({
      where: { restaurantId: table.restaurantId },
    });

    if (menuItem) {
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          menuItemId: menuItem.id,
          name: menuItem.name,
          price: menuItem.price,
          quantity: 1,
          menuType: menuItem.menuType,
        },
      });
      order = await prisma.order.findUnique({
        where: { id: order.id },
        include: {
          items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: true } },
          table: true,
        },
      })!;
    }
  }

  const orderId = order.id;
  const restaurantId = order.restaurantId;
  const tableId = order.tableId;

  console.log(`Test order: ${orderId}`);
  console.log(`Restaurant: ${restaurantId}`);
  console.log(`Status: ${order.status}`);
  console.log(`Items: ${order.items.length}`);
  console.log(`Table: ${tableId}`);
  console.log('\n--- Firing two concurrent settle transactions ---\n');

  // Count existing transactions for this order
  const txnsBefore = await prisma.transaction.findMany({
    where: { orderId },
    select: { id: true, txnNumber: true },
  });
  console.log(`Transactions before test: ${txnsBefore.length}`);

  // 2. Fire two concurrent settle transactions
  const settleFn = async (label: string, requestId: string) => {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Idempotency check
        const existing = await tx.processedRequest.findUnique({
          where: {
            requestId_actionType_restaurantId: {
              requestId,
              actionType: 'settle',
              restaurantId,
            },
          },
        });
        if (existing) return { skipped: true, result: existing.result };

        // FOR UPDATE lock
        const lockedRows = await tx.$queryRaw<Array<{
          id: string; status: string; billNumber: string | null; tableId: string;
          inventoryDeducted: boolean; platform: string | null;
        }>>`
          SELECT "id", "status", "billNumber", "tableId", "inventoryDeducted", "platform"
          FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
        `;
        const lockedRow = lockedRows[0];

        if (!lockedRow) throw new Error('Order not found inside transaction');

        if (lockedRow.status === 'PAID') {
          throw new Error('Order is already paid');
        }

        // Fetch full order
        const lockedOrder = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: true } },
            table: true,
          },
        });

        if (!lockedOrder) throw new Error('Order not found (post-lock)');

        // Generate txn number
        const counterDate = new Date().toISOString().split('T')[0];
        const counter = await tx.dailyCounter.upsert({
          where: { restaurantId_counterDate: { restaurantId, counterDate } },
          update: { txnCount: { increment: 1 } },
          create: { restaurantId, counterDate, txnCount: 1 },
          select: { txnCount: true },
        });

        const txnNumber = counter.txnCount;

        // Create transaction record
        const createdTxn = await tx.transaction.create({
          data: {
            restaurantId,
            orderId: lockedOrder.id,
            tableNumber: lockedOrder.table.number,
            amount: new Prisma.Decimal(100),
            method: 'CASH',
            itemCount: 1,
            items: [{ name: 'Test Item', quantity: 1, price: 100, menuType: 'FOOD' }],
            txnNumber,
            txnDate: counterDate,
            paidAt: new Date(),
            subtotal: new Prisma.Decimal(100),
            discountPercent: new Prisma.Decimal(0),
            discountAmount: new Prisma.Decimal(0),
            cgst: new Prisma.Decimal(0),
            sgst: new Prisma.Decimal(0),
            grandTotal: new Prisma.Decimal(100),
          },
        });

        // Update order to PAID
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.PAID,
            billingRequested: false,
            paidAt: new Date(),
            inventoryDeducted: true,
          },
        });

        // Reset table
        await tx.table.update({
          where: { id: tableId },
          data: {
            status: 'AVAILABLE',
            workflowStatus: 'Free',
            captainId: null,
            guests: 0,
            sessionStartedAt: null,
            currentBill: 0,
            kotHistory: [],
            discount: null,
          },
        });

        // Write idempotency record
        await tx.processedRequest.create({
          data: {
            requestId,
            actionType: 'settle',
            orderId: lockedOrder.id,
            restaurantId,
            result: { txnNumber, transactionId: createdTxn.id } as any,
          },
        });

        return { skipped: false, txnNumber, transactionId: createdTxn.id };
      }, { timeout: 15000, maxWait: 20000 });

      console.log(`[${label}] SUCCESS: txnNumber=${result.txnNumber}, skipped=${result.skipped}`);
      return { label, success: true, result };
    } catch (err: any) {
      console.log(`[${label}] FAILED: ${err.message}`);
      if (err.code) console.log(`[${label}] Error code: ${err.code}`);
      return { label, success: false, error: err.message, code: err.code };
    }
  };

  const requestIdA = `concurrent-test-A-${Date.now()}`;
  const requestIdB = `concurrent-test-B-${Date.now()}`;

  const [resultA, resultB] = await Promise.all([
    settleFn('A', requestIdA),
    settleFn('B', requestIdB),
  ]);

  // 3. Verify database state
  console.log('\n--- Verifying database state ---\n');

  const txnsAfter = await prisma.transaction.findMany({
    where: { orderId },
    select: { id: true, txnNumber: true, method: true, paidAt: true },
  });

  console.log(`Transactions for order after test: ${txnsAfter.length}`);
  for (const t of txnsAfter) {
    console.log(`  id=${t.id}, txnNumber=${t.txnNumber}, method=${t.method}, paidAt=${t.paidAt}`);
  }

  const finalOrder = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });
  console.log(`Order status: ${finalOrder?.status}`);

  // 4. Assertions
  console.log('\n--- Verdict ---');

  const successCount = [resultA, resultB].filter(r => r.success && !(r as any).result?.skipped).length;
  const failCount = [resultA, resultB].filter(r => !r.success).length;
  const newTxns = txnsAfter.length - txnsBefore.length;

  if (successCount === 1 && failCount === 1) {
    console.log('PASS: Exactly one settle succeeded, one failed. No double-charge.');
  } else if (successCount === 2) {
    console.log('FAIL: Both requests succeeded — DOUBLE SETTLE detected!');
  } else {
    console.log(`UNEXPECTED: ${successCount} succeeded, ${failCount} failed`);
  }

  if (newTxns === 1) {
    console.log('PASS: Exactly 1 new transaction record created.');
  } else if (newTxns === 0) {
    console.log('FAIL: No transaction record created — settle did not complete.');
  } else {
    console.log(`FAIL: ${newTxns} new transaction records — should be exactly 1.`);
  }

  // Check which error the loser got
  const loser = [resultA, resultB].find(r => !r.success);
  if (loser) {
    if (loser.error === 'Order is already paid') {
      console.log('PASS: Loser got "Order is already paid" (FOR UPDATE guard worked).');
    } else if (loser.code === 'P2002') {
      console.log('PASS: Loser got P2002 unique constraint (backstop worked).');
    } else {
      console.log(`WARN: Loser got unexpected error: ${loser.error} (code: ${loser.code})`);
    }
  }

  // Cleanup
  if (finalOrder?.status !== 'PAID') {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PAID, paidAt: new Date() },
    });
    console.log('\n(Cleanup: marked test order as PAID)');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
