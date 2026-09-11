// Beer-only reconciliation — fixes the beer section that was missed by the
// main import (category header was at row 4, parser started at row 5).
//
// Usage:
//   node scripts/reconcile-beer-only.js              — DRY RUN
//   node scripts/reconcile-beer-only.js --apply      — write to DB

const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const OPENING_DATE = "2026-09-08";

function parseNum(val) {
  if (val == null || val === "") return 0;
  const s = String(val).replace(/[,]/g, "").replace(/[#].*$/, "").trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseQty(val) {
  if (val == null || val === "") return 0;
  const s = String(val).trim();
  if (s === "" || s === "0") return 0;
  const n = parseFloat(s.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseMlFromName(name) {
  if (!name) return null;
  const m = name.match(/(\d+)\s*ml\b/i);
  return m ? parseInt(m[1], 10) : null;
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

function cleanBrandName(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/\s*\d+\s*ml\b/gi, "").trim();
  return s.split(/\s+/).map(w => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
}

function parseBeerFromExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

  const products = [];
  let inBeerSection = false;

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    const colA = row[0];
    const brandRaw = row[1];

    // Detect beer section
    if (colA && String(colA).trim().toLowerCase() === "beers") {
      inBeerSection = true;
      continue;
    }
    // Detect end of beer section (next category header)
    if (colA && String(colA).trim() && String(colA).trim().toLowerCase() !== "beers") {
      inBeerSection = false;
      continue;
    }

    if (!inBeerSection) continue;
    if (!brandRaw || !String(brandRaw).trim()) continue;

    const brandName = String(brandRaw).trim();
    const bottleSize = parseMlFromName(brandName) || 650;
    const landingPrice = parseNum(row[7]);   // H = beer landing price
    const totalQty = parseQty(row[37]);       // AL = total qty

    if (totalQty === 0 && landingPrice === 0) continue;

    products.push({
      brand: cleanBrandName(brandName),
      rawBrand: brandName,
      bottleSizeMl: bottleSize,
      purchaseRate: landingPrice,
      totalQty,
      totalStockMl: totalQty * bottleSize,
    });
  }

  return products;
}

async function main() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Beer-Only Reconciliation — Vgrand Lounge`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`${"=".repeat(80)}\n`);

  const beers = parseBeerFromExcel("C:/Users/akhil/Downloads/Untitled spreadsheet.xlsx");
  console.log(`Excel beer items: ${beers.length}\n`);

  const dbItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true, category: "Beer" },
    select: { id: true, name: true, brand: true, bottleSizeMl: true, currentStockMl: true, purchaseRate: true },
  });
  console.log(`DB active beer items: ${dbItems.length}\n`);

  // Build lookup
  const dbByNorm = new Map();
  for (const item of dbItems) {
    const norm = normalizeBrand(item.brand || item.name);
    const key = `${norm}::${item.bottleSizeMl}`;
    if (!dbByNorm.has(key)) dbByNorm.set(key, []);
    dbByNorm.get(key).push(item);
  }

  const actions = { match: [], new: [], duplicate: [] };
  const matchedIds = new Set();

  for (const ep of beers) {
    const norm = normalizeBrand(ep.brand);
    const key = `${norm}::${ep.bottleSizeMl}`;
    const candidates = dbByNorm.get(key) || [];

    if (candidates.length === 0) {
      actions.new.push(ep);
    } else if (candidates.length === 1) {
      const db = candidates[0];
      matchedIds.add(db.id);
      actions.match.push({
        excel: ep,
        dbItem: db,
        currentStockMl: Number(db.currentStockMl),
        excelStockMl: ep.totalStockMl,
        deltaMl: ep.totalStockMl - Number(db.currentStockMl),
        rateChanged: ep.purchaseRate > 0 && Number(db.purchaseRate || 0) !== ep.purchaseRate,
      });
    } else {
      const sorted = [...candidates].sort((a, b) => Math.abs(Number(b.currentStockMl)) - Math.abs(Number(a.currentStockMl)));
      const keep = sorted[0];
      const deactivate = sorted.slice(1);
      matchedIds.add(keep.id);
      for (const d of deactivate) matchedIds.add(d.id);
      actions.duplicate.push({ excel: ep, keep, deactivate, deltaMl: ep.totalStockMl - Number(keep.currentStockMl) });
    }
  }

  // Orphan beer items (active, not matched)
  const orphanBeers = dbItems.filter(i => !matchedIds.has(i.id));

  console.log(`ACTION SUMMARY`);
  console.log(`  MATCH (adjust):    ${actions.match.length}`);
  console.log(`  NEW (create):      ${actions.new.length}`);
  console.log(`  DUPLICATE (merge): ${actions.duplicate.length}`);
  console.log(`  ORPHAN (zero):     ${orphanBeers.length}\n`);

  // Print details
  if (actions.match.length > 0) {
    console.log(`MATCH:`);
    for (const m of actions.match) {
      const rc = m.rateChanged ? ` ₹${Number(m.dbItem.purchaseRate||0)}→₹${m.excel.purchaseRate}` : "";
      console.log(`  ${m.excel.brand} ${m.excel.bottleSizeMl}ml | DB=${m.currentStockMl}ml → Excel=${m.excelStockMl}ml (Δ${m.deltaMl >= 0 ? "+" : ""}${m.deltaMl}ml)${rc}`);
    }
  }
  if (actions.new.length > 0) {
    console.log(`\nNEW:`);
    for (const ep of actions.new) {
      console.log(`  ${ep.brand} ${ep.bottleSizeMl}ml | ${ep.totalQty} btl (${ep.totalStockMl}ml) | ₹${ep.purchaseRate}`);
    }
  }
  if (actions.duplicate.length > 0) {
    console.log(`\nDUPLICATE:`);
    for (const d of actions.duplicate) {
      console.log(`  ${d.excel.brand} ${d.excel.bottleSizeMl}ml:`);
      console.log(`    KEEP: ${d.keep.name} (stock=${Number(d.keep.currentStockMl)}ml) → adjust to ${d.excel.totalStockMl}ml`);
      for (const dup of d.deactivate) console.log(`    DEACTIVATE: ${dup.name} (stock=${Number(dup.currentStockMl)}ml)`);
    }
  }
  if (orphanBeers.length > 0) {
    console.log(`\nORPHAN beer items (zero out):`);
    for (const o of orphanBeers) {
      console.log(`  ${o.name} | size=${o.bottleSizeMl}ml | stock=${Number(o.currentStockMl)}ml`);
    }
  }

  if (!APPLY) {
    console.log(`\n${"=".repeat(80)}\nDRY RUN — no changes. Run with --apply to execute.\n${"=".repeat(80)}`);
    await prisma.$disconnect();
    return;
  }

  // APPLY
  console.log(`\n${"=".repeat(80)}\nAPPLYING...\n${"=".repeat(80)}`);
  let created = 0, adjusted = 0, merged = 0, zeroed = 0;
  const errors = [];

  // NEW
  for (const ep of actions.new) {
    try {
      const itemName = `${ep.brand} ${ep.bottleSizeMl}ml`;
      const item = await prisma.barInventoryItem.create({
        data: {
          restaurantId: RESTAURANT_ID, name: itemName, brand: ep.brand,
          category: "Beer", bottleSizeMl: ep.bottleSizeMl,
          currentStockMl: ep.totalStockMl,
          purchaseRate: ep.purchaseRate > 0 ? ep.purchaseRate : null,
          reorderLevelBottles: 2, isActive: true,
        },
      });
      if (ep.totalStockMl > 0) {
        await prisma.barInventoryMovement.create({
          data: { restaurantId: RESTAURANT_ID, itemId: item.id, date: OPENING_DATE,
            movementType: "OPENING", quantityMl: ep.totalStockMl, source: "OPENING_SETUP",
            notes: `Excel import — ${ep.totalQty} bottles × ${ep.bottleSizeMl}ml` },
        });
      }
      created++;
    } catch (e) { errors.push(`NEW ${ep.brand}: ${e.message}`); }
  }

  // MATCH
  for (const m of actions.match) {
    try {
      const updateData = {};
      if (m.rateChanged && m.excel.purchaseRate > 0) updateData.purchaseRate = m.excel.purchaseRate;
      if (m.deltaMl !== 0) {
        await prisma.barInventoryMovement.create({
          data: { restaurantId: RESTAURANT_ID, itemId: m.dbItem.id, date: OPENING_DATE,
            movementType: "ADJUSTMENT", quantityMl: m.deltaMl, source: "MANUAL_ENTRY",
            notes: `Excel beer reconciliation — adjust from ${m.currentStockMl}ml to ${m.excelStockMl}ml` },
        });
        updateData.currentStockMl = m.excelStockMl;
      }
      if (Object.keys(updateData).length > 0) {
        await prisma.barInventoryItem.update({ where: { id: m.dbItem.id }, data: updateData });
      }
      adjusted++;
    } catch (e) { errors.push(`MATCH ${m.excel.brand}: ${e.message}`); }
  }

  // DUPLICATE
  for (const d of actions.duplicate) {
    try {
      for (const dup of d.deactivate) {
        await prisma.menuItem.updateMany({ where: { barInventoryItemId: dup.id }, data: { barInventoryItemId: d.keep.id } });
        await prisma.barInventoryItem.update({ where: { id: dup.id }, data: { isActive: false } });
        merged++;
      }
      if (d.deltaMl !== 0) {
        await prisma.barInventoryMovement.create({
          data: { restaurantId: RESTAURANT_ID, itemId: d.keep.id, date: OPENING_DATE,
            movementType: "ADJUSTMENT", quantityMl: d.deltaMl, source: "MANUAL_ENTRY",
            notes: `Excel beer reconciliation (merged) — adjust to ${d.excel.totalStockMl}ml` },
        });
        await prisma.barInventoryItem.update({ where: { id: d.keep.id }, data: { currentStockMl: d.excel.totalStockMl } });
      }
      if (d.excel.purchaseRate > 0) {
        await prisma.barInventoryItem.update({ where: { id: d.keep.id }, data: { purchaseRate: d.excel.purchaseRate } });
      }
    } catch (e) { errors.push(`DUP ${d.excel.brand}: ${e.message}`); }
  }

  // ORPHAN zero out
  for (const o of orphanBeers) {
    try {
      const currentStock = Number(o.currentStockMl);
      if (currentStock === 0) continue;
      await prisma.barInventoryMovement.create({
        data: { restaurantId: RESTAURANT_ID, itemId: o.id, date: OPENING_DATE,
          movementType: "ADJUSTMENT", quantityMl: -currentStock, source: "MANUAL_ENTRY",
          notes: "Excel beer reconciliation — zero out (not in Excel)" },
      });
      await prisma.barInventoryItem.update({ where: { id: o.id }, data: { currentStockMl: 0 } });
      zeroed++;
    } catch (e) { errors.push(`ORPHAN ${o.name}: ${e.message}`); }
  }

  console.log(`\nAPPLY COMPLETE`);
  console.log(`  Created: ${created}, Adjusted: ${adjusted}, Merged: ${merged}, Zeroed: ${zeroed}`);
  if (errors.length > 0) { console.log(`  Errors: ${errors.length}`); for (const e of errors) console.log(`    ${e}`); }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
