// ─────────────────────────────────────────────────────────────────────────────
// Store Stock — standalone store-supervisor inventory book (the /store portal)
// ─────────────────────────────────────────────────────────────────────────────
// A self-contained module: its own tables (store_items, store_entries,
// store_settings, store_audit), its own router, its own outlet lookup. It does
// NOT use authenticate / withTenantContext and does not read or write any
// kitchen, bar, order or billing table.
//
// Access: the outlet code (Outlet.restaurantCode) is in the URL path, e.g.
//   GET /api/store-stock/:code/state
// There is no password by request. Mitigations: failed code lookups are
// rate-limited per IP, all routes are rate-limited, and the module can only
// touch its own tables for the outlet the code resolves to.
//
// Ledger rules (enforced here, under a per-item advisory lock):
//   - entries are append-only; a mistake is fixed with a REVERSAL entry
//   - an entry may never take an item's stock below zero
//   - the business date is set by the server (Asia/Kolkata), never the client
// Valuation (weighted-average cost) is derived from the ledger by the client.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { basePrisma } from "../lib/prisma";
import logger from "../lib/logger";

const router = Router();

// Units. `fam` = conversion family (units in one family convert into each other via `f`);
// count/packaging units (tin, bottle, ...) each have their own family: no conversion.
// Keep in step with UNITS in the portal's storeEngine.js.
const UNIT_DEF: Record<string, { fam: string; f: number }> = {
  kg: { fam: "m", f: 1 }, g: { fam: "m", f: 0.001 }, ton: { fam: "m", f: 1000 },
  litre: { fam: "v", f: 1 }, ml: { fam: "v", f: 0.001 },
  piece: { fam: "p", f: 1 }, dozen: { fam: "p", f: 12 },
  packet: { fam: "k", f: 1 }, box: { fam: "b", f: 1 },
  tin: { fam: "tin", f: 1 }, bottle: { fam: "bottle", f: 1 }, jar: { fam: "jar", f: 1 },
  bag: { fam: "bag", f: 1 }, carton: { fam: "carton", f: 1 },
};
const UNITS = Object.keys(UNIT_DEF);
const DEFAULT_DEPTS = ["Indian Kitchen", "Chinese Kitchen", "Tandoori Kitchen", "Other"];
const EPS = 1e-9;

// ── Rate limits ──────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || "unknown",
  message: { error: "Too many requests. Please wait a moment." },
});
router.use(generalLimiter);

// Wrong outlet codes: 10 misses per IP per 10 minutes, then blocked for the rest of the window.
const misses = new Map<string, { n: number; reset: number }>();
function tooManyMisses(ip: string): boolean {
  const m = misses.get(ip);
  return !!m && m.reset > Date.now() && m.n >= 10;
}
function recordMiss(ip: string) {
  const now = Date.now();
  const m = misses.get(ip);
  if (!m || m.reset <= now) misses.set(ip, { n: 1, reset: now + 10 * 60_000 });
  else m.n++;
  if (misses.size > 5000) for (const [k, v] of misses) if (v.reset <= now) misses.delete(k);
}

// ── Outlet lookup from the code in the URL ───────────────────────────────────
interface OutletRef { id: string; name: string }
const outletCache = new Map<string, { at: number; outlet: OutletRef | null }>();

async function lookupOutlet(raw: string): Promise<OutletRef | null> {
  const key = raw.toUpperCase();
  const hit = outletCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.outlet;
  const o = await basePrisma.outlet.findFirst({
    where: { OR: [{ restaurantCode: key }, { id: raw }] },
    select: { id: true, name: true, isActive: true },
  });
  const outlet = o && o.isActive ? { id: o.id, name: o.name } : null;
  if (outletCache.size > 500) outletCache.clear();
  outletCache.set(key, { at: Date.now(), outlet });
  return outlet;
}

