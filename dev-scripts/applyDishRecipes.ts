import prisma from "../src/lib/prisma";
import {
  MASTER_INGREDIENTS,
  generateRecipe,
  isChickenBiryani,
  CHICKEN_BIRYANI_ITEMS,
  EGG_BIRYANI_ITEMS,
  MUTTON_BIRYANI_ITEMS,
  PRAWNS_BIRYANI_ITEMS,
  FISH_BIRYANI_ITEMS,
} from "../src/services/recipeEngine";
import { FLAGGED_DISHES, normalizeDishName } from "../src/services/dishRecipes";

async function resolveKitchenRestaurantIdSafe(restaurantId: string): Promise<string> {
  try {
    const { resolveKitchenRestaurantId } = await import("../src/lib/tenantContext");
    return await resolveKitchenRestaurantId(restaurantId);
  } catch {
    return restaurantId;
  }
}

const BAR_CATEGORIES = ["liquor", "cocktails & mocktails"];

const EXCLUDED_BIRYANI_ITEMS = new Set([
  ...CHICKEN_BIRYANI_ITEMS,
  ...EGG_BIRYANI_ITEMS,
  ...MUTTON_BIRYANI_ITEMS,
  ...PRAWNS_BIRYANI_ITEMS,
  ...FISH_BIRYANI_ITEMS,
].map((n) => n.toLowerCase()));

function isBarCategory(cat: string): boolean {
  const lower = cat.toLowerCase().trim();
  return BAR_CATEGORIES.some((b) => lower.includes(b));
}

function shouldSkip(item: { name: string; category?: { name: string } | null; isVeg: boolean }): boolean {
  const catName = item.category?.name ?? "";
  if (isBarCategory(catName)) return true;
  const lowerName = item.name.toLowerCase();
  // Skip all biryani items (handled by separate biryani recipe scripts)
  // But keep "biryani rice" which is a plain rice side dish
  if ((lowerName.includes("biryani") || lowerName.includes("birayni") || lowerName.includes("briyani")) && !lowerName.includes("biryani rice")) return true;
  if (EXCLUDED_BIRYANI_ITEMS.has(lowerName)) return true;
  if (isChickenBiryani(item.name, catName, item.isVeg)) return true;
  return false;
}

// ── Ground-truth item lists ──────────────────────────────────────────────────
// Maps category label → array of item names (from user's ground-truth lists)
type GroundTruth = Record<string, string[]>;

