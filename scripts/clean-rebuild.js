// clean-rebuild.js — Nuclear option: delete ALL movements on 2026-09-08,
// set currentStockMl from Excel, create one clean OPENING movement per item,
// then rebuild daily records.
//
// Usage:
//   node scripts/clean-rebuild.js --apply

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
  return name.toLowerCase().replace(/\s*\d+\s*ml\b/gi, "").replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Parse Excel products (including category header rows)
function parseExcelProducts() {
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
      }
    }
    const brand = row[1];
    if (!brand || typeof brand !== 'string') continue;
    const brandName = cleanBrandName(brand);
    if (!brandName) continue;
    if (currentCategory === "Beer") {
      const landing = parseNum(row[7]); const qty = parseNum(row[37]);
      if (qty > 0 || landing > 0) products.push({ brand: brandName, category: "Beer", bottleSizeMl: 650, purchaseRate: landing > 0 ? landing : null, totalQty: qty, totalStockMl: qty * 650, normKey: `${normalizeBrand(brandName)}::650` });
    } else {
      for (const sz of [{ml:180,lc:8,tc:37},{ml:375,lc:9,tc:38},{ml:750,lc:10,tc:39},{ml:90,lc:11,tc:40}]) {
        const landing = parseNum(row[sz.lc]); const qty = parseNum(row[sz.tc]);
        if (qty > 0 || landing > 0) products.push({ brand: brandName, category: currentCategory, bottleSizeMl: sz.ml, purchaseRate: landing > 0 ? landing : null, totalQty: qty, totalStockMl: qty * sz.ml, normKey: `${normalizeBrand(brandName)}::${sz.ml}` });
      }
    }
  }
  return products;
}