async function withOutlet(req: Request, res: Response, next: NextFunction) {
  try {
    const ip = req.ip || "unknown";
    if (tooManyMisses(ip)) return res.status(429).json({ error: "Too many wrong codes. Try again in a few minutes." });
    const raw = String(req.params.code || "").trim();
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(raw)) { recordMiss(ip); return res.status(404).json({ error: "Outlet not found" }); }
    const outlet = await lookupOutlet(raw);
    if (!outlet) { recordMiss(ip); return res.status(404).json({ error: "Outlet not found" }); }
    (req as any).outlet = outlet;
    next();
  } catch (err) {
    logger.error({ err }, "[StoreStock] outlet lookup failed");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clean = (v: unknown, max: number): string => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
function istDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function outletOf(req: Request): OutletRef { return (req as any).outlet as OutletRef; }

function mapEntry(e: any) {
  return {
    id: e.id,
    itemId: e.itemId,
    type: e.type,
    date: e.date,
    ts: new Date(e.createdAt).getTime(),
    qty: num(e.qty),
    rate: e.rate == null ? null : num(e.rate),
    dept: e.dept || undefined,
    to: e.receivedBy || undefined,
    supplier: e.supplier || undefined,
    reason: e.reason || undefined,
    note: e.note || undefined,
    approvedBy: e.approvedBy || undefined,
    reverses: e.reverses || undefined,
    by: e.enteredBy,
    entQty: e.entQty == null ? undefined : num(e.entQty),
    entUnit: e.entUnit || undefined,
    entRate: e.entRate == null ? undefined : num(e.entRate),
  };
}
const mapItem = (i: any) => ({ id: i.id, name: i.name, unit: i.unit, createdAt: new Date(i.createdAt).getTime() });

async function getDepts(outletId: string): Promise<string[]> {
  const s = await basePrisma.storeSetting.findUnique({ where: { outletId } });
  const d = s?.depts;
  return Array.isArray(d) && d.length ? (d as string[]) : DEFAULT_DEPTS.slice();
}

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function fail(res: Response, err: unknown) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return res.status(409).json({ error: "That already exists or was already corrected." });
  }
  logger.error({ err }, "[StoreStock] request failed");
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}
function requireBy(body: any): string {
  const by = clean(body?.by, 60);
  if (!by) throw new HttpError(400, "Enter your name first.");
  return by;
}

// ── GET /:code/state — everything the portal needs (also validates the code) ──
router.get("/:code/state", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req);
    const [items, entries, depts, audit] = await Promise.all([
      basePrisma.storeItem.findMany({ where: { outletId: outlet.id }, orderBy: { createdAt: "asc" } }),
      basePrisma.storeEntry.findMany({ where: { outletId: outlet.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      getDepts(outlet.id),
      basePrisma.storeAudit.findMany({ where: { outletId: outlet.id }, orderBy: { createdAt: "desc" }, take: 40 }),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({
      outlet: { name: outlet.name },
      today: istDate(),
      items: items.map(mapItem),
      entries: entries.map(mapEntry),
      depts,
      audit: audit.map((a) => ({ ts: new Date(a.createdAt).getTime(), by: a.by, action: a.action, detail: a.detail })),
    });
  } catch (err) { fail(res, err); }
});

// ── POST /:code/items — add an item once, with its opening stock and rate ────
router.post("/:code/items", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req), b = req.body || {};
    const by = requireBy(b);
    const name = clean(b.name, 80), unit = String(b.unit || "");
    const q = round4(Number(b.openingQty ?? 0)), r = round4(Number(b.openingRate ?? 0));
    if (!name) throw new HttpError(400, "Enter the item name.");
    if (!UNITS.includes(unit)) throw new HttpError(400, "Choose a unit.");
    if (!Number.isFinite(q) || !Number.isFinite(r) || q < 0 || r < 0) throw new HttpError(400, "Stock and rate cannot be negative.");
    if (q > 0 && !(r > 0)) throw new HttpError(400, "Enter the rate for the opening stock.");

    const result = await basePrisma.$transaction(async (tx) => {
      const item = await tx.storeItem.create({ data: { outletId: outlet.id, name, nameKey: name.toLowerCase(), unit, createdBy: by } });
      let entry = null;
      if (q > 0 || r > 0) {
        entry = await tx.storeEntry.create({
          data: { outletId: outlet.id, itemId: item.id, type: "OPENING", date: istDate(), qty: q, rate: r, enteredBy: by },
        });
      }
      await tx.storeAudit.create({ data: { outletId: outlet.id, by, action: "Item added", detail: `${name} (${unit}) opening ${q}` } });
      return { item, entry };
    });
    res.json({ item: mapItem(result.item), entry: result.entry ? mapEntry(result.entry) : null });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return res.status(409).json({ error: "This item already exists." });
    fail(res, err);
  }
});

