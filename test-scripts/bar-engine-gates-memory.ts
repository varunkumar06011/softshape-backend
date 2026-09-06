// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Engine — Gate Tests (1, 2 & 4), IN-MEMORY — NO DATABASE
// ─────────────────────────────────────────────────────────────────────────────
// Exercises the real calculation engine (createMovement / recalculateDailyRecord /
// sequentialRebuild) against an in-memory Prisma-compatible stub. No DB needed.
// Validates the pure math + cascade logic; DB constraints/transactions are out
// of scope here (that is what the DB-backed version is for).
//
// Run:
//   npx ts-node --compiler-options '{"module":"CommonJS"}' test-scripts/bar-engine-gates-memory.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  MOVEMENT_TYPES,
  MOVEMENT_SOURCES,
  createMovement,
  recalculateDailyRecord,
  sequentialRebuild,
} from "../src/services/barInventoryService";
import { getKolkataDateString } from "../src/utils/date";

// ── In-memory Prisma stub ─────────────────────────────────────────────────────
// Implements only the API surface the engine + this script use.
const SCOPE = "MEM";

class MemDB {
  seq = 0;
  items = new Map<string, any>();
  movements: any[] = [];
  records = new Map<string, any>(); // key = `${itemId}|${date}`

  private applySelect(row: any, select?: any) {
    if (!select || !row) return row;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
    return out;
  }

