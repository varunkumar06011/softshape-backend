// ─────────────────────────────────────────────────────────────────────────────
// menuHelpers — pure helper functions for menu parsing, shared between
// the legacy menu.ts route handlers and the new import pipeline.
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from routes/menu.ts so that the import parsers (excelParser,
// pdfParser, imageParser) can reuse the same logic without circular imports.
// menu.ts re-exports these for backward compatibility with its own call sites.
//
// Every function here is pure — no DB access, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

// ── Numeric / header helpers ──────────────────────────────────────────────────

export function isPureNumber(v: any): boolean {
  return /^\d+(\.\d+)?$/.test(String(v || "").trim());
}

export function parsePrice(v: any): number {
  const n = parseFloat(String(v || "").trim().replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}

export function normalizeHeader(header: string): string {
  return header.toString().trim().toLowerCase().replace(/\s+/g, "");
}

export function isHeaderKeyword(v: any): boolean {
  return /^(s\.?no|itemname|item|rate|price|amount|section|category)$/i.test(normalizeHeader(v));
}

// ── Keyword lists ─────────────────────────────────────────────────────────────

export const LIQUOR_KEYWORDS = [
  "beer", "whisky", "whiskey", "vodka", "rum", "gin", "brandy",
  "wine", "shots", "cocktail", "mocktail", "liquor", "spirit",
  "draft", "draught",
  // Volume / bottle-size indicators
  "30ml", "60ml", "90ml", "120ml", "180ml", "375ml", "750ml", "1ltr", "1 ltr",
  "pint", "quart", "nip", "miniature", "peg", "full", "half", "bottle", "ml", "ltr",
  // Common Indian/international liquor brands
  "absolut", "ballantine", "ballantines", "teacher", "teachers", "legacy",
  "black & white", "black and white", "johnnie walker", "jack daniel", "jack daniels",
  "chivas", "chivas regal", "royal stag", "imperial blue", "old monk",
  "mcdowell", "mcdowells", "kingfisher", "budweiser", "heineken", "corona", "tuborg",
  "haywards", "hayward", "foster", "fosters", "carlsberg", "antiquity", "blenders",
  "blenders pride", "directors", "directors special", "signature", "bagpiper",
  "smirnoff", "magic moment", "magic moments", "white mischief", "officer",
  "officers", "officer choice", "seagram", "seagrams", "100 pipers", " VAT 69",
  "bombay sapphire", "tanqueray", "harpers", "cutty sark", "j&b", "remy martin",
  "hennessy", "martell", "courvoisier", "bacardi", "captain morgan", "malibu",
  "jim beam", "maker mark", "wild turkey", "glenfiddich", "glenlivet", "macallan",
  "laphroaig", "ardbeg", "lagavulin", "glenmorangie", "singleton",
];

export const GARBAGE_KEYWORDS = ["page", "www.", "http", "@", ".com", "fssai", "gstin"];

// ── Veg / category / menu-type inference ──────────────────────────────────────

export function keywordMatches(name: string, keyword: string): boolean {
  const lower = name.toLowerCase();
  const k = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^a-z0-9])${k}(?:[^a-z0-9]|$)`, "i");
  return re.test(lower);
}

export function inferVeg(name: string): boolean {
  const lower = name.toLowerCase();
  const liquor = ["whisky", "whiskey", "vodka", "rum", "gin", "brandy", "beer", "wine", "absolut", "ballantine", "teacher", "legacy", "chivas", "royal stag", "imperial blue", "old monk", "mcdowell", "kingfisher", "budweiser", "heineken", "corona", "tuborg", "antiquity", "smirnoff", "seagram", "officer"];
  if (liquor.some((k) => keywordMatches(lower, k))) return false;
  const nonVeg = ["chicken", "mutton", "fish", "prawn", "egg", "beef", "pork", "crab", "biryani", "omlet", "kebab"];
  const veg = ["veg", "paneer", "mushroom", "aloo", "gobi", "dal", "corn", "cashew", "kofta", "palak", "kheema"];
  if (nonVeg.some((k) => lower.includes(k))) return false;
  if (veg.some((k) => lower.includes(k))) return true;
  return true;
}

export function inferMenuTypeFromCategory(category: string): string {
  const lower = category.toLowerCase();
  if (LIQUOR_KEYWORDS.some((k) => keywordMatches(lower, k))) return "LIQUOR";
  return "FOOD";
}

export function inferCategoryFromName(name: string, restaurantType?: string): string {
  const lower = name.toLowerCase();

  const categoryKeywordMap: { category: string; keywords: string[] }[] = [
    { category: "Liquor", keywords: [
      "30ml", "60ml", "90ml", "120ml", "180ml", "375ml", "750ml", "1ltr",
      "pint", "quart", "nip", "miniature", "peg", "bottle",
      "whisky", "whiskey", "vodka", "rum", "gin", "brandy", "beer", "wine",
      "absolut", "ballantine", "ballantines", "teacher", "teachers", "legacy",
      "black & white", "black and white", "johnnie walker", "jack daniel", "jack daniels",
      "chivas", "chivas regal", "royal stag", "imperial blue", "old monk",
      "mcdowell", "mcdowells", "kingfisher", "budweiser", "heineken", "corona", "tuborg",
      "haywards", "hayward", "foster", "fosters", "carlsberg", "antiquity", "blenders",
      "blenders pride", "directors", "directors special", "signature", "bagpiper",
      "smirnoff", "magic moment", "magic moments", "white mischief", "officer",
      "officers", "officer choice", "seagram", "seagrams", "100 pipers", "vat 69",
      "bombay sapphire", "tanqueray", "harpers", "cutty sark", "j&b", "remy martin",
      "hennessy", "martell", "courvoisier", "bacardi", "captain morgan", "malibu",
      "jim beam", "maker mark", "wild turkey", "glenfiddich", "glenlivet", "macallan",
      "laphroaig", "ardbeg", "lagavulin", "glenmorangie", "singleton",
    ]},
    { category: "Soups", keywords: ["soup", "rasam", "shorba"] },
    { category: "Salads", keywords: ["salad", "kachumber"] },
    { category: "Starters (Veg)", keywords: ["paneer tikka", "veg tikka", "gobi", "aloo 65", "veg 65", "mushroom 65", "corn 65", "paneer 65", "veg manchurian", "gobi manchurian", "mushroom manchurian", "veg spring roll", "crispy corn", "french fries", "golden fries", "baby corn 65", "cashewnut roast", "veg shangrilla", "chilli gobi", "masala papad", "spring rolls"] },
    { category: "Starters (Non-Veg)", keywords: ["chicken 65", "chicken manchurian", "chilli chicken", "crispy chicken", "pepper chicken", "chicken wings", "chicken lollipop", "chicken drumstick", "fish 65", "fish manchurian", "chilli fish", "prawn", "dragon chicken", "chicken majestic", "star chicken", "apollo fish", "velvet fish", "chicken shangrilla", "chicken alpha", "chicken 85", "kebab", "tikka", "pakora", "fry", "fingers", "chaat", "bhel", "cutlet", "roll", "starter", "appetizer", "bruschetta", "nachos"] },
    { category: "Tandoori", keywords: ["tandoori", "tikka", "kebab", "grill", "barbecue", "bbq"] },
    { category: "Breads", keywords: ["naan", "roti", "paratha", "kulcha", "puri", "bhatura", "chapati", "phulka"] },
    { category: "Biryani & Rice", keywords: ["biryani", "fried rice", "pulao", "rice", "khichdi", "curd rice", "sambar rice"] },
    { category: "Fried Rice & Noodles", keywords: ["noodles", "chowmein", "manchurian", "hakka", "schezwan", "momos", "dimsum"] },
    { category: "Seafood", keywords: ["fish", "prawn", "crab", "lobster", "squid", "pomfret", "tuna", "salmon"] },
    { category: "Curries (Veg)", keywords: ["paneer", "dal", "kofta", "korma", "kadai", "curry", "masala", "gravy", "sabzi", "keema", "palak", "methi", "kheema"] },
    { category: "Curries (Non-Veg)", keywords: ["butter chicken", "chicken curry", "mutton curry", "egg curry", "chicken masala", "mutton masala", "chilli chicken", "kadai chicken", "moghlai chicken"] },
    { category: "Main Course (Veg)", keywords: ["malai kofta", "shahi kurma", "veg jaipuri", "cashewnut curry", "paneer butter masala", "paneer tikka masala"] },
    { category: "Main Course (Non-Veg)", keywords: ["chicken afghani", "chicken priya pasand", "mutton", "beef", "pork"] },
    { category: "Desserts", keywords: ["gulab", "halwa", "kheer", "ice cream", "brownie", "cake", "rasmalai", "payasam", "ladoo", "barfi", "mithai", "pudding"] },
    { category: "Beverages", keywords: ["tea", "coffee", "juice", "lassi", "buttermilk", "soda", "shake", "smoothie", "water", "lime", "lemonade", "mojito", "cooler", "soft drink", "cola", "sprite", "fanta", "limca", "thumsup", "orange"] },
    { category: "Accompaniments", keywords: ["raita", "pappad", "papad", "chutney", "pickle", "onion ritha", "plain curd", "gravy"] },
  ];

  if (restaurantType === "BAR_LOUNGE" || restaurantType === "BAR_WITH_DINING") {
    categoryKeywordMap.push(
      { category: "Beer", keywords: ["beer", "kingfisher", "budweiser", "corona", "heineken", "carlsberg", "tiger", "bira", "pint", "draught", "draft"] },
      { category: "Whisky", keywords: ["whisky", "whiskey", "royal challenge", "blenders pride", "officer's choice", "jack daniel", "jameson", "chivas", "johnnie walker", "ballantine", "100 pipers", "imperial blue", "mc dowell", "black & white", "black and white", "teacher", "teachers", "legacy"] },
      { category: "Vodka", keywords: ["vodka", "smirnoff", "absolut", "magic moments", "romanov", "white mischief", "grey goose"] },
      { category: "Rum", keywords: ["rum", "old monk", "bacardi", "captain morgan", "malibu"] },
      { category: "Gin", keywords: ["gin", "bombay sapphire", "tanqueray", "blue moon"] },
      { category: "Brandy", keywords: ["brandy", "mc dowell", "old tavern", "honey bee"] },
      { category: "Wine", keywords: ["wine", "sula", "grover", "red wine", "white wine", "rose wine"] },
      { category: "Cocktails & Mocktails", keywords: ["cocktail", "mocktail", "mojito", "margarita", "martini", "pina colada", "cosmopolitan", "moctail"] },
      { category: "Shots", keywords: ["shot", "shooter", "tequila"] },
      { category: "Spirits", keywords: ["liquor", "spirit", "liqueur"] },
    );
  }

  let bestCategory = "Main Course (Veg)";
  let bestScore = 0;

  for (const { category, keywords } of categoryKeywordMap) {
    let score = 0;
    for (const k of keywords) {
      if (lower === k) {
        score += 10;
      } else if (keywordMatches(lower, k)) {
        score += 5;
      } else if (lower.includes(k)) {
        score += 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

// ── PDF / text-line helpers ───────────────────────────────────────────────────

export function isCategoryHeader(line: string): boolean {
  if (line.length > 45) return false;
  if (/₹?\s*\d{3,}/.test(line)) return false;
  const trimmed = line.trim();
  if (trimmed.length <= 2) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (trimmed === trimmed.toUpperCase() && trimmed.length > 2 && wordCount <= 5) return true;
  if (trimmed.endsWith(":")) return true;
  const knownNonCategory = new Set([
    "page", "menu", "restaurant", "order", "bill", "tax", "total", "subtotal",
    "date", "time", "special", "served", "contains", "choice", "please",
    "available", "note", "price", "item", "name", "qty", "quantity", "rate", "amount",
  ]);
  const words = trimmed.split(/\s+/);
  const isTitleCase = words.length > 0 && words.every((w) => w.length === 0 || w[0] === w[0].toUpperCase());
  if (isTitleCase && wordCount <= 3 && trimmed.length > 4 && !knownNonCategory.has(trimmed.toLowerCase())) return true;
  return false;
}

export function isGarbageLine(line: string): boolean {
  if (line.length < 3) return true;
  if (/^[\d\s\W]+$/.test(line)) return true;
  const lower = line.toLowerCase();
  if (GARBAGE_KEYWORDS.some((k) => lower.includes(k))) return true;
  return false;
}

export function extractVariantPrices(line: string): { half: number; full: number } | null {
  const m = line.match(/₹?\s*(\d{2,5})\s*\/\s*(\d{2,5})/);
  if (!m) return null;
  const p1 = parseInt(m[1], 10);
  const p2 = parseInt(m[2], 10);
  if (isNaN(p1) || isNaN(p2) || p1 <= 0 || p2 <= 0) return null;
  return { half: Math.min(p1, p2), full: Math.max(p1, p2) };
}

export function extractPrices(line: string): number[] {
  const prices: number[] = [];
  const regex = /(?:₹\s*)?(\d{2,5})(?:\s*\/\s*(?:\d{2,5}))?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    prices.push(parseInt(m[1], 10));
  }
  return prices;
}

export function extractItemName(line: string, _price: number): string {
  let name = line
    .replace(/(?:₹\s*)?\d{2,5}(?:\s*\/\s*(?:\d{2,5}))?/g, "")
    .replace(/\.{3,}/g, " ")
    .replace(/[\-–—]+$/, "")
    .replace(/[\-–—]\s*$/, "")
    .trim();
  return name;
}

// ── Venue helpers (rate-card) ─────────────────────────────────────────────────

export const VENUE_KEYWORDS = [
  "bar", "conference", "pdr", "room", "parcel", "banquet",
  "hall", "ac", "takeaway", "delivery", "gobox", "go box",
  "special", "vedika", "restaurant", "garden", "terrace",
  "rooftop", "family",
];

export const VENUE_ALIASES: Record<string, string> = {
  "pdr": "private dining room",
  "gobox": "go box",
  "barac": "bar ac",
  "barachall": "bar ac hall",
  "baracc": "bar ac",
  "parcel": "takeaway",
  "vedika": "vedika banquet hall",
  "specials": "specials",
};

export function normalizeVenueName(name: string): string {
  let n = name.toLowerCase().trim();
  n = n.replace(/[^a-z0-9]/g, "");
  if (VENUE_ALIASES[n]) n = VENUE_ALIASES[n].replace(/[^a-z0-9]/g, "");
  n = n.replace(/^(venue|bar|restaurant)/g, "");
  return n;
}

// ── Rate-card layout detection ────────────────────────────────────────────────

export interface RateCardLayout {
  isRateCard: boolean;
  venueHeaderRow: number;
  venueCols: number[];
  itemNameCol: number;
  itemCodeCol: number;
  unitCol: number;
  categoryCol: number;
  subcategoryCol: number;
  typeCol: number;
}

export function detectRateCardLayout(rawMatrix: any[][]): RateCardLayout {
  const maxScanRows = Math.min(10, rawMatrix.length);

  for (let r = 0; r < maxScanRows; r++) {
    const row = rawMatrix[r] || [];
    const venueCols: number[] = [];
    let itemNameCol = -1;
    let itemCodeCol = -1;
    let unitCol = -1;
    let categoryCol = -1;
    let subcategoryCol = -1;
    let typeCol = -1;

    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || "").trim().toLowerCase().replace(/\s+/g, "");
      if (!cell) continue;

      if (["itemname", "item", "dish", "name", "itemnames"].includes(cell)) {
        itemNameCol = c;
        continue;
      }
      if (["code", "sno", "s.no", "slno", "slno"].includes(cell) || /^s\.?no$/.test(cell)) {
        itemCodeCol = c;
        continue;
      }
      if (["unit", "qty", "quantity", "pack", "size"].includes(cell)) {
        unitCol = c;
        continue;
      }
      if (cell === "category") { categoryCol = c; continue; }
      if (cell === "subcategory") { subcategoryCol = c; continue; }
      if (cell === "type" || cell === "menutype") { typeCol = c; continue; }

      const normalized = normalizeVenueName(cell);
      const hasVenueKeyword = VENUE_KEYWORDS.some(kw => cell.includes(kw) || normalized.includes(kw.replace(/[^a-z0-9]/g, "")));
      if (hasVenueKeyword) {
        venueCols.push(c);
      }
    }

    if (venueCols.length === 0) {
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] || "").trim();
        if (!cell || isPureNumber(cell)) continue;
        if (c === itemNameCol || c === itemCodeCol || c === unitCol || c === categoryCol || c === subcategoryCol || c === typeCol) continue;

        let numericCount = 0;
        for (let dr = r + 1; dr < Math.min(r + 5, rawMatrix.length); dr++) {
          const val = rawMatrix[dr]?.[c];
          if (val !== undefined && val !== null && String(val).trim() !== "" && isPureNumber(val)) {
            numericCount++;
          }
        }
        if (numericCount >= 2) {
          const cellLower = cell.toLowerCase();
          const hasVenueWord = VENUE_KEYWORDS.some(kw => cellLower.includes(kw));
          if (hasVenueWord || numericCount >= 3) {
            venueCols.push(c);
          }
        }
      }
    }

    if (venueCols.length >= 2) {
      if (itemNameCol === -1) {
        for (let c = 0; c < row.length; c++) {
          if (venueCols.includes(c) || c === itemCodeCol || c === unitCol || c === categoryCol || c === subcategoryCol || c === typeCol) continue;
          const cell = String(row[c] || "").trim();
          if (cell && !isPureNumber(cell)) {
            itemNameCol = c;
            break;
          }
        }
        if (itemNameCol === -1 && r + 1 < rawMatrix.length) {
          const dataRow = rawMatrix[r + 1] || [];
          for (let c = 0; c < dataRow.length; c++) {
            if (venueCols.includes(c) || c === itemCodeCol || c === unitCol) continue;
            const cell = String(dataRow[c] || "").trim();
            if (cell && !isPureNumber(cell)) {
              itemNameCol = c;
              break;
            }
          }
        }
      }

      if (itemNameCol >= 0) {
        return { isRateCard: true, venueHeaderRow: r, venueCols, itemNameCol, itemCodeCol, unitCol, categoryCol, subcategoryCol, typeCol };
      }
    }
  }

  return { isRateCard: false, venueHeaderRow: -1, venueCols: [], itemNameCol: -1, itemCodeCol: -1, unitCol: -1, categoryCol: -1, subcategoryCol: -1, typeCol: -1 };
}

// ── Rate-card matrix parsing ──────────────────────────────────────────────────

export function parseRateCardMatrix(
  rawMatrix: any[][],
  layout: RateCardLayout,
  warnings: string[],
  restaurantType?: string,
): { rows: any[]; warnings: string[]; confidence: string; mode: string; venueHeaders: string[] } {
  const rows: any[] = [];
  const venueHeaders = layout.venueCols.map(c => String(rawMatrix[layout.venueHeaderRow][c] || "").trim());
  const seenNames = new Set<string>();

  for (let r = layout.venueHeaderRow + 1; r < rawMatrix.length; r++) {
    const rawRow = rawMatrix[r] || [];
    const name = String(rawRow[layout.itemNameCol] || "").trim();

    if (!name || isPureNumber(name)) {
      if (layout.itemCodeCol >= 0 && name && isPureNumber(name)) {
        const possibleName = String(rawRow[layout.itemNameCol + 1] || "").trim();
        if (possibleName && !isPureNumber(possibleName)) continue;
      }
      continue;
    }

    if (isGarbageLine(name)) continue;
    if (isHeaderKeyword(name)) continue;
    if (/^(total|subtotal|grand total|sum)/i.test(name)) continue;

    let actualName = name;
    let actualUnit = "";

    if (layout.itemCodeCol >= 0 && layout.itemCodeCol === layout.itemNameCol) {
      for (let c = layout.itemNameCol + 1; c < rawRow.length; c++) {
        if (layout.venueCols.includes(c)) break;
        const cell = String(rawRow[c] || "").trim();
        if (cell && !isPureNumber(cell)) {
          actualName = cell;
          break;
        }
      }
    }

    if (!actualName || isPureNumber(actualName)) continue;

    if (layout.unitCol >= 0) {
      actualUnit = String(rawRow[layout.unitCol] || "").trim();
    }

    let category = "Uncategorized";
    let subcategory = "";
    if (layout.subcategoryCol >= 0) {
      subcategory = String(rawRow[layout.subcategoryCol] || "").trim();
    }
    if (layout.categoryCol >= 0) {
      const cat = String(rawRow[layout.categoryCol] || "").trim();
      category = cat || subcategory || "Uncategorized";
    } else if (subcategory) {
      category = subcategory;
    } else {
      category = inferCategoryFromName(actualName, restaurantType);
    }

    let menuType = "FOOD";
    if (layout.typeCol >= 0) {
      const t = String(rawRow[layout.typeCol] || "").trim().toUpperCase();
      if (t === "LIQUOR" || t === "BAR") menuType = "LIQUOR";
    }
    if (menuType === "FOOD" && category !== "Uncategorized") {
      menuType = inferMenuTypeFromCategory(category);
    }

    if (inferMenuTypeFromCategory(actualName) === "LIQUOR" && !category.toLowerCase().includes("liquor") && !category.toLowerCase().includes("spirit")) {
      category = "Liquor";
      menuType = "LIQUOR";
    }

    const venuePrices: Record<string, number> = {};
    let allZero = true;
    let minPrice = Infinity;

    for (let i = 0; i < layout.venueCols.length; i++) {
      const col = layout.venueCols[i];
      const venueName = venueHeaders[i];
      const rawPrice = rawRow[col];
      const price = parsePrice(rawPrice);

      if (price > 0) {
        venuePrices[venueName] = price;
        allZero = false;
        if (price < minPrice) minPrice = price;
      }
    }

    if (allZero) {
      warnings.push(`Row ${r + 1}: "${actualName}" has all zero/empty prices — will be created but hidden`);
    }

    if (minPrice === Infinity) minPrice = 0;

    if (actualUnit.length > 20) {
      const truncated = actualUnit.substring(0, 20);
      warnings.push(`Row ${r + 1} [${actualName}]: unit truncated from '${actualUnit}' to '${truncated}'`);
      actualUnit = truncated;
    }

    const nameLower = actualName.toLowerCase();
    if (seenNames.has(nameLower)) {
      warnings.push(`Row ${r + 1}: duplicate item "${actualName}" — will update existing on import`);
    }
    seenNames.add(nameLower);

    rows.push({
      category: category || "Uncategorized",
      name: actualName,
      price: minPrice,
      isVeg: inferVeg(actualName),
      description: "",
      menuType,
      unit: actualUnit || undefined,
      venuePrices,
      isAvailable: !allZero,
    });
  }

  for (const row of rows) {
    if (row.category === "Uncategorized" || !row.category) {
      row.category = inferCategoryFromName(row.name, undefined);
      row.categoryInferred = true;
    }
  }

  return {
    rows,
    warnings,
    confidence: rows.length > 0 ? "HIGH" : "LOW",
    mode: "rate-card",
    venueHeaders,
  };
}

// ── Multi-block layout detection (header row preceded by category row) ────────

export function detectItemHeaderRow(rawMatrix: any[][]): number {
  const keywords = ["itemname", "item", "dish", "name"];
  for (let r = 0; r < Math.min(20, rawMatrix.length); r++) {
    const row = rawMatrix[r] || [];
    for (const cell of row) {
      if (keywords.includes(normalizeHeader(cell))) return r;
    }
  }
  return -1;
}

export function parseMultiBlockLayout(
  rawMatrix: any[][],
  headerRowIndex: number,
  warnings: string[],
): { rows: any[]; warnings: string[]; confidence: string } {
  const rows: any[] = [];
  const headerRow = rawMatrix[headerRowIndex] || [];
  const categoryRow = rawMatrix[headerRowIndex - 1] || [];

  const itemHeaderCols: number[] = [];
  for (let c = 0; c < headerRow.length; c++) {
    const n = normalizeHeader(headerRow[c]);
    if (["itemname", "item", "dish", "name"].includes(n)) itemHeaderCols.push(c);
  }

  if (itemHeaderCols.length === 0) {
    return { rows, warnings: [...warnings, "No item columns found in header row"], confidence: "LOW" };
  }

  let blockWidth = 4;
  if (itemHeaderCols.length > 1) {
    const counts = new Map<number, number>();
    for (let i = 1; i < itemHeaderCols.length; i++) {
      const d = itemHeaderCols[i] - itemHeaderCols[i - 1];
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    blockWidth = sorted[0][0];
  }

  const maxCol = Math.max(...rawMatrix.map((r) => r?.length || 0));
  const blockStarts: number[] = [];
  for (let s = 0; s <= maxCol; s += blockWidth) blockStarts.push(s);

  const blockCategories: string[] = blockStarts.map((s) => {
    const cat = String(categoryRow[s] || "").trim();
    return cat || "Uncategorized";
  });

  for (let r = headerRowIndex; r < rawMatrix.length; r++) {
    const rawRow = rawMatrix[r] || [];
    for (let b = 0; b < blockStarts.length; b++) {
      const start = blockStarts[b];
      const cells = [start, start + 1, start + 2, start + 3].map((c) => String(rawRow[c] || "").trim());
      const isHeaderRow = r === headerRowIndex;

      let firstText: string | null = null;
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

      let price = 0;
      for (let i = firstTextIdx + 1; i < cells.length; i++) {
        const p = parsePrice(cells[i]);
        if (p > 0) { price = p; break; }
      }

      if (price === 0) {
        blockCategories[b] = firstText;
        continue;
      }

      rows.push({
        category: blockCategories[b],
        name: firstText,
        price,
        isVeg: inferVeg(firstText),
        description: "",
        menuType: inferMenuTypeFromCategory(blockCategories[b]),
      });
    }
  }

  return { rows, warnings, confidence: rows.length > 0 ? "HIGH" : "LOW" };
}
