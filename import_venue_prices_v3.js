/**
 * import_venue_prices_v3.js
 * 
 * Reads the RATES BAR.xlsx spreadsheet and imports venue-specific prices
 * for ALL matching menu items in BOTH databases (restaurant-001 and bar-001).
 * 
 * Uses aggressive fuzzy matching to bridge naming differences between
 * the Excel sheet and the bar menu database.
 */

const xlsx = require('xlsx');

const API_BASE = 'http://localhost:3000';

// Column indices in the Excel sheet (0-based)
const VENUE_COLUMNS = {
  4: 'venue-bar',
  5: 'venue-conference1',
  6: 'venue-conference2',
  7: 'venue-pdr',
  10: 'venue-parcel',
};

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[''`]/g, "'")
    .replace(/&/g, 'and');
}

// Strip common suffixes/prefixes and noise words for fuzzy matching
function stripNoise(name) {
  return normalize(name)
    .replace(/\s*\([^)]*\)\s*/g, ' ')     // remove (NV), (Bones), etc.
    .replace(/\s*[/]\s*/g, ' ')            // slashes
    .replace(/\b(b\/l|b l|b\/less)\b/g, '') // B/L, B/Less (boneless)
    .replace(/\b(bones|bone)\b/g, '')       // bones
    .replace(/\b(curry)\b/g, '')            // curry
    .replace(/\b(spl|special)\b/g, '')      // spl/special
    .replace(/\b(cream of)\b/g, '')         // cream of
    .replace(/\b(veg|non)\b/g, '')          // veg/non prefix
    .replace(/\b(nos|pcs|pc|plate|bowl)\b/g, '') // units
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(name) {
  return new Set(
    normalize(name)
      .split(/[\s/&]+/)
      .filter(t => t.length > 1)
  );
}

function tokenOverlap(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.min(ta.size, tb.size);  // use min for more lenient matching
}

async function main() {
  try {
    // 1. Read Excel
    const workbook = xlsx.readFile('rates_bar.xlsx');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    
    // 2. Fetch ALL menu items from both databases via the API
    const [barRes, restRes] = await Promise.all([
      fetch(`${API_BASE}/api/bar/menu/items`),
      fetch(`${API_BASE}/api/menu/items/admin`).catch(() => fetch(`${API_BASE}/api/menu/items`)),
    ]);
    
    const barItems = await barRes.json();
    const restItems = await restRes.json();
    
    console.log(`Bar items: ${barItems.length}, Restaurant items: ${restItems.length}`);
    
    // 3. Build comprehensive lookup structures
    const allItems = [];
    for (const item of barItems) {
      allItems.push({ id: item.id, name: item.name, source: 'bar', menuType: item.menuType });
    }
    for (const item of restItems) {
      allItems.push({ id: item.id, name: item.name, source: 'rest', menuType: item.menuType });
    }
    
    // Build exact name map
    const exactMap = new Map();
    const strippedMap = new Map();
    
    for (const item of allItems) {
      const n = normalize(item.name);
      const s = stripNoise(item.name);
      
      if (!exactMap.has(n)) exactMap.set(n, []);
      exactMap.get(n).push(item);
      
      if (s && s.length > 2) {
        if (!strippedMap.has(s)) strippedMap.set(s, []);
        strippedMap.get(s).push(item);
      }
    }
    
    // 4. For each Excel row, find ALL matching menu items
    const batch = [];
    let matchedExcel = 0;
    let unmatchedExcel = 0;
    const unmatchedNames = [];
    const matchLog = []; // For debugging
    
    for (let i = 3; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[1] || typeof row[1] !== 'string') continue;
      
      const excelName = row[1].trim();
      if (excelName === 'Item' || excelName === '' || excelName.length < 2) continue;
      
      let matchedItems = new Map(); // id → item (deduplicate)
      
      // Step 1: Exact normalized match
      const n = normalize(excelName);
      if (exactMap.has(n)) {
        for (const item of exactMap.get(n)) {
          matchedItems.set(item.id, item);
        }
      }
      
      // Step 2: Stripped/noise-removed match
      const s = stripNoise(excelName);
      if (s && strippedMap.has(s)) {
        for (const item of strippedMap.get(s)) {
          matchedItems.set(item.id, item);
        }
      }
      
      // Step 3: Token overlap >= 0.75 using min denominator
      if (matchedItems.size === 0) {
        for (const [name, items] of exactMap.entries()) {
          const score = tokenOverlap(excelName, name);
          if (score >= 0.75) {
            for (const item of items) {
              matchedItems.set(item.id, item);
            }
          }
        }
      }
      
      // Step 4: Contains-based matching (one name contains the other)
      if (matchedItems.size === 0) {
        const excelStripped = stripNoise(excelName);
        for (const item of allItems) {
          const itemStripped = stripNoise(item.name);
          if (excelStripped.length >= 3 && itemStripped.length >= 3) {
            if (excelStripped.includes(itemStripped) || itemStripped.includes(excelStripped)) {
              matchedItems.set(item.id, item);
            }
          }
        }
      }
      
      if (matchedItems.size === 0) {
        unmatchedExcel++;
        unmatchedNames.push(excelName);
        continue;
      }
      
      matchedExcel++;
      const items = Array.from(matchedItems.values());
      
      if (items.some(it => it.source === 'bar')) {
        matchLog.push(`${excelName} → ${items.filter(it => it.source === 'bar').map(it => it.name).join(', ')} [bar]`);
      }
      
      // Create price records for each venue × each matched item
      for (const [colIdx, venueId] of Object.entries(VENUE_COLUMNS)) {
        const price = row[Number(colIdx)];
        if (typeof price === 'number' && !isNaN(price) && price > 0) {
          for (const item of items) {
            batch.push({ venueId, menuItemId: item.id, price });
          }
        }
      }
    }
    
    console.log(`\nExcel matched: ${matchedExcel}, Unmatched: ${unmatchedExcel}`);
    console.log(`Total price records: ${batch.length}`);
    
    if (unmatchedNames.length > 0 && unmatchedNames.length <= 50) {
      console.log(`\nUnmatched Excel names:`);
      unmatchedNames.forEach(n => console.log(`  ❌ ${n}`));
    }
    
    // Deduplicate
    const deduped = new Map();
    for (const record of batch) {
      const key = `${record.venueId}:${record.menuItemId}`;
      deduped.set(key, record);
    }
    const dedupedBatch = Array.from(deduped.values());
    console.log(`After deduplication: ${dedupedBatch.length} unique records`);
    
    // 5. Insert into DB
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    await prisma.venuePrice.deleteMany({});
    console.log('Cleared existing venue prices.');
    
    let inserted = 0;
    for (let i = 0; i < dedupedBatch.length; i += 500) {
      const chunk = dedupedBatch.slice(i, i + 500);
      await prisma.venuePrice.createMany({ data: chunk, skipDuplicates: true });
      inserted += chunk.length;
    }
    console.log(`\n✅ Imported ${inserted} venue prices.`);
    
    // 6. Verify bar item coverage
    const barFoodIds = barItems.filter(i => i.menuType === 'FOOD').map(i => i.id);
    const barPricesInPDR = dedupedBatch.filter(r => r.venueId === 'venue-pdr' && barFoodIds.includes(r.menuItemId));
    console.log(`\nBar FOOD items: ${barFoodIds.length}`);
    console.log(`Bar FOOD items with PDR price: ${barPricesInPDR.length}`);
    
    const stillMissing = barItems.filter(i => i.menuType === 'FOOD' && !deduped.has(`venue-pdr:${i.id}`));
    if (stillMissing.length > 0) {
      console.log(`\nBar FOOD items still without venue prices (${stillMissing.length}):`);
      stillMissing.forEach(i => console.log(`  ⚠️  ${i.name} (${i.id})`));
    }
    
    // 7. Verify specific items
    console.log('\n--- Verification: Chicken Drumstick ---');
    const drumstickItems = allItems.filter(i => normalize(i.name).includes('drumstick'));
    for (const item of drumstickItems) {
      const vps = await prisma.venuePrice.findMany({ where: { menuItemId: item.id } });
      console.log(`  ${item.name} [${item.source}]:`);
      if (vps.length === 0) console.log('    (no venue prices)');
      vps.forEach(v => console.log(`    ${v.venueId}: ₹${v.price}`));
    }
    
    await prisma.$disconnect();
    
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