// Stock may never be below zero at any point in an item's history. `rows` are the item's
// entries in ledger order, with any pending edit already applied to `qty`.
function assertNeverNegative(itemName: string, rows: { qty: number; date: string }[]) {
  let run = 0;
  for (const r of rows) {
    run += r.qty;
    if (run < -EPS) throw new HttpError(409, `This change would take ${itemName} below zero stock (on ${r.date}). Adjust the later issues first.`);
  }
}
const fmtN = (n: number | null | undefined) => (n == null ? "-" : String(round4(n)));

// ── PATCH /:code/items/:id — edit name, unit and/or opening stock + rate ──────
// Body: { by, name?, unit?, openingQty?, openingRate? }  (send only what changes)
//  - unit within the same family (kg <-> g, litre <-> ml, piece <-> dozen): every entry is
//    converted so quantities and values stay exactly the same.
//  - unit to a different family (e.g. kg -> tin): only while the item has nothing but its
//    opening entry, and the opening stock + rate must be re-entered in the new unit.
//  - opening stock / rate edit the item's OPENING entry in place (kept on its original date).
router.patch("/:code/items/:id", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req), b = req.body || {};
    const by = requireBy(b);
    const itemId = String(req.params.id);
    const hasName = b.name !== undefined, hasUnit = b.unit !== undefined;
    const hasOpen = b.openingQty !== undefined || b.openingRate !== undefined;
    if (!hasName && !hasUnit && !hasOpen) throw new HttpError(400, "Nothing to change.");
    const name = hasName ? clean(b.name, 80) : "";
    if (hasName && !name) throw new HttpError(400, "Enter a name.");

    const out = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${itemId}))`;
      const item = await tx.storeItem.findFirst({ where: { id: itemId, outletId: outlet.id } });
      if (!item) throw new HttpError(404, "Item not found.");
      const rows = await tx.storeEntry.findMany({ where: { itemId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const work = rows.map((e) => ({ id: e.id, type: e.type, date: e.date, qty: num(e.qty), rate: e.rate == null ? null : num(e.rate), touched: false, clearEnt: false }));
      const reversed = new Set(rows.filter((e) => e.type === "REVERSAL" && e.reverses).map((e) => e.reverses as string));
      const changes: string[] = [];
      let newName = item.name, newUnit = item.unit;

      if (hasName && name !== item.name) { changes.push(`name ${item.name} → ${name}`); newName = name; }

      // unit
      let unitFamilyChanged = false;
      if (hasUnit && String(b.unit) !== item.unit) {
        const u = String(b.unit), from = UNIT_DEF[item.unit], to = UNIT_DEF[u];
        if (!to) throw new HttpError(400, "Choose a unit.");
        if (from && from.fam === to.fam) {
          const k = from.f / to.f; // 1 old unit = k new units
          for (const w of work) {
            const nq = w.qty * k, nr = w.rate == null ? null : w.rate / k;
            if (Math.abs(round4(nq) - nq) > 1e-7 * Math.max(1, Math.abs(nq)) || (nr != null && Math.abs(round4(nr) - nr) > 1e-7 * Math.max(1, Math.abs(nr)))) {
              throw new HttpError(409, `Changing to ${u} would lose precision on older entries. Keep ${item.unit}, or correct those entries first.`);
            }
            w.qty = round4(nq); w.rate = nr == null ? null : round4(nr); w.touched = true;
          }
        } else {
          if (work.some((w) => w.type !== "OPENING")) {
            throw new HttpError(409, `${item.name} already has purchases or issues in ${item.unit}, so it can only change to a similar unit (for example kg ↔ g).`);
          }
          unitFamilyChanged = true;
        }
        changes.push(`unit ${item.unit} → ${u}`); newUnit = u;
      }

      // opening stock / rate
      const opening = rows.find((e) => e.type === "OPENING");
      if (unitFamilyChanged && opening && (num(opening.qty) > 0 || num(opening.rate) > 0) && !hasOpen) {
        throw new HttpError(400, `Enter the opening stock and rate in ${newUnit}.`);
      }
      if (hasOpen) {
        const q = b.openingQty === undefined ? undefined : round4(Number(b.openingQty));
        const r = b.openingRate === undefined ? undefined : round4(Number(b.openingRate));
        if ((q !== undefined && !Number.isFinite(q)) || (r !== undefined && !Number.isFinite(r)) || (q ?? 0) < 0 || (r ?? 0) < 0) throw new HttpError(400, "Stock and rate cannot be negative.");
        if (opening) {
          if (reversed.has(opening.id)) throw new HttpError(409, "The opening stock was corrected, so it can't be edited.");
          const w = work.find((x) => x.id === opening.id)!;
          const oq = num(opening.qty), orate = opening.rate == null ? 0 : num(opening.rate);
          const nq = q ?? w.qty, nr = r ?? w.rate ?? 0;
          if (nq > 0 && !(nr > 0)) throw new HttpError(400, `Enter the rate per ${newUnit} for the opening stock.`);
          if (round4(nq) !== round4(oq) || round4(nr) !== round4(orate) || unitFamilyChanged) {
            w.qty = nq; w.rate = nr; w.touched = true; w.clearEnt = true;
            changes.push(`opening ${fmtN(oq)} @ ${fmtN(orate)} → ${fmtN(nq)} @ ${fmtN(nr)}`);
          }
        } else if ((q ?? 0) > 0 || (r ?? 0) > 0) {
          if ((q ?? 0) > 0 && !((r ?? 0) > 0)) throw new HttpError(400, `Enter the rate per ${newUnit} for the opening stock.`);
          work.push({ id: "__new_opening__", type: "OPENING", date: istDate(), qty: q ?? 0, rate: r ?? 0, touched: true, clearEnt: false });
          changes.push(`opening added ${fmtN(q ?? 0)} @ ${fmtN(r ?? 0)}`);
        }
      }

      if (!changes.length) return { item, rows: rows.map(mapEntry) };
      assertNeverNegative(newName, work);

      const updated = await tx.storeItem.update({ where: { id: item.id }, data: { name: newName, nameKey: newName.toLowerCase(), unit: newUnit } });
      for (const w of work) {
        if (!w.touched) continue;
        if (w.id === "__new_opening__") {
          await tx.storeEntry.create({ data: { outletId: outlet.id, itemId, type: "OPENING", date: w.date, qty: w.qty, rate: w.rate, enteredBy: by } });
        } else {
          await tx.storeEntry.update({
            where: { id: w.id },
            data: { qty: w.qty, rate: w.rate, ...(w.clearEnt ? { entQty: null, entRate: null, entUnit: null } : {}) },
          });
        }
      }
      await tx.storeAudit.create({ data: { outletId: outlet.id, by, action: "Item edited", detail: `${item.name}: ${changes.join("; ")}`.slice(0, 480) } });
      const fresh = await tx.storeEntry.findMany({ where: { itemId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      return { item: updated, rows: fresh.map(mapEntry) };
    }, { timeout: 15000, maxWait: 10000 });

    res.json({ item: mapItem(out.item), entries: out.rows });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return res.status(409).json({ error: "Another item has this name." });
    fail(res, err);
  }
});

// ── POST /:code/entries — purchase | issue | adjust | reverse ────────────────
router.post("/:code/entries", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req), b = req.body || {};
    const by = requireBy(b);
    const kind = String(b.kind || "");
    if (!["PURCHASE", "ISSUE", "ADJUST", "REVERSAL"].includes(kind)) throw new HttpError(400, "Unknown entry type.");
    const itemId = String(b.itemId || "");
    const depts = await getDepts(outlet.id);

    const created = await basePrisma.$transaction(async (tx) => {
      // One writer per item at a time, so two phones can never both pass the stock check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${itemId}))`;
      const item = await tx.storeItem.findFirst({ where: { id: itemId, outletId: outlet.id } });
      if (!item) throw new HttpError(404, "Item not found.");

      const data: Prisma.StoreEntryUncheckedCreateInput = {
        outletId: outlet.id, itemId, type: kind, date: istDate(), qty: 0, enteredBy: by,
      };
      const q = Number(b.qty), rate = Number(b.rate);

      if (kind === "PURCHASE") {
        if (!(q > 0)) throw new HttpError(400, "Enter the quantity.");
        if (!(rate > 0)) throw new HttpError(400, "Enter the purchase rate.");
        data.qty = round4(q); data.rate = round4(rate); data.supplier = clean(b.supplier, 80) || null;
      } else if (kind === "ISSUE") {
        const dept = clean(b.dept, 40), to = clean(b.to, 60);
        if (!(q > 0)) throw new HttpError(400, "Enter the quantity.");
        if (!depts.includes(dept)) throw new HttpError(400, "Choose the department.");
        if (!to) throw new HttpError(400, "Enter who received it.");
        data.qty = -round4(q); data.dept = dept; data.receivedBy = to; data.note = clean(b.note, 120) || null;
      } else if (kind === "ADJUST") {
        const d = Number(b.qty), reason = clean(b.reason, 60), appr = clean(b.approvedBy, 60);
        if (!Number.isFinite(d) || d === 0) throw new HttpError(400, "There is no difference to record.");
        if (!reason) throw new HttpError(400, "Enter the reason.");
        if (!appr) throw new HttpError(400, "Enter who approved this adjustment.");
        data.qty = round4(d); data.reason = reason; data.approvedBy = appr; data.note = clean(b.note, 120) || null;
        if (d > 0 && Number(b.rate) > 0) data.rate = round4(Number(b.rate));
      } else {
        const reason = clean(b.reason, 120);
        if (!reason) throw new HttpError(400, "Enter the reason for the correction.");
        const orig = await tx.storeEntry.findFirst({ where: { id: String(b.reverses || ""), outletId: outlet.id, itemId } });
        if (!orig) throw new HttpError(404, "Entry not found.");
        if (orig.type === "REVERSAL") throw new HttpError(400, "A correction cannot be corrected.");
        const already = await tx.storeEntry.findFirst({ where: { reverses: orig.id } });
        if (already) throw new HttpError(409, "This entry was already corrected.");
        data.qty = -num(orig.qty); data.reverses = orig.id; data.reason = reason;
      }

      if (["PURCHASE", "ISSUE", "ADJUST"].includes(kind) && b.entUnit && UNITS.includes(String(b.entUnit))) {
        data.entUnit = String(b.entUnit);
        if (Number(b.entQty) > 0) data.entQty = round4(Number(b.entQty));
        if (Number(b.entRate) > 0) data.entRate = round4(Number(b.entRate));
      }

      // Stock can never go below zero.
      const sum = await tx.storeEntry.aggregate({ where: { itemId }, _sum: { qty: true } });
      const after = num(sum._sum.qty) + num(data.qty);
      if (after < -EPS) {
        throw new HttpError(409, `Not enough stock of ${item.name}: short by ${Math.round(-after * 1e3) / 1e3} ${item.unit}.`);
      }

      const entry = await tx.storeEntry.create({ data });
      if (kind === "ADJUST" || kind === "REVERSAL") {
        await tx.storeAudit.create({
          data: { outletId: outlet.id, by, action: kind === "ADJUST" ? "Adjustment" : "Entry corrected",
            detail: `${item.name} ${num(data.qty) > 0 ? "+" : ""}${num(data.qty)} ${item.unit} · ${data.reason}${data.approvedBy ? " · approved by " + data.approvedBy : ""}` },
        });
      }
      return entry;
    }, { timeout: 15000, maxWait: 10000 });

    res.json({ entry: mapEntry(created) });
  } catch (err) { fail(res, err); }
});

