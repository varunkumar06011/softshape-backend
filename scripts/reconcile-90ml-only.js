// reconcile-90ml-only.js — Import 90ml physical bottle SKUs that were skipped
// by the main reconciliation script.
//
// Usage:
//   node scripts/reconcile-90ml-only.js              — DRY RUN
//   node scripts/reconcile-90ml-only.js --apply      — write to DB

const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const IMPORT_DATE = "2026-09-08";

const wb = XLSX.readFile("C:\\Users\\akhil\\Downloads\\Untitled spreadsheet.xlsx");
const sheet = wb.Sheets["Liqor Prices 08.09.2026 "];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

const COL = {
  BRAND: 1,
  LAND_90: 11,     // L — 90ml bottle landing (always 0 in this Excel)
  TOTAL_90: 40,    // AO — total 90ml qty
};

function parseNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function parseQty(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function cleanBrandName(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/\s*\d+\s*ml\b/gi, "").trim();
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

// Parse 90ml products from Excel
function parse90mlProducts() {
  let currentCategory = "Beer";
  const products = [];

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    const catA = row[0];
    if (catA && typeof catA === 'string') {
      const upper = catA.toUpperCase().trim();
      if (['BRANDY', 'RUM', 'VODKA', 'WHISKY', 'WINE'].includes(upper)) {
        currentCategory = upper.charAt(0) + upper.slice(1).toLowerCase();
        // Don't skip — category header rows may also contain product data
      }
    }

    const brand = row[COL.BRAND];
    if (!brand || typeof brand !== 'string') continue;
    if (currentCategory === "Beer") continue; // beer doesn't have 90ml

    const qty = parseQty(row[COL.TOTAL_90]);
    if (qty <= 0) continue;

    const landingPrice = parseNum(row[COL.LAND_90]); // always 0 in this Excel
    const brandName = cleanBrandName(brand);

    products.push({
      brand: brandName,
      rawBrand: brand.trim(),
      category: currentCategory,
      bottleSizeMl: 90,
      purchaseRate: landingPrice > 0 ? landingPrice : null,
      totalQty: qty,
      totalStockMl: qty * 90,
    });
  }
  return products;
}

