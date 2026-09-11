// mapping-apply2.js — Round-2 consolidation for Vgrand Lounge.
//
// User-confirmed decisions:
//   A. "Courier Napoleon 750ml" IS the Red stock (only Red + Green exist)
//      → rename to "Courier Napoleon Red 750ml". Menu links already point here.
//   B. Royal Green Premium is a DIFFERENT product from Royal Stag
//      → create "Royal Green Premium 750ml" SKU + relink its menu items.
//   C. Smirnoff Orange = plain Smirnoff; 8pm Premium Black = plain 8pm
//      → existing links are correct, no action.
//   D. SIZE_MISMATCH → relink menu items to a same-base same-size SKU when
//      an ACTIVE one exists. Where none exists, list for manual decision.
//   E. Unlinked menu items → link to a matching active SKU when one exists
//      (sodas' SKUs are inactive, so they stay unlinked — intended).
//   F. Peg-size shells (≤60ml, no links, no stock) can't be physical bottles
//      → deactivate. 90ml+ sizes stay — user confirmed those are real bottles.
//
// Usage: node scripts/mapping-apply2.js           — dry run
//        node scripts/mapping-apply2.js --apply   — write to DB

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RID = "cmqy60ci200027dscyj9ubg8h"; // Vgrand Lounge

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