const VGRAND_LOUNGE_GROUND_TRUTH: GroundTruth = {
  "Soups": ["Tomato Soup", "Veg Sweet Corn Soup", "Veg Hot and Sour Soup", "Veg Dragon Soup", "Veg Manchow Soup", "Chicken Hot and Sour Soup", "Chicken Sweet Corn Soup", "Chicken Lungfung Soup", "Chicken Manchow Soup", "Chicken Dragon Soup", "V-Grand Spl Cream of Chicken Soup"],
  "Starters Veg & Egg": ["Boiled Egg", "Omelette", "Masala Papad", "Crispy Corn", "French Fries", "Aloo 65", "Aloo Manchurian", "Gobi 65", "Gobi Manchurian", "Gobi Chilli", "Golden Fried Crispy Baby Corn", "Veg Manchurian", "Veg Shangrilla", "Spring Rolls", "Cashew Nut Roast", "Baby Corn 65", "Baby Corn Manchurian", "Baby Corn Chilli", "Mushroom 65", "Mushroom Manchurian", "Mushroom Chilli", "Mushroom Pepper Salt", "Paneer 65", "Paneer Manchurian", "Paneer Chilli", "Paneer Majestic", "Paneer Tikka"],
  "Starters Non-Veg Indian": ["Chicken Roast", "Chicken Fry", "Phuket Fish", "Basket Chicken", "Chicken 555", "Lemon Chicken", "Ginger Chicken", "Chicken Patiala", "Cashew Nut Chicken", "Fish Fry Starter", "Tawa Fish", "Mutton Fry", "Kheema Balls", "Pepper Mutton", "Basket Mutton"],
  "Starters Non-Veg Chinese": ["Chicken Manchurian", "Chicken 65", "Chicken Chilli", "Crispy Chicken Fingers", "Pepper Chicken", "Fish 65", "Fish Manchurian", "Fish Chilli", "Schezwan Chicken", "Star Chicken", "Majestic Chicken", "Dragon Chicken", "Apollo Fish", "Velvet Fish", "Chicken Drumsticks", "Chicken Drums", "Chicken Wings", "Chicken Lollipop", "Chicken Shangrilla", "Chicken 85", "Chicken Alpha", "Chilli Prawns", "Loose Prawns", "Golden Fried Prawns", "85 Prawns", "Dragon Prawns", "Velvet Prawns"],
  "Starters Non-Veg Tandoori": ["Chicken Tikka", "Tandoori Chicken Half", "Tandoori Chicken Full", "Hariyali Chicken Kebab", "Murg Malai Kebab", "Reshmi Kebab", "Kalmi Kebab", "Tangdi Kebab", "Mutton Seekh Kebab", "V-Grand Special Tandoori Platter"],
  "Fried Rice": ["Veg Fried Rice", "Jeera Fried Rice", "Schezwan Veg Fried Rice", "Paneer Fried Rice", "Mushroom Fried Rice", "Egg Fried Rice", "Schezwan Egg Fried Rice", "Chicken Fried Rice", "Schezwan Chicken Fried Rice", "V-Grand Spl Chicken Fried Rice"],
  "Noodles": ["Veg Noodles", "Schezwan Veg Noodles", "Paneer Noodles", "Mushroom Noodles", "Egg Noodles", "Schezwan Egg Noodles", "Chicken Noodles", "Schezwan Chicken Noodles"],
  "Rice": ["Plain Rice", "Sambar Rice", "Tomato Rice", "Curd Rice", "Spl Curd Rice"],
  "Curries Veg": ["Dal Fry", "Dal Tadka", "Tomato Curry", "Aloo Masala", "Green Peas Masala", "Plain Palak", "Paneer Palak", "Kadai Paneer", "Mixed Veg Curry", "Kadai Veg Curry", "Capsicum Masala", "Baby Corn Masala", "Mushroom Curry", "Veg Kheema Curry", "Malai Kofta", "Veg Jaipuri", "Veg Shahi Kurma", "Methi Chaman", "Paneer Butter Masala", "Cashew Nut Curry"],
  "Curries Non-Veg": ["Egg Burji Curry", "Omelette Curry", "Boiled Egg Curry", "Chicken Afghani", "Butter Chicken", "Chicken Priya Pasand", "Chicken Shahi Kurma", "Kashmiri Chicken", "Chicken Tikka Masala", "Cashew Nut Chicken", "Maharani Chicken Curry", "Chicken Curry", "Andhra Chicken Curry", "Kadai Chicken", "Gongura Chicken", "Fish Curry", "Fish Fry Curry", "Mughlai Chicken", "Prawns Fry", "Prawns Curry", "Gongura Prawns", "Mutton Fry", "Mutton Curry", "Gongura Mutton", "Mutton Kheema Curry"],
  "Indian Breads": ["Pulka", "Plain Roti", "Butter Roti", "Plain Naan", "Butter Naan", "Garlic Naan", "Methi Naan", "Methi Paratha", "Paneer Kulcha", "Masala Kulcha"],
  "Ice Cream": ["Strawberry Ice Cream", "Vanilla Ice Cream", "Chocolate Ice Cream", "Butterscotch Ice Cream", "Pista Ice Cream", "Mango Ice Cream", "Black Currant Ice Cream", "American Nuts Ice Cream", "Italian Bounty Ice Cream", "Caramel Ice Cream", "Melto Ice Cream"],
  "Milkshakes & Lassi": ["Mango Lassi", "Lassi", "Vanilla Milkshake", "Strawberry Milkshake", "Chocolate Milkshake", "Pista Milkshake", "Black Currant Milkshake", "Mango Milkshake", "Butterscotch Milkshake"],
};

