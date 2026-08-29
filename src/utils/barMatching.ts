// ─────────────────────────────────────────────────────────────────────────────
// Bar Matching — Shared matching + ml-computation logic for bar inventory
// ─────────────────────────────────────────────────────────────────────────────
// Consolidates logic that was previously duplicated across:
//   - src/services/inventoryService.ts (live deduction + periodic retry)
//   - src/routes/barInventory.ts (manual retry endpoint)
//
// Both call sites now import from this single source of truth so that the
// backfill/suggestion script (Phase 2) and the transition-period fallback
// (Phase 4) can reuse the exact same behavior as the live path.
//
// Exports:
//   BEER_NAME_KEYWORDS, nameLooksLikeBeer, normalizeBeerName
//   buildInventoryByName, buildDualVariantMap
//   findInventoryForOrderedItem
//   computeMlPerUnit
//   parseMlFromName, normalizeProductBaseName
//   resolveMenuToInventory  (universal matcher)
// ─────────────────────────────────────────────────────────────────────────────

import { isBeerItem } from "./itemHelpers";
import { BAR_UNIT_ML } from "./barConstants";

// ── Beer-specific fuzzy matching helpers ─────────────────────────────────────
// Used to match ordered beer names to inventory beer names despite spelling
// variations (e.g., "Budweiser" vs "Budwiser", "Strong" vs "Storng").
// Only applied to beer items — other categories use exact/prefix matching.
export const BEER_NAME_KEYWORDS = [
  'beer', 'lager', 'ale', 'bira', 'carlsberg', 'budweiser',
  'kingfisher', 'coolberg', 'stok', 'draught',
];

export function nameLooksLikeBeer(name: string): boolean {
  return BEER_NAME_KEYWORDS.some((k) => name.includes(k));
}

export function normalizeBeerName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/[aeiou]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Inventory index builders ─────────────────────────────────────────────────
// Build a name → inventory-item map (lowercased, trimmed). Used by both the
// matcher and the dual-variant detector.
export function buildInventoryByName(allInventoryItems: any[]): Map<string, any> {
  const inventoryByName = new Map<string, any>();
  for (const inv of allInventoryItems) {
    const name = (inv.menuItem?.name || '').toLowerCase().trim();
    if (name) {
      inventoryByName.set(name, inv);
    }
  }
  return inventoryByName;
}

// Detect dual-variant inventory pairs (e.g., "X 750ml" + "X 180ml") that
// should spill over when the primary (750ml) runs out.
export function buildDualVariantMap(inventoryByName: Map<string, any>): Map<string, { inv750: any; inv180: any }> {
  const dualVariantMap = new Map<string, { inv750: any; inv180: any }>();
  for (const [invName, inv] of inventoryByName.entries()) {
    const match750 = invName.match(/^(.+)\s+750ml$/);
    const match180 = invName.match(/^(.+)\s+180ml$/);
    if (match750) {
      const base = match750[1];
      const inv180 = inventoryByName.get(`${base} 180ml`);
      if (inv180) dualVariantMap.set(base, { inv750: inv, inv180 });
    } else if (match180) {
      const base = match180[1];
      const inv750 = inventoryByName.get(`${base} 750ml`);
      if (inv750 && !dualVariantMap.has(base)) dualVariantMap.set(base, { inv750, inv180: inv });
    }
  }
  return dualVariantMap;
}

