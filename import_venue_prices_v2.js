/**
 * import_venue_prices_v2.js
 * 
 * Reads the RATES BAR.xlsx spreadsheet and imports venue-specific prices
 * for ALL matching menu items (both restaurant-001 and bar-001 databases).
 * 
 * Uses the running backend API so we don't need direct DB access.
 * Then POSTs the results to the venue/prices endpoint.
 */

const xlsx = require('xlsx');

const API_BASE = 'http://localhost:3000';

// Column indices in the Excel sheet (0-based)
const VENUE_COLUMNS = {
  4: 'venue-bar',
  5: 'venue-conference1',
  6: 'venue-conference2',  // "CONFERENCE 2"
  7: 'venue-pdr',
  10: 'venue-parcel',
};

// Normalize a name for comparison
function normalize(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[''`]/g, "'")
    .replace(/&/g, 'and');
}

// More aggressive normalization: strip parenthesized suffixes, slashes, common words
function superNormalize(name) {
  return normalize(name)
    .replace(/\s*\([^)]*\)\s*/g, ' ')  // remove (NV), (Bones), etc.
    .replace(/\s*[/]\s*/g, ' ')         // remove slashes
    .replace(/\s*(b\/l|b l)\s*/g, ' ')  // remove B/L
    .replace(/\b(bones|curry|spl|special|cream of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token overlap score
function tokenScore(a, b) {
  const tokensA = new Set(normalize(a).split(' ').filter(t => t.length > 1));
  const tokensB = new Set(normalize(b).split(' ').filter(t => t.length > 1));
  if (!tokensA.size || !tokensB.size) return 0;
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }
  return overlap / Math.max(tokensA.size, tokensB.size);
}

async function main() {
  try {
    // 1. Read Excel
    const workbook = xlsx.readFile('rates_bar.xlsx');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    
    console.log('Excel row count:', data.length);
    console.log('Header row 2:', JSON.stringify(data[2]));

    // 2. Fetch ALL menu items from both databases via the API
    const [barRes, restRes] = await Promise.all([
      fetch(`${API_BASE}/api/bar/menu/items`),
      fetch(`${API_BASE}/api/menu/items/admin`).catch(() => fetch(`${API_BASE}/api/menu/items`)),
    ]);
    
    const barItems = await barRes.json();
    const restItems = await restRes.json();
    
    console.log(`Bar items: ${barItems.length}, Restaurant items: ${restItems.length}`);
    
    // 3. Build name → [item IDs] lookup from ALL items
    // We want to match each Excel name to ALL menu item IDs with similar names
    const allItems = [];
    
    // Add bar items
    for (const item of barItems) {
      allItems.push({ id: item.id, name: item.name, source: 'bar' });
    }
    
    // Add restaurant items
    for (const item of restItems) {
      allItems.push({ id: item.id, name: item.name, source: 'rest' });
    }
    
    // Build normalized name → items map
    const exactNameMap = new Map(); // normalized name → [{id, name, source}]
    const superNameMap = new Map(); // super-normalized → [{id, name, source}]
    
    for (const item of allItems) {
      const n = normalize(item.name);
      const sn = superNormalize(item.name);
      
      if (!exactNameMap.has(n)) exactNameMap.set(n, []);
      exactNameMap.get(n).push(item);
      
      if (!superNameMap.has(sn)) superNameMap.set(sn, []);
      superNameMap.get(sn).push(item);
    }
    
    // 4. Process Excel rows and match to menu items
    const batch = []; // { venueId, menuItemId, price }
    let matchedRows = 0;
    let unmatchedRows = 0;
    const unmatchedNames = [];
    
    for (let i = 3; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[1] || typeof row[1] !== 'string') continue;
      
      const excelName = row[1].trim();
      if (excelName === 'Item' || excelName === '') continue; // Skip header rows
      
      // Try to match this Excel name to menu item(s)
      const normalizedExcel = normalize(excelName);
      const superNormalizedExcel = superNormalize(excelName);
      
      let matchedItems = [];
      
      // 1. Exact normalized match
      if (exactNameMap.has(normalizedExcel)) {
        matchedItems = exactNameMap.get(normalizedExcel);
      }
      
      // 2. Super-normalized match (strips parenthesized parts, common words)
      if (matchedItems.length === 0 && superNameMap.has(superNormalizedExcel)) {
        matchedItems = superNameMap.get(superNormalizedExcel);
      }
      
      // 3. Fuzzy token match (>= 0.7 overlap)
      if (matchedItems.length === 0) {
        let bestScore = 0;
        let bestItems = [];
        for (const [name, items] of exactNameMap.entries()) {
          const score = tokenScore(excelName, name);
          if (score > bestScore && score >= 0.7) {
            bestScore = score;
            bestItems = items;
          }
        }
        matchedItems = bestItems;
      }
      
      if (matchedItems.length === 0) {
        unmatchedRows++;
        unmatchedNames.push(excelName);
        continue;
      }
      
      matchedRows++;
      
      // For each venue column, create price records for ALL matched item IDs
      for (const [colIdx, venueId] of Object.entries(VENUE_COLUMNS)) {
        const price = row[Number(colIdx)];
        if (typeof price === 'number' && !isNaN(price) && price > 0) {
          for (const item of matchedItems) {
            batch.push({
              venueId,
              menuItemId: item.id,
              price,
            });
          }
        }
      }
    }
    
    console.log(`\nMatched: ${matchedRows} rows, Unmatched: ${unmatchedRows} rows`);
    console.log(`Total price records to insert: ${batch.length}`);
    
    if (unmatchedNames.length > 0) {
      console.log(`\nUnmatched Excel names (${unmatchedNames.length}):`);
      unmatchedNames.forEach(n => console.log(`  - ${n}`));
    }
    
    // 5. Clear existing and insert via direct DB (need PrismaClient)
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    // Deduplicate: keep last occurrence (later row wins)
    const deduped = new Map();
    for (const record of batch) {
      const key = `${record.venueId}:${record.menuItemId}`;
      deduped.set(key, record);
    }
    const dedupedBatch = Array.from(deduped.values());
    console.log(`\nAfter deduplication: ${dedupedBatch.length} unique records`);
    
    // Clear existing
    await prisma.venuePrice.deleteMany({});
    console.log('Cleared existing venue prices.');
    
    // Insert in batches of 500
    let inserted = 0;
    for (let i = 0; i < dedupedBatch.length; i += 500) {
      const chunk = dedupedBatch.slice(i, i + 500);
      await prisma.venuePrice.createMany({
        data: chunk,
        skipDuplicates: true,
      });
      inserted += chunk.length;
      console.log(`  Inserted ${inserted}/${dedupedBatch.length}...`);
    }
    
    console.log(`\n✅ Successfully imported ${inserted} venue prices.`);
    
    // 6. Verify: check drumstick specifically
    const drumstickItems = allItems.filter(i => normalize(i.name).includes('drumstick'));
    console.log('\nDrumstick items in DB:');
    for (const item of drumstickItems) {
      const vp = await prisma.venuePrice.findMany({
        where: { menuItemId: item.id },
      });
      console.log(`  ${item.name} (${item.source}/${item.id}):`);
      vp.forEach(v => console.log(`    ${v.venueId}: ${v.price}`));
    }
    
    await prisma.$disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