const VGRAND_FAMILY_GROUND_TRUTH: GroundTruth = {
  "Soups": ["TOMATO SOUP", "VEG SWEET CORN SOUP", "VEG HOT&SOUR SOUP", "VEG DRAGON SOUP", "VEG MANCHOW SOUP", "CHICKEN HOT&SOUR SOUP", "CHICKEN SWEET CORN SOUP", "CHICEKN MANCHOW SOUP", "CHICKEN DRAGON SOUP", "V GRANS SPCL CREAM OF CHICEKN SOUP"],
  "Starters Veg & Egg": ["BOILED EGG", "OMLET", "MASALA PAPAD", "CRISPY CORN", "FRENCH FRIES", "ALOO 65", "ALOO MANCHURIA", "GOBI 65", "GOBI MANCHURIA", "CHILLI GOBI", "GOLDEN FRIES CRISPY BABY CORN", "VEG MANCHURIA", "VEG SHANGRILLA", "SPRING ROLLS", "CASHEWNUT ROAST", "BABY CORN 65", "BABY CORN MANCHURIA", "CHILLI BABY CORN", "MUSHROMM 65", "MUSHROOM MANCHURIA", "CHILLI MUSHROOM", "MUSHROOM PEPPER SALT", "PANEER 65", "PANEER MANCHURIA", "CHILLI PANEER", "PANEER MAJESTIC", "PANEER TIKKA", "VEG BULLETS"],
  "Starters Non-Veg Indian": ["CHICKEN ROAST", "CHICKEN FRY", "PHUKET FISH", "BASKET CHICKEN", "CHICKEN 555", "LEMON CHICKEN", "GINGER CHICKEN", "CHICKEN PATIYALA", "CASHEWNUT CHICKEN", "FISH FRY", "TAWA FISH", "MUTTON FRY", "KHEEMA BALLS", "PEPPER MUTTON", "BASKET CHICKEN", "CHICKEN PAKODA", "CHICKEN MAHARANI", "LEMON CHICKEN", "MUTTON KHEEMA BALLS", "MUTTON ROAST"],
  "Starters Non-Veg Chinese": ["CHICKEN MANCHURIA", "CHICKEN 65", "CHILLI CHICKEN", "CRISPY CHICKEN FINGERS", "PEPPER CHICKEN", "FISH 65", "FISH MANCHURIA", "CHILI FISH", "SCHEZWAN CHICKEN", "STAR CHICKEN", "CHICKEN MAJESTIC", "DRAGON CHICKEN", "APOLLO FISH", "VELVET FISH", "CHICKEN DRUMSTICKS", "CHICKEN DRUM", "CHICKEN WINGS", "CHICKEN LOLLIPOP", "CHICKEN SHANGRILLA", "CHICKEN 85", "CHICKEN ALPHA", "CHILLI PRAWNS", "LOOSE PRAWNS", "GOLDEN FRIED PRAWNS", "PRAWNS 85", "DRAGON PRAWNS", "VELVET PRAWNS", "PRAWNS MANCHURIA"],
  "Starters Non-Veg Tandoori": ["CHICKEN TIKKA", "TANDOORI CHICKEN HALF", "TANDOORI CHICKEN FULL", "HARIYALI CHICKEN KEBAB", "MURG MALAI", "RESHMI KEBAB", "KALMI KEBAB", "TANGIDI KEBAB", "MUTTON SEEKH KEBAB", "V GRAND SPECIAL TANDOORI PLATTER"],
  "Fried Rice & Noodles": ["VEG FRIED RICE", "JEERA FRIED RICE", "SCHEZWAN FRIED RICE", "PANEER FRIED RICE", "MUSHROOM FRIED RICE", "VEG NOODLES", "SCHEZWAN VEG NOODLES", "PANEER NOODLES", "MUSHROOM NOODLES", "EGG FRIED RICE", "SCHEZWAN EGG FRIED RICE", "EGG NOODLES", "SCHEZWAN NOODLES", "CHICKEN FRIED RICE", "SCHEZWAN CHICKEN FRIED RICE", "CHICKEN NOODLES", "SCHEZWAN CHICKEN NOODLES", "V GRAND SPCL CHICKEN FRIED RICE", "MIXED NON VEG FRIED RICE", "MIXED VEG FRIED RICE", "CASHEW FRIED RICE"],
  "Curries Veg": ["DAL FRY", "TOMATO CURRY", "ALOO CURRY", "GREEN PEAS MASALA", "PANEER CURRY", "PALAK PANEER", "KADAI PANEER", "MIXED VEG CURRY", "KADAI VEG CURRY", "CAPSICUM MASALA", "BABAY CORN MASALA", "MUSHROOM MASALA", "VEG KHEEMA CURRY", "MALAI KOFTA", "VEG JAIPURI", "SHAHI KURMA", "METHI CHAMNA", "PANEER BUTTER MASALA", "CASHEWNUT CURRY", "CASHEW PANEER CURRY", "PANEER TIKKA MASALA"],
  "Curries Non-Veg": ["EGG BURJI", "OMLET CURRY", "BOILED EGG CURRY", "CHICKEN AFGHANI", "BUTTER CHICKEN", "CHICKEN PRIYA PASAND", "CHICKEN SHAHI KURMA", "KASHMIRI CHICKEN", "CHICKEN TIKKA MASALA", "CASHEWNUT CHICKEN CURRY", "CHICKEN MAHARANI CURRY", "CHICKEN CURRY", "ANDHRA CHICKEN CURRY", "KADAI CHICKEN", "GONGURA CHICKEN", "FISH CURRY", "MUGHALAI CHICKEN CURRY", "PRAWNS FRY", "PRAWNS CURRY", "GONGURA PRAWNS", "MUTTON FRY", "MUTTON CURRY", "GONGURA MUTTON", "MUTTON KHEEMA CURRY", "GONGURA MUTTON CURRY", "EGG KHEEMA CURRY", "KADAI MUTTON CURRY", "FISH FRY"],
  "Rice Items": ["PLAIN RICE", "SAMBAR RICE", "TOMATO RICE", "CURD RICE", "SPL CURD RICE"],
  "Indian Breads": ["PULKA", "PLAIN NAAN", "BUTTER NAAN", "GARLIC NAAN", "METHI NAAN", "METHI PARATHA", "PANEER KULCHA", "MASALA KULCHA", "PLAIN ROTI", "BUTTER ROTI"],
  "Ice Cream": ["VENNILA ICE CREAM", "STRAWBERRY ICE CREAM", "CHICKELATE ICE CREAM", "BUTTER SCOH ICE CREAM", "ITALIAN BOUNTY ICE CREAM", "PISTA ICE CREAM", "MANGO ICE CREAM", "BLACK CURRENT ICE CREAM", "AMERICAN NUTS ICE CREAM", "CARAMEL ICE CREAM"],
  "Milkshakes": ["VENILA MILKSHAKE", "STRAWBERRY MILKSHAKE", "PISTA MILKSHAKE", "BLACK CURRENT MILKSHAKE", "MANGO MILKSHAKE", "CHOCKLATE MILKSHAKE", "BUTTER SOH MILKSHAKE", "LASSI", "MANGO LASSI", "BUTTER MILK"],
  "Drinks": ["FRESH LIME SODA SALT", "FRESH LIME SODA SWEET", "MOJITHO", "SODA 250ML", "FRESH LIME SWEET & SALT"],
};

