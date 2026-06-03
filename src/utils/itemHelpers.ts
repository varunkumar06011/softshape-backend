/**
 * Utility functions for menu item classification and handling
 */

/**
 * Checks if a menu item is beer based on category or name
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
