// Check today's PAID (settled) orders and whether bar inventory was deducted
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const DAY_START = new Date("2026-08-24T00:00:00.000+05:30");
const DAY_END = new Date("2026-08-25T00:00:00.000+05:30");

async function main() {
  console.log(`Checking settled bills for ${RESTAURANT_ID} on 24.08.2026 (IST)\n`);

  const paidOrders = await prisma.order.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      status: "PAID",
      createdAt: { gte: DAY_START, lt: DAY_END },
    },
    select: {
      id: true,
      status: true,
      barInventoryDeducted: true,
      inventoryDeducted: true,
      inventoryReversed: true,
      totalAmount: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`PAID orders today: ${paidOrders.length}\n`);

  let deducted = 0;
  let notDeducted = 0;
  for (const o of paidOrders) {
    const tag = o.barInventoryDeducted ? "DEDUCTED" : "NOT-DEDUCTED";
    if (o.barInventoryDeducted) deducted++; else notDeducted++;
    console.log(
      `  ${o.id.slice(-8)} | ₹${o.totalAmount} | ${tag} | barInv=${o.barInventoryDeducted} inv=${o.inventoryDeducted} reversed=${o.inventoryReversed} | ${o.createdAt.toISOString()}`
    );
  }

  console.log(`\nDeducted: ${deducted} | Not deducted: ${notDeducted}`);

  // Also check today's SALE transactions to confirm stock movement
  const todaySales = await prisma.inventoryTransaction.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      type: "SALE",
      transactionDate: { gte: DAY_START, lt: DAY_END },
    },
    select: { itemId: true, quantityChange: true, notes: true, transactionDate: true },
  });

  console.log(`\nSALE inventory transactions today: ${todaySales.length}`);
  for (const t of todaySales) {
    console.log(`  ${t.transactionDate.toISOString()} | ${t.quantityChange}ml | ${t.notes || ""}`);
  }

  // Any failed deduction logs pending retry?
  const failedLogs = await prisma.barDeductionLog.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      status: "FAILED",
      createdAt: { gte: DAY_START, lt: DAY_END },
    },
    select: { orderId: true, inventoryItemId: true, quantity: true, error: true },
  });
  console.log(`\nFailed deduction logs today: ${failedLogs.length}`);
  for (const f of failedLogs) {
    console.log(`  order=${f.orderId} item=${f.inventoryItemId} qty=${f.quantity} error=${f.error}`);
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