// ── Matcher ──────────────────────────────────────────────────────────────────
// Resolves an ordered menu-item name to a primary (and optional secondary)
// inventory item. Tries, in order: exact name, dual-variant base, size-suffix
// strip, beer fuzzy (vowel-normalized), prefix.
//
// `logPrefix` is used in warning logs so the call site is identifiable
// ("[Inventory]" vs "[Bar Retry]").
export function findInventoryForOrderedItem(
  orderedName: string,
  inventoryByName: Map<string, any>,
  dualVariantMap: Map<string, { inv750: any; inv180: any }>,
  logPrefix = '[Inventory]',
  log = (msg: string) => {},
): { primary: any | null; secondary: any | null } {
  const normalized = orderedName.toLowerCase().trim();
  const direct = inventoryByName.get(normalized);
  if (direct) {
    // Check if the exact match is part of a dual-variant pair (e.g., "X 750ml" → also return "X 180ml")
    for (const [baseName, { inv750, inv180 }] of dualVariantMap.entries()) {
      if (direct.id === inv750?.id) return { primary: inv750, secondary: inv180 ?? null };
      if (direct.id === inv180?.id) return { primary: inv750 ?? direct, secondary: direct };
    }
    return { primary: direct, secondary: null };
  }

  for (const [baseName, { inv750, inv180 }] of dualVariantMap.entries()) {
    if (normalized === baseName || normalized.startsWith(baseName)) {
      return { primary: inv750 ?? null, secondary: inv180 ?? null };
    }
  }

  const stripped = normalized.replace(/\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i, '').trim();
  if (stripped !== normalized) {
    const partialMatch = inventoryByName.get(stripped);
    if (partialMatch) return { primary: partialMatch, secondary: null };
    // Also try matching to a 750ml inventory variant (e.g., "X 180ml" → "X 750ml")
    const variant750 = inventoryByName.get(`${stripped} 750ml`);
    if (variant750) return { primary: variant750, secondary: null };
  }

  // Beer-specific fuzzy match: normalize by removing vowels to handle spelling variations.
  // Only applies to beer items (checked via name keywords). Catches cases like:
  //   "Budweiser Beer" (ordered) → "Budwiser Beer" (inventory)
  //   "Stok Strong Beer" (ordered) → "Stok Storng Beer" (inventory)
  if (nameLooksLikeBeer(normalized)) {
    const normalizedOrdered = normalizeBeerName(normalized);
    for (const [invName, inv] of inventoryByName.entries()) {
      if (!nameLooksLikeBeer(invName)) continue;
      if (normalizeBeerName(invName) === normalizedOrdered) {
        log(`${logPrefix} Beer fuzzy match (vowel-normalized): "${orderedName}" → "${inv.menuItem?.name}"`);
        return { primary: inv, secondary: null };
      }
    }
  }

  for (const [invName, inv] of inventoryByName.entries()) {
    if (invName === normalized) continue;
    if (invName.startsWith(normalized + ' ') || normalized.startsWith(invName + ' ')) {
      log(`${logPrefix} Fuzzy prefix match: "${orderedName}" → "${inv.menuItem?.name}"`);
      return { primary: inv, secondary: null };
    }
  }

  return { primary: null, secondary: null };
}

