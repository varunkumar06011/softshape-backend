// ─────────────────────────────────────────────────────────────────────────────
// storeStock.test.ts — edit endpoints of the Store Stock portal (/api/store-stock)
// ─────────────────────────────────────────────────────────────────────────────
// Runs the real router against an in-memory stand-in for the store_* tables, so
// the edit rules are tested without a database:
//   - item edit: name, unit (same family converts, other family only when safe), opening
//   - entry edit: purchase / issue / adjust / opening, and what may never be edited
//   - stock can never go below zero at any point in an item's history
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

type Row = Record<string, any>;
const db = vi.hoisted(() => ({ items: [] as Row[], entries: [] as Row[], audit: [] as Row[], seq: 0 }));

vi.mock("@prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error { code = "P2002"; } },
}));

vi.mock("../lib/prisma", () => {
  const match = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const table = (rows: () => Row[], prefix: string) => ({
    findFirst: async ({ where }: Row = {}) => rows().find((r) => match(r, where)) ?? null,
    findMany: async ({ where }: Row = {}) => rows().filter((r) => match(r, where)),
    create: async ({ data }: Row) => {
      const row = { id: `${prefix}${++db.seq}`, createdAt: new Date(2026, 10, 1, 0, 0, db.seq), ...data };
      rows().push(row);
      return row;
    },
    update: async ({ where, data }: Row) => {
      const row = rows().find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  });
  const tx: Row = {
    storeItem: table(() => db.items, "i"),
    storeEntry: table(() => db.entries, "e"),
    storeAudit: table(() => db.audit, "a"),
    storeSetting: { findUnique: async () => null },
    outlet: { findFirst: async () => ({ id: "o1", name: "Test Outlet", isActive: true }) },
    $executeRaw: async () => 0,
  };
  tx.$transaction = async (fn: (t: Row) => unknown) => fn(tx);
  return { basePrisma: tx };
});

import router from "./storeStock";

const app = express();
app.use(express.json());
app.use("/api/store-stock", router);
const api = (m: "get" | "post" | "patch", path: string) => (request(app) as any)[m](`/api/store-stock/OUT1${path}`);

function seedItem(name: string, unit: string, entries: Row[]): string {
  const item = { id: `i${++db.seq}`, outletId: "o1", name, nameKey: name.toLowerCase(), unit, createdAt: new Date() };
  db.items.push(item);
  for (const e of entries) db.entries.push({ id: `e${++db.seq}`, outletId: "o1", itemId: item.id, date: "2026-11-01", createdAt: new Date(2026, 10, 1, 0, 0, db.seq), enteredBy: "Test", ...e });
  return item.id;
}
const entryOf = (id: string) => db.entries.find((e) => e.id === id)!;

beforeEach(() => { db.items.length = 0; db.entries.length = 0; db.audit.length = 0; db.seq = 0; });

describe("units", () => {
  it("accepts tin and bottle when adding an item", async () => {
    for (const unit of ["tin", "bottle", "jar", "bag", "carton"]) {
      const r = await api("post", "/items").send({ by: "Lakshmi", name: `Thing ${unit}`, unit, openingQty: 5, openingRate: 100 });
      expect(r.status).toBe(200);
      expect(r.body.item.unit).toBe(unit);
    }
    const bad = await api("post", "/items").send({ by: "Lakshmi", name: "X", unit: "barrel" });
    expect(bad.status).toBe(400);
  });
});

describe("edit item", () => {
  it("renames and logs it", async () => {
    const id = seedItem("Rice", "kg", [{ type: "OPENING", qty: 10, rate: 50 }]);
    const r = await api("patch", `/items/${id}`).send({ by: "Lakshmi", name: "Basmati Rice" });
    expect(r.status).toBe(200);
    expect(r.body.item.name).toBe("Basmati Rice");
    expect(db.items[0].nameKey).toBe("basmati rice");
    expect(db.audit[0].action).toBe("Item edited");
  });

  it("rejects an empty request and a missing name of the person", async () => {
    const id = seedItem("Rice", "kg", []);
    expect((await api("patch", `/items/${id}`).send({ by: "L" })).status).toBe(400);
    expect((await api("patch", `/items/${id}`).send({ name: "Rice 2" })).status).toBe(400);
  });

  it("edits the opening stock and rate in place and keeps its date", async () => {
    const id = seedItem("Rice", "kg", [{ type: "OPENING", qty: 10, rate: 50 }]);
    const r = await api("patch", `/items/${id}`).send({ by: "L", openingQty: 12, openingRate: 55 });
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(1);
    expect(db.entries[0]).toMatchObject({ qty: 12, rate: 55, date: "2026-11-01" });
  });

  it("creates the opening entry when the item never had one", async () => {
    const id = seedItem("Salt", "kg", []);
    const r = await api("patch", `/items/${id}`).send({ by: "L", openingQty: 4, openingRate: 20 });
    expect(r.status).toBe(200);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0]).toMatchObject({ type: "OPENING", qty: 4, rate: 20 });
    expect((await api("patch", `/items/${id}`).send({ by: "L", openingQty: 4, openingRate: 0 })).status).toBe(400);
  });

  it("kg → g converts every entry so quantities and values do not change", async () => {
    const id = seedItem("Rice", "kg", [
      { type: "OPENING", qty: 10, rate: 50 },
      { type: "PURCHASE", qty: 5, rate: 60, entUnit: "kg", entQty: 5, entRate: 60 },
      { type: "ISSUE", qty: -3, dept: "Indian Kitchen", receivedBy: "Ramesh" },
    ]);
    const r = await api("patch", `/items/${id}`).send({ by: "L", unit: "g" });
    expect(r.status).toBe(200);
    expect(r.body.item.unit).toBe("g");
    expect(db.entries.map((e) => e.qty)).toEqual([10000, 5000, -3000]);
    expect(db.entries.map((e) => e.rate)).toEqual([0.05, 0.06, null]);
    // value of the purchase is the same: 5 kg × 60 = 5000 g × 0.06
    expect(db.entries[1].qty * db.entries[1].rate).toBeCloseTo(300);
    // and back again
    const back = await api("patch", `/items/${id}`).send({ by: "L", unit: "kg" });
    expect(back.status).toBe(200);
    expect(db.entries.map((e) => e.qty)).toEqual([10, 5, -3]);
    expect(db.entries.map((e) => e.rate)).toEqual([50, 60, null]);
  });

  it("refuses a unit change to another family once there are purchases or issues", async () => {
    const id = seedItem("Oil", "litre", [{ type: "OPENING", qty: 10, rate: 100 }, { type: "PURCHASE", qty: 5, rate: 110 }]);
    const r = await api("patch", `/items/${id}`).send({ by: "L", unit: "tin", openingQty: 10, openingRate: 100 });
    expect(r.status).toBe(409);
    expect(db.items[0].unit).toBe("litre");
    expect(db.entries.map((e) => e.qty)).toEqual([10, 5]);
  });

  it("allows litre → tin while only the opening entry exists, if the opening is re-entered", async () => {
    const id = seedItem("Oil", "litre", [{ type: "OPENING", qty: 10, rate: 100 }]);
    expect((await api("patch", `/items/${id}`).send({ by: "L", unit: "tin" })).status).toBe(400);
    const r = await api("patch", `/items/${id}`).send({ by: "L", unit: "tin", openingQty: 2, openingRate: 1500 });
    expect(r.status).toBe(200);
    expect(db.items[0].unit).toBe("tin");
    expect(db.entries[0]).toMatchObject({ qty: 2, rate: 1500 });
  });

  it("will not edit an opening entry that was already corrected", async () => {
    const id = seedItem("Rice", "kg", [{ type: "OPENING", qty: 10, rate: 50 }]);
    db.entries.push({ id: "eRev", outletId: "o1", itemId: id, type: "REVERSAL", date: "2026-11-02", createdAt: new Date(2026, 10, 2), qty: -10, reverses: db.entries[0].id, reason: "x", enteredBy: "T" });
    const r = await api("patch", `/items/${id}`).send({ by: "L", openingQty: 12, openingRate: 50 });
    expect(r.status).toBe(409);
  });

  it("will not lower the opening stock below what was already issued", async () => {
    const id = seedItem("Rice", "kg", [{ type: "OPENING", qty: 10, rate: 50 }, { type: "ISSUE", qty: -8, dept: "Indian Kitchen", receivedBy: "R" }]);
    const r = await api("patch", `/items/${id}`).send({ by: "L", openingQty: 5, openingRate: 50 });
    expect(r.status).toBe(409);
    expect(db.entries[0].qty).toBe(10);
  });

  it("returns 404 for an item of another outlet", async () => {
    const id = seedItem("Rice", "kg", []);
    db.items[0].outletId = "other";
    expect((await api("patch", `/items/${id}`).send({ by: "L", name: "X" })).status).toBe(404);
  });
});

