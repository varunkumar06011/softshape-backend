// mapping-review.js — Read-only review sheet for Vgrand Lounge bar inventory.
//
// Produces CSVs under reports/mapping-review/ describing:
//   1. menu-linked.csv            — every liquor menu item → its inventory SKU
//   2. menu-unlinked.csv          — liquor menu items with no inventory link
//   3. inventory-duplicates.csv   — same base+size SKU appearing multiple times
//   4. inventory-stranded.csv     — active SKUs holding stock but no menu link
//   5. inventory-unlinked-empty.csv — active SKUs, no link, no stock (deactivate?)
//   6. possible-typos.csv         — near-identical base names (misspelled dupes)
//
// Every row carries suggestedAction + a blank `decision` column for review.
// Nothing is written to the database.

const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();
const RID = "cmqy60ci200027dscyj9ubg8h"; // Vgrand Lounge
const OUT_DIR = path.join(__dirname, "..", "reports", "mapping-review");

// ── Same normalization as src/utils/barMatching.ts ───────────────────────────
function parseMlFromName(name) {
  if (!name) return null;
  const ltr = name.match(/(\d+)\s*l(?:tr|itre|iter)?\b/i);
  if (ltr) return parseInt(ltr[1], 10) * 1000;
  const ml = name.match(/(\d+)\s*ml\b/i);
  return ml ? parseInt(ml[1], 10) : null;
}

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
  for (let i = 0; i <= m; i++) {
    d[i] = [i];
    for (let j = 1; j <= n; j++) d[i][j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

function csvEsc(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, header, rows) {
  const lines = [header.join(","), ...rows.map((r) => r.map(csvEsc).join(","))];
  fs.writeFileSync(path.join(OUT_DIR, file), lines.join("\n"), "utf8");
  return rows.length;
}

const CHARGE_WORDS = /charge|hall|projector|service/i;
const SODA_WORDS = /cola|fanta|sprite|thums|limca|maaza|soda|water|rim ?zim|pulpy|monster|charged/i;
const COCKTAIL_WORDS = /cocktail|mojit|margarita|martini|cosmopolitan/i;

// Tokens that distinguish product variants (Red vs Green, Premium Black vs plain).
// A menu item carrying one of these while the linked SKU lacks it = likely wrong SKU.
const VARIANT_TOKENS = new Set([
  'red', 'green', 'gold', 'black', 'white', 'blue', 'premium', 'select', 'ultra',
  'lite', 'light', 'strong', 'vsop', 'xo', 'rare', 'blonde', 'orange', 'apple',
  'tangy', 'platinum', 'magnum', 'deluxe', 'silver', 'classic', 'special',
  'reserve', 'superior', 'barrel', 'crystal', 'signature',
]);
// Category words carry no variant information — strip before token compare.
const CATEGORY_TOKENS = new Set(['whisky', 'whiskey', 'beer', 'brandy', 'rum', 'vodka', 'wine', 'gin', 'tequila', 'scotch', 'liquor', 'spirit', 'blended', 'and']);

function tokens(base) {
  return base.split(' ').filter((t) => t && !CATEGORY_TOKENS.has(t));
}

// Classify a menu→SKU link where normalized bases differ.
function classifyNameDiff(mBase, iBase) {
  const mt = tokens(mBase), it = tokens(iBase);
  const menuOnly = mt.filter((t) => !it.includes(t));
  const invOnly = it.filter((t) => !mt.includes(t));
  if (menuOnly.some((t) => VARIANT_TOKENS.has(t))) return 'VARIANT_MISMATCH'; // menu says Red/Green/Premium — SKU doesn't
  if (!menuOnly.length || !invOnly.length) return 'NAME_VARIANT';           // one name is a subset of the other
  if (levenshtein(mBase, iBase) <= 3) return 'NAME_VARIANT';                // close spelling — same product
  return 'CROSS_BASE';                                                      // genuinely different names — review
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Include INACTIVE items too — they can still hold stock and menu links.
  const items = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID },
    orderBy: [{ name: "asc" }],
  });
  const menus = await prisma.menuItem.findMany({
    where: { restaurantId: RID, menuType: "LIQUOR", isDeleted: false },
    select: { id: true, name: true, deductionMl: true, barInventoryItemId: true },
    orderBy: { name: "asc" },
  });

  const invById = new Map(items.map((i) => [i.id, i]));
  const linkedCount = new Map();
  for (const m of menus) {
    if (m.barInventoryItemId) linkedCount.set(m.barInventoryItemId, (linkedCount.get(m.barInventoryItemId) || 0) + 1);
  }
  // Match/dedupe on the NAME base — brand fields are unreliable in this data.
  const invBase = (i) => baseName(i.name);

  // Best candidate for a base name: prefer size match, then 750, then largest.
  // Only ACTIVE items are candidates for re-linking; inactive ones are reported
  // separately so the reviewer knows a SKU exists but is deactivated.
  function bestSku(base, size) {
    const cands = items.filter((i) => i.isActive && invBase(i) === base);
    if (!cands.length) return null;
    if (size && size >= 100) {
      const exact = cands.find((i) => i.bottleSizeMl === size);
      if (exact) return exact;
    }
    return cands.find((i) => i.bottleSizeMl === 750)
      || cands.slice().sort((a, b) => b.bottleSizeMl - a.bottleSizeMl)[0];
  }
  function inactiveSku(base, size) {
    const cands = items.filter((i) => !i.isActive && invBase(i) === base);
    if (!cands.length) return null;
    return (size && cands.find((i) => i.bottleSizeMl === size)) || cands[0];
  }

  // ── 1. Linked menu items ──────────────────────────────────────────────────
  const linkedRows = [];
  for (const m of menus) {
    if (!m.barInventoryItemId) continue;
    const inv = invById.get(m.barInventoryItemId);
    const menuSize = parseMlFromName(m.name);
    const mBase = baseName(m.name);
    if (!inv) {
      linkedRows.push([m.name, m.deductionMl ?? "", "(missing inventory item)", "", "", "BROKEN_LINK", "RELINK", ""]);
      continue;
    }
    const iBase = invBase(inv);
    const stock = Math.round(Number(inv.currentStockMl));
    const flags = [];
    const actions = [];
    if (iBase !== mBase) {
      const cls = classifyNameDiff(mBase, iBase);
      flags.push(cls);
      if (cls === 'VARIANT_MISMATCH' || cls === 'CROSS_BASE') {
        const tgt = bestSku(mBase, menuSize);
        actions.push(tgt ? `RELINK -> ${tgt.name} [${tgt.id}]` : `create "${mBase}" SKU if stocked`);
      } else {
        actions.push('rename SKU/brand to match (cosmetic)');
      }
    }
    if (!inv.isActive) flags.push('INACTIVE_SKU');
    if (stock < 0) { flags.push('NEGATIVE_STOCK'); actions.push('COUNT on stocktake day'); }
    if (menuSize && menuSize < 100 && inv.bottleSizeMl !== 750) {
      const tgt = bestSku(mBase, null);
      flags.push('PEG_NOT_750');
      if (tgt && tgt.bottleSizeMl === 750) actions.push(`RELINK -> ${tgt.name} [${tgt.id}]`);
    }
    if (menuSize && menuSize >= 100 && inv.bottleSizeMl !== menuSize) {
      const same = items.find((i) => invBase(i) === mBase && i.bottleSizeMl === menuSize);
      flags.push('SIZE_MISMATCH');
      actions.push(same ? `RELINK -> ${same.name} [${same.id}]` : `no ${menuSize}ml SKU — pours from ${inv.bottleSizeMl}ml (ok if not stocked)`);
    }
    if (!flags.length) { flags.push('OK'); actions.push('KEEP'); }
    linkedRows.push([m.name, m.deductionMl ?? "", `${inv.name} (${inv.bottleSizeMl}ml)`, stock, iBase === mBase ? "" : `base:${iBase}`, flags.join('+'), actions.join(' | '), ""]);
  }

  // ── 2. Unlinked menu items ────────────────────────────────────────────────
  const unlinkedRows = [];
  for (const m of menus) {
    if (m.barInventoryItemId) continue;
    const mBase = baseName(m.name);
    const guess = CHARGE_WORDS.test(m.name) ? "CHARGE — set menuType FOOD (not bar stock)"
      : COCKTAIL_WORDS.test(m.name) ? "COCKTAIL — link to base spirit SKU + set deductionMl"
      : SODA_WORDS.test(m.name) ? "SOFT DRINK — link to its own SKU if stocked, else menuType FOOD"
      : "REVIEW";
    const tgt = bestSku(mBase, parseMlFromName(m.name));
    const inact = tgt ? null : inactiveSku(mBase, parseMlFromName(m.name));
    unlinkedRows.push([m.name, m.deductionMl ?? "", mBase, guess,
      tgt ? `candidate: ${tgt.name} [${tgt.id}]` : inact ? `INACTIVE SKU exists: ${inact.name} [${inact.id}] — reactivate if stocked` : "no candidate", ""]);
  }

  // ── 3. Duplicate SKUs (same base + same size), across ALL items ───────────
  const dupGroups = new Map();
  for (const i of items) {
    const k = `${invBase(i)}|${i.bottleSizeMl}`;
    if (!dupGroups.has(k)) dupGroups.set(k, []);
    dupGroups.get(k).push(i);
  }
  const dupRows = [];
  const mergedIds = new Set();
  for (const [k, grp] of dupGroups) {
    if (grp.length < 2) continue;
    const keep = grp.slice().sort((a, b) =>
      (linkedCount.get(b.id) || 0) - (linkedCount.get(a.id) || 0)
      || Math.abs(Number(b.currentStockMl)) - Math.abs(Number(a.currentStockMl)))[0];
    for (const i of grp) {
      if (i.id !== keep.id && i.isActive) mergedIds.add(i.id);
      dupRows.push([k.split("|")[0], i.bottleSizeMl, i.name, i.id, i.isActive ? "active" : "INACTIVE", Math.round(Number(i.currentStockMl)), linkedCount.get(i.id) || 0,
        i.id === keep.id ? "KEEP (canonical)" : `MERGE stock into [${keep.id}] then DEACTIVATE`, ""]);
    }
  }

  // ── 4/5. Inventory items with no menu link ───────────────────────────────
  const strandedRows = [];
  const emptyRows = [];
  for (const i of items) {
    if ((linkedCount.get(i.id) || 0) > 0) continue;
    const stock = Math.round(Number(i.currentStockMl));
    const state = i.isActive ? "" : "INACTIVE ";
    if (stock !== 0) {
      strandedRows.push([i.name, i.brand || "", i.category, i.bottleSizeMl, stock, i.isActive ? "active" : "INACTIVE", i.id,
        mergedIds.has(i.id) ? `${state}MERGE (dup of canonical)` : `${state}REVIEW — real bottles? then keep & link; phantom? merge into same-base 750`, ""]);
    } else {
      emptyRows.push([i.name, i.brand || "", i.category, i.bottleSizeMl, i.isActive ? "active" : "INACTIVE", i.id,
        mergedIds.has(i.id) ? `${state}DEACTIVATE (duplicate)` : `${state}REVIEW — likely deactivate`, ""]);
    }
  }

  // ── 6. Possible typos (near-identical base names) ─────────────────────────
  const bases = [...new Set(items.map((i) => invBase(i)).filter(Boolean))].sort();
  const typoRows = [];
  for (let a = 0; a < bases.length; a++) {
    for (let b = a + 1; b < bases.length; b++) {
      const A = bases[a], B = bases[b];
      if (A[0] !== B[0]) break; // sorted — different first letter means no more close matches
      const dist = levenshtein(A, B);
      if (dist > 0 && dist <= 3) {
        const ia = items.filter((i) => invBase(i) === A).map((i) => `${i.name} (${Math.round(Number(i.currentStockMl))}ml)`).join("; ");
        const ib = items.filter((i) => invBase(i) === B).map((i) => `${i.name} (${Math.round(Number(i.currentStockMl))}ml)`).join("; ");
        typoRows.push([A, ia, B, ib, dist, "REVIEW — same product misspelled? merge", ""]);
      }
    }
  }

  // ── Write CSVs ────────────────────────────────────────────────────────────
  const counts = {
    "menu-linked.csv": writeCsv("menu-linked.csv",
      ["menuItem", "deductionMl", "linkedSku", "skuStockMl", "note", "flag", "suggestedAction", "decision"], linkedRows),
    "menu-unlinked.csv": writeCsv("menu-unlinked.csv",
      ["menuItem", "deductionMl", "baseName", "classification", "candidateSku", "decision"], unlinkedRows),
    "inventory-duplicates.csv": writeCsv("inventory-duplicates.csv",
      ["baseName", "bottleSizeMl", "itemName", "itemId", "state", "stockMl", "linkedMenuCount", "suggestedAction", "decision"], dupRows),
    "inventory-stranded.csv": writeCsv("inventory-stranded.csv",
      ["itemName", "brand", "category", "bottleSizeMl", "stockMl", "state", "itemId", "suggestedAction", "decision"], strandedRows),
    "inventory-unlinked-empty.csv": writeCsv("inventory-unlinked-empty.csv",
      ["itemName", "brand", "category", "bottleSizeMl", "state", "itemId", "suggestedAction", "decision"], emptyRows),
    "possible-typos.csv": writeCsv("possible-typos.csv",
      ["baseA", "itemsA", "baseB", "itemsB", "editDistance", "suggestedAction", "decision"], typoRows),
  };

  // ── Console summary ───────────────────────────────────────────────────────
  const flagCounts = {};
  for (const r of linkedRows) flagCounts[r[5]] = (flagCounts[r[5]] || 0) + 1;
  console.log("\n═══ MAPPING REVIEW — Vgrand Lounge ═══");
  console.log(`Liquor menu items: ${menus.length} (linked ${linkedRows.length}, unlinked ${unlinkedRows.length})`);
  console.log(`Inventory items: ${items.length} total (${items.filter((i) => i.isActive).length} active)`);
  console.log("Link flags:", JSON.stringify(flagCounts));
  console.log(`Duplicate groups: ${new Set(dupRows.map(r => r[0] + '|' + r[1])).size} (${dupRows.length} rows)`);
  console.log(`Stranded SKUs with stock: ${strandedRows.length} | Unlinked zero-stock SKUs: ${emptyRows.length}`);
  console.log(`Possible typo pairs: ${typoRows.length}`);
  console.log("\nFiles written to reports/mapping-review/:");
  for (const [f, n] of Object.entries(counts)) console.log(`  ${f} — ${n} rows`);

  await prisma.$disconnect();
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