// ── ml-per-unit computation ──────────────────────────────────────────────────
// Computes the ml to deduct per ordered unit, based on the matched inventory
// item's type (beer / spirit / other) and the order-line price. Mirrors the
// branching that previously lived inline in both deduction paths.
//
// Returns `{ mlPerUnit, variantLabel }`.
export function computeMlPerUnit(
  primaryInv: any,
  itemPrice: number,
  menuItemName: string,
  logPrefix = '[Inventory]',
  log = (msg: string) => {},
): { mlPerUnit: number; variantLabel: string } {
  const isBeer = isBeerItem(primaryInv.menuItem);
  const isSpirit = !isBeer && primaryInv.menuItem.variants.some(
    (v: { name: string }) => v.name.trim().toLowerCase() === '30ml'
  );

  if (isBeer) {
    const variants = primaryInv.menuItem.variants as Array<{ name: string; price: any }>;
    const matchedVariant = variants.find(v => Number(v.price) === itemPrice);
    if (matchedVariant) {
      const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
      const mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? 650 : parsedMl;
      return { mlPerUnit, variantLabel: `${mlPerUnit}ml` };
    }
    return { mlPerUnit: 650, variantLabel: '650ml bottle' };
  }

  if (isSpirit) {
    const variants = primaryInv.menuItem.variants as Array<{ name: string; price: any }>;
    const matchedVariant = variants.find(v => Number(v.price) === itemPrice);
    if (matchedVariant) {
      const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
      const mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? BAR_UNIT_ML : parsedMl;
      return { mlPerUnit, variantLabel: `${mlPerUnit}ml` };
    }
    // Fallback: try to parse ml from the ordered item name (e.g., "X 180Ml" → 180)
    const nameMlMatch = menuItemName.match(/(\d+)\s*ml/i);
    if (nameMlMatch) {
      const mlPerUnit = parseInt(nameMlMatch[1], 10);
      log(`${logPrefix} No variant price match for ${primaryInv.menuItem.name} at ₹${itemPrice}, parsed ${mlPerUnit}ml from ordered name "${menuItemName}"`);
      return { mlPerUnit, variantLabel: `${mlPerUnit}ml (from name)` };
    }
    log(`${logPrefix} No variant price match for ${primaryInv.menuItem.name} at ₹${itemPrice}, defaulting to ${BAR_UNIT_ML}ml`);
    return { mlPerUnit: BAR_UNIT_ML, variantLabel: `${BAR_UNIT_ML}ml (unmatched price ₹${itemPrice})` };
  }

  // Other (bottle-based) items: use the inventory item's bottleSize.
  return { mlPerUnit: Number(primaryInv.bottleSize), variantLabel: 'bottle' };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL MENU → INVENTORY MATCHER
// ─────────────────────────────────────────────────────────────────────────────
// Resolves any menu item to the correct inventory bottle using a 3-tier
// priority system:
//
//   1. DIRECT   — menu item's ID directly links to an inventory item
//   2. MAPPING  — BarItemMapping table has an explicit row
//   3. BASE_NAME — product base name match with size awareness
//
// Key principle: the MENU ITEM SIZE (the pour/serving size) determines how
// many ML to deduct. The INVENTORY BOTTLE SIZE determines which bottle to
// deduct FROM. These are independent:
//
//   Menu: "Mansion House 30ml"  →  deduct 30ml
//   Inventory: "Mansion House 750ml" (bottle=750ml)  →  from this bottle
//
//   Menu: "Mansion House 180ml" →  deduct 180ml
//   Inventory: "Mansion House 180ml" (bottle=180ml)  →  from this bottle
//
// When multiple inventory bottles exist for the same product, the matcher
// prefers an exact size match, then falls back to the largest bottle as
// primary (with the smaller as secondary for spill-over).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse ML quantity from an item name.
 * Handles: "30ML", "30ml", "750 Ml", "1LTR", "1L", "650ml", "600 Ml", etc.
 * Returns null if no size can be determined.
 */
export function parseMlFromName(name: string): number | null {
  if (!name) return null;
  // Handle "1LTR", "1L", "1 Ltr", "1Litre", "1 Liter"
  const ltrMatch = name.match(/(\d+)\s*l(?:tr|itre|iter)?\b/i);
  if (ltrMatch) return parseInt(ltrMatch[1], 10) * 1000;
  // Handle "650ML", "30ml", "750 Ml", etc.
  const mlMatch = name.match(/(\d+)\s*ml\b/i);
  if (mlMatch) return parseInt(mlMatch[1], 10);
  return null;
}

/**
 * Normalize an item name to its base product name (without size suffixes).
 * Example: "Mansion House 30ml" → "mansion house"
 *          "KF Strong Beer 650ML" → "kf strong beer"
 *          "Kinley Water Bottle 1LTR" → "kinley water bottle"
 */
export function normalizeProductBaseName(name: string): string {
  return name.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')           // remove parenthetical
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ') // remove size
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Known size variants for spirits/liquor served by peg.
 */
const KNOWN_PEG_SIZES = [30, 60, 90, 180, 375, 750];

/**
 * Result of the universal menu→inventory resolution.
 */
export interface MenuInventoryMatch {
  primary: any | null;
  secondary: any | null;
  mlPerUnit: number;
  variantLabel: string;
  matchMethod: 'DIRECT' | 'MAPPING' | 'BASE_NAME' | 'BEER_FUZZY' | 'NONE';
  menuSize: number | null;
  primaryBottleSize: number | null;
}

/**
 * Build an index of inventory items by base product name.
 * Returns a Map from normalized base name → array of inventory items.
 */
export function buildInventoryByBaseName(allInventoryItems: any[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const inv of allInventoryItems) {
    const name = inv.menuItem?.name || '';
    const base = normalizeProductBaseName(name);
    if (!base) continue;
    const arr = map.get(base) || [];
    arr.push(inv);
    map.set(base, arr);
  }
  return map;
}

/**
 * Pick the best primary and secondary inventory items from a list of
 * candidates that share the same base product name.
 *
 * Selection rules:
 *   1. If the menu size exactly matches an inventory bottle size, use that
 *      bottle as primary.
 *   2. Otherwise, use the largest bottle as primary and the next largest
 *      as secondary (for spill-over when primary runs out).
 *   3. For beer items, prefer the bottle whose size matches the menu size
 *      or the first candidate.
 */
function pickBestInventory(
  candidates: any[],
  menuSize: number | null,
  isBeer: boolean,
): { primary: any | null; secondary: any | null } {
  if (candidates.length === 0) return { primary: null, secondary: null };
  if (candidates.length === 1) return { primary: candidates[0], secondary: null };

  // Try exact size match
  if (menuSize) {
    const exact = candidates.find(c => Number(c.bottleSize) === menuSize);
    if (exact) {
      // Secondary = a different bottle size of the same product
      const others = candidates.filter(c => c.id !== exact.id);
      const secondary = others.length > 0
        ? others.sort((a, b) => Number(b.bottleSize) - Number(a.bottleSize))[0]
        : null;
      return { primary: exact, secondary };
    }
  }

  // No exact match — sort by bottle size descending (largest = primary)
  const sorted = [...candidates].sort((a, b) => Number(b.bottleSize) - Number(a.bottleSize));

  // For beer, prefer matching the menu size to the closest bottle
  if (isBeer && menuSize) {
    const closest = sorted.find(c => Number(c.bottleSize) >= menuSize) || sorted[0];
    const others = sorted.filter(c => c.id !== closest.id);
    return {
      primary: closest,
      secondary: others.length > 0 ? others[0] : null,
    };
  }

  // For spirits: largest bottle as primary, next as secondary
  return {
    primary: sorted[0],
    secondary: sorted.length > 1 ? sorted[1] : null,
  };
}

/**
 * Universal menu→inventory resolver.
 *
 * Given a menu item (id, name, price) and the full set of inventory items,
 * resolves to:
 *   - primary inventory item (the bottle to deduct from)
 *   - secondary inventory item (spill-over bottle, if any)
 *   - mlPerUnit (how many ML to deduct per ordered unit)
 *   - matchMethod (how the match was found)
 *
 * Priority:
 *   1. DIRECT   — inventory item.menuItemId === menu item id
 *   2. MAPPING  — BarItemMapping table row for (menuItemId, variantPrice)
 *   3. BASE_NAME — normalized product name match with size awareness
 *   4. BEER_FUZZY — vowel-normalized beer name match (beer only)
 *
 * mlPerUnit is ALWAYS derived from the MENU ITEM's size (parsed from name
 * or variant), never from the inventory bottle size. This ensures:
 *   "Mansion House 30ml" → deduct 30ml (from whatever bottle is in stock)
 *   "Mansion House 180ml" → deduct 180ml
 *   "Whisky X 750ml" → deduct 750ml
 */
export function resolveMenuToInventory(
  menuItemId: string,
  menuItemName: string,
  itemPrice: number,
  allInventoryItems: any[],
  options: {
    mappings?: Map<string, any>;       // menuItemId:variantPrice → mapping
    logPrefix?: string;
    log?: (msg: string) => void;
  } = {},
): MenuInventoryMatch {
  const logPrefix = options.logPrefix || '[Inventory]';
  const log = options.log || (() => {});
  const menuSize = parseMlFromName(menuItemName);
  const normalized = menuItemName.toLowerCase().trim();

  // ── Priority 1: DIRECT menuItemId link ──────────────────────────────
  const directInvs = allInventoryItems.filter(
    inv => inv.menuItemId === menuItemId
  );
  if (directInvs.length > 0) {
    const beer = isBeerItem(directInvs[0].menuItem);
    const { primary, secondary } = pickBestInventory(directInvs, menuSize, beer);
    if (primary) {
      const mlPerUnit = computeServeMl(menuSize, itemPrice, primary, menuItemName, logPrefix, log);
      log(`${logPrefix} DIRECT match: "${menuItemName}" → "${primary.menuItem?.name}" (bottle=${primary.bottleSize}ml), deduct ${mlPerUnit}ml/unit`);
      return {
        primary,
        secondary,
        mlPerUnit,
        variantLabel: `${mlPerUnit}ml`,
        matchMethod: 'DIRECT',
        menuSize,
        primaryBottleSize: Number(primary.bottleSize),
      };
    }
  }

  // ── Priority 2: BarItemMapping table ────────────────────────────────
  if (options.mappings) {
    const mapping = options.mappings.get(`${menuItemId}:${itemPrice}`);
    if (mapping) {
      const primary = allInventoryItems.find(i => i.id === mapping.primaryInvId) ?? null;
      const secondary = mapping.secondaryInvId
        ? allInventoryItems.find(i => i.id === mapping.secondaryInvId) ?? null
        : null;
      if (primary) {
        // Use mapping's mlPerUnit, but verify against menu size.
        // If the mapping's mlPerUnit doesn't match the menu size, prefer
        // the menu size (the mapping may have been created with a wrong value).
        let mlPerUnit = Number(mapping.mlPerUnit);
        if (menuSize && menuSize !== mlPerUnit) {
          log(`${logPrefix} MAPPING mlPerUnit correction: mapping says ${mlPerUnit}ml, menu name says ${menuSize}ml — using ${menuSize}ml from menu name`);
          mlPerUnit = menuSize;
        }
        if (!menuSize && mlPerUnit <= 0) {
          mlPerUnit = computeServeMl(null, itemPrice, primary, menuItemName, logPrefix, log);
        }
        log(`${logPrefix} MAPPING match: "${menuItemName}" → "${primary.menuItem?.name}" (bottle=${primary.bottleSize}ml), deduct ${mlPerUnit}ml/unit`);
        return {
          primary,
          secondary,
          mlPerUnit,
          variantLabel: `${mlPerUnit}ml`,
          matchMethod: 'MAPPING',
          menuSize,
          primaryBottleSize: Number(primary.bottleSize),
        };
      }
    }
  }

  // ── Priority 3: BASE_NAME matching ──────────────────────────────────
  const invByBaseName = buildInventoryByBaseName(allInventoryItems);
  const baseName = normalizeProductBaseName(menuItemName);
  const candidates = invByBaseName.get(baseName);
  if (candidates && candidates.length > 0) {
    const beer = nameLooksLikeBeer(normalized);
    const { primary, secondary } = pickBestInventory(candidates, menuSize, beer);
    if (primary) {
      const mlPerUnit = computeServeMl(menuSize, itemPrice, primary, menuItemName, logPrefix, log);
      log(`${logPrefix} BASE_NAME match: "${menuItemName}" → "${primary.menuItem?.name}" (bottle=${primary.bottleSize}ml), deduct ${mlPerUnit}ml/unit`);
      return {
        primary,
        secondary,
        mlPerUnit,
        variantLabel: `${mlPerUnit}ml`,
        matchMethod: 'BASE_NAME',
        menuSize,
        primaryBottleSize: Number(primary.bottleSize),
      };
    }
  }

  // ── Priority 4: BEER_FUZZY (beer spelling variations) ───────────────
  if (nameLooksLikeBeer(normalized)) {
    const normalizedOrdered = normalizeBeerName(normalized);
    for (const inv of allInventoryItems) {
      const invName = (inv.menuItem?.name || '').toLowerCase().trim();
      if (!nameLooksLikeBeer(invName)) continue;
      if (normalizeBeerName(invName) === normalizedOrdered) {
        const mlPerUnit = computeServeMl(menuSize, itemPrice, inv, menuItemName, logPrefix, log);
        log(`${logPrefix} BEER_FUZZY match: "${menuItemName}" → "${inv.menuItem?.name}" (bottle=${inv.bottleSize}ml), deduct ${mlPerUnit}ml/unit`);
        return {
          primary: inv,
          secondary: null,
          mlPerUnit,
          variantLabel: `${mlPerUnit}ml`,
          matchMethod: 'BEER_FUZZY',
          menuSize,
          primaryBottleSize: Number(inv.bottleSize),
        };
      }
    }
  }

  // ── No match found ──────────────────────────────────────────────────
  return {
    primary: null,
    secondary: null,
    mlPerUnit: 0,
    variantLabel: 'unmapped',
    matchMethod: 'NONE',
    menuSize,
    primaryBottleSize: null,
  };
}

/**
 * Compute the serve ML (how many ML to deduct per ordered unit).
 *
 * Priority:
 *   1. Parse from the MENU ITEM name (e.g., "Mansion House 30ml" → 30)
 *   2. Match variant price → parse ML from variant name
 *   3. For beer: parse from variant name or default to bottle size
 *   4. For spirits with no size: default to BAR_UNIT_ML (30ml peg)
 *   5. For other items: use inventory bottle size
 */
function computeServeMl(
  menuSize: number | null,
  itemPrice: number,
  primaryInv: any,
  menuItemName: string,
  logPrefix: string,
  log: (msg: string) => void,
): number {
  // 1. Menu name has explicit size — always use it
  if (menuSize && menuSize > 0) return menuSize;

  const beer = isBeerItem(primaryInv.menuItem);

  // 2. Try variant price match
  const variants = (primaryInv.menuItem?.variants || []) as Array<{ name: string; price: any }>;
  const matchedVariant = variants.find(v => Number(v.price) === itemPrice);
  if (matchedVariant) {
    const parsedMl = parseMlFromName(matchedVariant.name);
    if (parsedMl && parsedMl > 0) return parsedMl;
    // Variant name might have just a number
    const numMatch = matchedVariant.name.match(/(\d+)/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n > 0) return n;
    }
  }

  // 3. Try parsing from the menu item name again (broader patterns)
  const nameMl = parseMlFromName(menuItemName);
  if (nameMl && nameMl > 0) return nameMl;

  // 4. Beer: default to bottle size
  if (beer) {
    const bottleSize = Number(primaryInv.bottleSize);
    return bottleSize > 0 ? bottleSize : 650;
  }

  // 5. Spirit with no size info: default to 30ml peg
  const has30mlVariant = variants.some(v => {
    const vn = (v.name || '').trim().toLowerCase();
    return vn === '30ml' || vn === '30 ml';
  });
  if (has30mlVariant) return BAR_UNIT_ML;

  // 6. Other items: use bottle size
  const bottleSize = Number(primaryInv.bottleSize);
  return bottleSize > 0 ? bottleSize : BAR_UNIT_ML;
}

export { BAR_UNIT_ML, KNOWN_PEG_SIZES };
