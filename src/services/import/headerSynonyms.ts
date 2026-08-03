// ─────────────────────────────────────────────────────────────────────────────
// headerSynonyms — synonym dictionary + fuzzy matcher for column headers.
// ─────────────────────────────────────────────────────────────────────────────
// Maps ~80+ common Indian-restaurant spreadsheet header variants to canonical
// fields. Used by the excel/csv parser to auto-suggest column mappings before
// the user confirms them in the mapping UI.
//
// Matching strategy (in order, first match wins):
//   1. EXACT   — normalized header equals a canonical field name
//   2. SYNONYM — normalized header is in the synonym list for a field
//   3. FUZZY   — Levenshtein distance ≤ 2 against any synonym
//   4. AI      — caller invokes mapHeadersWithAI() for remaining unmapped cols
//
// No invented confidence percentages — the returned MappingSource enum is the
// only signal the frontend needs to color the mapping badge.
// ─────────────────────────────────────────────────────────────────────────────

import { CanonicalField } from '../../lib/import/CanonicalField';
import { MappingSource } from '../../lib/import/MappingSource';

/**
 * Synonym dictionary. Each canonical field maps to a list of normalized
 * (lowercase, no whitespace, no punctuation) header variants.
 *
 * Keep entries lowercase and free of spaces/punctuation — `normalizeHeader`
 * produces that form before lookup.
 */
const SYNONYMS: Record<CanonicalField, string[]> = {
  [CanonicalField.NAME]: [
    'name', 'itemname', 'item', 'dish', 'dishname', 'menuitem', 'fooditem',
    'foodname', 'food', 'product', 'productname', 'productitem', 'itemdescription',
    'menuname', 'dishnameenglish', 'itemnameenglish', 'itemtitle',
  ],
  [CanonicalField.PRICE]: [
    'price', 'mrp', 'rate', 'amount', 'cost', 'sellingprice', 'sellingrate',
    'rateinclgst', 'amountinclgst', 'priceinclgst', 'mrpinclgst',
    'sellingpriceinclgst', 'ratewithgst', 'amountwithgst', 'price₹', 'rate₹',
    'amount₹', 'cost₹', 'mrp₹', 'price(rs)', 'rate(rs)', 'amount(rs)',
    'priceinr', 'rateinr', 'amountinr', 'baseprice', 'unitprice', 'listprice',
    'finalprice', 'taxablevalue', 'taxableamount', 'sellingamount',
  ],
  [CanonicalField.CATEGORY]: [
    'category', 'cat', 'section', 'department', 'dept', 'foodgroup', 'group',
    'menusection', 'categoryname', 'catname', 'sectionname', 'groupname',
    'foodcategory', 'menucategory', 'itemcategory', 'itemgroup', 'type',
    'foodtype', 'fooddepartment', 'menuitemcategory', 'itemsection',
    'subcategory', 'subcat', 'subgroup', 'subdepartment',
  ],
  [CanonicalField.IS_VEG]: [
    'isveg', 'veg', 'vegetarian', 'vegnonveg', 'vnv', 'v/nv', 'vnv',
    'foodtype', 'type', 'vegnonveg', 'vegetariannonvegetarian', 'v', 'nv',
    'vegflag', 'nonveg', 'nonvegetarian', 'isvegetarian', 'vegstatus',
    'foodpreference', 'preference',
  ],
  [CanonicalField.DESCRIPTION]: [
    'description', 'desc', 'details', 'remarks', 'comments', 'notes',
    'itemdescription', 'itemdetails', 'itemremarks', 'itemnotes',
    'productdescription', 'productdetails', 'about', 'aboutitem',
  ],
  [CanonicalField.GST]: [
    'gst', 'taxrate', 'gstpercent', 'gstpercent', 'gstpct', 'tax',
    'taxpercent', 'taxpct', 'cgst', 'sgst', 'igst', 'gstslab', 'taxslab',
    'gsttax', 'gstamount', 'taxratepercent', 'gstpercentrate', 'tax%',
    'gst%', 'taxrate%', 'gstslabpercent',
  ],
  [CanonicalField.HSN]: [
    'hsn', 'hsncode', 'hsnsac', 'sac', 'hsnsaccode', 'hsnnumber',
    'hsncodeforitem', 'itemhsn', 'producthsn', 'hsncodegst',
  ],
  [CanonicalField.IMAGE]: [
    'image', 'imageurl', 'photo', 'img', 'picture', 'imagepath',
    'imagelink', 'photourl', 'imgurl', 'itemimage', 'productimage',
    'menuimage', 'dishimage', 'imagepathurl', 'imagefilename',
  ],
  [CanonicalField.SKU]: [
    'sku', 'code', 'itemcode', 'productcode', 'barcode', 'itemno',
    'itemnumber', 'productno', 'productnumber', 'skucode', 'itemsku',
    'productsku', 'itemidentifier', 'itembarcode', 'productbarcode',
  ],
  [CanonicalField.KITCHEN]: [
    'kitchen', 'kitchenstation', 'counter', 'station', 'kitchencounter',
    'preparationstation', 'cookingstation', 'kotstation', 'orderstation',
    'kitchendestination', 'itemkitchen', 'productkitchen',
  ],
  [CanonicalField.PRINTER]: [
    'printer', 'printstation', 'kotprinter', 'printerkot', 'printername',
    'printerdestination', 'printerforitem', 'itemprinter', 'productprinter',
    'kotprintername', 'printertarget',
  ],
  [CanonicalField.PREPARATION_TIME]: [
    'preptime', 'preparationtime', 'cookingtime', 'maketime', 'readytime',
    'preparationminutes', 'cooktime', 'preparationduration', 'preptimeminutes',
    'estimatedpreptime', 'itempreptime', 'productpreptime',
  ],
  [CanonicalField.IS_AVAILABLE]: [
    'available', 'status', 'active', 'instock', 'isactive', 'isavailable',
    'availability', 'instockstatus', 'stockstatus', 'itemavailable',
    'productavailable', 'isinstock', 'availablestatus', 'activeinactive',
  ],
  [CanonicalField.MENU_TYPE]: [
    'menutype', 'type2', 'foodtype2', 'itemtype', 'producttype',
    'menuitemtype', 'foodorliquor', 'foodliquor', 'categorytype',
    'itemmenutype', 'productmenutype', 'menucategorytype',
  ],
  [CanonicalField.UNIT]: [
    'unit', 'unitofmeasure', 'uom', 'quantityunit', 'measureunit',
    'unitmeasure', 'itemunit', 'productunit', 'packingunit', 'packunit',
    'sizeunit', 'portionunit',
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a header string for matching: lowercase, no whitespace, no punctuation. */
export function normalizeHeader(header: string): string {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\w]/g, '');
}

