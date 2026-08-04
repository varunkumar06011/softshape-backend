import prismaClient, { basePrisma } from "../lib/prisma";
import { resolveKitchenRestaurantId } from "../lib/tenantContext";
import { findDishRecipe, isBonelessItem, isHalfPortion, isFullPortion } from "./dishRecipes";

type ExtendedPrisma = typeof prismaClient;

// ─────────────────────────────────────────────────────────────────────────────
// Recipe Engine — Standard Indian restaurant recipe generation
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the old AI-based recipe suggestion flow with a deterministic,
// rule-based engine that generates ingredient recipes for food menu items.
//
// Exports:
//   MASTER_INGREDIENTS  — 55 standard Indian restaurant ingredients
//   generateRecipe()    — rule-based recipe generation from item name/category
//   getExpectedUnit()   — unit lookup for validation
//   runAutoGenerate()   — shared core logic for seed script + API route
// ─────────────────────────────────────────────────────────────────────────────

export interface MasterIngredient {
  name: string;
  unit: "g" | "ml" | "pcs";
  defaultStock: number;
  reorderLevel: number;
}

// 55 standard Indian restaurant ingredients in smallest practical units (g/ml/pcs).
export const MASTER_INGREDIENTS: MasterIngredient[] = [
  // Proteins
  { name: "Chicken", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Mutton", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Fish", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Prawns", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Egg", unit: "pcs", defaultStock: 200, reorderLevel: 50 },
  { name: "Paneer", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  // Vegetables
  { name: "Onion", unit: "g", defaultStock: 10000, reorderLevel: 2000 },
  { name: "Tomato", unit: "g", defaultStock: 10000, reorderLevel: 2000 },
  { name: "Potato", unit: "g", defaultStock: 10000, reorderLevel: 2000 },
  { name: "Cauliflower", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Capsicum", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Carrot", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Green Peas", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Spinach", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Cabbage", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Mushroom", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Baby Corn", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  { name: "French Beans", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Lady Finger", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Brinjal", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  // Dairy & Fats
  { name: "Ghee", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  { name: "Butter", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  { name: "Cream", unit: "ml", defaultStock: 2000, reorderLevel: 500 },
  { name: "Curd", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Milk", unit: "ml", defaultStock: 10000, reorderLevel: 2000 },
  // Dry Spices & Powders
  { name: "Turmeric Powder", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Red Chilli Powder", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Coriander Powder", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Cumin Powder", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Garam Masala", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Biryani Masala", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  { name: "Cumin Seeds", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Mustard Seeds", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Salt", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  { name: "Black Pepper", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Kasuri Methi", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Saffron", unit: "g", defaultStock: 100, reorderLevel: 20 },
  // Aromatics & Herbs
  { name: "Ginger", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  { name: "Garlic", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  { name: "Green Chilli", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  { name: "Coriander Leaves", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  { name: "Mint Leaves", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  { name: "Curry Leaves", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Green Cardamom", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Cloves", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Cinnamon", unit: "g", defaultStock: 500, reorderLevel: 100 },
  { name: "Bay Leaf", unit: "g", defaultStock: 500, reorderLevel: 100 },
  // Grains & Flours
  { name: "Basmati Rice", unit: "g", defaultStock: 20000, reorderLevel: 5000 },
  { name: "Maida", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Atta", unit: "g", defaultStock: 10000, reorderLevel: 2000 },
  { name: "Besan", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Cornflour", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  // Oils & Sauces
  { name: "Cooking Oil", unit: "ml", defaultStock: 10000, reorderLevel: 2000 },
  { name: "Soya Sauce", unit: "ml", defaultStock: 2000, reorderLevel: 500 },
  { name: "Schezwan Sauce", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  // Misc
  { name: "Sugar", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Cashews", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  // Additional ingredients for broader coverage
  { name: "Noodles", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Lemon", unit: "pcs", defaultStock: 200, reorderLevel: 50 },
  { name: "Cucumber", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Sweet Corn", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Ice Cream", unit: "g", defaultStock: 3000, reorderLevel: 500 },
  { name: "Chocolate", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  { name: "Coconut", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  // Additional ingredients for per-dish recipes
  { name: "Toor Dal", unit: "g", defaultStock: 5000, reorderLevel: 1000 },
  { name: "Tamarind", unit: "g", defaultStock: 1000, reorderLevel: 200 },
  { name: "Vinegar", unit: "ml", defaultStock: 1000, reorderLevel: 200 },
  { name: "Gongura", unit: "g", defaultStock: 2000, reorderLevel: 500 },
  { name: "Semolina", unit: "g", defaultStock: 2000, reorderLevel: 500 },
];

// Pre-build a name→unit map for O(1) lookup.
const INGREDIENT_UNIT_MAP = new Map<string, string>(
  MASTER_INGREDIENTS.map((i) => [i.name, i.unit]),
);

/** Returns the expected unit (g/ml/pcs) for a master ingredient name, or "" if not found. */
export function getExpectedUnit(ingredientName: string): string {
  return INGREDIENT_UNIT_MAP.get(ingredientName) ?? "";
}

// ── Category base templates ──────────────────────────────────────────────────
// Each base is a list of [ingredientName, quantityInGramsOrMl].
type IngredientEntry = [string, number];

const CATEGORY_BASES: Record<string, IngredientEntry[]> = {
  soups: [
    ["Onion", 50], ["Garlic", 10], ["Ginger", 10], ["Cooking Oil", 15],
    ["Cornflour", 10], ["Soya Sauce", 10], ["Salt", 5], ["Green Chilli", 5],
  ],
  starters: [
    ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5],
    ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3],
    ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cornflour", 15],
  ],
  biryani: [
    ["Basmati Rice", 250], ["Onion", 75], ["Tomato", 50], ["Ginger", 10],
    ["Garlic", 10], ["Cooking Oil", 20], ["Ghee", 15], ["Turmeric Powder", 3],
    ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cumin Powder", 5],
    ["Garam Masala", 5], ["Cumin Seeds", 3], ["Bay Leaf", 2],
    ["Cinnamon", 2], ["Green Cardamom", 3], ["Cloves", 2], ["Salt", 8], ["Curd", 30],
  ],
  "fried rice": [
    ["Basmati Rice", 200], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30],
    ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10],
    ["Salt", 5], ["Garlic", 10], ["Ginger", 5],
  ],
  noodles: [
    ["Noodles", 150], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30],
    ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10],
    ["Garlic", 10], ["Ginger", 5], ["Salt", 5],
  ],
  rice: [
    ["Basmati Rice", 200], ["Cooking Oil", 10], ["Cumin Seeds", 3],
    ["Salt", 5], ["Turmeric Powder", 2],
  ],
  curries: [
    ["Onion", 75], ["Tomato", 75], ["Ginger", 10], ["Garlic", 10],
    ["Cooking Oil", 20], ["Turmeric Powder", 3], ["Red Chilli Powder", 5],
    ["Coriander Powder", 5], ["Cumin Powder", 5], ["Garam Masala", 5],
    ["Cumin Seeds", 3], ["Salt", 8], ["Curd", 20],
  ],
  "indian breads": [
    ["Atta", 80], ["Salt", 2],
  ],
  tandoori: [
    ["Curd", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3],
    ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Cooking Oil", 15],
    ["Salt", 5],
  ],
  "ice cream": [
    ["Milk", 150], ["Cream", 30], ["Sugar", 20],
  ],
  "milkshakes & lassi": [
    ["Milk", 150], ["Curd", 50], ["Sugar", 20],
  ],
  // ── Additional category templates for broader coverage ──
  "breads": [
    ["Atta", 80], ["Salt", 2],
  ],
  "main course": [
    ["Onion", 75], ["Tomato", 75], ["Ginger", 10], ["Garlic", 10],
    ["Cooking Oil", 20], ["Turmeric Powder", 3], ["Red Chilli Powder", 5],
    ["Coriander Powder", 5], ["Cumin Powder", 5], ["Garam Masala", 5],
    ["Cumin Seeds", 3], ["Salt", 8], ["Curd", 20],
  ],
  "desserts": [
    ["Milk", 100], ["Sugar", 20],
  ],
  "beverages": [
    ["Milk", 150], ["Sugar", 20],
  ],
  "soft drinks": [
    ["Sugar", 10],
  ],
  "salads": [
    ["Onion", 50], ["Tomato", 50], ["Cucumber", 50], ["Salt", 3],
  ],
  "accompaniments": [
    ["Curd", 100], ["Salt", 3],
  ],
  "seafood": [
    ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5],
    ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3],
    ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cornflour", 15],
  ],
};

export type BulkScalingType = "linear" | "spice" | "salt";
export interface ChickenBiryaniIngredient {
  ingredientName: string;
  perParcelQty: number; // grams (or pcs for Egg), for 1 Full plate/parcel
  scalingType: BulkScalingType;
}

// Shared base ingredients for all biryani protein types (keeps them in sync).
const BIRYANI_BASE_INGREDIENTS: ChickenBiryaniIngredient[] = [
  { ingredientName: "Basmati Rice", perParcelQty: 200, scalingType: "linear" },
  { ingredientName: "Cooking Oil", perParcelQty: 40, scalingType: "linear" },
  { ingredientName: "Ghee", perParcelQty: 6, scalingType: "linear" },
  { ingredientName: "Onion", perParcelQty: 20, scalingType: "linear" },
  { ingredientName: "Ginger", perParcelQty: 2, scalingType: "linear" },
  { ingredientName: "Garlic", perParcelQty: 2, scalingType: "linear" },
  { ingredientName: "Curd", perParcelQty: 40, scalingType: "linear" },
  { ingredientName: "Red Chilli Powder", perParcelQty: 0.8, scalingType: "spice" },
  { ingredientName: "Turmeric Powder", perParcelQty: 0.4, scalingType: "spice" },
  { ingredientName: "Garam Masala", perParcelQty: 1.6, scalingType: "spice" },
  { ingredientName: "Green Cardamom", perParcelQty: 0.6, scalingType: "spice" },
  { ingredientName: "Biryani Masala", perParcelQty: 2, scalingType: "spice" },
  { ingredientName: "Salt", perParcelQty: 20, scalingType: "salt" },
];

const PROTEIN_CONFIG: Record<string, { ingredientName: string; perParcelQty: number }> = {
  chicken: { ingredientName: "Chicken", perParcelQty: 160 },
  egg:     { ingredientName: "Egg",     perParcelQty: 3 },   // pcs, not grams
  mutton:  { ingredientName: "Mutton",  perParcelQty: 150 },
  prawns:  { ingredientName: "Prawns",  perParcelQty: 180 },
  fish:    { ingredientName: "Fish",    perParcelQty: 150 },
};

function buildBiryaniRecipe(protein: keyof typeof PROTEIN_CONFIG): ChickenBiryaniIngredient[] {
  const p = PROTEIN_CONFIG[protein];
  return [
    { ingredientName: p.ingredientName, perParcelQty: p.perParcelQty, scalingType: "linear" },
    ...BIRYANI_BASE_INGREDIENTS,
  ];
}

export const CHICKEN_BIRYANI_RECIPE = buildBiryaniRecipe("chicken");
export const EGG_BIRYANI_RECIPE     = buildBiryaniRecipe("egg");
export const MUTTON_BIRYANI_RECIPE  = buildBiryaniRecipe("mutton");
export const PRAWNS_BIRYANI_RECIPE  = buildBiryaniRecipe("prawns");
export const FISH_BIRYANI_RECIPE    = buildBiryaniRecipe("fish");

// Mixed biryani: 1/4 quantity of each protein per parcel.
export const MIXED_BIRYANI_RECIPE: ChickenBiryaniIngredient[] = [
  { ingredientName: "Chicken", perParcelQty: 40, scalingType: "linear" },
  { ingredientName: "Mutton", perParcelQty: 37.5, scalingType: "linear" },
  { ingredientName: "Fish", perParcelQty: 37.5, scalingType: "linear" },
  { ingredientName: "Prawns", perParcelQty: 45, scalingType: "linear" },
  ...BIRYANI_BASE_INGREDIENTS,
];

export const CHICKEN_BIRYANI_ITEMS: string[] = [
  "Chicken Dum Biryani", "Chicken Fry Piece Biryani", "Boneless Chicken Biryani",
  "Lollipop Biryani", "Mughlai Chicken Biryani", "Ulavacharu Chicken Biryani",
  "Pachimirchi Chicken Biryani", "Kona Seema Chicken Biryani",
  "OG Gongura Chicken Biryani", "Rangamma Gari Kodi Biryani",
  "Raju Gari Kodi Biryani", "Sultani Chicken Biryani", "Rambo Biryani",
  "Dilkhush Biryani", "Ajantha Biryani", "Tikka Biryani", "Tandoori Biryani",
  "Mirchi Bajji Biryani",
  // Vgrand Lounge variants
  "AVAKAYA CHICKEN BIRYANI B/L", "AVAKAYA CHICKEN BIRYANI BONES",
  "GONGURA CHICKEN BIRYANI BONES", "Natu Kodi Biryani",
  "RAJU GARI CHICKEN BIRYANI", "Rayalaseema Chicken Biryani",
  "Todat Spl Chicken Biryani", "Today Spl Chicken Biryani",
  "Chicken Dum Biryani Family Pack", "Sp Biryani Family Pack", "DILKUSH BIRYANI B/L",
  "MOGHALAI CHICKEN BIRYAI B/L",
  // Vgrand Family Restaurant variants
  "Chicken boneless biryani family pack", "Chicken dum family pack",
  "Chicken fry piece family pack", "MUGHULAI CHICKEN BIRYANI",
  "KONASEEMA CHICKEN BIRYANI", "Pahadi Chicken Biryani",
  "POT BIRYANI", "RAJU GRAI KODI BIRYANI", "SULTAN CHICKEN BIRYANI",
  "Today Spl Kheema Biryani",
];

export const EGG_BIRYANI_ITEMS: string[] = [
  "Egg Biryani",
];

export const MUTTON_BIRYANI_ITEMS: string[] = [
  "Mutton Dum Biryani", "Mutton Fry Biryani", "Mutton Kheema Biryani",
  "Military Mutton Biryani", "Mutton Shahi Gosh Biryani",
  // Vgrand Lounge variants
  "Nalli Gosht Mutton Biryani 1 Piece", "Nalli Gosht Mutton Biryani 2 Pieces",
  "ULAVACHARU MUTTON BIRYANI",
  "GONGURA MUTTON BIRYANI",
  "Mutton Fry Biryani Family Pack", "MUTTON FRY PICE BIRYANI",
  "MUTTON KEEMA BIRYANI", "Mutton Ghee Roast Biryani",
  // Vgrand Family Restaurant variants
  "MILITARY MUTTON BIRYANI", "Today Spl Mutton Biryani",
  "MUTTON FRY PIECE BIRYANI",
];

export const PRAWNS_BIRYANI_ITEMS: string[] = [
  "Prawns Biryani", "Raju Gari Royyala Biryani",
  // Vgrand Lounge variants
  "Gongura Prawns Biryani", "Today Spl Prawns Biryani",
];

export const FISH_BIRYANI_ITEMS: string[] = [
  "Fish Biryani",
  // Vgrand Lounge variants
  "Today Spl Fish Biryani",
];

export const MIXED_BIRYANI_ITEMS: string[] = [
  "Mixed Non Veg Biryani",
  "MIXED NON VEG BIRYANI",
];

const PROTEIN_ITEM_SETS: Record<string, Set<string>> = {
  chicken: new Set(CHICKEN_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  egg:     new Set(EGG_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  mutton:  new Set(MUTTON_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  prawns:  new Set(PRAWNS_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  fish:    new Set(FISH_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  mixed:   new Set(MIXED_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
};

export const PROTEIN_RECIPE_MAP: Record<string, ChickenBiryaniIngredient[]> = {
  chicken: CHICKEN_BIRYANI_RECIPE,
  egg: EGG_BIRYANI_RECIPE,
  mutton: MUTTON_BIRYANI_RECIPE,
  prawns: PRAWNS_BIRYANI_RECIPE,
  fish: FISH_BIRYANI_RECIPE,
  mixed: MIXED_BIRYANI_RECIPE,
};

// ── Name pattern rules (case-insensitive substring match) ────────────────────
const NAME_PATTERNS: { patterns: string[]; ingredients: IngredientEntry[] }[] = [
  { patterns: ["chicken"], ingredients: [["Chicken", 150]] },
  { patterns: ["mutton"], ingredients: [["Mutton", 150]] },
  { patterns: ["fish"], ingredients: [["Fish", 150]] },
  { patterns: ["prawn"], ingredients: [["Prawns", 150]] },
  { patterns: ["paneer"], ingredients: [["Paneer", 100]] },
  { patterns: ["aloo"], ingredients: [["Potato", 100]] },
  { patterns: ["gobi"], ingredients: [["Cauliflower", 150]] },
  { patterns: ["manchurian"], ingredients: [["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40]] },
  { patterns: ["schezwan"], ingredients: [["Schezwan Sauce", 15], ["Garlic", 10], ["Ginger", 5]] },
  { patterns: ["65"], ingredients: [["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15]] },
  { patterns: ["kadai"], ingredients: [["Capsicum", 40], ["Coriander Powder", 5], ["Red Chilli Powder", 5]] },
  { patterns: ["shahi", "kurma", "korma"], ingredients: [["Cream", 30], ["Cashews", 15], ["Ghee", 10]] },
  { patterns: ["malai"], ingredients: [["Cream", 30], ["Ghee", 10]] },
  { patterns: ["kofta"], ingredients: [["Besan", 20], ["Cashews", 10]] },
  { patterns: ["mughlai"], ingredients: [["Cream", 30], ["Cashews", 15], ["Ghee", 10], ["Garam Masala", 5]] },
  { patterns: ["afghani"], ingredients: [["Cream", 30], ["Cashews", 15], ["Ghee", 10]] },
  { patterns: ["bajji"], ingredients: [["Besan", 30], ["Cooking Oil", 20]] },
  { patterns: ["palak"], ingredients: [["Spinach", 100]] },
  { patterns: ["mushroom"], ingredients: [["Mushroom", 100]] },
  { patterns: ["matar"], ingredients: [["Green Peas", 50]] },
  { patterns: ["methi"], ingredients: [["Kasuri Methi", 5]] },
  { patterns: ["dal"], ingredients: [["Besan", 50]] },
  // ── Additional protein keywords (Telugu/Urdu names) ──
  { patterns: ["kodi", "tangidi"], ingredients: [["Chicken", 150]] },
  { patterns: ["gosht"], ingredients: [["Mutton", 150]] },
  { patterns: ["royyala"], ingredients: [["Prawns", 150]] },
  { patterns: ["egg", "omlet", "omelet"], ingredients: [["Egg", 2]] },
  // ── Dish-specific patterns ──
  { patterns: ["kebab", "kabab", "lollipop", "wings", "platter", "plater"], ingredients: [["Chicken", 150]] },
  // (noodle pattern removed — name-based override switches to noodles base which already has Noodles)
  { patterns: ["dosa"], ingredients: [["Maida", 100], ["Cooking Oil", 10]] },
  { patterns: ["pulav", "pulao"], ingredients: [["Bay Leaf", 2], ["Cinnamon", 2], ["Cloves", 2], ["Green Cardamom", 2]] },
  { patterns: ["raita", "ritha"], ingredients: [["Onion", 20]] },
  { patterns: ["lassi"], ingredients: [["Curd", 100], ["Milk", 50], ["Sugar", 15]] },
  { patterns: ["milkshake", "milk shake"], ingredients: [["Ice Cream", 50]] },
  { patterns: ["ice cream", "icecream"], ingredients: [["Ice Cream", 100], ["Sugar", 10]] },
  { patterns: ["gulab jamun", "gulabjamun"], ingredients: [["Maida", 50], ["Sugar", 30], ["Ghee", 10]] },
  { patterns: ["lemon"], ingredients: [["Lemon", 1]] },
  { patterns: ["mojito", "mojitho"], ingredients: [["Lemon", 1], ["Sugar", 10], ["Mint Leaves", 5]] },
  { patterns: ["butter milk", "buttermilk"], ingredients: [["Cumin Powder", 2]] },
  { patterns: ["baby corn", "babycorn"], ingredients: [["Baby Corn", 100]] },
  { patterns: ["corn"], ingredients: [["Sweet Corn", 80]] },
  { patterns: ["chocolate", "choclate", "chocklate"], ingredients: [["Chocolate", 30]] },
  { patterns: ["strawberry"], ingredients: [["Sugar", 15]] },
  { patterns: ["mango"], ingredients: [["Sugar", 15]] },
  { patterns: ["pista", "pistha"], ingredients: [["Cashews", 10]] },
  { patterns: ["black current", "blackcurrent"], ingredients: [["Sugar", 10]] },
  { patterns: ["caramel"], ingredients: [["Sugar", 15], ["Butter", 5]] },
  { patterns: ["vanilla", "vennila"], ingredients: [["Sugar", 10]] },
  { patterns: ["bounty"], ingredients: [["Chocolate", 20], ["Coconut", 10]] },
  { patterns: ["roast"], ingredients: [["Cooking Oil", 10]] },
  { patterns: ["fry"], ingredients: [["Cooking Oil", 10]] },
  { patterns: ["spring roll"], ingredients: [["Cabbage", 30], ["Carrot", 20], ["Maida", 30]] },
  { patterns: ["cutlet"], ingredients: [["Potato", 100], ["Besan", 20]] },
  { patterns: ["vada", "wada"], ingredients: [["Besan", 50], ["Cooking Oil", 15]] },
  { patterns: ["pakoda", "pakora"], ingredients: [["Besan", 40], ["Onion", 50]] },
  { patterns: ["french fries", "french fry"], ingredients: [["Potato", 150], ["Salt", 5]] },
  { patterns: ["coconut"], ingredients: [["Coconut", 50]] },
];

// ── Bread-specific overrides (replace base entirely when matched) ────────────
const BREAD_OVERRIDES: { patterns: string[]; ingredients: IngredientEntry[] }[] = [
  { patterns: ["pulka"], ingredients: [["Atta", 80], ["Salt", 2]] },
  { patterns: ["plain roti"], ingredients: [["Atta", 80], ["Salt", 2]] },
  { patterns: ["butter roti"], ingredients: [["Atta", 80], ["Salt", 2], ["Butter", 10]] },
  { patterns: ["plain naan"], ingredients: [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5]] },
  { patterns: ["butter naan"], ingredients: [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Butter", 15]] },
  { patterns: ["garlic naan"], ingredients: [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Butter", 15], ["Garlic", 10], ["Coriander Leaves", 5]] },
  { patterns: ["methi naan"], ingredients: [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Butter", 15], ["Kasuri Methi", 5]] },
  { patterns: ["methi paratha"], ingredients: [["Atta", 80], ["Salt", 2], ["Kasuri Methi", 5], ["Cooking Oil", 5]] },
  { patterns: ["paneer kulcha"], ingredients: [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Paneer", 30], ["Coriander Leaves", 5]] },
  { patterns: ["masala kulcha"], ingredients: [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Onion", 20], ["Coriander Leaves", 5], ["Green Chilli", 3]] },
];

// ── Chicken Biryani override (multi-tenant, pattern-based) ───────────────────
// Applied when an item is in the biryani category and is non-veg chicken.
// Replaces the generic biryani base with exact per-parcel quantities.
//
// 1 parcel = 1 full plate = 200g rice, 160g chicken, etc.
// Family pack = 3 parcels (configurable below).

const CHICKEN_BIRYANI_TEMPLATE: IngredientEntry[] = [
  ["Basmati Rice", 200],
  ["Chicken", 160],
  ["Cooking Oil", 40],
  ["Ghee", 6],
  ["Onion", 20],
  ["Ginger", 2],
  ["Garlic", 2],
  ["Curd", 40],
  ["Red Chilli Powder", 0.8],
  ["Turmeric Powder", 0.4],
  ["Garam Masala", 1.6],
  ["Green Cardamom", 0.6],
  ["Biryani Masala", 2],
  ["Salt", 20],
];

const CHICKEN_BIRYANI_MARKERS = ["chicken", "kodi", "wings", "sp biryani", "spl biryani", "special biryani"];
const NON_CHICKEN_BIRYANI_MARKERS = [
  "mutton", "fish", "prawn", "egg", "paneer", "mushroom",
  "veg", "mixed", "cashew", "special veg",
  "royyala", "kheema", "keema", "bajji",
  "biryani rice", "fried rice",
];

// Family pack multiplier: default 3 parcels. Override via FAMILY_PACK_MULTIPLIER env var.
const FAMILY_PACK_MULTIPLIER = Number(process.env.FAMILY_PACK_MULTIPLIER) || 3;
const HALF_PACK_MULTIPLIER = 0.5;
const FULL_PACK_MULTIPLIER = 1;

/** Pattern-based detection: is this a chicken biryani item? */
export function isChickenBiryani(itemName: string, category: string, isVeg: boolean): boolean {
  const name = itemName.toLowerCase();
  const cat = category.toLowerCase();

  const isBiryaniName = name.includes("biryani") || name.includes("biryai");
  if (!cat.includes("biryani") && !isBiryaniName) return false;
  if (isVeg) return false;

  // Exclude items that are clearly other proteins, veg, or non-biryani dishes
  // (e.g. fried rice under a "Biryani & Fried Rice" category).
  if (NON_CHICKEN_BIRYANI_MARKERS.some((m) => name.includes(m))) return false;

  // Explicit chicken indicators (covers Chicken, Kodi in Telugu)
  if (CHICKEN_BIRYANI_MARKERS.some((m) => name.includes(m))) return true;

  // Fallback: non-veg biryani without other protein markers is treated as chicken biryani.
  // This catches names like "Lollipop Biryani", "Rambo Biryani", "Ajantha Biryani",
  // "Tikka Biryani", etc. without hardcoding item names.
  return true;
}

/** Portion multiplier from item name: Half / Full / Family. */
export function getPortionMultiplier(itemName: string): number {
  const name = itemName.toLowerCase();
  if (name.includes("family")) return FAMILY_PACK_MULTIPLIER;
  if (/\bhalf\b/.test(name)) return HALF_PACK_MULTIPLIER;
  if (/\bfull\b/.test(name)) return FULL_PACK_MULTIPLIER;
  return FULL_PACK_MULTIPLIER;
}

function matchCategory(cat: string): string {
  const lower = cat.toLowerCase().trim();
  for (const key of Object.keys(CATEGORY_BASES)) {
    if (lower.includes(key)) return key;
  }
  return "";
}

export interface GeneratedIngredient {
  ingredientName: string;
  quantity: number;
  unit: string;
}

/**
 * Generate a recipe for a menu item based on its name, category, and veg flag.
 * Uses category base templates → name pattern rules → bread overrides → style modifiers.
 * Every returned ingredientName is guaranteed to be a literal from MASTER_INGREDIENTS.
 */
export function generateRecipe(
  itemName: string,
  category: string,
  isVeg: boolean,
): GeneratedIngredient[] {
  const name = itemName.toLowerCase();

  // ── Per-dish recipe lookup (highest priority) ──────────────────────────────
  // Check the curated per-dish recipe table first. This gives exact ingredient
  // lists for named dishes like "Butter Chicken", "Palak Paneer", etc.
  const dishMatch = findDishRecipe(itemName);
  if (dishMatch) {
    let entries: [string, number][] = dishMatch.ingredients.map(([n, q]) => [n, q] as [string, number]);

    // Apply boneless modifier: +20g protein for boneless variants
    if (isBonelessItem(itemName)) {
      const protein = entries.find(([n]) =>
        ["Chicken", "Mutton", "Fish", "Prawns"].includes(n),
      );
      if (protein) protein[1] += 20;
    }

    // Apply half/full portion modifiers
    if (isHalfPortion(itemName)) {
      for (const entry of entries) entry[1] *= 0.5;
    } else if (isFullPortion(itemName)) {
      for (const entry of entries) entry[1] *= 2;
    }

    // Build result, filtering to only valid MASTER_INGREDIENTS names
    const result: GeneratedIngredient[] = [];
    for (const [ingName, qty] of entries) {
      const unit = getExpectedUnit(ingName);
      if (!unit) continue;
      result.push({ ingredientName: ingName, quantity: Math.round(qty * 1000) / 1000, unit });
    }
    return result;
  }

  // ── Fall back to category-based recipe generation ──────────────────────────
  let catKey = matchCategory(category);

  // Name-based base override: if item name indicates a different base than category suggests.
  // E.g. "Chicken Fried Rice" in "Biryani & Rice" category should use fried rice base, not biryani.
  if (name.includes("fried rice") && catKey !== "fried rice") catKey = "fried rice";
  if (name.includes("noodle") && catKey !== "noodles") catKey = "noodles";
  if ((name.includes("pulav") || name.includes("pulao")) && catKey !== "rice") catKey = "rice";
  if ((name.includes("curd rice") || name.includes("sambar rice") || name.includes("jeera rice") || name.includes("plain rice") || name.includes("biryani rice")) && catKey !== "rice") catKey = "rice";
  // Raita and butter milk: use accompaniments base (curd-based), not curry
  if ((name.includes("raita") || name.includes("ritha")) && catKey !== "accompaniments") catKey = "accompaniments";
  if ((name.includes("butter milk") || name.includes("buttermilk")) && catKey !== "accompaniments") catKey = "accompaniments";
  // Dal items in starters category: use curries base instead
  if (name.includes("dal ") && catKey === "starters") catKey = "curries";
  // French fries: no base (just potato + oil + salt from pattern)
  if (name.includes("french fries") || name.includes("french fry")) catKey = "";
  // Pre-packaged items: no base template (they're purchased as-is, not made from ingredients)
  if (["water", "coke", "coca cola", "sprite", "limca", "thums up", "maaza", "pulpy orange", "soda"].some((p) => name.includes(p))) catKey = "";

  // Detect chicken biryani before building the base.
  const isChickenBiryaniItem = isChickenBiryani(itemName, category, isVeg);
  const portionMultiplier = isChickenBiryaniItem ? getPortionMultiplier(itemName) : 1;

  // Start with category base or empty
  let entries: IngredientEntry[] = catKey
    ? CATEGORY_BASES[catKey].map(([n, q]) => [n, q] as IngredientEntry)
    : [];

  // Curated biryani items get an exact per-parcel recipe based on protein type.
  let matchedProtein: string | null = null;
  if (catKey === "biryani" || name.includes("biryani") || name.includes("biryai")) {
    for (const [protein, set] of Object.entries(PROTEIN_ITEM_SETS)) {
      if (set.has(name)) { matchedProtein = protein; break; }
    }
  }
  const isCuratedBiryani = matchedProtein !== null;
  if (isCuratedBiryani) {
    entries = PROTEIN_RECIPE_MAP[matchedProtein!].map((i) => [i.ingredientName, i.perParcelQty]) as IngredientEntry[];
  }

  // Bread-specific overrides: if category is Indian Breads, try to match a bread pattern.
  // If matched, replace the base entirely.
  if (catKey === "indian breads" || catKey === "breads") {
    for (const override of BREAD_OVERRIDES) {
      if (override.patterns.some((p) => name.includes(p))) {
        entries = override.ingredients.map(([n, q]) => [n, q] as IngredientEntry);
        break;
      }
    }
  }

  // Chicken Biryani override: replace the generic biryani base with exact per-parcel template.
  // Applied to non-curated chicken biryani items; curated items use the fixed recipe above.
  if (isChickenBiryaniItem && !isCuratedBiryani) {
    entries = CHICKEN_BIRYANI_TEMPLATE.map(([n, q]) => [n, q * portionMultiplier] as IngredientEntry);
  }

  // Helper to add/merge ingredients
  const merge = (list: IngredientEntry[]) => {
    for (const [ingName, qty] of list) {
      const existing = entries.find(([n]) => n === ingName);
      if (existing) {
        existing[1] += qty;
      } else {
        entries.push([ingName, qty]);
      }
    }
  };

  // Apply name pattern rules (skip for curated biryani — recipe already has exact ingredients)
  if (!isCuratedBiryani) {
    // Apply name pattern rules (skip for chicken biryani — template already has exact ingredients)
    if (!isChickenBiryaniItem) {
      for (const rule of NAME_PATTERNS) {
        if (rule.patterns.some((p) => name.includes(p))) {
          merge(rule.ingredients);
        }
      }
    }
  }

  // ── Style modifiers ────────────────────────────────────────────────────────

  // Boneless: +20g protein (skip egg biryani — exact recipe, no modifiers)
  if (matchedProtein !== "egg" && name.includes("boneless")) {
    const protein = entries.find(([n]) =>
      ["Chicken", "Mutton", "Fish", "Prawns"].includes(n),
    );
    if (protein) protein[1] += 20;
  }

  // Full: x2 all quantities (skip chicken biryani — portion multiplier already applied)
  if (!isChickenBiryaniItem && /\bfull\b/.test(name)) {
    for (const entry of entries) entry[1] *= 2;
  }

  // Half: x0.5 all quantities (skip chicken biryani — portion multiplier already applied)
  if (!isChickenBiryaniItem && /\bhalf\b/.test(name)) {
    for (const entry of entries) entry[1] *= 0.5;
  }

  // Special/Spl: +Ghee +Cashews (skip egg biryani — exact recipe, no modifiers)
  if (matchedProtein !== "egg" && (name.includes("special") || name.includes("spl"))) {
    merge([["Ghee", 10], ["Cashews", 10]]);
  }

  // Build result, filtering to only valid MASTER_INGREDIENTS names
  const result: GeneratedIngredient[] = [];
  for (const [ingName, qty] of entries) {
    const unit = getExpectedUnit(ingName);
    if (!unit) continue; // skip unknown ingredient names (safety)
    result.push({ ingredientName: ingName, quantity: Math.round(qty * 1000) / 1000, unit });
  }

  return result;
}

// ── runAutoGenerate: shared core logic for seed script + API route ───────────

export interface AutoGenerateResult {
  ingredientsCreated: number;
  recipesGenerated: number;
  itemsSkippedExistingRecipe: number;
  warnings: string[];
}

/**
 * Upserts all 55 master ingredients and generates recipes for every FOOD menu item
 * for the given restaurant. Runs inside a single transaction with a 30s timeout.
 *
 * - Existing KitchenInventoryItem rows are never touched (update: {}).
 * - Unit-mismatched ingredients are skipped with a warning (not silently miscalculated).
 * - Existing MenuItemRecipe rows are fully replaced for each item (overwrite mode).
 */
export async function runAutoGenerate(
  prisma: ExtendedPrisma,
  restaurantId: string,
): Promise<AutoGenerateResult> {
  const allWarnings: string[] = [];
  let ingredientsCreated = 0;
  let recipesGenerated = 0;
  let itemsSkippedExistingRecipe = 0;

  const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

  await prisma.$transaction(
    async (tx) => {
      // Step 1: Check which ingredients already exist, then upsert all 55.
      const existingItems = await tx.kitchenInventoryItem.findMany({
        where: {
          restaurantId: kitchenRestaurantId,
          name: { in: MASTER_INGREDIENTS.map((i) => i.name) },
        },
        select: { name: true },
      });
      const existingNames = new Set(existingItems.map((i) => i.name));

      for (const ing of MASTER_INGREDIENTS) {
        await tx.kitchenInventoryItem.upsert({
          where: {
            restaurantId_name: { restaurantId: kitchenRestaurantId, name: ing.name },
          },
          create: {
            restaurantId: kitchenRestaurantId,
            name: ing.name,
            unit: ing.unit,
            currentStock: ing.defaultStock,
            reorderLevel: ing.reorderLevel,
            price: 0,
          },
          update: {},
        });
      }

      ingredientsCreated = MASTER_INGREDIENTS.length - existingNames.size;

      // Step 2: Fetch all FOOD menu items and all inventory in parallel.
      const [menuItems, allInventory] = await Promise.all([
        tx.menuItem.findMany({
          where: { restaurantId, isDeleted: false, menuType: "FOOD" },
          include: { category: true },
        }),
        tx.kitchenInventoryItem.findMany({
          where: { restaurantId: kitchenRestaurantId, name: { in: MASTER_INGREDIENTS.map((i) => i.name) } },
          select: { id: true, name: true, unit: true },
        }),
      ]);

      const inventoryByName = new Map(
        allInventory.map((i) => [i.name, { id: i.id, unit: i.unit }]),
      );
      const foodItemIds = menuItems.map((i) => i.id);

      // Steps 3-4: Generate recipes in-memory and validate against the fetched inventory.
      const recipesToCreate: { menuItemId: string; ingredientId: string; quantity: number }[] = [];
      const itemsWithValidRecipes = new Set<string>();

      for (const item of menuItems) {
        const categoryName = item.category?.name ?? "";
        const generated = generateRecipe(item.name, categoryName, item.isVeg);
        const validLines: { ingredientId: string; quantity: number }[] = [];

        for (const line of generated) {
          const liveItem = inventoryByName.get(line.ingredientName);

          if (!liveItem) {
            allWarnings.push(
              `Ingredient "${line.ingredientName}" not found in inventory for item "${item.name}" — skipped.`,
            );
            continue;
          }

          const expectedUnit = getExpectedUnit(line.ingredientName);
          if (liveItem.unit !== expectedUnit) {
            allWarnings.push(
              `Unit mismatch for "${line.ingredientName}" on item "${item.name}": inventory uses "${liveItem.unit}", recipe engine expects "${expectedUnit}" — skipped, fix manually in inventory or recipe editor.`,
            );
            continue;
          }

          validLines.push({ ingredientId: liveItem.id, quantity: line.quantity });
        }

        if (validLines.length > 0) {
          itemsWithValidRecipes.add(item.id);
          for (const v of validLines) {
            recipesToCreate.push({
              menuItemId: item.id,
              ingredientId: v.ingredientId,
              quantity: v.quantity,
            });
          }
        }
      }

      // Step 5: Check which items had existing recipes before we overwrite.
      const existingRecipes = await tx.menuItemRecipe.findMany({
        where: { restaurantId, menuItemId: { in: foodItemIds } },
        select: { menuItemId: true },
      });
      const itemsWithExistingRecipes = new Set(existingRecipes.map((r) => r.menuItemId));

      // Step 6: Delete existing recipes only for items that will get new valid recipes.
      if (itemsWithValidRecipes.size > 0) {
        await tx.menuItemRecipe.deleteMany({
          where: { restaurantId, menuItemId: { in: Array.from(itemsWithValidRecipes) } },
        });
      }

      // Step 7: Create all new recipe rows in one batched operation.
      if (recipesToCreate.length > 0) {
        await tx.menuItemRecipe.createMany({
          data: recipesToCreate.map((r) => ({ ...r, restaurantId })),
        });
      }

      recipesGenerated = itemsWithValidRecipes.size;
      itemsSkippedExistingRecipe = foodItemIds.filter(
        (id) => itemsWithExistingRecipes.has(id) && !itemsWithValidRecipes.has(id),
      ).length;
    },
    { timeout: 30000 },
  );

  // Step 8: Cap warnings at ~200 entries
  const MAX_WARNINGS = 200;
  let warnings = allWarnings;
  if (allWarnings.length > MAX_WARNINGS) {
    warnings = allWarnings.slice(0, MAX_WARNINGS);
    warnings.push(`...and ${allWarnings.length - MAX_WARNINGS} more`);
  }

  return { ingredientsCreated, recipesGenerated, itemsSkippedExistingRecipe, warnings };
}

export interface ApplyChickenBiryaniResult {
  restaurantId: string;
  ingredientsCreated: number;
  recipesGenerated: number;
  itemsMatched: string[];
  warnings: string[];
}

/**
 * Apply precise chicken biryani recipes to all matching FOOD menu items for a restaurant.
 * Multi-tenant safe: scoped by restaurantId, pattern-based detection (no hardcoded item names).
 *
 * - Creates/updating master ingredients needed for the template (Biryani Masala, etc.)
 * - Finds chicken biryani items via isChickenBiryani() patterns
 * - Deletes existing recipes for matched items only
 * - Creates new per-parcel recipes
 * - Settlement will automatically deduct these quantities via orderService
 */
export async function applyChickenBiryaniRecipes(
  prisma: ExtendedPrisma,
  restaurantId: string,
): Promise<ApplyChickenBiryaniResult> {
  const allWarnings: string[] = [];
  let ingredientsCreated = 0;
  let recipesGenerated = 0;
  const itemsMatched: string[] = [];

  const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

  await prisma.$transaction(
    async (tx) => {
      // Step 1: Ensure all master ingredients exist (especially Biryani Masala).
      const existingItems = await tx.kitchenInventoryItem.findMany({
        where: {
          restaurantId: kitchenRestaurantId,
          name: { in: MASTER_INGREDIENTS.map((i) => i.name) },
        },
        select: { name: true },
      });
      const existingNames = new Set(existingItems.map((i) => i.name));

      for (const ing of MASTER_INGREDIENTS) {
        await tx.kitchenInventoryItem.upsert({
          where: { restaurantId_name: { restaurantId: kitchenRestaurantId, name: ing.name } },
          create: {
            restaurantId: kitchenRestaurantId,
            name: ing.name,
            unit: ing.unit,
            currentStock: ing.defaultStock,
            reorderLevel: ing.reorderLevel,
            price: 0,
          },
          update: {},
        });
      }
      ingredientsCreated = MASTER_INGREDIENTS.length - existingNames.size;

      // Step 2: Fetch FOOD menu items with their categories.
      const menuItems = await tx.menuItem.findMany({
        where: { restaurantId, isDeleted: false, menuType: "FOOD" },
        include: { category: true },
      });

      const chickenBiryaniItems = menuItems.filter((item) =>
        isChickenBiryani(item.name, item.category?.name ?? "", item.isVeg),
      );

      if (chickenBiryaniItems.length === 0) {
        allWarnings.push(`No chicken biryani items found for restaurant ${restaurantId}.`);
        return;
      }

      itemsMatched.push(...chickenBiryaniItems.map((i) => i.name));

      // Step 3: Fetch inventory for validation.
      const allInventory = await tx.kitchenInventoryItem.findMany({
        where: { restaurantId: kitchenRestaurantId, name: { in: MASTER_INGREDIENTS.map((i) => i.name) } },
        select: { id: true, name: true, unit: true },
      });
      const inventoryByName = new Map(
        allInventory.map((i) => [i.name, { id: i.id, unit: i.unit }]),
      );

      const recipesToCreate: { menuItemId: string; ingredientId: string; quantity: number }[] = [];
      const itemsWithValidRecipes = new Set<string>();

      for (const item of chickenBiryaniItems) {
        const categoryName = item.category?.name ?? "";
        const generated = generateRecipe(item.name, categoryName, item.isVeg);
        const validLines: { ingredientId: string; quantity: number }[] = [];

        for (const line of generated) {
          const liveItem = inventoryByName.get(line.ingredientName);
          if (!liveItem) {
            allWarnings.push(
              `Ingredient "${line.ingredientName}" not found in inventory for item "${item.name}" — skipped.`,
            );
            continue;
          }
          const expectedUnit = getExpectedUnit(line.ingredientName);
          if (liveItem.unit !== expectedUnit) {
            allWarnings.push(
              `Unit mismatch for "${line.ingredientName}" on item "${item.name}": inventory uses "${liveItem.unit}", recipe engine expects "${expectedUnit}" — skipped.`,
            );
            continue;
          }
          validLines.push({ ingredientId: liveItem.id, quantity: line.quantity });
        }

        if (validLines.length > 0) {
          itemsWithValidRecipes.add(item.id);
          for (const v of validLines) {
            recipesToCreate.push({
              menuItemId: item.id,
              ingredientId: v.ingredientId,
              quantity: v.quantity,
            });
          }
        }
      }

      // Step 4: Delete existing recipes for matched items that will get new recipes.
      if (itemsWithValidRecipes.size > 0) {
        await tx.menuItemRecipe.deleteMany({
          where: { restaurantId, menuItemId: { in: Array.from(itemsWithValidRecipes) } },
        });
      }

      // Step 5: Create new recipes.
      if (recipesToCreate.length > 0) {
        await tx.menuItemRecipe.createMany({
          data: recipesToCreate.map((r) => ({ ...r, restaurantId })),
        });
      }

      recipesGenerated = itemsWithValidRecipes.size;
    },
    { timeout: 30000 },
  );

  const MAX_WARNINGS = 200;
  let warnings = allWarnings;
  if (allWarnings.length > MAX_WARNINGS) {
    warnings = allWarnings.slice(0, MAX_WARNINGS);
    warnings.push(`...and ${allWarnings.length - MAX_WARNINGS} more`);
  }

  return { restaurantId, ingredientsCreated, recipesGenerated, itemsMatched, warnings };
}
