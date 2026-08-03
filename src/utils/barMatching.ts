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

export { BAR_UNIT_ML };