describe("edit entry", () => {
  it("edits a purchase: quantity, rate and supplier, clears the typed-unit note, writes the audit line", async () => {
    const id = seedItem("Rice", "kg", [{ type: "OPENING", qty: 10, rate: 50 }, { type: "PURCHASE", qty: 5, rate: 60, supplier: "Raju", entUnit: "kg", entQty: 5, entRate: 60 }]);
    const pid = db.entries[1].id;
    const r = await api("patch", `/entries/${pid}`).send({ by: "L", qty: 6, rate: 62.5, supplier: "Raju Traders" });
    expect(r.status).toBe(200);
    expect(r.body.entry).toMatchObject({ id: pid, qty: 6, rate: 62.5, supplier: "Raju Traders", date: "2026-11-01" });
    expect(entryOf(pid).entUnit).toBeNull();
    expect(db.audit.at(-1)).toMatchObject({ by: "L", action: "Entry edited" });
    expect(db.audit.at(-1)!.detail).toContain("qty 5 → 6");
    expect(db.audit.at(-1)!.detail).toContain("rate 60 → 62.5");
    expect(id).toBeTruthy();
  });

  it("does nothing, and logs nothing, when no value changed", async () => {
    seedItem("Rice", "kg", [{ type: "OPENING", qty: 10, rate: 50 }, { type: "PURCHASE", qty: 5, rate: 60 }]);
    const r = await api("patch", `/entries/${db.entries[1].id}`).send({ by: "L", qty: 5, rate: 60 });
    expect(r.status).toBe(200);
    expect(db.audit).toHaveLength(0);
  });

  it("validates purchase values", async () => {
    seedItem("Rice", "kg", [{ type: "PURCHASE", qty: 5, rate: 60 }]);
    const pid = db.entries[0].id;
    expect((await api("patch", `/entries/${pid}`).send({ by: "L", qty: 0 })).status).toBe(400);
    expect((await api("patch", `/entries/${pid}`).send({ by: "L", rate: -1 })).status).toBe(400);
    expect((await api("patch", `/entries/${pid}`).send({ qty: 6 })).status).toBe(400);
  });

  it("will not reduce a purchase below what was issued afterwards", async () => {
    seedItem("Rice", "kg", [{ type: "PURCHASE", qty: 10, rate: 60 }, { type: "ISSUE", qty: -8, dept: "Indian Kitchen", receivedBy: "R" }]);
    const r = await api("patch", `/entries/${db.entries[0].id}`).send({ by: "L", qty: 5 });
    expect(r.status).toBe(409);
    expect(db.entries[0].qty).toBe(10);
    expect(db.audit).toHaveLength(0);
  });

  it("edits an issue: more quantity only while stock lasts, department must exist, receiver required", async () => {
    seedItem("Rice", "kg", [{ type: "PURCHASE", qty: 10, rate: 60 }, { type: "ISSUE", qty: -4, dept: "Indian Kitchen", receivedBy: "Ramesh" }]);
    const iid = db.entries[1].id;
    const ok = await api("patch", `/entries/${iid}`).send({ by: "L", qty: 6, dept: "Chinese Kitchen", to: "Suresh" });
    expect(ok.status).toBe(200);
    expect(entryOf(iid)).toMatchObject({ qty: -6, dept: "Chinese Kitchen", receivedBy: "Suresh" });
    expect((await api("patch", `/entries/${iid}`).send({ by: "L", qty: 11 })).status).toBe(409);
    expect((await api("patch", `/entries/${iid}`).send({ by: "L", dept: "Rooftop" })).status).toBe(400);
    expect((await api("patch", `/entries/${iid}`).send({ by: "L", to: "  " })).status).toBe(400);
    expect(entryOf(iid).qty).toBe(-6);
  });

  it("edits an adjustment (signed difference, reason, approver)", async () => {
    seedItem("Rice", "kg", [{ type: "PURCHASE", qty: 10, rate: 60 }, { type: "ADJUST", qty: -1, reason: "Wastage", approvedBy: "Owner" }]);
    const aid = db.entries[1].id;
    const ok = await api("patch", `/entries/${aid}`).send({ by: "L", qty: -2, reason: "Spoilage", approvedBy: "Manager" });
    expect(ok.status).toBe(200);
    expect(entryOf(aid)).toMatchObject({ qty: -2, reason: "Spoilage", approvedBy: "Manager" });
    expect((await api("patch", `/entries/${aid}`).send({ by: "L", qty: 0 })).status).toBe(400);
    expect((await api("patch", `/entries/${aid}`).send({ by: "L", approvedBy: "" })).status).toBe(400);
  });

  it("edits an opening entry", async () => {
    seedItem("Rice", "kg", [{ type: "OPENING", qty: 10, rate: 50 }]);
    const r = await api("patch", `/entries/${db.entries[0].id}`).send({ by: "L", qty: 11, rate: 52 });
    expect(r.status).toBe(200);
    expect(db.entries[0]).toMatchObject({ qty: 11, rate: 52 });
  });

  it("never edits a correction or an entry that was already corrected", async () => {
    seedItem("Rice", "kg", [{ type: "PURCHASE", qty: 10, rate: 60 }]);
    const orig = db.entries[0];
    const rev = { id: "eRev", outletId: "o1", itemId: orig.itemId, type: "REVERSAL", date: "2026-11-02", createdAt: new Date(2026, 10, 2), qty: -10, reverses: orig.id, reason: "typo", enteredBy: "T" };
    db.entries.push(rev);
    expect((await api("patch", `/entries/${orig.id}`).send({ by: "L", qty: 9 })).status).toBe(409);
    expect((await api("patch", `/entries/${rev.id}`).send({ by: "L", reason: "other" })).status).toBe(400);
    expect(orig.qty).toBe(10);
  });

  it("404 for an unknown entry or one from another outlet", async () => {
    seedItem("Rice", "kg", [{ type: "PURCHASE", qty: 10, rate: 60 }]);
    expect((await api("patch", "/entries/nope").send({ by: "L", qty: 3 })).status).toBe(404);
    db.entries[0].outletId = "other";
    expect((await api("patch", `/entries/${db.entries[0].id}`).send({ by: "L", qty: 3 })).status).toBe(404);
  });
});
