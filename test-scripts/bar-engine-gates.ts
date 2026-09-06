// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Engine — Gate Tests (1, 2 & 4)
// ─────────────────────────────────────────────────────────────────────────────
// SAFETY: this script will ONLY run against a separate test database.
//   Required env vars:
//     BAR_TEST_DATABASE_URL  — Prisma URL of a TEST/staging database
//     BAR_TEST_CONFIRM=1     — explicit acknowledgement
//   It hard-refuses if BAR_TEST_DATABASE_URL is unset or identical to the
//   configured DATABASE_URL. All test rows use restaurantId = TEST_SCOPE
//   and are deleted again at the end.
//
// Run:
//   npx ts-node --compiler-options '{"module":"CommonJS"}' test-scripts/bar-engine-gates.ts
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import {
  MOVEMENT_TYPES,
  MOVEMENT_SOURCES,
  createMovement,
  recalculateDailyRecord,
  sequentialRebuild,
} from "../src/services/barInventoryService";
import { getKolkataDateString } from "../src/utils/date";

// ── Safety guards ─────────────────────────────────────────────────────────────
const TEST_URL = process.env.BAR_TEST_DATABASE_URL;
const MAIN_URL = process.env.DATABASE_URL;
if (!TEST_URL || process.env.BAR_TEST_CONFIRM !== "1") {
  console.error(
    "ABORT: set BAR_TEST_DATABASE_URL (a test/staging DB) and BAR_TEST_CONFIRM=1.\n" +
    "This script never runs against the configured production database.",
  );
  process.exit(1);
}
if (MAIN_URL && TEST_URL === MAIN_URL) {
  console.error("ABORT: BAR_TEST_DATABASE_URL is identical to DATABASE_URL (production). Refusing.");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
const TEST_SCOPE = "BAR_ENGINE_TEST_SCOPE";

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(name: string, actual: number | string | null | undefined, expected: number | string) {
  const a = typeof expected === "number" ? Math.round(Number(actual) * 100) / 100 : actual;
  const e = typeof expected === "number" ? Math.round(expected * 100) / 100 : expected;
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name} = ${e}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}: expected ${e}, got ${a}`);
  }
}

function isoDaysAgo(n: number): string {
  const today = getKolkataDateString();
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function makeItem(name: string, bottleSizeMl: number, brand = "TestBrand") {
  return prisma.barInventoryItem.create({
    data: {
      restaurantId: TEST_SCOPE,
      name, brand, category: "Test",
      bottleSizeMl, currentStockMl: 0,
    },
  });
}

async function recordOf(itemId: string, date: string) {
  return prisma.barDailyRecord.findUnique({
    where: { restaurantId_date_itemId: { restaurantId: TEST_SCOPE, date, itemId } },
  });
}

async function move(itemId: string, date: string, type: string, qtyMl: number, extra: any = {}) {
  return createMovement(prisma as any, {
    restaurantId: TEST_SCOPE, itemId, date,
    movementType: type, quantityMl: qtyMl,
    source: extra.source || MOVEMENT_SOURCES.MANUAL_ENTRY,
    correctionForId: extra.correctionForId ?? null,
    orderId: extra.orderId ?? null,
    orderItemId: extra.orderItemId ?? null,
    unitCost: extra.unitCost ?? null,
    notes: extra.notes ?? null,
    createdBy: "gate-test",
  });
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "bar_inventory_movements" WHERE "restaurantId" = ${TEST_SCOPE}`;
  await prisma.$executeRaw`DELETE FROM "bar_daily_records" WHERE "restaurantId" = ${TEST_SCOPE}`;
  await prisma.$executeRaw`DELETE FROM "bar_inventory_edit_logs" WHERE "restaurantId" = ${TEST_SCOPE}`;
  await prisma.$executeRaw`DELETE FROM "bar_inventory_items" WHERE "restaurantId" = ${TEST_SCOPE}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE 1 — Calculation engine unit cases
// ─────────────────────────────────────────────────────────────────────────────
async function gate1() {
  console.log("\n═══ GATE 1 — Calculation engine ═══");
  const today = getKolkataDateString();
  const item = await makeItem("Gate1 Whisky 750ml", 750);

  // Opening 10 bottles (7500ml)
  await move(item.id, today, MOVEMENT_TYPES.OPENING, 7500, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, today);
  let r = await recordOf(item.id, today);
  check("G1 openingMl", r?.openingMl, 7500);
  check("G1 closing after opening", r?.systemClosingMl, 7500);

  // Purchase +2 bottles (1500ml)
  await move(item.id, today, MOVEMENT_TYPES.PURCHASE, 1500);
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, today);
  r = await recordOf(item.id, today);
  check("G1 purchasedMl", r?.purchasedMl, 1500);
  check("G1 closing after purchase", r?.systemClosingMl, 9000);

  // AC sale 30ml + 60ml
  await move(item.id, today, MOVEMENT_TYPES.AC_SALE, -30, { orderId: "TEST_ORDER_1" });
  await move(item.id, today, MOVEMENT_TYPES.AC_SALE, -60, { orderId: "TEST_ORDER_1" });
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, today);
  r = await recordOf(item.id, today);
  check("G1 acSaleMl", r?.acSaleMl, 90);
  check("G1 closing after AC", r?.systemClosingMl, 8910);

  // Non-AC sale 750ml
  await move(item.id, today, MOVEMENT_TYPES.NON_AC_SALE, -750);
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, today);
  r = await recordOf(item.id, today);
  check("G1 nonAcSaleMl", r?.nonAcSaleMl, 750);
  check("G1 closing after Non-AC", r?.systemClosingMl, 8160);

  // Wastage 30ml
  await move(item.id, today, MOVEMENT_TYPES.WASTAGE, -30);
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, today);
  r = await recordOf(item.id, today);
  check("G1 wastageMl", r?.wastageMl, 30);
  check("G1 closing after wastage", r?.systemClosingMl, 8130);

  // Positive + negative adjustment
  await move(item.id, today, MOVEMENT_TYPES.ADJUSTMENT, 100);
  await move(item.id, today, MOVEMENT_TYPES.ADJUSTMENT, -50);
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, today);
  r = await recordOf(item.id, today);
  check("G1 adjustmentMl (net)", r?.adjustmentMl, 50);
  check("G1 closing after adjustments", r?.systemClosingMl, 8180);

  // Correction on the Non-AC sale: 750 → 900 (delta -150)
  const orig = await prisma.barInventoryMovement.findFirst({
    where: { itemId: item.id, date: today, movementType: MOVEMENT_TYPES.NON_AC_SALE },
  });
  await move(item.id, today, MOVEMENT_TYPES.CORRECTION, -150, {
    correctionForId: orig!.id, source: MOVEMENT_SOURCES.CORRECTION_EDIT,
  });
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, today);
  r = await recordOf(item.id, today);
  check("G1 nonAcSaleMl after correction", r?.nonAcSaleMl, 900);
  check("G1 closing after correction", r?.systemClosingMl, 8030);

  // Physical count 8000 → variance = 8000 - 8030 = -30, system unchanged
  await prisma.barDailyRecord.update({
    where: { id: r!.id },
    data: { physicalClosingMl: 8000, varianceMl: -30 },
  });
  r = await recordOf(item.id, today);
  check("G1 physicalClosingMl", r?.physicalClosingMl, 8000);
  check("G1 varianceMl", r?.varianceMl, -30);
  check("G1 systemClosing untouched", r?.systemClosingMl, 8030);

  const fresh = await prisma.barInventoryItem.findUnique({ where: { id: item.id } });
  check("G1 currentStockMl", fresh?.currentStockMl, 8030);
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE 2 — Exact Royal Stag end-to-end scenario
// ─────────────────────────────────────────────────────────────────────────────
async function gate2() {
  console.log("\n═══ GATE 2 — Royal Stag end-to-end ═══");
  const today = getKolkataDateString();

  const rs750 = await makeItem("RS 750ml", 750, "Royal Stag");
  const rs375 = await makeItem("RS 375ml", 375, "Royal Stag");
  const rs180 = await makeItem("RS 180ml", 180, "Royal Stag");

  // Start: 10×750, 5×375, 5×180
  await move(rs750.id, today, MOVEMENT_TYPES.OPENING, 7500, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  await move(rs375.id, today, MOVEMENT_TYPES.OPENING, 1875, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  await move(rs180.id, today, MOVEMENT_TYPES.OPENING, 900, { source: MOVEMENT_SOURCES.OPENING_SETUP });

  // Purchase +2 × 750ml
  await move(rs750.id, today, MOVEMENT_TYPES.PURCHASE, 1500);

  // AC: 30 + 60 from 750; 90 from 375
  await move(rs750.id, today, MOVEMENT_TYPES.AC_SALE, -30, { orderId: "TEST_ORDER_A" });
  await move(rs750.id, today, MOVEMENT_TYPES.AC_SALE, -60, { orderId: "TEST_ORDER_A" });
  await move(rs375.id, today, MOVEMENT_TYPES.AC_SALE, -90, { orderId: "TEST_ORDER_A" });

  // Non-AC: 750ml from 750 SKU
  await move(rs750.id, today, MOVEMENT_TYPES.NON_AC_SALE, -750);

  // Wastage: 30ml from 180 SKU
  await move(rs180.id, today, MOVEMENT_TYPES.WASTAGE, -30);

  for (const it of [rs750, rs375, rs180]) {
    await sequentialRebuild(prisma as any, TEST_SCOPE, it.id, today);
  }

  // Expected: 750 → 7500+1500−90−750 = 8160; 375 → 1875−90 = 1785; 180 → 900−30 = 870
  const cases = [
    { it: rs750, opening: 7500, purchased: 1500, ac: 90, nonac: 750, wast: 0, closing: 8160 },
    { it: rs375, opening: 1875, purchased: 0, ac: 90, nonac: 0, wast: 0, closing: 1785 },
    { it: rs180, opening: 900, purchased: 0, ac: 0, nonac: 0, wast: 30, closing: 870 },
  ];
  for (const c of cases) {
    const r = await recordOf(c.it.id, today);
    check(`G2 ${c.it.name} opening`, r?.openingMl, c.opening);
    check(`G2 ${c.it.name} purchased`, r?.purchasedMl, c.purchased);
    check(`G2 ${c.it.name} acSale`, r?.acSaleMl, c.ac);
    check(`G2 ${c.it.name} nonAcSale`, r?.nonAcSaleMl, c.nonac);
    check(`G2 ${c.it.name} wastage`, r?.wastageMl, c.wast);
    check(`G2 ${c.it.name} closing`, r?.systemClosingMl, c.closing);
    const fresh = await prisma.barInventoryItem.findUnique({ where: { id: c.it.id } });
    check(`G2 ${c.it.name} currentStock`, fresh?.currentStockMl, c.closing);
  }

  // Brand total (aggregate, ml): 8160 + 1785 + 870 = 10815
  const brandItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: TEST_SCOPE, brand: "Royal Stag" },
  });
  const brandTotal = brandItems.reduce((s, i) => s + Number(i.currentStockMl), 0);
  check("G2 brand total ml", brandTotal, 10815);
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE 4 — Historical edit cascade
// ─────────────────────────────────────────────────────────────────────────────
async function gate4() {
  console.log("\n═══ GATE 4 — Historical cascade ═══");
  // Use the last 5 real days: D-4 … today
  const d4 = isoDaysAgo(4), d3 = isoDaysAgo(3), d2 = isoDaysAgo(2), d1 = isoDaysAgo(1);
  const today = getKolkataDateString();

  const item = await makeItem("Gate4 Vodka 750ml", 750);

  // Day D-4: opening 750ml, Non-AC sale 750ml → closing 0
  await move(item.id, d4, MOVEMENT_TYPES.OPENING, 750, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  const origNonAc = await move(item.id, d4, MOVEMENT_TYPES.NON_AC_SALE, -750);
  // Day D-3: purchase 1500 → closing = 0 + 1500 = 1500
  await move(item.id, d3, MOVEMENT_TYPES.PURCHASE, 1500);
  // Day D-2: AC sale 300 → closing = 1500 - 300 = 1200
  await move(item.id, d2, MOVEMENT_TYPES.AC_SALE, -300, { orderId: "TEST_ORDER_H" });
  // Day D-1: wastage 100 → closing = 1200 - 100 = 1100
  await move(item.id, d1, MOVEMENT_TYPES.WASTAGE, -100);

  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, d4);

  let r = await recordOf(item.id, d4);
  check("G4 D-4 closing (pre-edit)", r?.systemClosingMl, 0);
  r = await recordOf(item.id, d3);
  check("G4 D-3 opening (pre-edit)", r?.openingMl, 0);
  check("G4 D-3 closing (pre-edit)", r?.systemClosingMl, 1500);
  r = await recordOf(item.id, d1);
  check("G4 D-1 closing (pre-edit)", r?.systemClosingMl, 1100);
  r = await recordOf(item.id, today);
  check("G4 today closing (pre-edit)", r?.systemClosingMl, 1100);

  // ── Edit D-4 Non-AC: 750 → 900  (CORRECTION delta -150) ───────────────────
  await move(item.id, d4, MOVEMENT_TYPES.CORRECTION, -150, {
    correctionForId: origNonAc.id, source: MOVEMENT_SOURCES.CORRECTION_EDIT,
  });
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, d4);

  r = await recordOf(item.id, d4);
  check("G4 D-4 nonAcSale (post-edit)", r?.nonAcSaleMl, 900);
  check("G4 D-4 closing (post-edit)", r?.systemClosingMl, -150);
  r = await recordOf(item.id, d3);
  check("G4 D-3 opening cascaded", r?.openingMl, -150);
  check("G4 D-3 closing cascaded", r?.systemClosingMl, 1350);
  r = await recordOf(item.id, d2);
  check("G4 D-2 opening cascaded", r?.openingMl, 1350);
  check("G4 D-2 closing cascaded", r?.systemClosingMl, 1050);
  r = await recordOf(item.id, d1);
  check("G4 D-1 closing cascaded", r?.systemClosingMl, 950);
  r = await recordOf(item.id, today);
  check("G4 today closing cascaded", r?.systemClosingMl, 950);

  const fresh = await prisma.barInventoryItem.findUnique({ where: { id: item.id } });
  check("G4 currentStockMl == final closing", fresh?.currentStockMl, 950);

  // ── Clear D-4 Non-AC entirely: 900 → 0  (CORRECTION +900) ────────────────
  await move(item.id, d4, MOVEMENT_TYPES.CORRECTION, 900, {
    correctionForId: origNonAc.id, source: MOVEMENT_SOURCES.CORRECTION_EDIT,
  });
  await sequentialRebuild(prisma as any, TEST_SCOPE, item.id, d4);
  r = await recordOf(item.id, d4);
  check("G4 D-4 nonAcSale after clear", r?.nonAcSaleMl, 0);
  // Clearing the entire 750ml sale restores it: 1100 + 750 = 1850
  r = await recordOf(item.id, today);
  check("G4 today closing after clear", r?.systemClosingMl, 1850);

  // Audit: the original movement must be unchanged
  const orig = await prisma.barInventoryMovement.findUnique({ where: { id: origNonAc.id } });
  check("G4 original NON_AC_SALE untouched", orig?.quantityMl, -750);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Bar engine gate tests — scope "${TEST_SCOPE}" on TEST DB`);
  await cleanup(); // remove any residue from a previous run
  try {
    await gate1();
    await gate2();
    await gate4();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\n════════════════════════════════════`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