/** Build a reverse lookup: normalizedSynonym → CanonicalField. */
const SYNONYM_INDEX: Map<string, CanonicalField> = (() => {
  const m = new Map<string, CanonicalField>();
  for (const [field, synonyms] of Object.entries(SYNONYMS) as [CanonicalField, string[]][]) {
    for (const s of synonyms) {
      const normalized = normalizeHeader(s);
      // First-write-wins: a synonym mapped to two fields stays with the first.
      // The field declaration order in CanonicalField determines priority.
      if (!m.has(normalized)) m.set(normalized, field);
    }
    // Also index the canonical field name itself (normalized) for EXACT matches.
    const canonical = normalizeHeader(field);
    if (!m.has(canonical)) m.set(canonical, field);
  }
  return m;
})();

/** Levenshtein distance between two strings (case-sensitive, call after normalize). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export interface HeaderMatch {
  field: CanonicalField | null;
  source: MappingSource;
}

/**
 * Match a single header to a canonical field using rules + fuzzy matching.
 * Returns { field: null, source: null } when no rule-based match is found —
 * the caller can then defer to mapHeadersWithAI() for the unmatched columns.
 */
export function matchHeader(header: string): HeaderMatch {
  const normalized = normalizeHeader(header);
  if (!normalized) return { field: null, source: MappingSource.MANUAL };

  // 1. Exact / synonym lookup
  const exact = SYNONYM_INDEX.get(normalized);
  if (exact) {
    // If the normalized header equals the canonical field name, it's EXACT.
    const isExact = normalized === normalizeHeader(exact);
    return { field: exact, source: isExact ? MappingSource.EXACT : MappingSource.SYNONYM };
  }

  // 2. Fuzzy match against all indexed synonyms (distance ≤ 2)
  let bestField: CanonicalField | null = null;
  let bestDistance = 3; // must be ≤ 2 to qualify
  for (const [synonym, field] of SYNONYM_INDEX.entries()) {
    // Skip very short synonyms to avoid false positives (e.g. "v", "nv").
    if (synonym.length < 4) continue;
    const d = levenshtein(normalized, synonym);
    if (d < bestDistance) {
      bestDistance = d;
      bestField = field;
    }
  }
  if (bestField) return { field: bestField, source: MappingSource.FUZZY };

  return { field: null, source: MappingSource.MANUAL };
}

/**
 * Match a list of column headers, returning one HeaderMatch per column.
 * Does NOT call AI — the caller is responsible for invoking mapHeadersWithAI()
 * for columns that returned { field: null }.
 */
export function matchHeaders(columns: string[]): HeaderMatch[] {
  return columns.map(matchHeader);
}

/**
 * Apply a saved mapping (from the MenuColumnMapping table) on top of rule-based
 * matches. Saved mappings override auto-detection for the columns they cover.
 */
export function applySavedMappings(
  ruleMatches: HeaderMatch[],
  columns: string[],
  saved: Record<string, CanonicalField>,
): HeaderMatch[] {
  return ruleMatches.map((m, i) => {
    const original = columns[i];
    const savedField = saved[original] || saved[original.trim().toLowerCase()];
    if (savedField) {
      return { field: savedField, source: MappingSource.SAVED };
    }
    return m;
  });
}

/**
 * Merge AI mappings into rule matches for columns that rule-based matching
 * could not resolve (field === null). Rule-matched columns keep their field.
 */
export function mergeAIMappings(
  ruleMatches: HeaderMatch[],
  aiMappings: { field: CanonicalField | null; source: MappingSource }[],
): HeaderMatch[] {
  return ruleMatches.map((m, i) => {
    if (m.field !== null) return m;
    const ai = aiMappings[i];
    if (!ai) return m;
    return { field: ai.field, source: ai.source };
  });
}
