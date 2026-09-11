// fix-inventory-match-excel.js — Fix inventory to match Excel exactly
// 1. Create missing 90ml items for products on category header rows
// 2. Deactivate all zero-stock items NOT in the Excel
// 3. Fix Budwiser Magnum 650ml stock (6500ml → 0ml)
//
// Usage:
//   node scripts/fix-inventory-match-excel.js              — DRY RUN
//   node scripts/fix-inventory-match-excel.js --apply      — write to DB

const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RID = "cmqy60ci200027dscyj9ubg8h";
const DATE = "2026-09-08";

const wb = XLSX.readFile("C:\\Users\\akhil\\Downloads\\Untitled spreadsheet.xlsx");
const sheet = wb.Sheets["Liqor Prices 08.09.2026 "];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

function parseNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function cleanBrandName(raw) {
  if (!raw) return "";
  let s = String(raw).trim().replace(/\s*\d+\s*ml\b/gi, "").trim();
  return s.split(/\s+/).map(w => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
}
function normalizeBrand(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/\s*\d+\s*ml\b/gi, "")
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse ALL Excel products — including those on category header rows
function parseExcelProducts() {
  let currentCategory = "Beer";
  const products = [];

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    // Check for category header in col A — but DON'T skip the row!
    const catA = row[0];
    if (catA && typeof catA === 'string') {
      const upper = catA.toUpperCase().trim();
      if (['BRANDY', 'RUM', 'VODKA', 'WHISKY', 'WINE'].includes(upper)) {
        currentCategory = upper.charAt(0) + upper.slice(1).toLowerCase();
        // DON'T continue — process the product on this row too
      }
    }

    const brand = row[1];
    if (!brand || typeof brand !== 'string') continue;
    const brandName = cleanBrandName(brand);
    if (!brandName) continue;

    if (currentCategory === "Beer") {
      const landing = parseNum(row[7]);
      const qty = parseNum(row[37]);
      const bottleSize = 650;
      if (qty > 0 || landing > 0) {
        products.push({
          brand: brandName, category: "Beer", bottleSizeMl: bottleSize,
          purchaseRate: landing > 0 ? landing : null,
          totalQty: qty, totalStockMl: qty * bottleSize,
          normKey: `${normalizeBrand(brandName)}::${bottleSize}`,
        });
      }
    } else {
      const sizes = [
        { ml: 180, landCol: 8, totalCol: 37 },
        { ml: 375, landCol: 9, totalCol: 38 },
        { ml: 750, landCol: 10, totalCol: 39 },
        { ml: 90, landCol: 11, totalCol: 40 },
      ];
      for (const sz of sizes) {
        const landing = parseNum(row[sz.landCol]);
        const qty = parseNum(row[sz.totalCol]);
        if (qty > 0 || landing > 0) {
          products.push({
            brand: brandName, category: currentCategory, bottleSizeMl: sz.ml,
            purchaseRate: landing > 0 ? landing : null,
            totalQty: qty, totalStockMl: qty * sz.ml,
            normKey: `${normalizeBrand(brandName)}::${sz.ml}`,
          });
        }
      }
    }
  }
  return products;
}

