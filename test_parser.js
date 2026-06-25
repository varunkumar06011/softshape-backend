const xlsx = require('xlsx');

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '');
}

function isPureNumber(v) {
  const s = String(v).trim();
  return /^\d+(\.\d+)?$/.test(s);
}

function parsePrice(v) {
  const s = String(v).trim().replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function isHeaderKeyword(v) {
  const n = normalizeHeader(v);
  return ['itemname', 'item', 'rate', 'price', 'amount', 's.no', 'sno', 'sno.', 's\.no', 's\.no.', 'no', 's\.no', 'section', 'category'].includes(n);
}

function inferVeg(name) {
  const lower = name.toLowerCase();
  const nonVeg = ['chicken', 'mutton', 'fish', 'prawn', 'egg', 'beef', 'pork', 'crab', 'biryani', 'omlet', 'kebab'];
  const veg = ['veg', 'paneer', 'mushroom', 'aloo', 'gobi', 'dal', 'corn', 'cashew', 'kofta', 'palak', 'kheema'];
  if (nonVeg.some(k => lower.includes(k))) return false;
  if (veg.some(k => lower.includes(k))) return true;
  return true;
}

function parseMultiBlock(rawMatrix) {
  const warnings = [];
  const rows = [];

  // Find header row (contains "ITEM NAME" etc.)
  let headerRowIndex = -1;
  const headerKeywords = ['itemname', 'item', 'dish', 'name'];
  for (let r = 0; r < Math.min(20, rawMatrix.length); r++) {
    const row = rawMatrix[r] || [];
    for (const cell of row) {
      if (headerKeywords.includes(normalizeHeader(cell))) {
        headerRowIndex = r;
        break;
      }
    }
    if (headerRowIndex !== -1) break;
  }

  if (headerRowIndex === -1 || rawMatrix.length < headerRowIndex + 2) {
    warnings.push('No ITEM NAME header row found');
    return { rows, warnings, confidence: 'LOW' };
  }

  const headerRow = rawMatrix[headerRowIndex];
  const categoryRow = rawMatrix[headerRowIndex - 1] || [];

  // Find item header columns
  const itemHeaderCols = [];
  for (let c = 0; c < headerRow.length; c++) {
    const n = normalizeHeader(headerRow[c]);
    if (['itemname', 'item', 'dish', 'name'].includes(n)) itemHeaderCols.push(c);
  }

  if (itemHeaderCols.length === 0) {
    warnings.push('No item columns found in header row');
    return { rows, warnings, confidence: 'LOW' };
  }

  // Determine block width from consecutive item header distances
  let blockWidth = 4;
  if (itemHeaderCols.length > 1) {
    const diffs = [];
    for (let i = 1; i < itemHeaderCols.length; i++) diffs.push(itemHeaderCols[i] - itemHeaderCols[i - 1]);
    const counts = new Map();
    for (const d of diffs) counts.set(d, (counts.get(d) || 0) + 1);
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    blockWidth = sorted[0][0];
  }

  // Determine max column count
  const maxCol = Math.max(...rawMatrix.map(r => r?.length || 0));
  const blockStarts = [];
  for (let s = 0; s <= maxCol; s += blockWidth) blockStarts.push(s);

  // Initialize category for each block from the row above the header row
  const blockCategories = blockStarts.map(s => {
    const cat = String(categoryRow[s] || '').trim();
    return cat || 'Uncategorized';
  });

  // Process rows from header row onwards
  for (let r = headerRowIndex; r < rawMatrix.length; r++) {
    const rawRow = rawMatrix[r] || [];
    for (let b = 0; b < blockStarts.length; b++) {
      const start = blockStarts[b];
      const isHeaderRow = r === headerRowIndex;
      const cells = [start, start + 1, start + 2, start + 3].map(c => String(rawRow[c] || '').trim());

      // Find first text cell in the block (excluding pure numbers and header keywords)
      let firstText = null;
      let firstTextIdx = -1;
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i];
        if (!v) continue;
        if (isPureNumber(v)) continue;
        if (isHeaderRow && isHeaderKeyword(v)) continue;
        firstText = v;
        firstTextIdx = i;
        break;
      }

      if (!firstText) continue;

      // Find first price after the text cell
      let price = 0;
      for (let i = firstTextIdx + 1; i < cells.length; i++) {
        const p = parsePrice(cells[i]);
        if (p > 0) { price = p; break; }
      }

      if (price === 0) {
        // No price after text => category header
        blockCategories[b] = firstText;
        continue;
      }

      // Valid item
      rows.push({
        category: blockCategories[b],
        name: firstText,
        price,
        isVeg: inferVeg(firstText),
        description: '',
        menuType: 'FOOD',
      });
    }
  }

  return { rows, warnings, confidence: rows.length > 0 ? 'HIGH' : 'LOW' };
}

const filePath = process.argv[2] || 'family-menu.csv';
const buffer = require('fs').readFileSync(filePath);
const workbook = xlsx.read(buffer, { type: 'buffer' });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true });

const result = parseMultiBlock(matrix);
console.log('Parsed rows:', result.rows.length);
console.log('Confidence:', result.confidence);
console.log('Warnings:', result.warnings.length);
if (result.warnings.length > 0) console.log(result.warnings.slice(0, 10));
console.log('Categories found:', [...new Set(result.rows.map(r => r.category))].length);
console.log('First 20 items:');
console.log(JSON.stringify(result.rows.slice(0, 20), null, 2));
console.log('Last 10 items:');
console.log(JSON.stringify(result.rows.slice(-10), null, 2));