  private match(row: any, where: any = {}) {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  barInventoryItem = {
    create: ({ data }: any) => {
      const row = { id: `item_${++this.seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      this.items.set(row.id, row);
      return row;
    },
    findUnique: ({ where, select }: any) => {
      const row = this.items.get(where.id);
      return Promise.resolve(this.applySelect(row, select) ?? null);
    },
    findFirst: ({ where, select }: any) => {
      const row = [...this.items.values()].find((i) => this.match(i, where));
      return Promise.resolve(this.applySelect(row, select) ?? null);
    },
    findMany: ({ where }: any = {}) =>
      Promise.resolve([...this.items.values()].filter((i) => this.match(i, where))),
    update: ({ where, data }: any) => {
      const row = this.items.get(where.id);
      if (!row) throw new Error(`item ${where.id} not found`);
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === "object" && "increment" in (v as any)
          ? Number(row[k] || 0) + Number((v as any).increment)
          : v;
      }
      return Promise.resolve(row);
    },
    updateMany: ({ where, data }: any) => {
      let count = 0;
      for (const row of this.items.values()) {
        if (this.match(row, where)) { Object.assign(row, data); count++; }
      }
      return Promise.resolve({ count });
    },
  };

  barInventoryMovement = {
    create: ({ data }: any) => {
      const row = { id: `mv_${++this.seq}`, seq: this.seq, createdAt: new Date(this.seq), updatedAt: new Date(this.seq), ...data };
      this.movements.push(row);
      return Promise.resolve(row);
    },
    findMany: ({ where, orderBy }: any = {}) => {
      const rows = this.movements.filter((m) => this.match(m, where));
      if (orderBy?.createdAt === "asc") rows.sort((a, b) => a.seq - b.seq);
      return Promise.resolve(rows);
    },
    findFirst: ({ where, orderBy }: any = {}) => {
      const rows = this.movements.filter((m) => this.match(m, where));
      if (orderBy?.createdAt === "asc") rows.sort((a, b) => a.seq - b.seq);
      return Promise.resolve(rows[0] ?? null);
    },
    findUnique: ({ where }: any) =>
      Promise.resolve(this.movements.find((m) => m.id === where.id) ?? null),
  };

  barDailyRecord = {
    findUnique: ({ where }: any) => {
      const k = `${where.restaurantId_date_itemId.itemId}|${where.restaurantId_date_itemId.date}`;
      return Promise.resolve(this.records.get(k) ?? null);
    },
    upsert: ({ where, create, update }: any) => {
      const k = `${where.restaurantId_date_itemId.itemId}|${where.restaurantId_date_itemId.date}`;
      const existing = this.records.get(k);
      if (existing) {
        Object.assign(existing, update);
        return Promise.resolve(existing);
      }
      const row = { id: `rec_${++this.seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
      this.records.set(k, row);
      return Promise.resolve(row);
    },
    update: ({ where, data }: any) => {
      for (const row of this.records.values()) {
        if (row.id === where.id) { Object.assign(row, data); return Promise.resolve(row); }
      }
      throw new Error(`record ${where.id} not found`);
    },
  };
}

const db = new MemDB();
const tx = db as any;

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(name: string, actual: any, expected: number | string) {
  const a = typeof expected === "number" ? Math.round(Number(actual) * 100) / 100 : actual;
  const e = typeof expected === "number" ? Math.round(expected * 100) / 100 : expected;
  if (a === e) { passed++; console.log(`  PASS  ${name} = ${e}`); }
  else { failed++; console.log(`  FAIL  ${name}: expected ${e}, got ${a}`); }
}

function isoDaysAgo(n: number): string {
  const today = getKolkataDateString();
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const makeItem = (name: string, bottleSizeMl: number, brand = "TestBrand") =>
  db.barInventoryItem.create({
    data: { restaurantId: SCOPE, name, brand, category: "Test", bottleSizeMl, currentStockMl: 0 },
  });

const recordOf = (itemId: string, date: string) =>
  db.barDailyRecord.findUnique({ where: { restaurantId_date_itemId: { restaurantId: SCOPE, itemId, date } } });

const move = (itemId: string, date: string, type: string, qtyMl: number, extra: any = {}) =>
  createMovement(tx, {
    restaurantId: SCOPE, itemId, date,
    movementType: type, quantityMl: qtyMl,
    source: extra.source || MOVEMENT_SOURCES.MANUAL_ENTRY,
    correctionForId: extra.correctionForId ?? null,
    orderId: extra.orderId ?? null,
    orderItemId: extra.orderItemId ?? null,
    unitCost: extra.unitCost ?? null,
    notes: extra.notes ?? null,
    createdBy: "gate-test",
  });

const rebuild = (itemId: string, fromDate: string) => sequentialRebuild(tx, SCOPE, itemId, fromDate);
const recalc = (itemId: string, date: string) => recalculateDailyRecord(tx, SCOPE, itemId, date);

// ─────────────────────────────────────────────────────────────────────────────
// GATE 1 — Calculation engine unit cases
// ─────────────────────────────────────────────────────────────────────────────
async function gate1() {
  console.log("\n═══ GATE 1 — Calculation engine ═══");
  const today = getKolkataDateString();
  const item = await makeItem("Gate1 Whisky 750ml", 750);

  await move(item.id, today, MOVEMENT_TYPES.OPENING, 7500, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  await rebuild(item.id, today);
  let r = await recordOf(item.id, today);
  check("G1 openingMl", r?.openingMl, 7500);
  check("G1 closing after opening", r?.systemClosingMl, 7500);

  await move(item.id, today, MOVEMENT_TYPES.PURCHASE, 1500);
  await rebuild(item.id, today);
  r = await recordOf(item.id, today);
  check("G1 purchasedMl", r?.purchasedMl, 1500);
  check("G1 closing after purchase", r?.systemClosingMl, 9000);

  await move(item.id, today, MOVEMENT_TYPES.AC_SALE, -30, { orderId: "T1" });
  await move(item.id, today, MOVEMENT_TYPES.AC_SALE, -60, { orderId: "T1" });
  await rebuild(item.id, today);
  r = await recordOf(item.id, today);
  check("G1 acSaleMl", r?.acSaleMl, 90);
  check("G1 closing after AC", r?.systemClosingMl, 8910);

  await move(item.id, today, MOVEMENT_TYPES.NON_AC_SALE, -750);
  await rebuild(item.id, today);
  r = await recordOf(item.id, today);
  check("G1 nonAcSaleMl", r?.nonAcSaleMl, 750);
  check("G1 closing after Non-AC", r?.systemClosingMl, 8160);

  await move(item.id, today, MOVEMENT_TYPES.WASTAGE, -30);
  await rebuild(item.id, today);
  r = await recordOf(item.id, today);
  check("G1 wastageMl", r?.wastageMl, 30);
  check("G1 closing after wastage", r?.systemClosingMl, 8130);

  await move(item.id, today, MOVEMENT_TYPES.ADJUSTMENT, 100);
  await move(item.id, today, MOVEMENT_TYPES.ADJUSTMENT, -50);
  await rebuild(item.id, today);
  r = await recordOf(item.id, today);
  check("G1 adjustmentMl (net)", r?.adjustmentMl, 50);
  check("G1 closing after adjustments", r?.systemClosingMl, 8180);

  const orig = db.movements.find((m) => m.itemId === item.id && m.date === today && m.movementType === MOVEMENT_TYPES.NON_AC_SALE);
  await move(item.id, today, MOVEMENT_TYPES.CORRECTION, -150, { correctionForId: orig.id, source: MOVEMENT_SOURCES.CORRECTION_EDIT });
  await rebuild(item.id, today);
  r = await recordOf(item.id, today);
  check("G1 nonAcSaleMl after correction", r?.nonAcSaleMl, 900);
  check("G1 closing after correction", r?.systemClosingMl, 8030);

  await db.barDailyRecord.update({ where: { id: r!.id }, data: { physicalClosingMl: 8000, varianceMl: -30 } });
  r = await recordOf(item.id, today);
  check("G1 physicalClosingMl", r?.physicalClosingMl, 8000);
  check("G1 varianceMl", r?.varianceMl, -30);
  check("G1 systemClosing untouched", r?.systemClosingMl, 8030);

  check("G1 currentStockMl", (await db.barInventoryItem.findUnique({ where: { id: item.id } })).currentStockMl, 8030);
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

  await move(rs750.id, today, MOVEMENT_TYPES.OPENING, 7500, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  await move(rs375.id, today, MOVEMENT_TYPES.OPENING, 1875, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  await move(rs180.id, today, MOVEMENT_TYPES.OPENING, 900, { source: MOVEMENT_SOURCES.OPENING_SETUP });

  await move(rs750.id, today, MOVEMENT_TYPES.PURCHASE, 1500);
  await move(rs750.id, today, MOVEMENT_TYPES.AC_SALE, -30, { orderId: "A" });
  await move(rs750.id, today, MOVEMENT_TYPES.AC_SALE, -60, { orderId: "A" });
  await move(rs375.id, today, MOVEMENT_TYPES.AC_SALE, -90, { orderId: "A" });
  await move(rs750.id, today, MOVEMENT_TYPES.NON_AC_SALE, -750);
  await move(rs180.id, today, MOVEMENT_TYPES.WASTAGE, -30);

  for (const it of [rs750, rs375, rs180]) await rebuild(it.id, today);

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
    check(`G2 ${c.it.name} currentStock`, (await db.barInventoryItem.findUnique({ where: { id: c.it.id } })).currentStockMl, c.closing);
  }

  const brandTotal = (await db.barInventoryItem.findMany({ where: { brand: "Royal Stag" } }))
    .reduce((s, i) => s + Number(i.currentStockMl), 0);
  check("G2 brand total ml", brandTotal, 10815);
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE 4 — Historical edit cascade
// ─────────────────────────────────────────────────────────────────────────────
async function gate4() {
  console.log("\n═══ GATE 4 — Historical cascade ═══");
  const d4 = isoDaysAgo(4), d3 = isoDaysAgo(3), d2 = isoDaysAgo(2), d1 = isoDaysAgo(1);
  const today = getKolkataDateString();
  const item = await makeItem("Gate4 Vodka 750ml", 750);

  await move(item.id, d4, MOVEMENT_TYPES.OPENING, 750, { source: MOVEMENT_SOURCES.OPENING_SETUP });
  const origNonAc = await move(item.id, d4, MOVEMENT_TYPES.NON_AC_SALE, -750);
  await move(item.id, d3, MOVEMENT_TYPES.PURCHASE, 1500);
  await move(item.id, d2, MOVEMENT_TYPES.AC_SALE, -300, { orderId: "H" });
  await move(item.id, d1, MOVEMENT_TYPES.WASTAGE, -100);
  await rebuild(item.id, d4);

  let r = await recordOf(item.id, d4);
  check("G4 D-4 closing (pre-edit)", r?.systemClosingMl, 0);
  r = await recordOf(item.id, d3);
  check("G4 D-3 opening (pre-edit)", r?.openingMl, 0);
  check("G4 D-3 closing (pre-edit)", r?.systemClosingMl, 1500);
  r = await recordOf(item.id, d1);
  check("G4 D-1 closing (pre-edit)", r?.systemClosingMl, 1100);
  r = await recordOf(item.id, today);
  check("G4 today closing (pre-edit)", r?.systemClosingMl, 1100);

  // Edit D-4 Non-AC: 750 → 900 (CORRECTION -150)
  await move(item.id, d4, MOVEMENT_TYPES.CORRECTION, -150, { correctionForId: origNonAc.id, source: MOVEMENT_SOURCES.CORRECTION_EDIT });
  await rebuild(item.id, d4);

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
  check("G4 currentStockMl == final closing", (await db.barInventoryItem.findUnique({ where: { id: item.id } })).currentStockMl, 950);

  // Clear D-4 Non-AC entirely: 900 → 0 (CORRECTION +900)
  await move(item.id, d4, MOVEMENT_TYPES.CORRECTION, 900, { correctionForId: origNonAc.id, source: MOVEMENT_SOURCES.CORRECTION_EDIT });
  await rebuild(item.id, d4);
  r = await recordOf(item.id, d4);
  check("G4 D-4 nonAcSale after clear", r?.nonAcSaleMl, 0);
  // Clearing the entire 750ml sale restores it: 1100 + 750 = 1850
  r = await recordOf(item.id, today);
  check("G4 today closing after clear", r?.systemClosingMl, 1850);

  // Original movement must be untouched (append-only)
  check("G4 original NON_AC_SALE untouched", db.movements.find((m) => m.id === origNonAc.id)?.quantityMl, -750);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Bar engine gate tests — IN MEMORY (no database)");
  await gate1();
  await gate2();
  await gate4();
  console.log(`\n════════════════════════════════════`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
