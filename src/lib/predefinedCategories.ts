// ─────────────────────────────────────────────────────────────────────────────
// Predefined Categories — Food and Liquor category lists
// ─────────────────────────────────────────────────────────────────────────────
// Provides predefined category names for food and liquor menus.
// Used during onboarding and AI menu generation to suggest categories
// that the restaurant owner can select from, rather than typing custom names.
//
// FOOD_CATEGORIES: 22 common Indian restaurant food categories
// LIQUOR_CATEGORIES: 15 common bar/liquor categories
// ALL_CATEGORIES: combined list for restaurants that serve both food and liquor
//
// buildCategoryListForPrompt(): generates a text list of categories for the
// AI menu generation prompt, including liquor categories only for bar-type restaurants.
// ─────────────────────────────────────────────────────────────────────────────

// Standard food categories for Indian restaurants
export const FOOD_CATEGORIES = [
  'Soups',
  'Starters (Veg)',
  'Starters (Non-Veg)',
  'Breads',
  'Main Course (Veg)',
  'Main Course (Non-Veg)',
  'Biryani & Rice',
  'Noodles & Chinese',
  'Seafood',
  'Desserts',
  'Beverages',
  'Salads',
  'Accompaniments',
  'Tandoori',
  'South Indian',
  'Curries (Veg)',
  'Curries (Non-Veg)',
  'Roti & Paratha',
  'Fried Rice & Noodles',
  'Breakfast',
  'Combos',
  'Thali',
];

// Standard liquor/bar categories
export const LIQUOR_CATEGORIES = [
  'Beer',
  'Whisky',
  'Vodka',
  'Rum',
  'Gin',
  'Brandy',
  'Wine',
  'Champagne',
  'Cocktails & Mocktails',
  'Shots',
  'Liqueurs',
  'Spirits',
  'Soft Drinks',
  'Water',
  'Juices',
];

// Combined list of all predefined categories (food + liquor)
export const ALL_CATEGORIES = [...FOOD_CATEGORIES, ...LIQUOR_CATEGORIES];

// Builds a category list string for the AI menu generation prompt.
// For bar-type restaurants (BAR_LOUNGE, BAR_WITH_DINING), includes both food
// and liquor categories. For other types, includes only food categories.
//
// Parameters:
//   restaurantType — one of the restaurant types from moduleDefaults
// Returns: a formatted string listing categories for the AI prompt.
export function buildCategoryListForPrompt(restaurantType?: string): string {
  const isBarType = restaurantType === 'BAR_LOUNGE' || restaurantType === 'BAR_WITH_DINING';
  const food = FOOD_CATEGORIES.join(', ');
  const liquor = LIQUOR_CATEGORIES.join(', ');
  if (isBarType) {
    return `FOOD categories: ${food}\nLIQUOR categories: ${liquor}`;
  }
  return `Categories: ${food}`;
}