// ── PATCH /:code/entries/:id — edit an entry in place (date stays as it was) ──
// Body: { by, ...fields to change }. Quantities are in the item's own unit; for ISSUE and
// PURCHASE/OPENING send the positive amount, for ADJUST the signed difference.
//   OPENING : qty, rate            PURCHASE: qty, rate, supplier
//   ISSUE   : qty, dept, to, note  ADJUST  : qty, reason, approvedBy, note, rate
// Corrections (REVERSAL) and entries that were already corrected cannot be edited.
// Every edit is written to the audit log with the old and new values.
router.patch("/:code/entries/:id", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req), b = req.body || {};
    const by = requireBy(b);
    const entryId = String(req.params.id);
    const pre = await basePrisma.storeEntry.findFirst({ where: { id: entryId, outletId: outlet.id }, select: { itemId: true } });
    if (!pre) throw new HttpError(404, "Entry not found.");
    const depts = await getDepts(outlet.id);
    const has = (k: string) => b[k] !== undefined;

    const updated = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pre.itemId}))`;
      const item = await tx.storeItem.findFirst({ where: { id: pre.itemId, outletId: outlet.id } });
      const entry = await tx.storeEntry.findFirst({ where: { id: entryId, outletId: outlet.id } });
      if (!item || !entry) throw new HttpError(404, "Entry not found.");
      if (entry.type === "REVERSAL") throw new HttpError(400, "A correction can't be edited.");
      if (await tx.storeEntry.findFirst({ where: { reverses: entry.id } })) throw new HttpError(409, "This entry was already corrected, so it can't be edited.");

      const data: Prisma.StoreEntryUncheckedUpdateInput = {};
      const changes: string[] = [];
      const oldQty = num(entry.qty), oldRate = entry.rate == null ? null : num(entry.rate);
      const text = (label: string, key: "supplier" | "receivedBy" | "note" | "reason" | "approvedBy" | "dept", field: string, max: number, required: boolean, msg: string) => {
        if (!has(field)) return;
        const v = clean(b[field], max);
        if (required && !v) throw new HttpError(400, msg);
        const old = (entry as any)[key] || "";
        if (v !== old) { (data as any)[key] = v || null; changes.push(`${label} ${old || "-"} → ${v || "-"}`); }
      };
      const posNum = (field: string, msg: string): number => {
        const v = round4(Number(b[field]));
        if (!Number.isFinite(v) || !(v > 0)) throw new HttpError(400, msg);
        return v;
      };

      let newQty = oldQty, newRate = oldRate;
      if (entry.type === "OPENING") {
        if (has("qty")) { newQty = round4(Number(b.qty)); if (!Number.isFinite(newQty) || newQty < 0) throw new HttpError(400, "Stock cannot be negative."); }
        if (has("rate")) { newRate = round4(Number(b.rate)); if (!Number.isFinite(newRate) || newRate < 0) throw new HttpError(400, "Rate cannot be negative."); }
        if (newQty > 0 && !((newRate ?? 0) > 0)) throw new HttpError(400, "Enter the rate for the opening stock.");
      } else if (entry.type === "PURCHASE") {
        if (has("qty")) newQty = posNum("qty", "Enter the quantity.");
        if (has("rate")) newRate = posNum("rate", "Enter the purchase rate.");
        text("supplier", "supplier", "supplier", 80, false, "");
      } else if (entry.type === "ISSUE") {
        if (has("qty")) newQty = -posNum("qty", "Enter the quantity.");
        if (has("dept")) {
          const dept = clean(b.dept, 40);
          if (dept !== entry.dept) {
            if (!depts.includes(dept)) throw new HttpError(400, "Choose the department.");
            data.dept = dept; changes.push(`department ${entry.dept || "-"} → ${dept}`);
          }
        }
        text("received by", "receivedBy", "to", 60, true, "Enter who received it.");
        text("note", "note", "note", 120, false, "");
      } else if (entry.type === "ADJUST") {
        if (has("qty")) { newQty = round4(Number(b.qty)); if (!Number.isFinite(newQty) || newQty === 0) throw new HttpError(400, "There is no difference to record."); }
        text("reason", "reason", "reason", 60, true, "Enter the reason.");
        text("approved by", "approvedBy", "approvedBy", 60, true, "Enter who approved this adjustment.");
        text("note", "note", "note", 120, false, "");
        if (newQty > 0 && has("rate") && Number(b.rate) > 0) newRate = round4(Number(b.rate));
        if (newQty < 0) newRate = null;
      }

      const qtyChanged = round4(newQty) !== round4(oldQty);
      const rateChanged = (newRate == null ? null : round4(newRate)) !== (oldRate == null ? null : round4(oldRate));
      if (qtyChanged) { data.qty = newQty; changes.push(`qty ${fmtN(Math.abs(oldQty))} → ${fmtN(Math.abs(newQty))}`); }
      if (rateChanged) { data.rate = newRate; changes.push(`rate ${fmtN(oldRate)} → ${fmtN(newRate)}`); }
      if (!changes.length) return entry;
      if (qtyChanged || rateChanged) { data.entQty = null; data.entRate = null; data.entUnit = null; } // typed-unit note no longer matches

      const all = await tx.storeEntry.findMany({ where: { itemId: item.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, qty: true, date: true } });
      assertNeverNegative(item.name, all.map((r) => ({ qty: r.id === entry.id ? newQty : num(r.qty), date: r.date })));

      const saved = await tx.storeEntry.update({ where: { id: entry.id }, data });
      await tx.storeAudit.create({ data: { outletId: outlet.id, by, action: "Entry edited", detail: `${item.name} · ${entry.type.toLowerCase()} of ${entry.date}: ${changes.join("; ")}`.slice(0, 480) } });
      return saved;
    }, { timeout: 15000, maxWait: 10000 });

    res.json({ entry: mapEntry(updated) });
  } catch (err) { fail(res, err); }
});

// ── POST /:code/count-match — physical count equals the book (audit only) ─────
router.post("/:code/count-match", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req), by = requireBy(req.body);
    const item = await basePrisma.storeItem.findFirst({ where: { id: String(req.body?.itemId || ""), outletId: outlet.id } });
    if (!item) throw new HttpError(404, "Item not found.");
    await basePrisma.storeAudit.create({ data: { outletId: outlet.id, by, action: "Count matched", detail: `${item.name} ${Number(req.body?.counted) || 0} ${item.unit}` } });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ── PUT /:code/departments — add / remove departments ─────────────────────────
router.put("/:code/departments", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req), by = requireBy(req.body);
    const list: string[] = Array.isArray(req.body?.depts) ? req.body.depts.map((d: unknown) => clean(d, 40)).filter(Boolean) : [];
    const uniq = Array.from(new Map(list.map((d) => [d.toLowerCase(), d])).values());
    if (!uniq.length || uniq.length > 12) throw new HttpError(400, "Keep between 1 and 12 departments.");
    const used = await basePrisma.storeEntry.findMany({ where: { outletId: outlet.id, dept: { not: null } }, distinct: ["dept"], select: { dept: true } });
    const missing = used.map((u) => u.dept as string).filter((d) => !uniq.includes(d));
    if (missing.length) throw new HttpError(409, `${missing[0]} has entries and cannot be removed.`);
    await basePrisma.storeSetting.upsert({ where: { outletId: outlet.id }, create: { outletId: outlet.id, depts: uniq }, update: { depts: uniq } });
    await basePrisma.storeAudit.create({ data: { outletId: outlet.id, by, action: "Departments changed", detail: uniq.join(", ") } });
    res.json({ depts: uniq });
  } catch (err) { fail(res, err); }
});

export default router;
