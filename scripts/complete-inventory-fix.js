// complete-inventory-fix.js — One-shot fix for the entire bar inventory
//
// 1. Unlink non-liquor menu items (water, soda, soft drinks, food, charges)
// 2. Add missing liquor/beer brands with 0 opening stock
// 3. Link all liquor menu items to inventory (pegs → bottles, fuzzy, alias)
// 4. Restore 8 Sept AC_SALE movements from BarDeductionLog
// 5. Rebuild daily records from 8 Sept → today
// 6. Verify PDF report matches dashboard
//
// Usage:
//   node scripts/complete-inventory-fix.js              — DRY RUN
//   node scripts/complete-inventory-fix.js --apply      — write to DB

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RID = "cmqy60ci200027dscyj9ubg8h";
const DATE = "2026-09-08";

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeBrand(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/\s*\d+\s*ml\b/gi, "")
    .replace(/\s*(full\s+bottle|bottle|can|beer)\s*/gi, " ")
    .replace(/\btin\b/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMlFromName(name) {
  if (!name) return null;
  const m = name.match(/(\d+)\s*ml\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]) + 1;
    }
  }
  return dp[m][n];
}

// Non-liquor keywords — these should NOT be tracked in bar inventory
const NON_LIQUOR = /^(water|soda|coca|cola|sprite|fanta|limca|maaza|pulpy|thums|thumsup|tin\s*thums|monster|energy|fresh\s*lime|mojitho|mojito|rimzim|cooldrink|charged|projector|hall|cocktail|cocktai|chicken|manchurian|food|snacks|charge)/i;

// Known brand aliases (menu name → Excel brand normalized)
const BRAND_ALIASES = {
  "absolut vodka": "absolute vokda",
  "ballantines": "ballaentines",
  "courrier napoleon green": "courier napoleon green",
  "courrier napoleon red": "courier napoleon",
  "hydarabad blue": "hyderabad blue",
  "jamson": "jemson",
  "teacher higland": "teachers",
  "willian lawson": "william lawson",
  "bp": "blenders pride",
  "im whisky": "imperial blue",
  "oc whisky": "officers choice blue",
  "b7 whisky": "sterling b7",
  "b10 whisky": "sterling b10",
  "mc vsop brandy": "mc brandy vsop",
  "mc wishky": "mc whisky",
  "magic moments green": "magic moments vodka green apple",
  "magic moments orange": "magic moments vodka orange",
  "magic moments or": "magic moments vodka orange",
  "kyron brandy": "kyron premium",
  "morpheus xo rare brandy": "morpheous",
  "smirnoff orange vodka": "smrinoff",
  "royal green premium": "royal stag",
  "black and white": "black white",
  "britesh wh": "british whiky",
  "british empire whisky": "british whiky",
  "british whisky": "british whiky",
  "o c elegant whisky": "officers choice supreme",
  "oab": "old admiral",
  "whytehall": "whytal brandy",
  "vat69": "vat 69",
  "budweiser magnum": "budwiser magnum",
  "budwiser": "budwiser magnum",
};

