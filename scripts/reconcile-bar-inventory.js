// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Reconciliation Import — Vgrand Lounge
// ─────────────────────────────────────────────────────────────────────────────
// Reads the liquor stock Excel (physical count as of 8 Sept 2026), matches
// against existing BarInventoryItems, and produces a detailed action plan.
//
// Actions:
//   MATCH    — Excel product matches a DB item → ADJUST stock to Excel value,
//               update purchaseRate if different.
//   NEW      — Excel product not in DB → create BarInventoryItem + OPENING movement.
//   DUP      — Multiple DB items match same Excel product → keep non-zero stock
//               one, deactivate the other, transfer menu links.
//   JUNK     — DB item in a non-liquor category (food/charges/soft drinks) →
//               deactivate (isActive=false).
//   ORPHAN   — DB liquor item not in Excel → flag for manual review.
//
// Usage:
//   node scripts/reconcile-bar-inventory.js              — DRY RUN (report only)
//   node scripts/reconcile-bar-inventory.js --apply      — write changes to DB
// ─────────────────────────────────────────────────────────────────────────────

const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h"; // Vgrand Lounge
const OPENING_DATE = "2026-09-08"; // Excel report date

// ── Liquor categories that are legitimate bar inventory ──────────────────────
const LIQUOR_CATEGORIES = new Set([
  "Beer", "Brandy", "Rum", "Vodka", "Whisky", "Wine", "Liquor", "Breezer",
]);

