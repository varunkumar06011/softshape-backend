// ─────────────────────────────────────────────────────────────────────────────
// Item Helpers — Menu item classification and type detection utilities
// ─────────────────────────────────────────────────────────────────────────────
// Provides helper functions for classifying menu items, primarily used to
// distinguish beer items from other liquor items (beer uses different
// inventory tracking logic — sold by bottle rather than by peg).
//
// Functions:
//   isBeerItem(item) — checks if a menu item is beer based on category or name
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Utility functions for menu item classification and handling
 */

/**
 * Checks if a menu item is beer based on category or name.
 * Beer items are tracked differently in bar inventory (bottle-based vs peg-based).
 * @param item - MenuItem with category and name fields
 * @returns true if item is beer
 */
export function isBeerItem(item: any): boolean {
  if (!item) return false;

  // Get category - handle nested category object or direct string
  const categoryObj = item.category;
  let category = '';

  if (categoryObj && typeof categoryObj === 'object' && 'name' in categoryObj) {
    category = String(categoryObj.name || '').toLowerCase();
  } else if (typeof categoryObj === 'string') {
    category = categoryObj.toLowerCase();
  }

  // Check category first
  if (category.includes('beer')) return true;

  // Get name
  const name = String(item.name || '').toLowerCase();

  // Check name for beer keywords
  const beerKeywords = [
    'beer', 'lager', 'ale', 'bira', 'carlsberg', 'budweiser',
    'kingfisher', 'kf', 'coolberg', 'stok', 'draught'
  ];

  return beerKeywords.some(keyword => name.includes(keyword));
}

/**
 * Spirit categories — items sold in 30ml pegs from full (750ml) bottles.
 * 180ml items are excluded (sold as half-bottles, not pegs).
 */
const SPIRIT_CATEGORIES = [
  'brandy', 'whisky', 'whiskey', 'rum', 'vodka', 'wine', 'gin',
  'tequila', 'scotch', 'liquor', 'spirit',
];

/**
 * Checks if a menu item is a spirit (sold in 30ml pegs).
 * Spirits use peg-based consumption: unitCost = purchaseCost × 30 / 750.
 * 180ml items are NOT peg-based — they are sold as half-bottles.
 * @param item - MenuItem with category, name, and variants
 * @param bottleSize - bottle size in ml (optional, from InventoryItem)
 * @returns true if item is a spirit sold in pegs
 */
export function isSpiritItem(item: any, bottleSize?: number): boolean {
  if (!item) return false;
  // Beer is never a spirit
  if (isBeerItem(item)) return false;

  // 180ml items are half-bottles, not peg-based
  if (bottleSize != null && bottleSize === 180) return false;

  // Check for 30ml variant (strong signal of peg-based selling)
  const variants = item.variants || [];
  if (variants.some((v: any) => v.name.trim().toLowerCase() === '30ml')) return true;

  // 30ml/60ml/90ml items are pegs
  if (bottleSize != null && bottleSize <= 60) return true;

  // Check category for spirit categories
  const categoryObj = item.category;
  let category = '';
  if (categoryObj && typeof categoryObj === 'object' && 'name' in categoryObj) {
    category = String(categoryObj.name || '').toLowerCase();
  } else if (typeof categoryObj === 'string') {
    category = categoryObj.toLowerCase();
  }
  // Only treat as spirit if bottleSize >= 375 (full or near-full bottles
  // that pegs are poured from). 180ml is already excluded above.
  if (bottleSize != null && bottleSize < 375 && bottleSize > 60) return false;
  return SPIRIT_CATEGORIES.some(cat => category.includes(cat));
}