// ── Category filter mapping ──────────────────────────────────────────────────
// Maps the CATEGORY env var value to ground-truth category keys
const CATEGORY_MAP: Record<string, string[]> = {
  "soups": ["Soups"],
  "starters-veg": ["Starters Veg & Egg"],
  "starters-nonveg": ["Starters Non-Veg Indian", "Starters Non-Veg Chinese", "Starters Non-Veg Tandoori"],
  "fried-rice": ["Fried Rice", "Fried Rice & Noodles"],
  "noodles": ["Noodles", "Fried Rice & Noodles"],
  "curries-veg": ["Curries Veg"],
  "curries-nonveg": ["Curries Non-Veg"],
  "rice": ["Rice", "Rice Items"],
  "breads": ["Indian Breads"],
  "ice-cream": ["Ice Cream"],
  "milkshakes": ["Milkshakes & Lassi", "Milkshakes"],
  "drinks": ["Drinks"],
};

// ── Category name filter for DB queries ──────────────────────────────────────
const CATEGORY_DB_FILTERS: Record<string, string[]> = {
  "soups": ["soup"],
  "starters-veg": ["starters (veg)", "starters veg", "veg starter"],
  "starters-nonveg": ["starters (non", "non veg", "starter", "tandoori"],
  "fried-rice": ["fried rice", "noodles", "biryani & rice", "biryani and rice"],
  "noodles": ["fried rice", "noodles", "biryani & rice", "biryani and rice"],
  "curries-veg": ["curries", "veg"],
  "curries-nonveg": ["curries", "non veg"],
  "rice": ["rice"],
  "breads": ["breads", "indian breads", "roti", "naan"],
  "ice-cream": ["ice cream", "dessert"],
  "milkshakes": ["milkshakes", "lassi", "drinks", "beverages", "dessert"],
  "drinks": ["drinks", "beverages", "soft drink"],
};

