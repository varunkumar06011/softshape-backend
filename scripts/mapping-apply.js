// mapping-apply.js — Consolidate bar inventory for Vgrand Lounge.
//
// Approved scope (from review of reports/mapping-review/*.csv):
//   1. DUPLICATE SKUs (same normalized base + size)  → merge into canonical:
//      positive stock transfers via ADJUSTMENT movements, menu links re-point,
//      loser deactivated. Negative/zero dup stock is zeroed, NOT transferred
//      (phantom — nothing physical to move).
//   2. TYPO pairs (all 36 confirmed) → canonical side = more menu links, then
//      more stock. Losing-side items merge into a same-size canonical SKU when
//      one exists, otherwise are RENAMED to the canonical spelling.
//      RCW pair excluded — RCW is a real alias for Royal Challenger Whisky.
//
// Everything else (VARIANT_MISMATCH, CROSS_BASE, unlinked items) is left for
// manual review — NOT touched here.
//
// Usage:
//   node scripts/mapping-apply.js            — DRY RUN (plan only)
//   node scripts/mapping-apply.js --apply    — write to DB

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RID = "cmqy60ci200027dscyj9ubg8h"; // Vgrand Lounge

const EXCLUDE_TYPO_BASES = new Set(["rcw"]); // RCW = Royal Challenger Whisky alias

// Variant/distinguishing tokens must match exactly — Red≠Green, B10≠B7.
const VARIANT_TOKENS = new Set([
  'red', 'green', 'gold', 'black', 'white', 'blue', 'premium', 'select', 'ultra',
  'lite', 'light', 'strong', 'vsop', 'xo', 'rare', 'blonde', 'orange', 'apple',
  'tangy', 'platinum', 'magnum', 'deluxe', 'silver', 'classic', 'special',
  'reserve', 'superior', 'barrel', 'crystal', 'signature', 'sweet', 'salt',
]);

// Two bases are the SAME product misspelled only when:
//  - spaceless-equal ("vat69" vs "vat 69"), or
//  - same token count, every token pairs with same first letter and edit
//    distance ≤1 (≤2 for tokens ≥4 chars, to catch transpositions like
//    "glod"→"gold", "vokda"→"vodka"), and any variant/numeric token
//    appears verbatim on both sides (red≠green, b10≠b7, 389≠699).
function isSameProductTypo(a, b) {
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return true;
  const ta = a.split(" "), tb = b.split(" ");
  if (ta.length !== tb.length) return false;
  const used = new Set();
  for (const t of ta) {
    if (/\d/.test(t) || VARIANT_TOKENS.has(t)) {
      if (!tb.includes(t)) return false;
      used.add(t);
      continue;
    }
    let best = null, bestD = 99;
    for (const u of tb) {
      if (used.has(u) || u === t) continue;
      const d = levenshtein(t, u);
      if (d < bestD) { bestD = d; best = u; }
    }
    if (tb.includes(t)) { continue; } // exact token present — matched implicitly
    const maxD = t.length >= 4 ? 2 : 1;
    if (!best || bestD > maxD || best[0] !== t[0]) return false;
    used.add(best);
  }
  return true;
}