// ── Excel column indices (0-based, verified from the actual file) ────────────
// Row 4 (index 4) = header row with sub-headers
// Data starts at row 5 (index 5)
//
// IMPORTANT: The bar/non-AC QTY columns in the Excel are NOT in a consistent
// size order (the value columns have formula errors). Instead, we use the
// TOTAL QTY columns (AL/AM/AN) which give the correct total quantity per size
// across all locations (godown + bar + non-AC combined).
const COL = {
  CATEGORY: 0,    // A — "Beers", "BRANDY", "RUM", etc.
  BRAND: 1,       // B — product name
  // Bottle landing prices (per bottle)
  LAND_BEER: 7,   // H
  LAND_180: 8,    // I
  LAND_375: 9,    // J
  LAND_750: 10,   // K
  // Total qty per size (godown + bar + non-AC combined) — RELIABLE source
  TOTAL_180: 37,  // AL — total 180ml qty (also beer total qty)
  TOTAL_375: 38,  // AM — total 375ml qty
  TOTAL_750: 39,  // AN — total 750ml qty
  TOTAL_GRAND: 40, // AO — grand total qty across all sizes
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// Title-case the category from the Excel
function normalizeCategory(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.toLowerCase() === "beers") return "Beer";
  // Title case: "BRANDY" → "Brandy", "VODKA" → "Vodka"
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Parse bottle size from brand name (e.g. "K F STRONG 650ML" → 650)
function parseMlFromName(name) {
  if (!name) return null;
  const m = name.match(/(\d+)\s*ml\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// Normalize brand name: lowercase, remove size suffixes, remove special chars
function normalizeBrand(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/\s*\d+\s*ml\b/gi, "")
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Clean brand name for display (title case, no size)
function cleanBrandName(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  // Remove trailing size like "650ML"
  s = s.replace(/\s*\d+\s*ml\b/gi, "").trim();
  // Title case
  return s.split(/\s+/).map(w => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
}

// ── Parse Excel ──────────────────────────────────────────────────────────────

function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null, blankrows: true });

  const products = [];
  let currentCategory = null;

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    const colA = row[COL.CATEGORY];
    const brandRaw = row[COL.BRAND];

    // Update category when column A has a value
    if (colA && String(colA).trim()) {
      currentCategory = normalizeCategory(colA);
      // If this row has no brand, it's just a category header row
      if (!brandRaw || !String(brandRaw).trim()) continue;
    }

    if (!brandRaw || !String(brandRaw).trim()) continue;
    if (!currentCategory) continue;

    const brandName = String(brandRaw).trim();
    const isBeer = currentCategory === "Beer";

    if (isBeer) {
      // Beer: one SKU, bottle size from name or default 650
      const bottleSize = parseMlFromName(brandName) || 650;
      const landingPrice = parseNum(row[COL.LAND_BEER]);
      const totalQty = parseQty(row[COL.TOTAL_180]); // beer uses first total col

      // Skip if no stock AND no landing price (empty row)
      if (totalQty === 0 && landingPrice === 0) continue;

      products.push({
        brand: cleanBrandName(brandName),
        rawBrand: brandName,
        category: "Beer",
        bottleSizeMl: bottleSize,
        purchaseRate: landingPrice,
        totalQty,
        totalStockMl: totalQty * bottleSize,
      });
    } else {
      // Liquor: up to 3 SKUs (180, 375, 750) — NO 90ml SKUs
      const sizes = [
        { ml: 180, landCol: COL.LAND_180, totalCol: COL.TOTAL_180 },
        { ml: 375, landCol: COL.LAND_375, totalCol: COL.TOTAL_375 },
        { ml: 750, landCol: COL.LAND_750, totalCol: COL.TOTAL_750 },
      ];

      for (const sz of sizes) {
        const landingPrice = parseNum(row[sz.landCol]);
        const totalQty = parseQty(row[sz.totalCol]);

        // Create SKU if it has stock OR a non-zero landing price
        if (totalQty === 0 && landingPrice === 0) continue;

        products.push({
          brand: cleanBrandName(brandName),
          rawBrand: brandName,
          category: currentCategory,
          bottleSizeMl: sz.ml,
          purchaseRate: landingPrice,
          totalQty,
          totalStockMl: totalQty * sz.ml,
        });
      }
    }
  }

  return products;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Bar Inventory Reconciliation — Vgrand Lounge`);
  console.log(`Mode: ${APPLY ? "APPLY (writes to DB)" : "DRY RUN (no writes)"}`);
  console.log(`Opening date: ${OPENING_DATE}`);
  console.log(`${"=".repeat(80)}\n`);

  // 1. Parse Excel
  const excelPath = "C:/Users/akhil/Downloads/Untitled spreadsheet.xlsx";
  const excelProducts = parseExcel(excelPath);
  console.log(`Excel parsed: ${excelProducts.length} physical bottle SKUs\n`);

  // Print Excel summary
  const excelByCat = {};
  for (const p of excelProducts) {
    if (!excelByCat[p.category]) excelByCat[p.category] = [];
    excelByCat[p.category].push(p);
  }
  console.log("Excel SKUs by category:");
  for (const [cat, list] of Object.entries(excelByCat)) {
    const totalStock = list.reduce((s, p) => s + p.totalStockMl, 0);
    console.log(`  ${cat}: ${list.length} SKUs, total stock = ${totalStock}ml`);
  }
  console.log();

  // 2. Load existing DB items
  const dbItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID },
    select: {
      id: true, name: true, brand: true, category: true,
      bottleSizeMl: true, currentStockMl: true, purchaseRate: true,
      isActive: true,
    },
  });
  console.log(`DB items loaded: ${dbItems.length} (active: ${dbItems.filter(i => i.isActive).length})\n`);

  // Build lookup: normalized brand + size → DB items
  const dbByNormKey = new Map();
  for (const item of dbItems) {
    const normBrand = normalizeBrand(item.brand || item.name);
    const key = `${normBrand}::${item.bottleSizeMl}`;
    if (!dbByNormKey.has(key)) dbByNormKey.set(key, []);
    dbByNormKey.get(key).push(item);
  }

  // 3. Match and classify
  const actions = {
    match: [],      // Excel → existing DB item (adjust stock)
    new: [],        // Excel → no DB item (create)
    duplicate: [],  // Excel → multiple DB items (merge)
  };

  const matchedDbIds = new Set();

  for (const ep of excelProducts) {
    const normBrand = normalizeBrand(ep.brand);
    const key = `${normBrand}::${ep.bottleSizeMl}`;
    const candidates = (dbByNormKey.get(key) || []).filter(i => i.isActive);

    if (candidates.length === 0) {
      actions.new.push(ep);
    } else if (candidates.length === 1) {
      const dbItem = candidates[0];
      matchedDbIds.add(dbItem.id);
      const currentStock = Number(dbItem.currentStockMl);
      const delta = ep.totalStockMl - currentStock;
      actions.match.push({
        excel: ep,
        dbItem,
        currentStockMl: currentStock,
        excelStockMl: ep.totalStockMl,
        deltaMl: delta,
        purchaseRateChanged: ep.purchaseRate > 0 && Number(dbItem.purchaseRate || 0) !== ep.purchaseRate,
      });
    } else {
      // Multiple candidates — duplicate
      // Keep the one with the most stock (or non-zero), deactivate others
      const sorted = [...candidates].sort((a, b) => Math.abs(Number(b.currentStockMl)) - Math.abs(Number(a.currentStockMl)));
      const keep = sorted[0];
      const deactivate = sorted.slice(1);
      matchedDbIds.add(keep.id);
      for (const d of deactivate) matchedDbIds.add(d.id);
      actions.duplicate.push({
        excel: ep,
        keep,
        deactivate,
        currentStockMl: Number(keep.currentStockMl),
        excelStockMl: ep.totalStockMl,
        deltaMl: ep.totalStockMl - Number(keep.currentStockMl),
      });
    }
  }

  // 4. Classify DB items not matched by Excel
  const unmatchedDbItems = dbItems.filter(i => i.isActive && !matchedDbIds.has(i.id));
  const junk = [];
  const orphansZero = [];   // 0 stock — leave untouched
  const orphansNonZero = []; // non-zero stock — flag for manual review

  for (const item of unmatchedDbItems) {
    const cat = item.category || "";
    if (!LIQUOR_CATEGORIES.has(cat)) {
      junk.push(item);
    } else {
      const stock = Number(item.currentStockMl);
      if (stock === 0) {
        orphansZero.push(item);
      } else {
        orphansNonZero.push(item);
      }
    }
  }

  // 5. Print report
  console.log(`${"─".repeat(80)}`);
  console.log(`ACTION SUMMARY`);
  console.log(`${"─".repeat(80)}`);
  console.log(`  MATCH (adjust stock):          ${actions.match.length}`);
  console.log(`  NEW (create + opening):        ${actions.new.length}`);
  console.log(`  DUPLICATE (merge):             ${actions.duplicate.length}`);
  console.log(`  JUNK (deactivate):             ${junk.length}`);
  console.log(`  ORPHAN 0 stock (leave):        ${orphansZero.length}`);
  console.log(`  ORPHAN non-zero (review):      ${orphansNonZero.length}`);
  console.log();

  // ── MATCH details ──
  if (actions.match.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`MATCH — adjust stock to Excel value (${actions.match.length})`);
    console.log(`${"─".repeat(80)}`);
    console.log("  Brand / Size | DB Stock | Excel Stock | Delta | Rate Change");
    console.log("  " + "-".repeat(76));
    for (const m of actions.match) {
      const rateChg = m.purchaseRateChanged ? ` ₹${Number(m.dbItem.purchaseRate||0)}→₹${m.excel.purchaseRate}` : "";
      console.log(`  ${m.excel.brand} ${m.excel.bottleSizeMl}ml | ${m.currentStockMl}ml | ${m.excelStockMl}ml | ${m.deltaMl >= 0 ? "+" : ""}${m.deltaMl}ml${rateChg}`);
    }
  }

  // ── NEW details ──
  if (actions.new.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`NEW — create BarInventoryItem + OPENING (${actions.new.length})`);
    console.log(`${"─".repeat(80)}`);
    console.log("  Brand / Size | Category | Stock | Landing Price");
    console.log("  " + "-".repeat(76));
    for (const ep of actions.new) {
      console.log(`  ${ep.brand} ${ep.bottleSizeMl}ml | ${ep.category} | ${ep.totalQty} btl (${ep.totalStockMl}ml) | ₹${ep.purchaseRate}`);
    }
  }

  // ── DUPLICATE details ──
  if (actions.duplicate.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`DUPLICATE — merge (${actions.duplicate.length})`);
    console.log(`${"─".repeat(80)}`);
    for (const d of actions.duplicate) {
      console.log(`  ${d.excel.brand} ${d.excel.bottleSizeMl}ml:`);
      console.log(`    KEEP:     ${d.keep.name} (id=${d.keep.id.slice(-8)}, stock=${d.currentStockMl}ml) → adjust to ${d.excelStockMl}ml`);
      for (const dup of d.deactivate) {
        console.log(`    DEACTIVATE: ${dup.name} (id=${dup.id.slice(-8)}, stock=${Number(dup.currentStockMl)}ml)`);
      }
    }
  }

  // ── JUNK details ──
  if (junk.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`JUNK — deactivate non-liquor items (${junk.length})`);
    console.log(`${"─".repeat(80)}`);
    for (const j of junk) {
      console.log(`  ${j.name} | cat=${j.category} | size=${j.bottleSizeMl}ml | stock=${Number(j.currentStockMl)}ml`);
    }
  }

  // ── ORPHAN details ──
  if (orphansNonZero.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`ORPHAN NON-ZERO — DB liquor items with stock NOT in Excel (MANUAL REVIEW) (${orphansNonZero.length})`);
    console.log(`${"─".repeat(80)}`);
    for (const o of orphansNonZero) {
      console.log(`  ${o.name} | cat=${o.category} | size=${o.bottleSizeMl}ml | stock=${Number(o.currentStockMl)}ml`);
    }
  }

  if (orphansZero.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`ORPHAN ZERO — DB liquor items with 0 stock not in Excel (leave untouched) (${orphansZero.length})`);
    console.log(`${"─".repeat(80)}`);
    // Just list names, no stock detail (all 0)
    const names = orphansZero.map(o => o.name).sort();
    for (let i = 0; i < names.length; i += 4) {
      console.log("  " + names.slice(i, i + 4).join(" | "));
    }
  }

  // 6. Totals
  const excelTotalStockMl = excelProducts.reduce((s, p) => s + p.totalStockMl, 0);
  const excelTotalValue = excelProducts.reduce((s, p) => s + p.totalStockMl * (p.purchaseRate / p.bottleSizeMl), 0);
  console.log(`\n${"─".repeat(80)}`);
  console.log(`EXCEL TOTALS`);
  console.log(`${"─".repeat(80)}`);
  console.log(`  Total SKUs:        ${excelProducts.length}`);
  console.log(`  Total stock (ml):  ${excelTotalStockMl}`);
  console.log(`  Stock value (₹):   ${Math.round(excelTotalValue)}`);

  if (!APPLY) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`DRY RUN — no changes made. Run with --apply to execute.`);
    console.log(`${"=".repeat(80)}`);
    await prisma.$disconnect();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APPLY — write changes to DB
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(80)}`);
  console.log(`APPLYING CHANGES TO DB...`);
  console.log(`${"=".repeat(80)}\n`);

  let created = 0, adjusted = 0, deactivated = 0, merged = 0, zeroed = 0;
  const errors = [];

  // ── 1. NEW — create BarInventoryItem + OPENING movement ──
  console.log("Creating new items + OPENING movements...");
  for (const ep of actions.new) {
    try {
      const itemName = `${ep.brand} ${ep.bottleSizeMl}ml`;
      const item = await prisma.barInventoryItem.create({
        data: {
          restaurantId: RESTAURANT_ID,
          name: itemName,
          brand: ep.brand,
          category: ep.category,
          bottleSizeMl: ep.bottleSizeMl,
          currentStockMl: ep.totalStockMl,
          purchaseRate: ep.purchaseRate > 0 ? ep.purchaseRate : null,
          reorderLevelBottles: 1,
          isActive: true,
        },
      });

      // Create OPENING movement (only if non-zero stock)
      if (ep.totalStockMl > 0) {
        await prisma.barInventoryMovement.create({
          data: {
            restaurantId: RESTAURANT_ID,
            itemId: item.id,
            date: OPENING_DATE,
            movementType: "OPENING",
            quantityMl: ep.totalStockMl,
            source: "OPENING_SETUP",
            notes: `Excel import — ${ep.totalQty} bottles × ${ep.bottleSizeMl}ml`,
          },
        });
      }
      created++;
    } catch (e) {
      errors.push(`NEW ${ep.brand} ${ep.bottleSizeMl}ml: ${e.message}`);
    }
  }
  console.log(`  Created: ${created}`);

  // ── 2. MATCH — adjust stock + update purchaseRate ──
  console.log("Adjusting matched items...");
  for (const m of actions.match) {
    try {
      // Update purchaseRate if changed
      const updateData = {};
      if (m.purchaseRateChanged && m.excel.purchaseRate > 0) {
        updateData.purchaseRate = m.excel.purchaseRate;
      }

      // Create ADJUSTMENT movement if stock delta is non-zero
      if (m.deltaMl !== 0) {
        await prisma.barInventoryMovement.create({
          data: {
            restaurantId: RESTAURANT_ID,
            itemId: m.dbItem.id,
            date: OPENING_DATE,
            movementType: "ADJUSTMENT",
            quantityMl: m.deltaMl,
            source: "MANUAL_ENTRY",
            notes: `Excel reconciliation — adjust from ${m.currentStockMl}ml to ${m.excelStockMl}ml`,
          },
        });
        updateData.currentStockMl = m.excelStockMl;
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.barInventoryItem.update({
          where: { id: m.dbItem.id },
          data: updateData,
        });
      }
      adjusted++;
    } catch (e) {
      errors.push(`MATCH ${m.excel.brand} ${m.excel.bottleSizeMl}ml: ${e.message}`);
    }
  }
  console.log(`  Adjusted: ${adjusted}`);

  // ── 3. DUPLICATE — deactivate non-keep items, transfer links, adjust keep ──
  console.log("Merging duplicates...");
  for (const d of actions.duplicate) {
    try {
      // Transfer menu links from deactivated items to keep item
      for (const dup of d.deactivate) {
        await prisma.menuItem.updateMany({
          where: { barInventoryItemId: dup.id },
          data: { barInventoryItemId: d.keep.id },
        });
        // Deactivate the duplicate
        await prisma.barInventoryItem.update({
          where: { id: dup.id },
          data: { isActive: false },
        });
        merged++;
      }

      // Adjust keep item stock to Excel value
      if (d.deltaMl !== 0) {
        await prisma.barInventoryMovement.create({
          data: {
            restaurantId: RESTAURANT_ID,
            itemId: d.keep.id,
            date: OPENING_DATE,
            movementType: "ADJUSTMENT",
            quantityMl: d.deltaMl,
            source: "MANUAL_ENTRY",
            notes: `Excel reconciliation (merged ${d.deactivate.length} duplicates) — adjust to ${d.excelStockMl}ml`,
          },
        });
        await prisma.barInventoryItem.update({
          where: { id: d.keep.id },
          data: { currentStockMl: d.excelStockMl },
        });
      }

      // Update purchaseRate on keep item
      if (d.excel.purchaseRate > 0) {
        await prisma.barInventoryItem.update({
          where: { id: d.keep.id },
          data: { purchaseRate: d.excel.purchaseRate },
        });
      }
    } catch (e) {
      errors.push(`DUP ${d.excel.brand} ${d.excel.bottleSizeMl}ml: ${e.message}`);
    }
  }
  console.log(`  Merged (deactivated duplicates): ${merged}`);

  // ── 4. JUNK — deactivate non-liquor items ──
  console.log("Deactivating junk items...");
  for (const j of junk) {
    try {
      // Unlink any menu items first
      await prisma.menuItem.updateMany({
        where: { barInventoryItemId: j.id },
        data: { barInventoryItemId: null },
      });
      await prisma.barInventoryItem.update({
        where: { id: j.id },
        data: { isActive: false },
      });
      deactivated++;
    } catch (e) {
      errors.push(`JUNK ${j.name}: ${e.message}`);
    }
  }
  console.log(`  Deactivated: ${deactivated}`);

  // ── 5. ORPHAN non-zero — set stock to 0 via ADJUSTMENT ──
  console.log("Zeroing non-zero orphan stock...");
  for (const o of orphansNonZero) {
    try {
      const currentStock = Number(o.currentStockMl);
      const delta = -currentStock; // set to 0
      await prisma.barInventoryMovement.create({
        data: {
          restaurantId: RESTAURANT_ID,
          itemId: o.id,
          date: OPENING_DATE,
          movementType: "ADJUSTMENT",
          quantityMl: delta,
          source: "MANUAL_ENTRY",
          notes: `Excel reconciliation — zero out stock (item not in Excel physical count)`,
        },
      });
      await prisma.barInventoryItem.update({
        where: { id: o.id },
        data: { currentStockMl: 0 },
      });
      zeroed++;
    } catch (e) {
      errors.push(`ORPHAN ${o.name}: ${e.message}`);
    }
  }
  console.log(`  Zeroed: ${zeroed}`);

  // ── Summary ──
  console.log(`\n${"=".repeat(80)}`);
  console.log(`APPLY COMPLETE`);
  console.log(`${"=".repeat(80)}`);
  console.log(`  Items created:          ${created}`);
  console.log(`  Items adjusted:         ${adjusted}`);
  console.log(`  Duplicates deactivated: ${merged}`);
  console.log(`  Junk deactivated:       ${deactivated}`);
  console.log(`  Orphans zeroed:         ${zeroed}`);
  console.log(`  Errors:                 ${errors.length}`);
  if (errors.length > 0) {
    console.log(`\n  ERRORS:`);
    for (const e of errors) console.log(`    ${e}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  await prisma.$disconnect();
  process.exit(1);
});