async function main() {
  const excelProducts = parse90mlProducts();

  console.log(`\n${"=".repeat(80)}`);
  console.log(`90ml Bottle Import — Vgrand Lounge`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`${"=".repeat(80)}\n`);

  console.log(`Excel 90ml products: ${excelProducts.length}`);
  console.log(`Total 90ml stock: ${excelProducts.reduce((s, p) => s + p.totalStockMl, 0)}ml\n`);

  // Load existing DB items
  const dbItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    select: { id: true, name: true, brand: true, category: true, bottleSizeMl: true, currentStockMl: true, purchaseRate: true },
  });

  // Build lookup: normalized brand + size → items
  const dbByNorm = new Map();
  for (const item of dbItems) {
    const norm = normalizeBrand(item.brand || item.name);
    const key = `${norm}::${item.bottleSizeMl}`;
    if (!dbByNorm.has(key)) dbByNorm.set(key, []);
    dbByNorm.get(key).push(item);
  }

  const actions = { match: [], new: [], duplicate: [] };
  const matchedIds = new Set();

  for (const ep of excelProducts) {
    const norm = normalizeBrand(ep.brand);
    const key = `${norm}::90`;
    const candidates = dbByNorm.get(key) || [];

    if (candidates.length === 0) {
      actions.new.push(ep);
    } else if (candidates.length === 1) {
      const dbItem = candidates[0];
      const currentStock = Number(dbItem.currentStockMl);
      const delta = ep.totalStockMl - currentStock;
      actions.match.push({ excel: ep, dbItem, currentStockMl: currentStock, deltaMl: delta });
      matchedIds.add(dbItem.id);
    } else {
      // Multiple candidates — pick the one with most stock
      const sorted = [...candidates].sort((a, b) => Math.abs(Number(b.currentStockMl)) - Math.abs(Number(a.currentStockMl)));
      const keep = sorted[0];
      const dups = sorted.slice(1);
      actions.duplicate.push({ excel: ep, keep, dups });
      matchedIds.add(keep.id);
      for (const d of dups) matchedIds.add(d.id);
    }
  }

  // Print report
  console.log(`${"─".repeat(80)}`);
  console.log(`ACTION SUMMARY`);
  console.log(`${"─".repeat(80)}`);
  console.log(`  MATCH (adjust):    ${actions.match.length}`);
  console.log(`  NEW (create):      ${actions.new.length}`);
  console.log(`  DUPLICATE (merge): ${actions.duplicate.length}`);

  if (actions.match.length > 0) {
    console.log(`\nMATCH:`);
    for (const m of actions.match) {
      const delta = m.deltaMl !== 0 ? ` (Δ${m.deltaMl > 0 ? "+" : ""}${m.deltaMl}ml)` : "";
      console.log(`  ${m.excel.brand} 90ml | DB=${m.currentStockMl}ml → Excel=${m.excel.totalStockMl}ml${delta}`);
    }
  }

  if (actions.new.length > 0) {
    console.log(`\nNEW:`);
    for (const ep of actions.new) {
      console.log(`  ${ep.brand} 90ml | ${ep.category} | ${ep.totalQty} btl (${ep.totalStockMl}ml) | rate=${ep.purchaseRate || "null"}`);
    }
  }

  if (actions.duplicate.length > 0) {
    console.log(`\nDUPLICATE:`);
    for (const d of actions.duplicate) {
      console.log(`  ${d.excel.brand} 90ml | keep="${d.keep.name}" | dups=${d.dups.length}`);
    }
  }

  if (!APPLY) {
    console.log(`\n${"=".repeat(80)}\nDRY RUN — no changes. Run with --apply to execute.\n${"=".repeat(80)}`);
    await prisma.$disconnect();
    return;
  }

  // APPLY
  console.log(`\n${"=".repeat(80)}\nAPPLYING...\n${"=".repeat(80)}`);
  let created = 0, adjusted = 0, errors = [];

  // 1. NEW — create items + opening movements
  console.log("Creating new 90ml items...");
  for (const ep of actions.new) {
    try {
      const itemName = `${ep.brand} 90ml`;
      const item = await prisma.barInventoryItem.create({
        data: {
          restaurantId: RESTAURANT_ID,
          name: itemName,
          brand: ep.brand,
          category: ep.category,
          bottleSizeMl: 90,
          currentStockMl: ep.totalStockMl,
          purchaseRate: ep.purchaseRate,
          reorderLevelBottles: 1,
          isActive: true,
        },
      });
      await prisma.barInventoryMovement.create({
        data: {
          restaurantId: RESTAURANT_ID,
          itemId: item.id,
          movementType: "OPENING",
          quantityMl: ep.totalStockMl,
          date: IMPORT_DATE,
          source: "OPENING_SETUP",
          notes: "90ml bottle import from Excel physical count 08.09.2026",
        },
      });
      created++;
    } catch (e) {
      errors.push(`NEW ${ep.brand} 90ml: ${e.message}`);
    }
  }

  // 2. MATCH — adjust stock
  console.log("Adjusting matched items...");
  for (const m of actions.match) {
    try {
      if (m.deltaMl !== 0) {
        await prisma.barInventoryMovement.create({
          data: {
            restaurantId: RESTAURANT_ID,
            itemId: m.dbItem.id,
            movementType: "ADJUSTMENT",
            quantityMl: m.deltaMl,
            date: IMPORT_DATE,
            source: "OPENING_SETUP",
            notes: "90ml reconciliation to Excel physical count 08.09.2026",
          },
        });
        await prisma.barInventoryItem.update({
          where: { id: m.dbItem.id },
          data: { currentStockMl: m.excel.totalStockMl },
        });
      }
      adjusted++;
    } catch (e) {
      errors.push(`MATCH ${m.excel.brand} 90ml: ${e.message}`);
    }
  }

  console.log(`\nAPPLY COMPLETE`);
  console.log(`  Created: ${created}`);
  console.log(`  Adjusted: ${adjusted}`);
  if (errors.length > 0) { console.log(`  Errors: ${errors.length}`); for (const e of errors) console.log(`    ${e}`); }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
