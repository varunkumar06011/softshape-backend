import prismaClient, { basePrisma } from "../lib/prisma";
import { resolveKitchenRestaurantId } from "../lib/tenantContext";

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
  { name: "Biryani Masala", unit: "g", defaultStock: 500, reorderLevel: 100 },
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
    ["Maida", 120], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30],
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
  ["Ginger", 4],
  ["Curd", 40],
  ["Red Chilli Powder", 0.8],
  ["Turmeric Powder", 0.4],
  ["Garam Masala", 1.6],
  ["Green Cardamom", 0.6],
  ["Salt", 20],
  ["Biryani Masala", 2],
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

  if (!cat.includes("biryani")) return false;
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
  const catKey = matchCategory(category);

  // Detect chicken biryani before building the base.
  const isChickenBiryaniItem = isChickenBiryani(itemName, category, isVeg);
  const portionMultiplier = isChickenBiryaniItem ? getPortionMultiplier(itemName) : 1;

  // Start with category base or empty
  let entries: IngredientEntry[] = catKey
    ? CATEGORY_BASES[catKey].map(([n, q]) => [n, q] as IngredientEntry)
    : [];

  // Bread-specific overrides: if category is Indian Breads, try to match a bread pattern.
  // If matched, replace the base entirely.
  if (catKey === "indian breads") {
    for (const override of BREAD_OVERRIDES) {
      if (override.patterns.some((p) => name.includes(p))) {
        entries = override.ingredients.map(([n, q]) => [n, q] as IngredientEntry);
        break;
      }
    }
  }

  // Chicken Biryani override: replace the generic biryani base with exact per-parcel template.
  // Multi-tenant pattern detection — no hardcoded item names.
  if (isChickenBiryaniItem) {
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

  // Apply name pattern rules (skip for chicken biryani — template already has exact ingredients)
  if (!isChickenBiryaniItem) {
    for (const rule of NAME_PATTERNS) {
      if (rule.patterns.some((p) => name.includes(p))) {
        merge(rule.ingredients);
      }
    }
  }

  // ── Style modifiers ────────────────────────────────────────────────────────

  // Boneless: +20g protein
  if (name.includes("boneless")) {
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

  // Special/Spl: +Ghee +Cashews
  if (name.includes("special") || name.includes("spl")) {
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