// Rebuild helpers
function getKolkataDateString() {
  const now = new Date();
  const kolkata = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${kolkata.getFullYear()}-${String(kolkata.getMonth() + 1).padStart(2, "0")}-${String(kolkata.getDate()).padStart(2, "0")}`;
}
function getPreviousDate(date) {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function getDateRange(from, to) {
  const dates = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    const d = new Date(current + "T00:00:00");
    d.setDate(d.getDate() + 1);
    current = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return dates;
}

(async () => {
  const excelProducts = parseExcelProducts();
  const excelByKey = new Map();
  for (const p of excelProducts) excelByKey.set(p.normKey, p);

  const dbItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, brand: true, bottleSizeMl: true, currentStockMl: true, purchaseRate: true },
  });

  // Build DB lookup
  const dbByKey = new Map();
  for (const item of dbItems) {
    const norm = normalizeBrand(item.brand || item.name);
    dbByKey.set(`${norm}::${item.bottleSizeMl}`, item);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Clean Rebuild — Delete all 2026-09-08 movements, set Excel stock, rebuild`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`Items: ${dbItems.length}, Excel products: ${excelProducts.length}`);
  console.log(`${"=".repeat(80)}\n`);

  // Map DB items to Excel stock values
  const fixes = [];
  for (const p of excelProducts) {
    const dbItem = dbByKey.get(p.normKey);
    if (!dbItem) continue;
    const currentStock = Number(dbItem.currentStockMl);
    if (Math.abs(currentStock - p.totalStockMl) > 0.1) {
      fixes.push({ item: dbItem, excelStock: p.totalStockMl, currentStock, diff: p.totalStockMl - currentStock });
    }
  }
  console.log(`Items with wrong currentStockMl: ${fixes.length}`);
  for (const f of fixes.slice(0, 10)) {
    console.log(`  ${f.item.name}: ${f.currentStock}ml → ${f.excelStock}ml (Δ${f.diff > 0 ? "+" : ""}${f.diff}ml)`);
  }
  if (fixes.length > 10) console.log(`  ... and ${fixes.length - 10} more`);

  if (!APPLY) {
    console.log(`\nDRY RUN — use --apply to execute`);
    await prisma.$disconnect();
    return;
  }

  // Step 1: Delete ALL movements on 2026-09-08
  console.log(`\nStep 1: Deleting all movements on ${DATE}...`);
  const deleted = await prisma.barInventoryMovement.deleteMany({
    where: { restaurantId: RID, date: DATE },
  });
  console.log(`  Deleted: ${deleted.count} movements`);

  // Step 2: Set currentStockMl to Excel values and create clean OPENING movements
  console.log(`\nStep 2: Setting Excel stock + creating OPENING movements...`);
  let updated = 0;
  for (const p of excelProducts) {
    const dbItem = dbByKey.get(p.normKey);
    if (!dbItem) continue;
    
    // Update stock
    await prisma.barInventoryItem.update({
      where: { id: dbItem.id },
      data: { currentStockMl: p.totalStockMl },
    });

    // Create clean OPENING movement
    await prisma.barInventoryMovement.create({
      data: {
        restaurantId: RID, itemId: dbItem.id, movementType: "OPENING",
        quantityMl: p.totalStockMl, date: DATE, source: "OPENING_SETUP",
        notes: "Clean rebuild: Excel physical count 08.09.2026",
      },
    });
    updated++;
  }
  console.log(`  Updated: ${updated} items`);

  // Step 3: Rebuild daily records from 2026-09-08 to today
  console.log(`\nStep 3: Rebuilding daily records...`);
  const today = getKolkataDateString();
  const dates = getDateRange(DATE, today);
  let success = 0, errors = 0;

  for (const item of dbItems) {
    try {
      let lastClosing = 0;
      for (const date of dates) {
        const movements = await prisma.barInventoryMovement.findMany({
          where: { restaurantId: RID, itemId: item.id, date },
          orderBy: { createdAt: "asc" },
        });

        let purchasedMl = 0, acSaleMl = 0, nonAcSaleMl = 0, wastageMl = 0, adjustmentMl = 0;
        let openingOverrideMl = null;
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
          }
        }
        acSaleMl = Math.max(0, acSaleMl);

        const prevDate = getPreviousDate(date);
        const prevRecord = await prisma.barDailyRecord.findUnique({
          where: { restaurantId_date_itemId: { restaurantId: RID, date: prevDate, itemId: item.id } },
        });

        const openingMl = openingOverrideMl ?? (prevRecord ? Number(prevRecord.physicalClosingMl ?? prevRecord.systemClosingMl) : 0);
        const systemClosingMl = openingMl + purchasedMl - acSaleMl - nonAcSaleMl - wastageMl + adjustmentMl;

        const bottleSizeMl = Number(item.bottleSizeMl) || 750;
        const costPerMl = item.purchaseRate ? Number(item.purchaseRate) / bottleSizeMl : 0;
        const stockValue = systemClosingMl * costPerMl;

        await prisma.barDailyRecord.upsert({
          where: { restaurantId_date_itemId: { restaurantId: RID, date, itemId: item.id } },
          create: {
            restaurantId: RID, itemId: item.id, date,
            openingMl, purchasedMl, acSaleMl, nonAcSaleMl, wastageMl, adjustmentMl,
            systemClosingMl, purchaseRate: item.purchaseRate, stockValue,
          },
          update: {
            openingMl, purchasedMl, acSaleMl, nonAcSaleMl, wastageMl, adjustmentMl,
            systemClosingMl, purchaseRate: item.purchaseRate, stockValue,
          },
        });
        lastClosing = systemClosingMl;
      }

      // Update live stock to last closing
      await prisma.barInventoryItem.update({
        where: { id: item.id },
        data: { currentStockMl: lastClosing },
      });
      success++;
    } catch (e) {
      errors++;
      console.error(`  ERROR: ${item.name}: ${e.message}`);
    }
  }
  console.log(`  Success: ${success}, Errors: ${errors}`);

  // Final verification
  const finalItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, currentStockMl: true, bottleSizeMl: true, purchaseRate: true },
  });
  const totalStock = finalItems.reduce((s, i) => s + Number(i.currentStockMl), 0);
  const totalValue = finalItems.reduce((s, i) => {
    const rate = Number(i.purchaseRate || 0);
    const size = Number(i.bottleSizeMl);
    return s + (rate > 0 && size > 0 ? Number(i.currentStockMl) * (rate / size) : 0);
  }, 0);

  const records = await prisma.barDailyRecord.findMany({
    where: { restaurantId: RID, date: DATE },
    select: { itemId: true, openingMl: true, systemClosingMl: true },
  });
  const itemMap = new Map(finalItems.map(i => [i.id, i]));
  let mismatches = 0;
  for (const rec of records) {
    const item = itemMap.get(rec.itemId);
    if (!item) continue;
    if (Math.abs(Number(rec.openingMl) - Number(item.currentStockMl)) > 0.1) mismatches++;
  }

  // Report value from daily records
  const reportValue = records.reduce((s, r) => {
    const item = itemMap.get(r.itemId);
    if (!item) return s;
    const rate = Number(item.purchaseRate || 0);
    const size = Number(item.bottleSizeMl);
    return s + (rate > 0 && size > 0 ? Number(r.systemClosingMl) * (rate / size) : 0);
  }, 0);
  const reportStock = records.reduce((s, r) => {
    const item = itemMap.get(r.itemId);
    if (!item) return s;
    return s + Number(r.systemClosingMl);
  }, 0);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`FINAL STATE`);
  console.log(`${"=".repeat(80)}`);
  console.log(`Total stock (dashboard): ${totalStock}ml (Excel: 1,438,666ml)`);
  console.log(`Total stock (report): ${reportStock}ml`);
  console.log(`Stock difference: ${totalStock - reportStock}ml`);
  console.log(`Total value (dashboard): Rs. ${Math.round(totalValue).toLocaleString('en-IN')}`);
  console.log(`Total value (report): Rs. ${Math.round(reportValue).toLocaleString('en-IN')}`);
  console.log(`Value difference: Rs. ${Math.round(totalValue - reportValue).toLocaleString('en-IN')}`);
  console.log(`DailyRecord mismatches: ${mismatches}/${records.length}`);

  await prisma.$disconnect();
})();