// ── Normalization (same as barMatching.ts / mapping-review.js) ───────────────
function baseName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, " ")
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) { d[i] = [i]; for (let j = 1; j <= n; j++) d[i][j] = i === 0 ? j : 0; }
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function titleCase(s) {
  return s.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
function getKolkataDateString() {
  const k = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, "0")}-${String(k.getDate()).padStart(2, "0")}`;
}
function getPreviousDate(date) {
  const d = new Date(date + "T00:00:00"); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function getDateRange(from, to) {
  const out = []; let c = from;
  while (c <= to) { out.push(c); const d = new Date(c + "T00:00:00"); d.setDate(d.getDate() + 1);
    c = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  return out;
}

// ── Daily-record rebuild (same as rebuild-daily-records.js) ─────────────────
async function recalculateDailyRecord(tx, restaurantId, itemId, date) {
  const movements = await tx.barInventoryMovement.findMany({
    where: { restaurantId, itemId, date }, orderBy: { createdAt: "asc" },
  });
  let purchasedMl = 0, acSaleMl = 0, nonAcSaleMl = 0, wastageMl = 0, adjustmentMl = 0, openingOverrideMl = null;
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
      case "CORRECTION": adjustmentMl += qty; break;
    }
  }
  acSaleMl = Math.max(0, acSaleMl);
  const prevRecord = await tx.barDailyRecord.findFirst({
    where: { restaurantId, itemId, date: { lt: date } }, orderBy: { date: "desc" },
  });
  const openingMl = openingOverrideMl ?? (prevRecord ? Number(prevRecord.physicalClosingMl ?? prevRecord.systemClosingMl) : 0);
  const systemClosingMl = openingMl + purchasedMl - acSaleMl - nonAcSaleMl - wastageMl + adjustmentMl;
  const item = await tx.barInventoryItem.findUnique({ where: { id: itemId }, select: { purchaseRate: true, sellingPricePerMl: true, bottleSizeMl: true } });
  const bottleSizeMl = item?.bottleSizeMl || 750;
  const costPerMl = item?.purchaseRate ? Number(item.purchaseRate) / bottleSizeMl : 0;
  const sellPerMl = item?.sellingPricePerMl ? Number(item.sellingPricePerMl) : 0;
  const stockValue = systemClosingMl * costPerMl;
  const acRevenue = acSaleMl * sellPerMl, nonAcRevenue = nonAcSaleMl * sellPerMl;
  const totalRevenue = acRevenue + nonAcRevenue;
  const consumptionCost = (acSaleMl + nonAcSaleMl + wastageMl) * costPerMl;
  const profit = totalRevenue - consumptionCost;
  await tx.barDailyRecord.upsert({
    where: { restaurantId_date_itemId: { restaurantId, date, itemId } },
    create: { restaurantId, itemId, date, openingMl, purchasedMl, acSaleMl, nonAcSaleMl, wastageMl, adjustmentMl, systemClosingMl, purchaseRate: item?.purchaseRate || null, stockValue, acRevenue, nonAcRevenue, totalRevenue, consumptionCost, profit },
    update: { openingMl, purchasedMl, acSaleMl, nonAcSaleMl, wastageMl, adjustmentMl, systemClosingMl, purchaseRate: item?.purchaseRate || null, stockValue, acRevenue, nonAcRevenue, totalRevenue, consumptionCost, profit },
  });
  return systemClosingMl;
}
async function sequentialRebuild(tx, restaurantId, itemId, fromDate) {
  let last = 0;
  for (const date of getDateRange(fromDate, getKolkataDateString()))
    last = await recalculateDailyRecord(tx, restaurantId, itemId, date);
  await tx.barInventoryItem.update({ where: { id: itemId }, data: { currentStockMl: last } });
}

(async () => {
  const TODAY = getKolkataDateString();
  const items = await prisma.barInventoryItem.findMany({ where: { restaurantId: RID }, orderBy: { name: "asc" } });
  const menus = await prisma.menuItem.findMany({
    where: { restaurantId: RID, isDeleted: false, barInventoryItemId: { not: null } },
    select: { id: true, barInventoryItemId: true },
  });
  const linkedCount = new Map();
  for (const m of menus) linkedCount.set(m.barInventoryItemId, (linkedCount.get(m.barInventoryItemId) || 0) + 1);
  const invBase = (i) => baseName(i.name);
  const score = (i) => (i.isActive ? 1e9 : 0) + (linkedCount.get(i.id) || 0) * 1e5 + Math.abs(Number(i.currentStockMl));

  // Merge `from` item into `to` item.
  const plan = [];
  async function planMerge(from, to, why) {
    const stock = Number(from.currentStockMl);
    plan.push(`  MERGE "${from.name}" [${from.id}] -> "${to.name}" [${to.id}]  stock=${Math.round(stock)}ml links=${linkedCount.get(from.id) || 0}  (${why})`);
    if (!APPLY) return;
    await prisma.$transaction(async (tx) => {
      if (stock > 0) {
        // Real stock moves to canonical; the dup zeroes out.
        await tx.barInventoryMovement.create({ data: { restaurantId: RID, itemId: from.id, date: TODAY, movementType: "ADJUSTMENT", quantityMl: -stock, source: "MANUAL_ENTRY", notes: `consolidated into ${to.name} [${to.id}]`, createdBy: "mapping-apply" } });
        await tx.barInventoryMovement.create({ data: { restaurantId: RID, itemId: to.id, date: TODAY, movementType: "ADJUSTMENT", quantityMl: stock, source: "MANUAL_ENTRY", notes: `consolidated from ${from.name} [${from.id}]`, createdBy: "mapping-apply" } });
      } else if (stock < 0) {
        // Phantom negative — zero the dup only, don't pollute canonical.
        await tx.barInventoryMovement.create({ data: { restaurantId: RID, itemId: from.id, date: TODAY, movementType: "ADJUSTMENT", quantityMl: -stock, source: "MANUAL_ENTRY", notes: `zeroed phantom stock on merge into ${to.name} [${to.id}]`, createdBy: "mapping-apply" } });
      }
      await tx.menuItem.updateMany({ where: { restaurantId: RID, barInventoryItemId: from.id }, data: { barInventoryItemId: to.id } });
      await tx.barInventoryItem.update({ where: { id: from.id }, data: { isActive: false } });
    });
    // Rebuild both items' daily records + live stock (outside the tx).
    for (const id of [from.id, to.id]) {
      await prisma.$transaction((tx) => sequentialRebuild(tx, RID, id, TODAY));
    }
    // Keep in-memory state current so pass 2 sees pass-1 merges.
    from.isActive = false;
    if (stock > 0) to.currentStockMl = Number(to.currentStockMl) + stock;
    from.currentStockMl = 0;
    linkedCount.set(to.id, (linkedCount.get(to.id) || 0) + (linkedCount.get(from.id) || 0));
    linkedCount.set(from.id, 0);
  }

  // ── Pass 1: exact duplicates (same base + size) ───────────────────────────
  const dupGroups = new Map();
  for (const i of items) {
    const k = `${invBase(i)}|${i.bottleSizeMl}`;
    if (!dupGroups.has(k)) dupGroups.set(k, []);
    dupGroups.get(k).push(i);
  }
  console.log(`\n═══ PASS 1 — duplicate SKU merges (${APPLY ? "APPLY" : "DRY RUN"}) ═══`);
  for (const [k, grp] of dupGroups) {
    if (grp.length < 2) continue;
    const keep = grp.slice().sort((a, b) => score(b) - score(a))[0];
    console.log(`group ${k} — canonical: ${keep.name} [${keep.id}]`);
    for (const i of grp) if (i.id !== keep.id) await planMerge(i, keep, "duplicate SKU");
  }

  // ── Pass 2: typo pairs (same product, misspelled base) ────────────────────
  const bases = [...new Set(items.map((i) => invBase(i)).filter(Boolean))].sort();
  const pairs = [];
  for (let a = 0; a < bases.length; a++) {
    for (let b = a + 1; b < bases.length; b++) {
      if (bases[a][0] !== bases[b][0]) break;
      const dist = levenshtein(bases[a], bases[b]);
      const looksTypo = dist > 0 && dist <= 3;
      if (looksTypo && !EXCLUDE_TYPO_BASES.has(bases[a]) && !EXCLUDE_TYPO_BASES.has(bases[b])
          && !bases[a].includes("rcw") && !bases[b].includes("rcw")
          && isSameProductTypo(bases[a], bases[b]))
        pairs.push([bases[a], bases[b]]);
      else if (looksTypo)
        console.log(`  (skipped pair "${bases[a]}" vs "${bases[b]}" — different products, not typos)`);
    }
  }
  console.log(`\n═══ PASS 2 — typo-pair merges (${pairs.length} pairs) ═══`);
  for (const [A, B] of pairs) {
    const sideA = items.filter((i) => invBase(i) === A);
    const sideB = items.filter((i) => invBase(i) === B);
    const sideScore = (s) => s.reduce((n, i) => n + score(i), 0);
    const [winBase, loseBase] = sideScore(sideA) >= sideScore(sideB) ? [A, B] : [B, A];
    const winners = items.filter((i) => invBase(i) === winBase);
    const losers = items.filter((i) => invBase(i) === loseBase);
    const winLabel = titleCase(winBase);
    console.log(`pair "${loseBase}" -> "${winBase}"`);
    for (const li of losers) {
      if (!li.isActive && Number(li.currentStockMl) === 0 && !linkedCount.get(li.id)) continue;
      const sameSize = winners.find((w) => w.isActive && w.bottleSizeMl === li.bottleSizeMl);
      if (sameSize) {
        await planMerge(li, sameSize, "typo merge, same size exists");
      } else {
        // No same-size canonical — rename the losing item to correct spelling.
        const newName = `${winLabel} ${li.bottleSizeMl}ml`;
        plan.push(`  RENAME "${li.name}" [${li.id}] -> "${newName}"  (no same-size canonical; stock/links preserved)`);
        if (APPLY) {
          try {
            await prisma.barInventoryItem.update({ where: { id: li.id }, data: { name: newName, brand: winLabel } });
          } catch (e) {
            // Name collision — a canonical-side same-size item exists after all; merge instead.
            const tgt = winners.find((w) => w.bottleSizeMl === li.bottleSizeMl) || winners[0];
            if (tgt) await planMerge(li, tgt, "rename collided — merged");
            else console.log(`  ! rename failed for ${li.id}: ${e.message}`);
          }
        }
      }
    }
  }

  console.log(`\n═══ PLAN (${plan.length} actions) ═══`);
  for (const p of plan) console.log(p);
  console.log(APPLY ? "\nApplied." : "\nDry run — rerun with --apply to execute.");
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