// ── Categories that should filter by isVeg ───────────────────────────────────
const VEG_ONLY_CATEGORIES = new Set(["starters-veg", "curries-veg"]);
const NON_VEG_CATEGORIES = new Set(["starters-nonveg", "curries-nonveg"]);

async function applyForRestaurant(
  restaurantId: string,
  restaurantLabel: string,
  groundTruth: GroundTruth,
  dryRun: boolean,
  categoryFilter?: string,
) {
  const kitchenRestaurantId = await resolveKitchenRestaurantIdSafe(restaurantId);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Restaurant: ${restaurantLabel} (${restaurantId})`);
  console.log(`Kitchen ID: ${kitchenRestaurantId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  if (categoryFilter) console.log(`Category: ${categoryFilter}`);
  console.log("=".repeat(70));

  // Upsert master ingredients (even in dry run so we can validate recipes)
  for (const ing of MASTER_INGREDIENTS) {
    await prisma.kitchenInventoryItem.upsert({
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

  const allInventory = await prisma.kitchenInventoryItem.findMany({
    where: { restaurantId: kitchenRestaurantId, name: { in: MASTER_INGREDIENTS.map((i) => i.name) } },
    select: { id: true, name: true, unit: true },
  });
  const inventoryByName = new Map(allInventory.map((i) => [i.name, { id: i.id, unit: i.unit }]));

  // Determine which ground-truth categories to process
  const gtCategories = categoryFilter
    ? (CATEGORY_MAP[categoryFilter] ?? [])
    : Object.keys(groundTruth);

  if (gtCategories.length === 0) {
    console.log(`\nNo ground-truth categories matched for filter "${categoryFilter}".`);
    return;
  }

  // Build DB query filters
  const dbFilters = categoryFilter
    ? (CATEGORY_DB_FILTERS[categoryFilter] ?? [])
    : [];

  // Query menu items
  const where: any = { restaurantId, isDeleted: false, menuType: "FOOD" };
  if (categoryFilter && VEG_ONLY_CATEGORIES.has(categoryFilter)) {
    where.isVeg = true;
  }
  if (categoryFilter && NON_VEG_CATEGORIES.has(categoryFilter)) {
    where.isVeg = false;
  }
  if (dbFilters.length > 0) {
    where.OR = dbFilters.map((f) => ({
      category: { name: { contains: f, mode: "insensitive" } },
    }));
  }

  const allMenuItems = await prisma.menuItem.findMany({
    where,
    include: { category: true },
    orderBy: { name: "asc" },
  });

  const targetItems = allMenuItems.filter((item) => !shouldSkip(item));
  console.log(`\nFOOD items in query: ${allMenuItems.length}`);
  console.log(`Items to process (after excluding biryani/bar): ${targetItems.length}`);

  // ── Ground-truth checklist ─────────────────────────────────────────────────
  console.log(`\n── Ground-Truth Checklist ──`);
  const allGtItems: string[] = [];
  for (const cat of gtCategories) {
    const items = groundTruth[cat] ?? [];
    allGtItems.push(...items);
  }

  const matchedItems: string[] = [];
  const unmatchedItems: string[] = [];
  const seenDbNames = new Set(targetItems.map((i) => normalizeDishName(i.name)));

  for (const gtItem of allGtItems) {
    const normalizedGt = normalizeDishName(gtItem);
    if (seenDbNames.has(normalizedGt)) {
      matchedItems.push(gtItem);
    } else {
      unmatchedItems.push(gtItem);
    }
  }

  console.log(`Matched in DB: ${matchedItems.length}/${allGtItems.length}`);
  if (unmatchedItems.length > 0) {
    console.log(`\n⚠ NOT FOUND in DB (${unmatchedItems.length}):`);
    for (const item of unmatchedItems) {
      console.log(`  - ${item}`);
    }
  }

  // ── Generate recipes ───────────────────────────────────────────────────────
  const recipesToCreate: { menuItemId: string; ingredientId: string; quantity: number }[] = [];
  const itemsWithValidRecipes = new Set<string>();
  const warnings: string[] = [];
  const flaggedItems: string[] = [];
  let sampleCount = 0;
  const SAMPLE_LIMIT = 5;

  for (const item of targetItems) {
    const categoryName = item.category?.name ?? "";
    const generated = generateRecipe(item.name, categoryName, item.isVeg);
    const validLines: { ingredientId: string; quantity: number }[] = [];

    const normalized = normalizeDishName(item.name);
    if (normalized in FLAGGED_DISHES) {
      flaggedItems.push(item.name);
    }

    if (generated.length > 0) {
      const isSample = sampleCount < SAMPLE_LIMIT;
      if (isSample) {
        console.log(`\n  📋 ${item.name} (${categoryName || "no category"})`);
        sampleCount++;
      } else if (dryRun && sampleCount === SAMPLE_LIMIT) {
        console.log(`\n  ... (showing first ${SAMPLE_LIMIT} samples, more items below)`);
        sampleCount++;
      }
    }

    for (const line of generated) {
      const liveItem = inventoryByName.get(line.ingredientName);
      if (!liveItem) {
        warnings.push(`Ingredient "${line.ingredientName}" not found in inventory for "${item.name}" — skipped.`);
        continue;
      }
      let adjustedQty = line.quantity;
      if (liveItem.unit !== line.unit) {
        const invUnit = liveItem.unit.toUpperCase();
        const recipeUnit = line.unit.toUpperCase();
        if (recipeUnit === "G" && invUnit === "KG") adjustedQty = line.quantity / 1000;
        else if (recipeUnit === "ML" && invUnit === "L") adjustedQty = line.quantity / 1000;
        else if (recipeUnit === "KG" && invUnit === "G") adjustedQty = line.quantity * 1000;
        else if (recipeUnit === "L" && invUnit === "ML") adjustedQty = line.quantity * 1000;
        else {
          warnings.push(`Unit mismatch: "${line.ingredientName}" on "${item.name}": inv="${liveItem.unit}", recipe="${line.unit}" — skipped.`);
          continue;
        }
      }
      if (sampleCount <= SAMPLE_LIMIT && generated.length > 0) {
        console.log(`     - ${line.ingredientName}: ${adjustedQty}${liveItem.unit}`);
      }
      validLines.push({ ingredientId: liveItem.id, quantity: adjustedQty });
    }

    const seenIngredientIds = new Set<string>();
    const dedupedValidLines = validLines.filter((v) => {
      if (seenIngredientIds.has(v.ingredientId)) return false;
      seenIngredientIds.add(v.ingredientId);
      return true;
    });

    if (dedupedValidLines.length > 0) {
      itemsWithValidRecipes.add(item.id);
      for (const v of dedupedValidLines) {
        recipesToCreate.push({ menuItemId: item.id, ingredientId: v.ingredientId, quantity: v.quantity });
      }
    }
  }

  // Global deduplication
  const recipeKeySet = new Set<string>();
  const dedupedRecipesToCreate = recipesToCreate.filter((r) => {
    const key = `${r.menuItemId}|${r.ingredientId}`;
    if (recipeKeySet.has(key)) return false;
    recipeKeySet.add(key);
    return true;
  });

  // ── Write to DB (if not dry run) ───────────────────────────────────────────
  if (!dryRun && itemsWithValidRecipes.size > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.menuItemRecipe.deleteMany({
        where: { restaurantId, menuItemId: { in: Array.from(itemsWithValidRecipes) } },
      });
      await tx.menuItemRecipe.createMany({
        data: dedupedRecipesToCreate.map((r) => ({ ...r, restaurantId })),
      });
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Summary for ${restaurantLabel}`);
  console.log(`${"─".repeat(50)}`);
  console.log(`Items with valid recipes: ${itemsWithValidRecipes.size}/${targetItems.length}`);
  console.log(`Recipe lines: ${dedupedRecipesToCreate.length}`);
  console.log(`Ground-truth matched: ${matchedItems.length}/${allGtItems.length}`);
  if (dryRun) console.log(`No database writes (DRY_RUN=true).`);
  else console.log(`Recipes written to database.`);

  if (flaggedItems.length > 0) {
    console.log(`\n⚠ FLAGGED dishes needing your confirmation (${flaggedItems.length}):`);
    for (const item of flaggedItems) {
      const key = normalizeDishName(item);
      const note = FLAGGED_DISHES[key];
      console.log(`  - ${item}: ${note}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    warnings.slice(0, 20).forEach((w) => console.log(`  - ${w}`));
    if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more`);
  }
}

async function main() {
  const restaurantIds = process.env.RESTAURANT_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!restaurantIds || restaurantIds.length === 0) {
    throw new Error("RESTAURANT_IDS env var required");
  }
  const dryRun = process.env.DRY_RUN !== "false";
  const categoryFilter = process.env.CATEGORY;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Apply Per-Dish Recipes (non-biryani FOOD items)`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Category: ${categoryFilter ?? "ALL"}`);
  console.log(`${"═".repeat(70)}`);

  // Map restaurant IDs to labels and ground truth
  const LOUNGE_ID = "cmqy60ci200027dscyj9ubg8h";
  const FAMILY_ID = "cmr03m0fa00015ot8jh16grhn";

  for (const id of restaurantIds) {
    if (id === LOUNGE_ID) {
      await applyForRestaurant(id, "Vgrand Lounge", VGRAND_LOUNGE_GROUND_TRUTH, dryRun, categoryFilter);
    } else if (id === FAMILY_ID) {
      await applyForRestaurant(id, "Vgrand Family Restaurant", VGRAND_FAMILY_GROUND_TRUTH, dryRun, categoryFilter);
    } else {
      // Unknown restaurant — try with empty ground truth
      await applyForRestaurant(id, `Restaurant ${id}`, {}, dryRun, categoryFilter);
    }
  }
  console.log(`\n${"═".repeat(70)}`);
  console.log("All restaurants processed.");
  console.log(`${"═".repeat(70)}`);
}

main()
  .catch((err) => { console.error("Apply failed:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
