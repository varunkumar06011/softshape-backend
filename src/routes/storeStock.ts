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

const UNITS = ["kg", "g", "ton", "litre", "ml", "piece", "dozen", "packet", "box"];
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

// ── PATCH /:code/items/:id — rename ──────────────────────────────────────────
router.patch("/:code/items/:id", withOutlet, async (req, res) => {
  try {
    const outlet = outletOf(req), by = requireBy(req.body);
    const name = clean(req.body?.name, 80);
    if (!name) throw new HttpError(400, "Enter a name.");
    const item = await basePrisma.storeItem.findFirst({ where: { id: String(req.params.id), outletId: outlet.id } });
    if (!item) throw new HttpError(404, "Item not found.");
    const updated = await basePrisma.storeItem.update({ where: { id: item.id }, data: { name, nameKey: name.toLowerCase() } });
    await basePrisma.storeAudit.create({ data: { outletId: outlet.id, by, action: "Item renamed", detail: `${item.name} → ${name}` } });
    res.json({ item: mapItem(updated) });
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
