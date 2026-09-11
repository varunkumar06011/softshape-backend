// rebuild-daily-records.js — Rebuild BarDailyRecord entries from movements
// starting from the import date. This fixes the discrepancy between the
// dashboard (live stock) and the PDF report (daily records).
//
// Usage:
//   node scripts/rebuild-daily-records.js              — DRY RUN
//   node scripts/rebuild-daily-records.js --apply      — write to DB

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RID = "cmqy60ci200027dscyj9ubg8h";
const FROM_DATE = "2026-09-08";

// Inline the recalculation logic (same as barInventoryService.ts)
// to avoid TypeScript compilation issues.

function getKolkataDateString() {
  const now = new Date();
  const kolkata = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = kolkata.getFullYear();
  const m = String(kolkata.getMonth() + 1).padStart(2, "0");
  const d = String(kolkata.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getPreviousDate(date) {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function getDateRange(from, to) {
  const dates = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    const d = new Date(current + "T00:00:00");
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    current = `${y}-${m}-${dd}`;
  }
  return dates;
}

async function recalculateDailyRecord(tx, restaurantId, itemId, date) {
  const movements = await tx.barInventoryMovement.findMany({
    where: { restaurantId, itemId, date },
    orderBy: { createdAt: "asc" },
  });

  let purchasedMl = 0, acSaleMl = 0, nonAcSaleMl = 0, wastageMl = 0, adjustmentMl = 0;
  let openingOverrideMl = null;

  for (const m of movements) {
    const qty = Number(m.quantityMl);
    switch (m.movementType) {
      case "PURCHASE": purchasedMl += qty; break;
      case "AC_SALE": acSaleMl += Math.abs(qty); break;
      case "SALE_REVERSAL": acSaleMl -= qty; break;
      case "NON_AC_SALE": nonAcSaleMl += Math.abs(qty); break;
      case "WASTAGE": wastageMl += Math.abs(qty); break;
      case "ADJUSTMENT": adjustmentMl += qty; break;
      case "OPENING": openingOverrideMl = Math.abs(qty); break;
      case "PHYSICAL_COUNT": break;
      case "CORRECTION": adjustmentMl += qty; break;
    }
  }

  acSaleMl = Math.max(0, acSaleMl);

  const prevDate = getPreviousDate(date);
  const prevRecord = await tx.barDailyRecord.findUnique({
    where: { restaurantId_date_itemId: { restaurantId, date: prevDate, itemId } },
  });

  const openingMl = openingOverrideMl ?? (prevRecord
    ? Number(prevRecord.physicalClosingMl ?? prevRecord.systemClosingMl)
    : 0);

  const systemClosingMl = openingMl + purchasedMl - acSaleMl - nonAcSaleMl - wastageMl + adjustmentMl;

  const item = await tx.barInventoryItem.findUnique({
    where: { id: itemId },
    select: { purchaseRate: true, sellingPricePerMl: true, bottleSizeMl: true },
  });

  const bottleSizeMl = item?.bottleSizeMl || 750;
  const costPerMl = item?.purchaseRate ? Number(item.purchaseRate) / bottleSizeMl : 0;
  const sellingPricePerMl = item?.sellingPricePerMl ? Number(item.sellingPricePerMl) : 0;

  const stockValue = systemClosingMl * costPerMl;
  const acRevenue = acSaleMl * sellingPricePerMl;
  const nonAcRevenue = nonAcSaleMl * sellingPricePerMl;
  const totalRevenue = acRevenue + nonAcRevenue;
  const consumptionCost = (acSaleMl + nonAcSaleMl + wastageMl) * costPerMl;
  const profit = totalRevenue - consumptionCost;

  await tx.barDailyRecord.upsert({
    where: { restaurantId_date_itemId: { restaurantId, date, itemId } },
    create: {
      restaurantId, itemId, date,
      openingMl, purchasedMl, acSaleMl, nonAcSaleMl, wastageMl, adjustmentMl,
      systemClosingMl, purchaseRate: item?.purchaseRate || null,
      stockValue, acRevenue, nonAcRevenue, totalRevenue, consumptionCost, profit,
    },
    update: {
      openingMl, purchasedMl, acSaleMl, nonAcSaleMl, wastageMl, adjustmentMl,
      systemClosingMl, purchaseRate: item?.purchaseRate || null,
      stockValue, acRevenue, nonAcRevenue, totalRevenue, consumptionCost, profit,
    },
  });

  return { openingMl, systemClosingMl, stockValue };
}

async function sequentialRebuild(tx, restaurantId, itemId, fromDate) {
  const today = getKolkataDateString();
  const dates = getDateRange(fromDate, today);
  let lastClosingMl = 0;

  for (const date of dates) {
    const result = await recalculateDailyRecord(tx, restaurantId, itemId, date);
    lastClosingMl = result.systemClosingMl;
  }

  // Update live stock to match the last day's closing
  await tx.barInventoryItem.update({
    where: { id: itemId },
    data: { currentStockMl: lastClosingMl },
  });

  return lastClosingMl;
}

(async () => {
  const items = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, currentStockMl: true, bottleSizeMl: true },
    orderBy: { name: "asc" },
  });

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Rebuild Daily Records from ${FROM_DATE}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`Items: ${items.length}`);
  console.log(`${"=".repeat(80)}\n`);

  if (!APPLY) {
    // DRY RUN: just show what would happen for a few items
    console.log("DRY RUN — showing first 5 items:\n");
    for (const item of items.slice(0, 5)) {
      const movements = await prisma.barInventoryMovement.findMany({
        where: { restaurantId: RID, itemId: item.id, date: FROM_DATE },
        orderBy: { createdAt: "asc" },
      });
      const openingMvmts = movements.filter(m => m.movementType === "OPENING");
      const openingVal = openingMvmts.length > 0 ? Number(openingMvmts[openingMvmts.length - 1].quantityMl) : 0;
      console.log(`  ${item.name}: ${movements.length} movements on ${FROM_DATE}, OPENING=${openingVal}ml, live=${Number(item.currentStockMl)}ml`);
    }
    console.log(`\nRun with --apply to rebuild all ${items.length} items.`);
    await prisma.$disconnect();
    return;
  }

  // APPLY: rebuild all items
  console.log("Rebuilding daily records...\n");
  let success = 0, errors = 0;
  const errorList = [];

  for (const item of items) {
    try {
      const finalClosing = await sequentialRebuild(prisma, RID, item.id, FROM_DATE);
      success++;
      if (success % 50 === 0) {
        console.log(`  Processed ${success}/${items.length}...`);
      }
    } catch (e) {
      errors++;
      errorList.push(`${item.name}: ${e.message}`);
    }
  }

  console.log(`\nAPPLY COMPLETE`);
  console.log(`  Success: ${success}/${items.length}`);
  console.log(`  Errors: ${errors}`);
  if (errorList.length > 0) {
    for (const e of errorList.slice(0, 10)) console.log(`    ${e}`);
  }

  // Verify: check a few records for 2026-09-08
  console.log(`\n=== Verification: BarDailyRecord for ${FROM_DATE} ===`);
  const records = await prisma.barDailyRecord.findMany({
    where: { restaurantId: RID, date: FROM_DATE },
    select: { itemId: true, openingMl: true, systemClosingMl: true },
  });
  console.log(`  Records: ${records.length}`);

  const itemsWithRecords = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, currentStockMl: true },
  });
  const itemMap = new Map(itemsWithRecords.map(i => [i.id, i]));

  let mismatches = 0;
  for (const rec of records) {
    const item = itemMap.get(rec.itemId);
    if (!item) continue;
    const recOpening = Number(rec.openingMl);
    const liveStock = Number(item.currentStockMl);
    if (Math.abs(recOpening - liveStock) > 0.1) {
      if (mismatches < 5) {
        console.log(`  MISMATCH: ${item.name}: record=${recOpening}ml live=${liveStock}ml`);
      }
      mismatches++;
    }
  }
  console.log(`  Mismatches: ${mismatches}/${records.length}`);

  await prisma.$disconnect();
})();
