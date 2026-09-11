// size-decisions.js — brand-grouped decision sheet for size mismatches.
// For each brand, lists sizes that have an INACTIVE same-size SKU (0 stock)
// plus menu items currently pouring from the 750. Mark "stocked" per brand.
const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
const prisma = new PrismaClient();
const RID = "cmqy60ci200027dscyj9ubg8h";
const OUT = path.join(__dirname, "..", "reports", "mapping-review", "size-decisions.csv");

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
const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

(async () => {
  const items = await prisma.barInventoryItem.findMany({ where: { restaurantId: RID } });
  const menus = await prisma.menuItem.findMany({
    where: { restaurantId: RID, menuType: "LIQUOR", isDeleted: false, barInventoryItemId: { not: null } },
    select: { id: true, name: true, barInventoryItemId: true },
  });
  const invById = new Map(items.map((i) => [i.id, i]));
  const invBase = (i) => baseName(i.name);
  const spaceless = (b) => b.replace(/\s+/g, "");

  // brand -> { sizes: Map<size, { inactiveSku, skuStock, menus: [names] }> }
  const brands = new Map();
  for (const m of menus) {
    const cur = invById.get(m.barInventoryItemId);
    if (!cur) continue;
    const size = parseMlFromName(m.name);
    if (!size || size < 100 || cur.bottleSizeMl === size) continue;
    const mBase = baseName(m.name);
    const brand = cur.brand || cur.name;
    if (!brands.has(brand)) brands.set(brand, new Map());
    const sizes = brands.get(brand);
    if (!sizes.has(size)) sizes.set(size, { menus: [], inactSku: null });
    sizes.get(size).menus.push(m.name);
    if (!sizes.get(size).inactSku) {
      sizes.get(size).inactSku = items.find((i) => !i.isActive && spaceless(invBase(i)) === spaceless(mBase) && i.bottleSizeMl === size) || null;
    }
  }

  const rows = [["brand", "sizeMl", "menuItemsAffected", "inactiveSkuExists", "inactiveSkuStockMl", "decision (STOCK / POUR-FROM-750)"]];
  for (const [brand, sizes] of [...brands.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const [size, info] of [...sizes.entries()].sort((a, b) => a[0] - b[0])) {
      rows.push([brand, size, info.menus.join("; "), info.inactSku ? info.inactSku.name : "NO SKU", info.inactSku ? Math.round(Number(info.inactSku.currentStockMl)) : "", ""]);
    }
  }
  fs.writeFileSync(OUT, rows.map((r) => r.map(esc).join(",")).join("\n"), "utf8");
  console.log(`${rows.length - 1} decision rows -> ${OUT}`);
  console.log("\nBrands needing a call:");
  for (const [brand, sizes] of [...brands.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${brand}: ${[...sizes.keys()].sort((a, b) => a - b).map((s) => `${s}ml`).join(", ")}`);
  }
  await prisma.$disconnect();
})();
