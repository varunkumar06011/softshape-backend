// mapping-apply3.js — Final linking pass for Vgrand Lounge.
//
// User's model: the bottle picker shows every size (90/180/375/750/650...) with
// live counts; the cashier picks whichever bottle is physically used. So every
// same-size SKU should be ACTIVE and linked — even at 0 stock. When the stock
// arrives they just add it; no more code work.
//
//   A. Menu item "X 180ml" linked to the 750 → if a same-size SKU exists
//      (active or inactive, incl. spacing-typo names like "Vat69 180Ml")
//      → reactivate + relink. If none exists → CREATE it at 0 stock + link.
//   B. Unlinked menu items → link to an ALREADY-ACTIVE matching SKU only
//      (soda SKUs stay inactive → sodas stay unlinked, per user).
//   C. Active zero-stock SKUs that no menu item can ever match → deactivate.
//
// Usage: node scripts/mapping-apply3.js           — dry run
//        node scripts/mapping-apply3.js --apply   — write to DB

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RID = "cmqy60ci200027dscyj9ubg8h";

function parseMlFromName(name) {
  const ltr = String(name || "").match(/(\d+)\s*l(?:tr|itre|iter)?\b/i);
  if (ltr) return parseInt(ltr[1], 10) * 1000;
  const ml = String(name || "").match(/(\d+)\s*ml\b/i);
  return ml ? parseInt(ml[1], 10) : null;
}
function baseName(name) {
  return String(name || "").toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, " ")
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
const spaceless = (s) => s.replace(/\s+/g, "");
function titleCase(s) {
  return s.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
// Brand label for a new SKU: current linked SKU's name minus its size, else menu base.
function labelFor(menu, linkedItem, menuBase) {
  if (linkedItem && baseName(linkedItem.name) !== menuBase) {
    // cross-base link (alias like "Bp" -> Blenders Pride) — use the SKU's brand
    return linkedItem.brand || linkedItem.name.replace(/\s*\d+\s*ml.*$/i, "").trim();
  }
  return linkedItem?.brand || titleCase(menuBase);
}

(async () => {
  const items = await prisma.barInventoryItem.findMany({ where: { restaurantId: RID } });
  const menus = await prisma.menuItem.findMany({
    where: { restaurantId: RID, menuType: "LIQUOR", isDeleted: false },
    select: { id: true, name: true, deductionMl: true, barInventoryItemId: true },
  });
  const invById = new Map(items.map((i) => [i.id, i]));
  const invBase = (i) => baseName(i.name);

  // Spaceless-base index: "vat69" and "vat 69" resolve together.
  const bySpaceless = new Map();
  const indexItem = (i) => {
    const k = spaceless(invBase(i));
    if (!bySpaceless.has(k)) bySpaceless.set(k, []);
    bySpaceless.get(k).push(i);
  };
  items.forEach(indexItem);

  // Prefer: active > exact-base match > spaceless-only; then larger stock.
  function pickSameSize(mBase, size) {
    const cands = (bySpaceless.get(spaceless(mBase)) || []).filter((i) => i.bottleSizeMl === size);
    if (!cands.length) return null;
    const exact = cands.filter((i) => invBase(i) === mBase);
    const pool = exact.length ? exact : cands;
    return pool.slice().sort((a, b) =>
      (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0)
      || Math.abs(Number(b.currentStockMl)) - Math.abs(Number(a.currentStockMl)))[0];
  }

  const report = { relinked: [], reactivated: [], created: [], linked: [], deactivated: [], leftovers: [] };

  async function activateAndLink(menu, sku, why) {
    const cur = menu.barInventoryItemId ? invById.get(menu.barInventoryItemId) : null;
    const tag = `${sku.isActive ? "" : "REACTIVATED + "}${why}`;
    report.relinked.push(`"${menu.name}" : ${cur ? `${cur.name} (${cur.bottleSizeMl}ml)` : "NONE"} -> ${sku.name} (${sku.bottleSizeMl}ml)  [${tag}]`);
    if (APPLY) {
      if (!sku.isActive) { await prisma.barInventoryItem.update({ where: { id: sku.id }, data: { isActive: true } }); sku.isActive = true; }
      await prisma.menuItem.update({ where: { id: menu.id }, data: { barInventoryItemId: sku.id, deductionMl: parseMlFromName(menu.name) ?? menu.deductionMl } });
      menu.barInventoryItemId = sku.id; // keep in-memory state current for pass C
    } else {
      menu.barInventoryItemId = sku.id;
    }
  }

  // ── A. Size mismatch → activate/create same-size SKU + relink ────────────
  // Search by the LINKED item's base first — menu names are aliases ("Britesh Wh"
  // -> "British Whiky"), the product family's same-size SKU is the right target.
  // Menu-name base is only a fallback (e.g. "8pm Premium Black 180ml" when no
  // "8pm 180ml" exists).
  for (const m of menus) {
    if (!m.barInventoryItemId) continue;
    const size = parseMlFromName(m.name);
    if (!size || size < 100) continue;
    const cur = invById.get(m.barInventoryItemId);
    if (!cur || cur.bottleSizeMl === size) continue;
    const mBase = baseName(m.name);
    const curBase = invBase(cur);
    const sku = pickSameSize(curBase, size) || pickSameSize(mBase, size);
    if (sku) {
      await activateAndLink(m, sku, curBase === invBase(sku) ? "same product, right size" : "menu-name size SKU");
      continue;
    }
    // No SKU at all for this size — create at 0 stock under the product's name.
    const label = labelFor(m, cur, mBase);
    const name = `${label} ${size}ml`;
    report.created.push(`create "${name}" (0 stock) + link "${m.name}"`);
    if (APPLY) {
      try {
        const made = await prisma.barInventoryItem.create({
          data: { restaurantId: RID, name, brand: label, category: cur?.category || "Liquor", bottleSizeMl: size },
        });
        indexItem(made);
        invById.set(made.id, made);
        await prisma.menuItem.update({ where: { id: m.id }, data: { barInventoryItemId: made.id, deductionMl: size } });
        m.barInventoryItemId = made.id;
      } catch (e) {
        report.leftovers.push(`create failed for "${name}": ${e.message}`);
      }
    }
  }

  // ── B. Unlinked menus → link to ACTIVE matching SKU only ─────────────────
  for (const m of menus) {
    if (m.barInventoryItemId) continue;
    const mBase = baseName(m.name);
    const size = parseMlFromName(m.name);
    const cands = (bySpaceless.get(spaceless(mBase)) || []).filter((i) => i.isActive);
    if (!cands.length) continue;
    const tgt = (size && size >= 100 && cands.find((i) => i.bottleSizeMl === size))
      || cands.find((i) => i.bottleSizeMl === 750)
      || cands.slice().sort((a, b) => b.bottleSizeMl - a.bottleSizeMl)[0];
    report.linked.push(`"${m.name}" -> ${tgt.name} (${tgt.bottleSizeMl}ml)`);
    if (APPLY) await prisma.menuItem.update({
      where: { id: m.id },
      data: { barInventoryItemId: tgt.id, deductionMl: size ?? m.deductionMl ?? tgt.bottleSizeMl },
    });
    m.barInventoryItemId = tgt.id;
  }

  // ── C. Active 0-stock SKUs nothing can match → deactivate ────────────────
  const menuBases = new Set(menus.map((m) => spaceless(baseName(m.name))));
  for (const i of items) {
    if (!i.isActive || Number(i.currentStockMl) !== 0) continue;
    if (menus.some((m) => m.barInventoryItemId === i.id)) continue;   // has links
    if (menuBases.has(spaceless(invBase(i)))) continue;               // a menu could match it
    report.deactivated.push(`${i.name} [${i.id}] (${i.bottleSizeMl}ml, 0 stock, no matching menu)`);
    if (APPLY) await prisma.barInventoryItem.update({ where: { id: i.id }, data: { isActive: false } });
  }

  console.log(`\n═══ ROUND-3 (${APPLY ? "APPLY" : "DRY RUN"}) ═══`);
  for (const [k, rows] of Object.entries(report)) {
    console.log(`\n${k} (${rows.length}):`);
    rows.slice(0, 60).forEach((r) => console.log(`  ${r}`));
    if (rows.length > 60) console.log(`  ... +${rows.length - 60} more`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