(async () => {
  const items = await prisma.barInventoryItem.findMany({ where: { restaurantId: RID } });
  const menus = await prisma.menuItem.findMany({
    where: { restaurantId: RID, menuType: "LIQUOR", isDeleted: false },
    select: { id: true, name: true, deductionMl: true, barInventoryItemId: true },
  });
  const invById = new Map(items.map((i) => [i.id, i]));
  const invBase = (i) => baseName(i.name);
  const activeWithBase = (b) => items.filter((i) => i.isActive && invBase(i) === b);
  const report = { renamed: [], created: [], relinked: [], noSizeSku: [], linkedUnlinked: [], deactivated: [] };

  // ── A. Napoleon Red rename ────────────────────────────────────────────────
  const napoleon = items.find((i) => i.name === "Courier Napoleon 750ml" && i.isActive);
  if (napoleon) {
    report.renamed.push(`"Courier Napoleon 750ml" -> "Courier Napoleon Red 750ml" (the SKU holds the Red stock; Green has its own)`);
    if (APPLY) await prisma.barInventoryItem.update({
      where: { id: napoleon.id },
      data: { name: "Courier Napoleon Red 750ml", brand: "Courier Napoleon Red" },
    });
  }

  // ── B. Royal Green Premium gets its own SKU ───────────────────────────────
  const rgp = items.find((i) => invBase(i) === "royal green premium");
  if (!rgp || !rgp.isActive) {
    report.created.push(`${rgp ? `reactivate "${rgp.name}"` : `create "Royal Green Premium 750ml"`} (stock 0 until count) + relink its menu items`);
    if (APPLY) {
      const target = rgp
        ? await prisma.barInventoryItem.update({ where: { id: rgp.id }, data: { isActive: true } })
        : await prisma.barInventoryItem.create({
            data: { restaurantId: RID, name: "Royal Green Premium 750ml", brand: "Royal Green Premium", category: "Whisky", bottleSizeMl: 750 },
          });
      rgp ? (rgp.isActive = true) : items.push(target);
      await prisma.menuItem.updateMany({
        where: { restaurantId: RID, isDeleted: false, name: { contains: "Royal Green Premium", mode: "insensitive" } },
        data: { barInventoryItemId: target.id },
      });
    }
  }

  // Same base with spaces removed — catches "Vat69" vs "Vat 69" menu typos.
  const spaceless = (b) => b.replace(/\s+/g, "");
  const bySpaceless = new Map();
  for (const i of items) {
    const k = spaceless(invBase(i));
    if (!bySpaceless.has(k)) bySpaceless.set(k, []);
    bySpaceless.get(k).push(i);
  }

  // ── D. Size-mismatch relinks (menu size >= 100, linked SKU different size) ─
  for (const m of menus) {
    if (!m.barInventoryItemId) continue;
    const menuSize = parseMlFromName(m.name);
    if (!menuSize || menuSize < 100) continue;
    const cur = invById.get(m.barInventoryItemId);
    if (!cur || cur.bottleSizeMl === menuSize) continue;
    const mBase = baseName(m.name);
    const sameSize = (bySpaceless.get(spaceless(mBase)) || []).filter((i) => i.bottleSizeMl === menuSize);
    const exact = sameSize.find((i) => i.isActive);
    if (exact) {
      report.relinked.push(`"${m.name}" : ${cur.name} (${cur.bottleSizeMl}) -> ${exact.name} (${menuSize})`);
      if (APPLY) await prisma.menuItem.update({ where: { id: m.id }, data: { barInventoryItemId: exact.id, deductionMl: menuSize } });
      continue;
    }
    const inact = sameSize.find((i) => !i.isActive);
    if (inact && Number(inact.currentStockMl) > 0) {
      // Inactive SKU holding real stock = you physically stock this size.
      report.relinked.push(`"${m.name}" : ${cur.name} (${cur.bottleSizeMl}) -> ${inact.name} (${menuSize}) [REACTIVATED — holds ${Math.round(Number(inact.currentStockMl))}ml]`);
      if (APPLY) {
        await prisma.barInventoryItem.update({ where: { id: inact.id }, data: { isActive: true } });
        await prisma.menuItem.update({ where: { id: m.id }, data: { barInventoryItemId: inact.id, deductionMl: menuSize } });
        inact.isActive = true;
      }
      continue;
    }
    report.noSizeSku.push(`"${m.name}" stays on ${cur.name} — ${inact ? `INACTIVE ${menuSize}ml SKU exists but holds 0 stock (${inact.name}) — stock it?` : `no ${menuSize}ml SKU — decide: stock it or keep pouring from ${cur.bottleSizeMl}`}`);
  }

  // ── E. Link unlinked menu items to matching active SKUs ───────────────────
  for (const m of menus) {
    if (m.barInventoryItemId) continue;
    const mBase = baseName(m.name);
    const menuSize = parseMlFromName(m.name);
    const cands = (bySpaceless.get(spaceless(mBase)) || []).filter((i) => i.isActive);
    if (!cands.length) continue;
    const tgt = (menuSize && menuSize >= 100 && cands.find((i) => i.bottleSizeMl === menuSize))
      || cands.find((i) => i.bottleSizeMl === 750)
      || cands.slice().sort((a, b) => b.bottleSizeMl - a.bottleSizeMl)[0];
    report.linkedUnlinked.push(`"${m.name}" -> ${tgt.name} (${tgt.bottleSizeMl}ml) deduction=${menuSize ?? m.deductionMl ?? "?"}ml`);
    if (APPLY) await prisma.menuItem.update({
      where: { id: m.id },
      data: { barInventoryItemId: tgt.id, deductionMl: menuSize ?? m.deductionMl ?? tgt.bottleSizeMl },
    });
  }

  // ── F. Deactivate peg-size shells (<=60ml, no links, no stock) ────────────
  const linkedIds = new Set(menus.map((m) => m.barInventoryItemId).filter(Boolean));
  for (const i of items) {
    if (!i.isActive || i.bottleSizeMl > 60) continue;
    if (linkedIds.has(i.id) || Number(i.currentStockMl) !== 0) continue;
    report.deactivated.push(`${i.name} [${i.id}] (${i.bottleSizeMl}ml shell — not a physical bottle)`);
    if (APPLY) await prisma.barInventoryItem.update({ where: { id: i.id }, data: { isActive: false } });
  }

  console.log(`\n═══ ROUND-2 PLAN (${APPLY ? "APPLY" : "DRY RUN"}) ═══`);
  for (const [k, rows] of Object.entries(report)) {
    console.log(`\n${k} (${rows.length}):`);
    rows.forEach((r) => console.log(`  ${r}`));
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
