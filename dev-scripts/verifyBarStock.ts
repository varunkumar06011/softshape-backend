// ─────────────────────────────────────────────────────────────────────────────
// verifyBarStock.ts — Verify InventoryItem.currentStock matches the sum of
// all recorded transactions (SALE, PURCHASE, WASTAGE, ADJUSTMENT, SALE_REVERSAL).
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' dev-scripts/verifyBarStock.ts
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RESTAURANT_ID = process.argv[2] || "cmqy60ci200027dscyj9ubg8h";
// Baseline date: transactions before this IST day are embodied in the physical
// count and must NOT be summed again (they would double-count the baseline).
const BASELINE_START = new Date("2026-08-24T00:00:00.000+05:30");

async function main() {
  console.log(`Verifying bar inventory stock for: ${RESTAURANT_ID}\n`);

  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
    orderBy: { menuItem: { name: "asc" } },
  });

  if (items.length === 0) {
    console.log("No active bar inventory items found.");
    process.exit(0);
  }

  // Load post-baseline transactions only. Pre-baseline transactions are
  // already reflected in the physical count that set openingStock.
  // Also exclude the baseline-setting ADJUSTMENT rows themselves — they
  // record the change FROM old system stock TO the physical baseline, so
  // counting them on top of openingStock would double-count the baseline.
  const txns = await prisma.inventoryTransaction.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      transactionDate: { gte: BASELINE_START },
      NOT: { notes: { startsWith: "Physical snapshot" } },
    },
    select: { itemId: true, type: true, quantityChange: true, stockBefore: true, stockAfter: true, notes: true, transactionDate: true },
    orderBy: { transactionDate: "asc" },
  });

  // Group by item
  const txnMap = new Map<string, typeof txns>();
  for (const t of txns) {
    if (!txnMap.has(t.itemId)) txnMap.set(t.itemId, []);
    txnMap.get(t.itemId)!.push(t);
  }

  let perfectCount = 0;
  let driftCount = 0;
  const driftItems: Array<{
    name: string;
    openingStock: number;
    currentStock: number;
    expectedStock: number;
    variance: number;
    saleTotal: number;
    purchaseTotal: number;
    wastageTotal: number;
    adjustmentTotal: number;
    reversalTotal: number;
    txnCount: number;
  }> = [];

  for (const item of items) {
    const itemTxns = txnMap.get(item.id) || [];

    let purchased = 0;
    let sold = 0;
    let wastage = 0;
    let adjusted = 0;
    let reversed = 0;

    for (const t of itemTxns) {
      const qty = Number(t.quantityChange);
      switch (t.type) {
        case "PURCHASE": purchased += qty; break;
        case "SALE": sold += Math.abs(qty); break;
        case "WASTAGE": wastage += Math.abs(qty); break;
        case "ADJUSTMENT": adjusted += qty; break;
        case "SALE_REVERSAL": reversed += Math.abs(qty); break;
      }
    }

    const opening = Number(item.openingStock);
    const current = Number(item.currentStock);
    const expected = Math.round((opening + purchased - sold - wastage + adjusted + reversed) * 100) / 100;
    const variance = Math.round((current - expected) * 100) / 100;

    if (Math.abs(variance) <= 0.01) {
      perfectCount++;
    } else {
      driftCount++;
      driftItems.push({
        name: item.menuItem?.name || item.id,
        openingStock: opening,
        currentStock: current,
        expectedStock: expected,
        variance,
        saleTotal: sold,
        purchaseTotal: purchased,
        wastageTotal: wastage,
        adjustmentTotal: adjusted,
        reversalTotal: reversed,
        txnCount: itemTxns.length,
      });
    }
  }

  console.log("========================================");
  console.log(`Total Items:      ${items.length}`);
  console.log(`Perfect Match:    ${perfectCount}`);
  console.log(`Drift / Variance: ${driftCount}`);
  console.log(`========================================\n`);

  if (driftCount === 0) {
    console.log("✅ ALL ITEMS MATCH. currentStock is perfectly aligned with transaction history.");
    console.log("   Every settled bill's deduction is accounted for.");
  } else {
    console.log("⚠️  ITEMS WITH VARIANCE (currentStock ≠ expected from transactions):\n");
    console.log(
      "Item Name".padEnd(30) +
      "Opening".padStart(10) +
      "Current".padStart(10) +
      "Expected".padStart(10) +
      "Variance".padStart(10) +
      "Sales".padStart(10) +
      "Purch".padStart(8) +
      "Txn#".padStart(5)
    );
    console.log("-".repeat(100));
    for (const d of driftItems) {
      console.log(
        d.name.slice(0, 28).padEnd(30) +
        String(d.openingStock).padStart(10) +
        String(d.currentStock).padStart(10) +
        String(d.expectedStock).padStart(10) +
        String(d.variance).padStart(10) +
        String(d.saleTotal).padStart(10) +
        String(d.purchaseTotal).padStart(8) +
        String(d.txnCount).padStart(5)
      );
    }
    console.log("\n⚠️  These items have drift. Causes could be:");
    console.log("   • Bills settled before inventory tracking was enabled");
    console.log("   • Manual database edits to currentStock");
    console.log("   • Failed deductions that were never retried");
    console.log("   • Voided bills where inventory reversal failed");
    console.log("\n👉 Run the snapshot initialization to reset the baseline.");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
