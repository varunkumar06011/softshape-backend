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
