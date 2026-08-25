// ─────────────────────────────────────────────────────────────────────────────
// deductTodayBills.ts — Run bar inventory deduction for all of today's PAID
// (settled) orders that were never deducted. Uses the same deductInventoryForOrder
// service the cashier settle flow uses — idempotent via BarDeductionLog and
// order flags, so it will not double-deduct.
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' dev-scripts/deductTodayBills.ts
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { deductInventoryForOrder } from "../src/services/inventoryService";

const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const DAY_START = new Date("2026-08-24T00:00:00.000+05:30");
const DAY_END = new Date("2026-08-25T00:00:00.000+05:30");

const APPLY = true; // false = dry run (list only)

async function main() {
  console.log(`Deducting today's settled bills for ${RESTAURANT_ID}`);
  console.log(`Window: ${DAY_START.toISOString()} → ${DAY_END.toISOString()} (IST 24.08.2026)`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const orders = await prisma.order.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      status: "PAID",
      barInventoryDeducted: false,
      createdAt: { gte: DAY_START, lt: DAY_END },
    },
    select: { id: true, totalAmount: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`PAID orders pending bar deduction: ${orders.length}\n`);

  if (!APPLY) {
    orders.forEach((o) => console.log(`  ${o.id} | ₹${o.totalAmount} | ${o.createdAt.toISOString()}`));
    await prisma.$disconnect();
    return;
  }

  let ok = 0;
  let failed = 0;

  for (const o of orders) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        return deductInventoryForOrder(o.id, RESTAURANT_ID, tx, null);
      }, { timeout: 15000, maxWait: 20000 });

      const barErr = result.barDeductionErrors.length;
      const updated = result.inventoryUpdates.length;

      if (barErr > 0) {
        console.log(`⚠ ${o.id.slice(-8)} | ₹${o.totalAmount} | ${updated} items deducted, ${barErr} errors: ${result.barDeductionErrors.join("; ")}`);
      } else {
        console.log(`✓ ${o.id.slice(-8)} | ₹${o.totalAmount} | ${updated} items deducted`);
      }
      ok++;
    } catch (err: any) {
      console.log(`✗ ${o.id.slice(-8)} | ₹${o.totalAmount} | FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Succeeded: ${ok} | Failed: ${failed}`);
  console.log(`========================================`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