(async () => {
  const excelProducts = parseExcelProducts();
  const excelByKey = new Map();
  for (const p of excelProducts) excelByKey.set(p.normKey, p);

  const dbItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, brand: true, category: true, bottleSizeMl: true, currentStockMl: true, purchaseRate: true },
  });

  const dbByKey = new Map();
  for (const item of dbItems) {
    const norm = normalizeBrand(item.brand || item.name);
    const key = `${norm}::${item.bottleSizeMl}`;
    dbByKey.set(key, item);
  }

  // 1. Missing items (in Excel, not in DB)
  const missing = excelProducts.filter(p => !dbByKey.has(p.normKey));

  // 2. Extra items (in DB, not in Excel)
  const extra = dbItems.filter(item => {
    const norm = normalizeBrand(item.brand || item.name);
    const key = `${norm}::${item.bottleSizeMl}`;
    return !excelByKey.has(key);
  });

  // 3. Stock mismatches
  const mismatches = [];
  for (const p of excelProducts) {
    const dbItem = dbByKey.get(p.normKey);
    if (!dbItem) continue;
    const dbStock = Number(dbItem.currentStockMl);
    if (Math.abs(dbStock - p.totalStockMl) > 0.1) {
      mismatches.push({ excel: p, dbItem, dbStock, excelStock: p.totalStockMl, diff: dbStock - p.totalStockMl });
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Fix Inventory to Match Excel — Vgrand Lounge`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`${"=".repeat(80)}\n`);

  console.log(`Excel products: ${excelProducts.length}`);
  console.log(`DB active items: ${dbItems.length}`);
  console.log(`\nMissing (create): ${missing.length}`);
  console.log(`Extra (deactivate): ${extra.length} (${extra.filter(e => Number(e.currentStockMl) > 0).length} with stock, ${extra.filter(e => Number(e.currentStockMl) === 0).length} zero stock)`);
  console.log(`Stock mismatches: ${mismatches.length}`);

  if (missing.length > 0) {
    console.log(`\n--- MISSING (will create) ---`);
    for (const p of missing) {
      console.log(`  ${p.brand} ${p.bottleSizeMl}ml | ${p.category} | ${p.totalQty} btl (${p.totalStockMl}ml) | rate=${p.purchaseRate || "null"}`);
    }
  }

  if (mismatches.length > 0) {
    console.log(`\n--- STOCK MISMATCHES (will adjust) ---`);
    for (const m of mismatches) {
      console.log(`  ${m.excel.brand} ${m.excel.bottleSizeMl}ml | DB=${m.dbStock}ml → Excel=${m.excelStock}ml (Δ${m.diff > 0 ? "+" : ""}${m.diff}ml)`);
    }
  }

  if (extra.length > 0) {
    console.log(`\n--- EXTRA (will deactivate) ---`);
    const withStock = extra.filter(e => Number(e.currentStockMl) > 0);
    const zeroStock = extra.filter(e => Number(e.currentStockMl) === 0);
    if (withStock.length > 0) {
      console.log(`  With stock (${withStock.length}):`);
      for (const e of withStock) {
        console.log(`    ${e.name} | ${e.category} | ${e.bottleSizeMl}ml | stock=${Number(e.currentStockMl)}ml`);
      }
    }
    console.log(`  Zero stock: ${zeroStock.length} items (will be deactivated)`);
  }

  if (!APPLY) {
    console.log(`\n${"=".repeat(80)}\nDRY RUN — no changes. Run with --apply to execute.\n${"=".repeat(80)}`);
    await prisma.$disconnect();
    return;
  }

  // APPLY
  console.log(`\n${"=".repeat(80)}\nAPPLYING...\n${"=".repeat(80)}`);
  let created = 0, adjusted = 0, deactivated = 0;
  const errors = [];

  // 1. Create missing items
  console.log("Creating missing items...");
  for (const p of missing) {
    try {
      const itemName = `${p.brand} ${p.bottleSizeMl}ml`;
      const item = await prisma.barInventoryItem.create({
        data: {
          restaurantId: RID, name: itemName, brand: p.brand, category: p.category,
          bottleSizeMl: p.bottleSizeMl, currentStockMl: p.totalStockMl,
          purchaseRate: p.purchaseRate, reorderLevelBottles: 1, isActive: true,
        },
      });
      await prisma.barInventoryMovement.create({
        data: {
          restaurantId: RID, itemId: item.id, movementType: "OPENING",
          quantityMl: p.totalStockMl, date: DATE, source: "OPENING_SETUP",
          notes: "Fix: missing product from category header row in Excel",
        },
      });
      created++;
    } catch (e) { errors.push(`CREATE ${p.brand} ${p.bottleSizeMl}ml: ${e.message}`); }
  }

  // 2. Fix stock mismatches
  console.log("Fixing stock mismatches...");
  for (const m of mismatches) {
    try {
      const delta = m.excelStock - m.dbStock;
      await prisma.barInventoryMovement.create({
        data: {
          restaurantId: RID, itemId: m.dbItem.id, movementType: "ADJUSTMENT",
          quantityMl: delta, date: DATE, source: "OPENING_SETUP",
          notes: "Fix: stock adjusted to match Excel physical count",
        },
      });
      await prisma.barInventoryItem.update({
        where: { id: m.dbItem.id },
        data: { currentStockMl: m.excelStock },
      });
      adjusted++;
    } catch (e) { errors.push(`ADJUST ${m.excel.brand} ${m.excel.bottleSizeMl}ml: ${e.message}`); }
  }

  // 3. Deactivate extra items
  console.log("Deactivating extra items...");
  for (const e of extra) {
    try {
      // If item has stock, create adjustment to zero first
      const stock = Number(e.currentStockMl);
      if (stock !== 0) {
        await prisma.barInventoryMovement.create({
          data: {
            restaurantId: RID, itemId: e.id, movementType: "ADJUSTMENT",
            quantityMl: -stock, date: DATE, source: "OPENING_SETUP",
            notes: "Fix: item not in Excel — zeroing stock before deactivation",
          },
        });
      }
      // Unlink menu items
      await prisma.menuItem.updateMany({
        where: { barInventoryItemId: e.id },
        data: { barInventoryItemId: null },
      });
      // Deactivate
      await prisma.barInventoryItem.update({
        where: { id: e.id },
        data: { isActive: false },
      });
      deactivated++;
    } catch (err) { errors.push(`DEACTIVATE ${e.name}: ${err.message}`); }
  }

  console.log(`\nAPPLY COMPLETE`);
  console.log(`  Created: ${created}`);
  console.log(`  Adjusted: ${adjusted}`);
  console.log(`  Deactivated: ${deactivated}`);
  if (errors.length > 0) { console.log(`  Errors: ${errors.length}`); for (const e of errors) console.log(`    ${e}`); }

  await prisma.$disconnect();
})();