function getKolkataDateString(d) {
  const date = d ? new Date(d) : new Date();
  const k = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, "0")}-${String(k.getDate()).padStart(2, "0")}`;
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

// ── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Complete Inventory Fix`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`${"=".repeat(80)}\n`);

  // Load all active inventory items
  const invItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, brand: true, category: true, bottleSizeMl: true, currentStockMl: true, purchaseRate: true },
  });
  const invByNorm = new Map();
  const invByBrand = new Map();
  for (const item of invItems) {
    const norm = normalizeBrand(item.brand || item.name);
    const key = `${norm}::${item.bottleSizeMl}`;
    if (!invByNorm.has(key)) invByNorm.set(key, []);
    invByNorm.get(key).push(item);
    if (!invByBrand.has(norm)) invByBrand.set(norm, []);
    invByBrand.get(norm).push(item);
  }
  console.log(`Active inventory items: ${invItems.length}`);

  // Load all LIQUOR menu items
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId: RID, menuType: "LIQUOR", isDeleted: false },
    select: { id: true, name: true, barInventoryItemId: true, deductionMl: true, basePrice: true },
    orderBy: { name: "asc" },
  });
  console.log(`LIQUOR menu items: ${menuItems.length}`);

  // ── STEP 1: Unlink non-liquor items ───────────────────────────────────
  console.log(`\n--- Step 1: Unlink non-liquor items ---`);
  const toUnlink = [];
  for (const mi of menuItems) {
    if (NON_LIQUOR.test(mi.name)) {
      if (mi.barInventoryItemId) {
        toUnlink.push(mi);
      }
    }
  }
  console.log(`  Non-liquor items to unlink: ${toUnlink.length}`);
  for (const mi of toUnlink.slice(0, 20)) {
    console.log(`    "${mi.name}"`);
  }

  // ── STEP 2: Find missing liquor brands ────────────────────────────────
  console.log(`\n--- Step 2: Find missing liquor brands ---`);
  const missingBrands = [];
  for (const mi of menuItems) {
    if (NON_LIQUOR.test(mi.name)) continue; // skip non-liquor
    if (mi.barInventoryItemId) continue; // already linked

    const sizeMl = parseMlFromName(mi.name);
    const normBrand = normalizeBrand(mi.name);

    // Try exact match
    if (sizeMl) {
      const key = `${normBrand}::${sizeMl}`;
      if (invByNorm.has(key)) continue;
    }
    // Try brand-only match
    if (invByBrand.has(normBrand)) continue;
    // Try fuzzy match
    let fuzzy = false;
    for (const [invNorm] of invByBrand.entries()) {
      if (invNorm.length >= 3 && (normBrand.includes(invNorm) || invNorm.includes(normBrand))) {
        fuzzy = true; break;
      }
    }
    if (fuzzy) continue;
    // Try alias
    if (BRAND_ALIASES[normBrand] && invByBrand.has(BRAND_ALIASES[normBrand])) continue;
    // Try levenshtein
    let lev = false;
    for (const [invNorm] of invByBrand.entries()) {
      if (invNorm.length >= 3) {
        const dist = levenshtein(normBrand, invNorm);
        const maxDist = Math.max(1, Math.floor(Math.max(normBrand.length, invNorm.length) * 0.25));
        if (dist <= maxDist) { lev = true; break; }
      }
    }
    if (lev) continue;

    // Truly missing — need to create
    missingBrands.push({ menuItem: mi, sizeMl, normBrand });
  }

  // Deduplicate by normalized brand ONLY (one bottle per brand, not one per peg size)
  // Bottle size: 650ml for beer, 750ml for liquor
  const missingUnique = new Map();
  for (const m of missingBrands) {
    if (!missingUnique.has(m.normBrand)) {
      const isBeer = /beer|bira|kingfisher|kf|budwiser|carlsberg|stok|boom|corona|coolberg|breezer/i.test(m.normBrand);
      const bottleSize = isBeer ? 650 : 750;
      missingUnique.set(m.normBrand, { ...m, bottleSize });
    }
  }
  console.log(`  Missing liquor brands: ${missingUnique.size}`);
  for (const [normBrand, m] of [...missingUnique.entries()].sort()) {
    console.log(`    "${normBrand}" → new ${m.bottleSize}ml bottle (0 stock)`);
  }

  // ── STEP 3: Restore 8 Sept AC_SALE movements ──────────────────────────
  console.log(`\n--- Step 3: Restore 8 Sept AC_SALE movements ---`);
  const sept8Logs = await prisma.barDeductionLog.findMany({
    where: { restaurantId: RID, status: "SUCCESS" },
    include: { order: { select: { settledAt: true, paidAt: true } } },
  });
  const logs8 = sept8Logs.filter(l => {
    const d = getKolkataDateString(l.order?.settledAt || l.order?.paidAt);
    return d === DATE;
  });
  console.log(`  8 Sept BarDeductionLog entries: ${logs8.length}`);
  for (const l of logs8) {
    const item = invItems.find(i => i.id === l.inventoryItemId);
    console.log(`    ${item ? item.name : l.inventoryItemId}: ${Number(l.quantity)}ml (active: ${item ? "yes" : "no"})`);
  }

  // ── DRY RUN END ────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log(`\n--- DRY RUN ---`);
    console.log(`  Would unlink ${toUnlink.length} non-liquor items`);
    console.log(`  Would create ${missingUnique.size} missing inventory items`);
    console.log(`  Would restore ${logs8.length} AC_SALE movements on 8 Sept`);
    console.log(`  Would rebuild daily records from ${DATE} to today`);
    console.log(`\nUse --apply to execute.`);
    await prisma.$disconnect();
    return;
  }

  // ── APPLY: Step 1 ─────────────────────────────────────────────────────
  console.log(`\n--- APPLY Step 1: Unlinking non-liquor items ---`);
  for (const mi of toUnlink) {
    await prisma.menuItem.update({
      where: { id: mi.id },
      data: { barInventoryItemId: null, deductionMl: null },
    });
  }
  console.log(`  Unlinked: ${toUnlink.length}`);

  // ── APPLY: Step 2 ─────────────────────────────────────────────────────
  console.log(`\n--- APPLY Step 2: Creating missing liquor brands ---`);
  let created = 0;
  const newItems = [];
  for (const [normBrand, m] of missingUnique) {
    const bottleSize = m.bottleSize;
    const name = `${normBrand.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")} ${bottleSize}ml`;
    const category = /beer|bira|kingfisher|kf|budwiser|carlsberg|stok|boom|corona|coolberg|breezer/i.test(normBrand) ? "Beer" : "Liquor";
    const brandName = normBrand.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

    // Check if an inactive item with the same name already exists
    const existing = await prisma.barInventoryItem.findFirst({
      where: { restaurantId: RID, name, isActive: false },
    });
    let newItem;
    if (existing) {
      // Reactivate it with 0 stock
      newItem = await prisma.barInventoryItem.update({
        where: { id: existing.id },
        data: { isActive: true, currentStockMl: 0, bottleSizeMl: bottleSize, brand: brandName, category },
      });
      console.log(`  Reactivated: ${name}`);
    } else {
      newItem = await prisma.barInventoryItem.create({
        data: {
          restaurantId: RID,
          name,
          brand: brandName,
          category,
          bottleSizeMl: bottleSize,
          currentStockMl: 0,
          purchaseRate: null,
          isActive: true,
          reorderLevelBottles: 0,
        },
      });
    }
    // Create OPENING movement with 0 stock
    await prisma.barInventoryMovement.create({
      data: {
        restaurantId: RID,
        itemId: newItem.id,
        movementType: "OPENING",
        quantityMl: 0,
        date: DATE,
        source: "OPENING_SETUP",
        notes: "Missing brand — 0 opening stock (not in Excel physical count)",
      },
    });
    newItems.push(newItem);
    created++;
  }
  console.log(`  Created: ${created} items with 0 stock`);

  // Reload inventory with new items
  const allInvItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, brand: true, category: true, bottleSizeMl: true, currentStockMl: true, purchaseRate: true },
  });
  const allInvByNorm = new Map();
  const allInvByBrand = new Map();
  for (const item of allInvItems) {
    const norm = normalizeBrand(item.brand || item.name);
    const key = `${norm}::${item.bottleSizeMl}`;
    if (!allInvByNorm.has(key)) allInvByNorm.set(key, []);
    allInvByNorm.get(key).push(item);
    if (!allInvByBrand.has(norm)) allInvByBrand.set(norm, []);
    allInvByBrand.get(norm).push(item);
  }

  // ── APPLY: Step 2b: Link missing brands to menu items ─────────────────
  console.log(`\n--- APPLY Step 2b: Linking menu items ---`);
  let linked = 0;
  // Reload menu items (some were unlinked in step 1)
  const allMenuItems = await prisma.menuItem.findMany({
    where: { restaurantId: RID, menuType: "LIQUOR", isDeleted: false, barInventoryItemId: null },
    select: { id: true, name: true, deductionMl: true },
    orderBy: { name: "asc" },
  });
  for (const mi of allMenuItems) {
    if (NON_LIQUOR.test(mi.name)) continue;
    const sizeMl = parseMlFromName(mi.name);
    const normBrand = normalizeBrand(mi.name);
    let matchItem = null;
    let deduct = sizeMl || 30;

    // Try exact brand + size
    if (sizeMl) {
      const key = `${normBrand}::${sizeMl}`;
      const matches = allInvByNorm.get(key) || [];
      if (matches.length >= 1) matchItem = matches[0];
    }
    // Try brand-only
    if (!matchItem) {
      const matches = allInvByBrand.get(normBrand) || [];
      if (matches.length >= 1) {
        matchItem = matches.find(b => b.bottleSizeMl === 750) || matches[0];
      }
    }
    // Try fuzzy
    if (!matchItem) {
      for (const [invNorm, items] of allInvByBrand.entries()) {
        if (invNorm.length >= 3 && (normBrand.includes(invNorm) || invNorm.includes(normBrand))) {
          matchItem = items.find(b => b.bottleSizeMl === 750) || items[0];
          break;
        }
      }
    }
    // Try alias
    if (!matchItem) {
      const alias = BRAND_ALIASES[normBrand];
      if (alias) {
        const matches = allInvByBrand.get(alias) || [];
        if (matches.length >= 1) {
          matchItem = matches.find(b => b.bottleSizeMl === 750) || matches[0];
        }
      }
    }
    // Try levenshtein
    if (!matchItem) {
      let bestMatch = null, bestDist = Infinity;
      for (const [invNorm, items] of allInvByBrand.entries()) {
        if (invNorm.length < 3) continue;
        const dist = levenshtein(normBrand, invNorm);
        const maxDist = Math.max(1, Math.floor(Math.max(normBrand.length, invNorm.length) * 0.25));
        if (dist <= maxDist && dist < bestDist) {
          bestDist = dist;
          bestMatch = items.find(b => b.bottleSizeMl === 750) || items[0];
        }
      }
      matchItem = bestMatch;
    }

    if (matchItem) {
      await prisma.menuItem.update({
        where: { id: mi.id },
        data: { barInventoryItemId: matchItem.id, deductionMl: deduct },
      });
      linked++;
    }
  }
  console.log(`  Linked: ${linked} menu items`);

  // ── APPLY: Step 3: Restore 8 Sept AC_SALE movements ──────────────────
  console.log(`\n--- APPLY Step 3: Restoring 8 Sept AC_SALE movements ---`);
  let restored = 0;
  for (const l of logs8) {
    // Check if movement already exists
    const existing = await prisma.barInventoryMovement.findFirst({
      where: {
        restaurantId: RID,
        itemId: l.inventoryItemId,
        date: DATE,
        movementType: "AC_SALE",
        orderId: l.orderId,
        orderItemId: l.orderItemId,
      },
    });
    if (existing) continue;

    // Get the bar item for unit cost
    const barItem = allInvItems.find(i => i.id === l.inventoryItemId);
    const unitCost = barItem && barItem.purchaseRate ? Number(barItem.purchaseRate) / barItem.bottleSizeMl : null;

    await prisma.barInventoryMovement.create({
      data: {
        restaurantId: RID,
        itemId: l.inventoryItemId,
        movementType: "AC_SALE",
        quantityMl: -Number(l.quantity),
        date: DATE,
        source: "POS_SETTLEMENT",
        orderId: l.orderId,
        orderItemId: l.orderItemId,
        unitCost,
        notes: "Restored from BarDeductionLog",
      },
    });
    restored++;
  }
  console.log(`  Restored: ${restored} AC_SALE movements`);

  // ── APPLY: Step 4: Rebuild daily records ──────────────────────────────
  console.log(`\n--- APPLY Step 4: Rebuilding daily records ---`);
  const today = getKolkataDateString();
  const dates = getDateRange(DATE, today);
  console.log(`  Dates: ${dates.join(", ")}`);

  const allItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RID, isActive: true },
    select: { id: true, name: true, bottleSizeMl: true, purchaseRate: true },
  });

  let success = 0, errors = 0;
  for (const item of allItems) {
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

      await prisma.barInventoryItem.update({
        where: { id: item.id },
        data: { currentStockMl: lastClosing },
      });
      success++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`  ERROR: ${item.name}: ${e.message}`);
    }
  }
  console.log(`  Success: ${success}, Errors: ${errors}`);

  // ── APPLY: Step 5: Verify ─────────────────────────────────────────────
  console.log(`\n--- Verification ---`);
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

  // Report stock for today
  const todayRecords = await prisma.barDailyRecord.findMany({
    where: { restaurantId: RID, date: today },
    select: { itemId: true, systemClosingMl: true },
  });
  const itemMap = new Map(finalItems.map(i => [i.id, i]));
  const reportStock = todayRecords.reduce((s, r) => {
    const item = itemMap.get(r.itemId);
    return item ? s + Number(r.systemClosingMl) : s;
  }, 0);
  const reportValue = todayRecords.reduce((s, r) => {
    const item = itemMap.get(r.itemId);
    if (!item) return s;
    const rate = Number(item.purchaseRate || 0);
    const size = Number(item.bottleSizeMl);
    return s + (rate > 0 && size > 0 ? Number(r.systemClosingMl) * (rate / size) : 0);
  }, 0);

  // Also check 8 Sept report
  const sept8Records = await prisma.barDailyRecord.findMany({
    where: { restaurantId: RID, date: DATE },
    select: { itemId: true, openingMl: true, systemClosingMl: true, acSaleMl: true },
  });
  const sept8Opening = sept8Records.reduce((s, r) => {
    const item = itemMap.get(r.itemId);
    return item ? s + Number(r.openingMl) : s;
  }, 0);
  const sept8Closing = sept8Records.reduce((s, r) => {
    const item = itemMap.get(r.itemId);
    return item ? s + Number(r.systemClosingMl) : s;
  }, 0);
  const sept8Sales = sept8Records.reduce((s, r) => s + Number(r.acSaleMl), 0);

  const linked2 = await prisma.menuItem.count({ where: { restaurantId: RID, menuType: "LIQUOR", barInventoryItemId: { not: null }, isDeleted: false } });
  const unlinked2 = await prisma.menuItem.count({ where: { restaurantId: RID, menuType: "LIQUOR", barInventoryItemId: null, isDeleted: false } });

  console.log(`\n${"=".repeat(80)}`);
  console.log(`FINAL STATE`);
  console.log(`${"=".repeat(80)}`);
  console.log(`Active inventory items: ${finalItems.length}`);
  console.log(`Menu links: ${linked2} linked, ${unlinked2} unlinked`);
  console.log(`\n8 Sept report:`);
  console.log(`  Opening: ${sept8Opening}ml (Excel stock)`);
  console.log(`  AC sales: ${sept8Sales}ml`);
  console.log(`  Closing: ${sept8Closing}ml`);
  console.log(`\nToday (${today}) report:`);
  console.log(`  Report stock: ${reportStock}ml`);
  console.log(`  Report value: Rs. ${Math.round(reportValue).toLocaleString('en-IN')}`);
  console.log(`\nDashboard (live):`);
  console.log(`  Live stock: ${totalStock}ml`);
  console.log(`  Live value: Rs. ${Math.round(totalValue).toLocaleString('en-IN')}`);
  console.log(`\nDashboard vs Today's report: ${(totalStock - reportStock).toFixed(1)}ml difference`);

  await prisma.$disconnect();
})();
