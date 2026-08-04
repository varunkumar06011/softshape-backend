export type IngredientEntry = [string, number];

const TYPO_FIXES: [RegExp, string][] = [
  [/chicekn/gi, "chicken"], [/noolde[ls]/gi, "noodles"],
  [/manchuria(?!n)/gi, "manchurian"], [/mushromm/gi, "mushroom"],
  [/mushroon/gi, "mushroom"], [/vennila/gi, "vanilla"],
  [/venila/gi, "vanilla"], [/chocklate/gi, "chocolate"],
  [/chickelate/gi, "chocolate"], [/choclate/gi, "chocolate"],
  [/butter soh/gi, "butterscotch"], [/fied rice/gi, "fried rice"],
  [/fired rice/gi, "fried rice"], [/babay corn/gi, "baby corn"],
  [/chamna/gi, "chaman"], [/patiyala/gi, "patiala"],
  [/cashewnut/gi, "cashew nut"], [/cashewn[ue]t/gi, "cashew nut"],
  [/v grans/gi, "v grand"], [/spcl/gi, "spl"],
  [/vgrand/gi, "v grand"],
  [/sechzwan/gi, "schezwan"], [/sclezwan/gi, "schezwan"],
  [/schzwan/gi, "schezwan"], [/shezwan/gi, "schezwan"],
  [/schzewan/gi, "schezwan"], [/shezawan/gi, "schezwan"],
  [/friedrice/gi, "fried rice"], [/noolde[ls]/gi, "noodles"],
  [/noodless/gi, "noodles"],
  [/birayni/gi, "biryani"],
  [/hot&sour/gi, "hot and sour"],
  [/lunggung/gi, "lungfung"],
  [/lung fung/gi, "lungfung"],
  [/lunfung/gi, "lungfung"],
];

export function normalizeDishName(name: string): string {
  let n = name.toLowerCase().trim();
  for (const [re, rep] of TYPO_FIXES) n = n.replace(re, rep);
  n = n.replace(/-/g, " ");
  n = n.replace(/\([^)]*\)/g, "").trim();
  n = n.replace(/\bbones\b/g, "").trim();
  n = n.replace(/\bb\/l\b/g, "boneless").trim();
  // Strip portion suffixes like "1/2", "1/3" — these indicate half/third portions
  n = n.replace(/\b1\/2\b/g, "").trim();
  n = n.replace(/\b1\/3\b/g, "").trim();
  n = n.replace(/\s+/g, " ").trim();
  return n;
}

export function isBonelessItem(name: string): boolean {
  const n = name.toLowerCase();
  return /\bb\/l\b/.test(n) || n.includes("boneless");
}

export function isHalfPortion(name: string): boolean {
  return /\bhalf\b/.test(name.toLowerCase()) || /\b1\/2\b/.test(name);
}

export function isFullPortion(name: string): boolean {
  return /\bfull\b/.test(name.toLowerCase());
}

// ── Per-dish recipes keyed by normalized lowercase name ─────────────────────
export const DISH_RECIPES: Record<string, IngredientEntry[]> = {
  // SOUPS
  "tomato soup": [["Tomato", 150], ["Sugar", 10], ["Cornflour", 10], ["Butter", 10], ["Cream", 20], ["Salt", 3], ["Black Pepper", 2], ["Ginger", 5], ["Garlic", 5], ["Cooking Oil", 10]],
  "veg sweet corn soup": [["Sweet Corn", 80], ["Cornflour", 10], ["Sugar", 5], ["Salt", 3], ["Green Chilli", 5], ["Ginger", 5], ["Garlic", 5], ["Cooking Oil", 10]],
  "veg hot and sour soup": [["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Soya Sauce", 10], ["Vinegar", 5], ["Cornflour", 10], ["Salt", 3], ["Green Chilli", 5], ["Ginger", 5], ["Garlic", 5], ["Cooking Oil", 10]],
  "veg dragon soup": [["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Schezwan Sauce", 15], ["Soya Sauce", 10], ["Cornflour", 10], ["Salt", 3], ["Garlic", 10], ["Ginger", 5], ["Cooking Oil", 10]],
  "veg manchow soup": [["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Soya Sauce", 10], ["Cornflour", 10], ["Salt", 3], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Cooking Oil", 10], ["Coriander Leaves", 5]],
  "chicken hot and sour soup": [["Chicken", 100], ["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Soya Sauce", 10], ["Vinegar", 5], ["Cornflour", 10], ["Salt", 3], ["Green Chilli", 5], ["Ginger", 5], ["Garlic", 5], ["Cooking Oil", 10], ["Egg", 1]],
  "chicken sweet corn soup": [["Chicken", 100], ["Sweet Corn", 80], ["Cornflour", 10], ["Sugar", 5], ["Salt", 3], ["Ginger", 5], ["Garlic", 5], ["Egg", 1], ["Cooking Oil", 5]],
  "chicken lungfung soup": [["Chicken", 100], ["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Soya Sauce", 10], ["Vinegar", 5], ["Cornflour", 10], ["Salt", 3], ["Green Chilli", 5], ["Ginger", 5], ["Garlic", 5], ["Egg", 1], ["Cooking Oil", 10]],
  "chicken manchow soup": [["Chicken", 100], ["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Soya Sauce", 10], ["Cornflour", 10], ["Salt", 3], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Cooking Oil", 10], ["Coriander Leaves", 5], ["Egg", 1]],
  "chicken dragon soup": [["Chicken", 100], ["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Schezwan Sauce", 15], ["Soya Sauce", 10], ["Cornflour", 10], ["Salt", 3], ["Garlic", 10], ["Ginger", 5], ["Cooking Oil", 10], ["Egg", 1]],
  "v grand spl cream of chicken soup": [["Chicken", 100], ["Cream", 30], ["Butter", 10], ["Cornflour", 10], ["Salt", 3], ["Black Pepper", 2], ["Ginger", 5], ["Garlic", 5]],
  "v grans spl cream of chicken soup": [["Chicken", 100], ["Cream", 30], ["Butter", 10], ["Cornflour", 10], ["Salt", 3], ["Black Pepper", 2], ["Ginger", 5], ["Garlic", 5]],
  "mutton soup": [["Mutton", 100], ["Onion", 30], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Black Pepper", 3], ["Coriander Powder", 3], ["Salt", 5], ["Cooking Oil", 10], ["Curry Leaves", 5]],
  "v grand spl veg soup": [["Cabbage", 40], ["Carrot", 30], ["Capsicum", 30], ["Sweet Corn", 50], ["Cream", 20], ["Cornflour", 10], ["Salt", 3], ["Black Pepper", 2], ["Ginger", 5], ["Garlic", 5], ["Cooking Oil", 10]],

  // STARTERS — VEG & EGG
  "boiled egg": [["Egg", 2], ["Salt", 2]],
  "omelette": [["Egg", 2], ["Onion", 30], ["Green Chilli", 5], ["Salt", 3], ["Cooking Oil", 10], ["Turmeric Powder", 2]],
  "omlet": [["Egg", 2], ["Onion", 30], ["Green Chilli", 5], ["Salt", 3], ["Cooking Oil", 10], ["Turmeric Powder", 2]],
  "masala papad": [["Besan", 30], ["Onion", 20], ["Tomato", 20], ["Coriander Leaves", 5], ["Salt", 2], ["Red Chilli Powder", 2], ["Cumin Powder", 2], ["Cooking Oil", 5]],
  "crispy corn": [["Sweet Corn", 150], ["Cornflour", 20], ["Cooking Oil", 30], ["Salt", 3], ["Green Chilli", 5], ["Garlic", 10], ["Ginger", 5], ["Curry Leaves", 5]],
  "french fries": [["Potato", 200], ["Cooking Oil", 30], ["Salt", 5]],
  "aloo 65": [["Potato", 150], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "aloo manchurian": [["Potato", 150], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "gobi 65": [["Cauliflower", 200], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "gobi manchurian": [["Cauliflower", 200], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "gobi chilli": [["Cauliflower", 200], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "chilli gobi": [["Cauliflower", 200], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "golden fried crispy baby corn": [["Baby Corn", 150], ["Cornflour", 20], ["Cooking Oil", 30], ["Salt", 3], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 5]],
  "golden fries crispy baby corn": [["Baby Corn", 150], ["Cornflour", 20], ["Cooking Oil", 30], ["Salt", 3], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 5]],
  "veg manchurian": [["Cabbage", 100], ["Carrot", 50], ["Capsicum", 30], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 20], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "veg shangrilla": [["Cabbage", 80], ["Carrot", 30], ["Capsicum", 30], ["Schezwan Sauce", 15], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "spring rolls": [["Cabbage", 50], ["Carrot", 30], ["Capsicum", 20], ["Green Peas", 20], ["Maida", 50], ["Cooking Oil", 20], ["Salt", 3], ["Soya Sauce", 5], ["Ginger", 5], ["Garlic", 5], ["Green Chilli", 3]],
  "cashew nut roast": [["Cashews", 150], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Red Chilli Powder", 5], ["Cooking Oil", 30], ["Salt", 5], ["Onion", 30]],
  "baby corn 65": [["Baby Corn", 150], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "baby corn manchurian": [["Baby Corn", 150], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "chilli baby corn": [["Baby Corn", 150], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "mushroom 65": [["Mushroom", 150], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "mushroom manchurian": [["Mushroom", 150], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "chilli mushroom": [["Mushroom", 150], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "mushroom pepper salt": [["Mushroom", 150], ["Black Pepper", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5], ["Onion", 30], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Cornflour", 10]],
  "paneer 65": [["Paneer", 150], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "paneer manchurian": [["Paneer", 150], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "chilli paneer": [["Paneer", 150], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "paneer majestic": [["Paneer", 150], ["Curd", 30], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 10], ["Mint Leaves", 5], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "paneer tikka": [["Paneer", 150], ["Curd", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 3], ["Cooking Oil", 15], ["Lemon", 1], ["Salt", 5], ["Coriander Leaves", 5]],
  "veg bullets": [["Potato", 100], ["Green Peas", 30], ["Carrot", 30], ["Cornflour", 20], ["Maida", 30], ["Cooking Oil", 20], ["Salt", 3], ["Garam Masala", 3], ["Green Chilli", 5]],

  // Additional veg/egg starters found in DB
  "mushroom fry": [["Mushroom", 150], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Cornflour", 10]],
  "chilli egg": [["Egg", 3], ["Soya Sauce", 10], ["Cornflour", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Capsicum", 30], ["Onion", 30], ["Cooking Oil", 20], ["Salt", 5]],
  "egg fry": [["Egg", 3], ["Onion", 30], ["Ginger", 5], ["Garlic", 5], ["Red Chilli Powder", 3], ["Turmeric Powder", 2], ["Curry Leaves", 5], ["Cooking Oil", 15], ["Salt", 5]],
  "egg munchuria": [["Egg", 3], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 30], ["Cooking Oil", 20], ["Salt", 5], ["Coriander Leaves", 5]],
  "egg manchurian": [["Egg", 3], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 30], ["Cooking Oil", 20], ["Salt", 5], ["Coriander Leaves", 5]],
  "ravva cutlet": [["Potato", 100], ["Onion", 30], ["Green Peas", 20], ["Carrot", 20], ["Semolina", 30], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Salt", 5], ["Garam Masala", 3]],
  "veg 99": [["Potato", 100], ["Paneer", 50], ["Cashews", 20], ["Cream", 20], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 5], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "velvet egg": [["Egg", 3], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Soya Sauce", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "veg spring rolls": [["Cabbage", 50], ["Carrot", 30], ["Capsicum", 20], ["Green Peas", 20], ["Maida", 50], ["Cooking Oil", 20], ["Salt", 3], ["Soya Sauce", 5], ["Ginger", 5], ["Garlic", 5], ["Green Chilli", 3]],

  // STARTERS — NON-VEG INDIAN
  "chicken roast": [["Chicken", 200], ["Onion", 50], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5]],
  "chicken fry": [["Chicken", 200], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cornflour", 10], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5]],
  "phuket fish": [["Fish", 200], ["Cornflour", 20], ["Garlic", 10], ["Ginger", 5], ["Red Chilli Powder", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Soya Sauce", 5]],
  "basket chicken": [["Chicken", 200], ["Onion", 30], ["Capsicum", 30], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Cooking Oil", 30], ["Salt", 5], ["Schezwan Sauce", 10]],
  "chicken 555": [["Chicken", 170], ["Curd", 30], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 10], ["Cashews", 10], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "lemon chicken": [["Chicken", 170], ["Lemon", 1], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Cornflour", 15], ["Soya Sauce", 5], ["Cooking Oil", 30], ["Salt", 5], ["Onion", 30], ["Curry Leaves", 5]],
  "ginger chicken": [["Chicken", 200], ["Ginger", 30], ["Garlic", 10], ["Onion", 30], ["Green Chilli", 10], ["Red Chilli Powder", 5], ["Cooking Oil", 30], ["Salt", 5], ["Curry Leaves", 5]],
  "chicken patiala": [["Chicken", 170], ["Onion", 50], ["Tomato", 50], ["Cream", 20], ["Butter", 10], ["Garam Masala", 5], ["Cashews", 10], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 20], ["Salt", 5]],
  "cashew nut chicken": [["Chicken", 170], ["Cashews", 50], ["Onion", 40], ["Tomato", 40], ["Cream", 20], ["Ghee", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 20], ["Salt", 5], ["Turmeric Powder", 2]],
  "fish fry starter": [["Fish", 200], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cornflour", 15], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Lemon", 1]],
  "fish fry starter roast": [["Fish", 200], ["Onion", 30], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 3], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5]],
  "tawa fish": [["Fish", 200], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3]],
  "mutton fry": [["Mutton", 200], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5]],
  "kheema balls": [["Mutton", 170], ["Onion", 30], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5], ["Garam Masala", 5], ["Cornflour", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3], ["Red Chilli Powder", 3]],
  "pepper mutton": [["Mutton", 200], ["Black Pepper", 10], ["Onion", 30], ["Garlic", 10], ["Ginger", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3]],
  "basket mutton": [["Mutton", 200], ["Onion", 30], ["Capsicum", 30], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Cooking Oil", 30], ["Salt", 5], ["Schezwan Sauce", 10]],
  "chicken pakoda": [["Chicken", 170], ["Besan", 50], ["Onion", 30], ["Green Chilli", 5], ["Ginger", 5], ["Garlic", 5], ["Curry Leaves", 5], ["Cooking Oil", 30], ["Salt", 5], ["Red Chilli Powder", 3]],
  "chicken maharani": [["Chicken", 170], ["Onion", 50], ["Tomato", 50], ["Cream", 30], ["Cashews", 15], ["Butter", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 20], ["Salt", 5]],
  "mutton kheema balls": [["Mutton", 170], ["Onion", 30], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5], ["Garam Masala", 5], ["Cornflour", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3]],
  "mutton roast": [["Mutton", 200], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Black Pepper", 5]],

  // STARTERS — NON-VEG CHINESE
  "chicken manchurian": [["Chicken", 170], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "chicken 65": [["Chicken", 170], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "chilli chicken": [["Chicken", 170], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "crispy chicken fingers": [["Chicken", 170], ["Cornflour", 20], ["Maida", 20], ["Garlic", 5], ["Ginger", 5], ["Cooking Oil", 30], ["Salt", 5]],
  "pepper chicken": [["Chicken", 200], ["Black Pepper", 10], ["Onion", 30], ["Garlic", 10], ["Ginger", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3]],
  "fish 65": [["Fish", 170], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "fish manchurian": [["Fish", 170], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],
  "chili fish": [["Fish", 170], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "fish chilli": [["Fish", 170], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "schezwan chicken": [["Chicken", 170], ["Schezwan Sauce", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5], ["Soya Sauce", 5]],
  "star chicken": [["Chicken", 170], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 10], ["Red Chilli Powder", 5], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "chicken majestic": [["Chicken", 170], ["Curd", 30], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 10], ["Mint Leaves", 5], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "dragon chicken": [["Chicken", 170], ["Schezwan Sauce", 15], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "apollo fish": [["Fish", 170], ["Cornflour", 20], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 10], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Red Chilli Powder", 3]],
  "velvet fish": [["Fish", 170], ["Cornflour", 15], ["Egg", 1], ["Garlic", 10], ["Ginger", 5], ["Soya Sauce", 5], ["Cooking Oil", 30], ["Salt", 5]],
  "chicken drumsticks": [["Chicken", 170], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curd", 20], ["Cooking Oil", 30], ["Salt", 5], ["Red Chilli Powder", 3], ["Turmeric Powder", 2]],
  "chicken drum": [["Chicken", 200], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curd", 20], ["Cooking Oil", 30], ["Salt", 5], ["Red Chilli Powder", 3], ["Turmeric Powder", 2]],
  "chicken wings": [["Chicken", 200], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curd", 20], ["Cooking Oil", 30], ["Salt", 5], ["Red Chilli Powder", 3], ["Turmeric Powder", 2]],
  "chicken lollipop": [["Chicken", 200], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curd", 20], ["Cooking Oil", 30], ["Salt", 5], ["Red Chilli Powder", 3], ["Turmeric Powder", 2]],
  "chicken shangrilla": [["Chicken", 170], ["Schezwan Sauce", 15], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Capsicum", 30], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "chicken 85": [["Chicken", 170], ["Curry Leaves", 10], ["Garlic", 15], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "chicken alpha": [["Chicken", 170], ["Curry Leaves", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3]],
  "chilli prawns": [["Prawns", 170], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 10], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "loose prawns": [["Prawns", 170], ["Cornflour", 15], ["Curry Leaves", 10], ["Garlic", 10], ["Green Chilli", 10], ["Cooking Oil", 30], ["Salt", 5], ["Red Chilli Powder", 3]],
  "golden fried prawns": [["Prawns", 170], ["Cornflour", 20], ["Cooking Oil", 30], ["Salt", 5], ["Garlic", 5], ["Ginger", 5], ["Turmeric Powder", 2]],
  "85 prawns": [["Prawns", 170], ["Curry Leaves", 10], ["Garlic", 15], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "prawns 85": [["Prawns", 170], ["Curry Leaves", 10], ["Garlic", 15], ["Ginger", 5], ["Green Chilli", 10], ["Cornflour", 15], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cooking Oil", 30], ["Salt", 5]],
  "dragon prawns": [["Prawns", 170], ["Schezwan Sauce", 15], ["Soya Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "velvet prawns": [["Prawns", 170], ["Cornflour", 15], ["Egg", 1], ["Garlic", 10], ["Ginger", 5], ["Soya Sauce", 5], ["Cooking Oil", 30], ["Salt", 5]],
  "prawns manchurian": [["Prawns", 170], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 15], ["Ginger", 10], ["Green Chilli", 5], ["Capsicum", 30], ["Onion", 40], ["Cooking Oil", 30], ["Salt", 5], ["Coriander Leaves", 5]],

  // Additional non-veg starters found in DB
  "hong kong chicken": [["Chicken", 170], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "singapore prawns": [["Prawns", 170], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],
  "trump chicken": [["Chicken", 170], ["Curd", 30], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 10], ["Red Chilli Powder", 5], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "guntur kodi vepudu": [["Chicken", 200], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 10], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3]],
  "kerala chicken": [["Chicken", 200], ["Coconut", 50], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Curry Leaves", 10], ["Cooking Oil", 20], ["Salt", 5], ["Mustard Seeds", 2]],
  "rayalaseema chicken": [["Chicken", 200], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 10], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3], ["Cumin Seeds", 3]],
  "chicken 777": [["Chicken", 170], ["Curd", 30], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 10], ["Red Chilli Powder", 5], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "royal kebab": [["Chicken", 170], ["Curd", 40], ["Cream", 20], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 5], ["Cashews", 10], ["Cooking Oil", 15], ["Salt", 5], ["Lemon", 1]],
  "chicken kebab": [["Chicken", 170], ["Curd", 40], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 3], ["Cooking Oil", 15], ["Salt", 5], ["Lemon", 1]],
  "fish fry roast": [["Fish", 200], ["Onion", 30], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 3], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5]],
  "natu kodi fry": [["Chicken", 200], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 10], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 3], ["Cumin Seeds", 3]],
  "papadi chicken": [["Chicken", 170], ["Besan", 30], ["Onion", 30], ["Ginger", 5], ["Garlic", 5], ["Red Chilli Powder", 3], ["Curry Leaves", 5], ["Cooking Oil", 30], ["Salt", 5], ["Turmeric Powder", 2]],
  "kaju star chicken": [["Chicken", 170], ["Cashews", 30], ["Cornflour", 15], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Curry Leaves", 10], ["Red Chilli Powder", 5], ["Cooking Oil", 30], ["Salt", 5], ["Garam Masala", 3]],
  "black bean chicken": [["Chicken", 170], ["Soya Sauce", 10], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Capsicum", 40], ["Onion", 30], ["Cooking Oil", 30], ["Salt", 5]],

  // STARTERS — NON-VEG TANDOORI
  "chicken tikka": [["Chicken", 170], ["Curd", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 3], ["Cooking Oil", 15], ["Lemon", 1], ["Salt", 5], ["Coriander Leaves", 5]],
  "tandoori chicken half": [["Chicken", 250], ["Curd", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 3], ["Cooking Oil", 15], ["Lemon", 1], ["Salt", 5]],
  "tandoori chicken full": [["Chicken", 500], ["Curd", 100], ["Ginger", 20], ["Garlic", 20], ["Red Chilli Powder", 10], ["Garam Masala", 10], ["Turmeric Powder", 5], ["Cooking Oil", 30], ["Lemon", 2], ["Salt", 10]],
  "hariyali chicken kebab": [["Chicken", 170], ["Curd", 50], ["Spinach", 50], ["Coriander Leaves", 20], ["Mint Leaves", 10], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 10], ["Garam Masala", 5], ["Cooking Oil", 15], ["Salt", 5], ["Lemon", 1]],
  "murg malai": [["Chicken", 170], ["Curd", 30], ["Cream", 30], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Green Cardamom", 2], ["Lemon", 1], ["Cornflour", 10]],
  "murg malai kebab": [["Chicken", 170], ["Curd", 30], ["Cream", 30], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Green Cardamom", 2], ["Lemon", 1], ["Cornflour", 10]],
  "reshmi kebab": [["Chicken", 170], ["Curd", 30], ["Cream", 20], ["Cashews", 15], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Lemon", 1], ["Cornflour", 10]],
  "kalmi kebab": [["Chicken", 170], ["Curd", 40], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 3], ["Garam Masala", 3], ["Cream", 20], ["Cooking Oil", 15], ["Salt", 5], ["Lemon", 1]],
  "tangdi kebab": [["Chicken", 170], ["Curd", 40], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 3], ["Cooking Oil", 15], ["Salt", 5], ["Lemon", 1]],
  "tangidi kebab": [["Chicken", 170], ["Curd", 40], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 3], ["Cooking Oil", 15], ["Salt", 5], ["Lemon", 1]],
  "mutton seekh kebab": [["Mutton", 170], ["Onion", 30], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5], ["Garam Masala", 5], ["Curd", 20], ["Cooking Oil", 20], ["Salt", 5], ["Lemon", 1], ["Coriander Leaves", 5]],
  "v grand special tandoori platter": [["Chicken", 200], ["Mutton", 100], ["Curd", 50], ["Cream", 20], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 3], ["Cooking Oil", 20], ["Salt", 5], ["Lemon", 1], ["Cashews", 10]],

  // FRIED RICE
  "veg fried rice": [["Basmati Rice", 200], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "jeera fried rice": [["Basmati Rice", 200], ["Cumin Seeds", 5], ["Cooking Oil", 15], ["Salt", 5], ["Onion", 20], ["Ginger", 5]],
  "schezwan veg fried rice": [["Basmati Rice", 200], ["Schezwan Sauce", 15], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "schezwan fried rice": [["Basmati Rice", 200], ["Schezwan Sauce", 15], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "paneer fried rice": [["Basmati Rice", 200], ["Paneer", 100], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "mushroom fried rice": [["Basmati Rice", 200], ["Mushroom", 100], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "egg fried rice": [["Basmati Rice", 200], ["Egg", 2], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "schezwan egg fried rice": [["Basmati Rice", 200], ["Egg", 2], ["Schezwan Sauce", 15], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "chicken fried rice": [["Basmati Rice", 200], ["Chicken", 150], ["Egg", 1], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "schezwan chicken fried rice": [["Basmati Rice", 200], ["Chicken", 150], ["Egg", 1], ["Schezwan Sauce", 15], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "v grand spl chicken fried rice": [["Basmati Rice", 200], ["Chicken", 150], ["Egg", 2], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 20], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5], ["Garam Masala", 3]],
  "v grand spcl chicken fried rice": [["Basmati Rice", 200], ["Chicken", 150], ["Egg", 2], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 20], ["Soya Sauce", 10], ["Schezwan Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5], ["Garam Masala", 3]],
  "mixed non veg fried rice": [["Basmati Rice", 200], ["Chicken", 80], ["Mutton", 50], ["Prawns", 50], ["Fish", 50], ["Egg", 1], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 20], ["Soya Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "mixed veg fried rice": [["Basmati Rice", 200], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cabbage", 30], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "cashew fried rice": [["Basmati Rice", 200], ["Cashews", 50], ["Onion", 30], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Salt", 5], ["Garlic", 10], ["Ginger", 5], ["Ghee", 5]],

  // NOODLES
  "veg noodles": [["Noodles", 150], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "schezwan veg noodles": [["Noodles", 150], ["Schezwan Sauce", 15], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "schezwan noodles": [["Noodles", 150], ["Schezwan Sauce", 15], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "paneer noodles": [["Noodles", 150], ["Paneer", 100], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "mushroom noodles": [["Noodles", 150], ["Mushroom", 100], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "egg noodles": [["Noodles", 150], ["Egg", 2], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "schezwan egg noodles": [["Noodles", 150], ["Egg", 2], ["Schezwan Sauce", 15], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "egg schezwan noodles": [["Noodles", 150], ["Egg", 2], ["Schezwan Sauce", 15], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "schezwan mixed veg fried rice": [["Basmati Rice", 200], ["Schezwan Sauce", 15], ["Onion", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cabbage", 30], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Salt", 5], ["Garlic", 10], ["Ginger", 5]],
  "chicken noodles": [["Noodles", 150], ["Chicken", 150], ["Egg", 1], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 10], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],
  "schezwan chicken noodles": [["Noodles", 150], ["Chicken", 150], ["Egg", 1], ["Schezwan Sauce", 15], ["Cabbage", 40], ["Capsicum", 30], ["Carrot", 30], ["Green Peas", 20], ["Cooking Oil", 15], ["Soya Sauce", 5], ["Garlic", 10], ["Ginger", 5], ["Salt", 5]],

  // RICE ITEMS
  "plain rice": [["Basmati Rice", 200], ["Cooking Oil", 5], ["Salt", 3], ["Cumin Seeds", 2]],
  "sambar rice": [["Basmati Rice", 200], ["Toor Dal", 50], ["Tamarind", 10], ["Onion", 30], ["Tomato", 30], ["Curry Leaves", 5], ["Mustard Seeds", 2], ["Turmeric Powder", 2], ["Red Chilli Powder", 3], ["Coriander Powder", 3], ["Salt", 5], ["Cooking Oil", 10]],
  "tomato rice": [["Basmati Rice", 200], ["Tomato", 100], ["Onion", 30], ["Ginger", 5], ["Garlic", 5], ["Red Chilli Powder", 3], ["Turmeric Powder", 2], ["Mustard Seeds", 2], ["Curry Leaves", 5], ["Cooking Oil", 10], ["Salt", 5], ["Cumin Seeds", 2]],
  "curd rice": [["Basmati Rice", 200], ["Curd", 100], ["Milk", 50], ["Salt", 3], ["Cumin Seeds", 2], ["Curry Leaves", 5], ["Ginger", 5], ["Green Chilli", 3], ["Cooking Oil", 5]],
  "spl curd rice": [["Basmati Rice", 200], ["Curd", 100], ["Milk", 50], ["Salt", 3], ["Cashews", 10], ["Sugar", 5], ["Cumin Seeds", 2], ["Curry Leaves", 3], ["Ginger", 3], ["Cooking Oil", 5]],
  "spl curd rice fruit & nuts": [["Basmati Rice", 200], ["Curd", 100], ["Milk", 50], ["Salt", 3], ["Cashews", 10], ["Sugar", 5], ["Cumin Seeds", 2], ["Curry Leaves", 3], ["Ginger", 3], ["Cooking Oil", 5]],
  "biryani rice": [["Basmati Rice", 250], ["Onion", 50], ["Cooking Oil", 15], ["Ghee", 10], ["Turmeric Powder", 2], ["Red Chilli Powder", 3], ["Garam Masala", 3], ["Cumin Seeds", 3], ["Bay Leaf", 1], ["Cinnamon", 1], ["Green Cardamom", 2], ["Cloves", 1], ["Salt", 5], ["Curd", 20]],
  "spl curd rice fruits & nuts": [["Basmati Rice", 200], ["Curd", 100], ["Milk", 50], ["Salt", 3], ["Cashews", 10], ["Sugar", 5], ["Cumin Seeds", 2], ["Curry Leaves", 3], ["Ginger", 3], ["Cooking Oil", 5]],

  // CURRIES — VEG
  "dal fry": [["Toor Dal", 100], ["Onion", 30], ["Tomato", 30], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 5], ["Turmeric Powder", 3], ["Cumin Seeds", 3], ["Mustard Seeds", 2], ["Curry Leaves", 5], ["Cooking Oil", 15], ["Salt", 5], ["Coriander Leaves", 5]],
  "dal tadka": [["Toor Dal", 100], ["Onion", 20], ["Tomato", 20], ["Garlic", 10], ["Ginger", 5], ["Green Chilli", 3], ["Turmeric Powder", 3], ["Cumin Seeds", 3], ["Mustard Seeds", 2], ["Curry Leaves", 5], ["Red Chilli Powder", 3], ["Cooking Oil", 15], ["Ghee", 5], ["Salt", 5], ["Coriander Leaves", 5]],
  "tomato curry": [["Tomato", 200], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Coriander Powder", 5], ["Cumin Powder", 3], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Curry Leaves", 5]],
  "aloo masala": [["Potato", 200], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cumin Powder", 3], ["Garam Masala", 3], ["Cumin Seeds", 3], ["Mustard Seeds", 2], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "aloo curry": [["Potato", 200], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cumin Powder", 3], ["Garam Masala", 3], ["Cumin Seeds", 3], ["Mustard Seeds", 2], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "green peas masala": [["Green Peas", 150], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cumin Powder", 3], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Cream", 20]],
  "paneer curry": [["Paneer", 150], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cumin Powder", 3], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Cream", 20]],
  "palak paneer": [["Paneer", 150], ["Spinach", 150], ["Onion", 30], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5], ["Turmeric Powder", 2], ["Garam Masala", 3], ["Cream", 20], ["Cooking Oil", 15], ["Salt", 5], ["Cumin Seeds", 3]],
  "paneer palak": [["Paneer", 150], ["Spinach", 150], ["Onion", 30], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5], ["Turmeric Powder", 2], ["Garam Masala", 3], ["Cream", 20], ["Cooking Oil", 15], ["Salt", 5], ["Cumin Seeds", 3]],
  "kadai paneer": [["Paneer", 150], ["Capsicum", 50], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Coriander Powder", 5], ["Red Chilli Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Kasuri Methi", 3]],
  "mixed veg curry": [["Potato", 50], ["Carrot", 50], ["Green Peas", 30], ["Capsicum", 30], ["Cauliflower", 50], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5]],
  "kadai veg curry": [["Capsicum", 50], ["Onion", 50], ["Tomato", 50], ["Potato", 50], ["Carrot", 30], ["Green Peas", 30], ["Ginger", 10], ["Garlic", 10], ["Coriander Powder", 5], ["Red Chilli Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5]],
  "capsicum masala": [["Capsicum", 150], ["Onion", 30], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5]],
  "baby corn masala": [["Baby Corn", 150], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Cream", 20]],
  "mushroom curry": [["Mushroom", 150], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Curry Leaves", 5]],
  "mushroom masala": [["Mushroom", 150], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Curry Leaves", 5]],
  "veg kheema curry": [["Paneer", 100], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Green Peas", 30], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5]],
  "malai kofta": [["Potato", 100], ["Paneer", 50], ["Cashews", 15], ["Cream", 30], ["Onion", 30], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Ghee", 10], ["Cooking Oil", 20], ["Salt", 5], ["Sugar", 5], ["Coriander Powder", 3]],
  "veg jaipuri": [["Potato", 50], ["Carrot", 30], ["Green Peas", 30], ["Capsicum", 30], ["Cauliflower", 40], ["Onion", 50], ["Tomato", 50], ["Cream", 20], ["Cashews", 10], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 3], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Turmeric Powder", 2]],
  "veg shahi kurma": [["Potato", 50], ["Carrot", 30], ["Green Peas", 30], ["Capsicum", 30], ["Cauliflower", 40], ["Onion", 50], ["Tomato", 30], ["Cream", 30], ["Cashews", 15], ["Ghee", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 15], ["Salt", 5], ["Curd", 20]],
  "shahi kurma": [["Potato", 50], ["Carrot", 30], ["Green Peas", 30], ["Capsicum", 30], ["Cauliflower", 40], ["Onion", 50], ["Tomato", 30], ["Cream", 30], ["Cashews", 15], ["Ghee", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 15], ["Salt", 5], ["Curd", 20]],
  "methi chaman": [["Paneer", 150], ["Spinach", 100], ["Kasuri Methi", 10], ["Onion", 30], ["Tomato", 30], ["Cream", 20], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Turmeric Powder", 2]],
  "methi chamna": [["Paneer", 150], ["Spinach", 100], ["Kasuri Methi", 10], ["Onion", 30], ["Tomato", 30], ["Cream", 20], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Turmeric Powder", 2]],
  "paneer butter masala": [["Paneer", 150], ["Tomato", 100], ["Onion", 30], ["Butter", 15], ["Cream", 20], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 3], ["Garam Masala", 3], ["Cashews", 10], ["Sugar", 5], ["Cooking Oil", 10], ["Salt", 5], ["Kasuri Methi", 3]],
  "cashew nut curry": [["Cashews", 100], ["Onion", 50], ["Tomato", 50], ["Cream", 20], ["Ghee", 10], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Red Chilli Powder", 3], ["Cooking Oil", 15], ["Salt", 5], ["Turmeric Powder", 2]],
  "cashew paneer curry": [["Cashews", 50], ["Paneer", 100], ["Onion", 50], ["Tomato", 50], ["Cream", 20], ["Ghee", 10], ["Ginger", 10], ["Garlic", 10], ["Garam Masala", 3], ["Red Chilli Powder", 3], ["Cooking Oil", 15], ["Salt", 5]],
  "paneer tikka masala": [["Paneer", 150], ["Tomato", 100], ["Onion", 50], ["Cream", 20], ["Butter", 10], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 2], ["Cooking Oil", 15], ["Salt", 5], ["Kasuri Methi", 3], ["Curd", 20], ["Lemon", 1]],
  "plain palak": [["Spinach", 150], ["Onion", 30], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5], ["Turmeric Powder", 2], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Cumin Seeds", 3]],

  // CURRIES — NON-VEG
  "egg burji": [["Egg", 3], ["Onion", 50], ["Tomato", 30], ["Ginger", 5], ["Garlic", 5], ["Green Chilli", 5], ["Turmeric Powder", 2], ["Red Chilli Powder", 3], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Coriander Leaves", 5]],
  "egg burji curry": [["Egg", 3], ["Onion", 50], ["Tomato", 30], ["Ginger", 5], ["Garlic", 5], ["Green Chilli", 5], ["Turmeric Powder", 2], ["Red Chilli Powder", 3], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5], ["Coriander Leaves", 5]],
  "omelette curry": [["Egg", 2], ["Onion", 30], ["Tomato", 50], ["Ginger", 5], ["Garlic", 5], ["Turmeric Powder", 2], ["Red Chilli Powder", 3], ["Coriander Powder", 3], ["Cumin Powder", 2], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5]],
  "omlet curry": [["Egg", 2], ["Onion", 30], ["Tomato", 50], ["Ginger", 5], ["Garlic", 5], ["Turmeric Powder", 2], ["Red Chilli Powder", 3], ["Coriander Powder", 3], ["Cumin Powder", 2], ["Garam Masala", 3], ["Cooking Oil", 15], ["Salt", 5]],
  "boiled egg curry": [["Egg", 2], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Cumin Seeds", 3]],
  "chicken afghani": [["Chicken", 170], ["Cream", 30], ["Cashews", 15], ["Curd", 30], ["Ghee", 10], ["Garam Masala", 5], ["Green Cardamom", 3], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 15], ["Salt", 5]],
  "butter chicken": [["Chicken", 170], ["Tomato", 150], ["Onion", 30], ["Butter", 20], ["Cream", 30], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Cashews", 15], ["Sugar", 5], ["Cooking Oil", 10], ["Salt", 5], ["Kasuri Methi", 3]],
  "chicken priya pasand": [["Chicken", 170], ["Onion", 50], ["Tomato", 50], ["Cream", 30], ["Cashews", 15], ["Butter", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 20], ["Salt", 5], ["Turmeric Powder", 2], ["Red Chilli Powder", 3]],
  "chicken shahi kurma": [["Chicken", 170], ["Onion", 50], ["Tomato", 30], ["Cream", 30], ["Cashews", 15], ["Ghee", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 15], ["Salt", 5], ["Curd", 20], ["Green Cardamom", 3]],
  "kashmiri chicken": [["Chicken", 170], ["Cashews", 20], ["Cream", 20], ["Ghee", 10], ["Saffron", 1], ["Garam Masala", 5], ["Onion", 30], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 15], ["Salt", 5], ["Red Chilli Powder", 3]],
  "chicken tikka masala": [["Chicken", 170], ["Tomato", 100], ["Onion", 50], ["Cream", 20], ["Butter", 10], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Turmeric Powder", 2], ["Cooking Oil", 15], ["Salt", 5], ["Kasuri Methi", 3], ["Curd", 20]],
  "cashew nut chicken curry": [["Chicken", 170], ["Cashews", 50], ["Onion", 40], ["Tomato", 40], ["Cream", 20], ["Ghee", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 20], ["Salt", 5], ["Turmeric Powder", 2]],
  "chicken maharani curry": [["Chicken", 170], ["Onion", 50], ["Tomato", 50], ["Cream", 30], ["Cashews", 15], ["Butter", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 20], ["Salt", 5], ["Turmeric Powder", 2]],
  "chicken curry": [["Chicken", 200], ["Onion", 75], ["Tomato", 75], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 20], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 5], ["Cumin Seeds", 3], ["Salt", 8]],
  "andhra chicken curry": [["Chicken", 200], ["Onion", 75], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 10], ["Red Chilli Powder", 10], ["Garam Masala", 5], ["Curry Leaves", 10], ["Cooking Oil", 20], ["Turmeric Powder", 3], ["Salt", 8], ["Cumin Seeds", 3]],
  "kadai chicken": [["Chicken", 200], ["Capsicum", 50], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Coriander Powder", 5], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Cooking Oil", 20], ["Salt", 5], ["Kasuri Methi", 3]],
  "gongura chicken": [["Chicken", 200], ["Gongura", 50], ["Onion", 50], ["Garlic", 10], ["Green Chilli", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Garam Masala", 3], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Salt", 5], ["Cumin Seeds", 3]],
  "fish curry": [["Fish", 200], ["Onion", 75], ["Tomato", 75], ["Ginger", 10], ["Garlic", 10], ["Tamarind", 15], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cooking Oil", 20], ["Salt", 5], ["Curry Leaves", 5], ["Cumin Seeds", 3]],
  "fish fry curry": [["Fish", 200], ["Onion", 50], ["Tomato", 30], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Garam Masala", 3], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Cornflour", 10]],
  "fish fry": [["Fish", 200], ["Onion", 30], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Cornflour", 15], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Lemon", 1]],
  "mughlai chicken": [["Chicken", 170], ["Onion", 50], ["Tomato", 50], ["Cream", 30], ["Cashews", 15], ["Ghee", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 15], ["Salt", 5], ["Curd", 20], ["Green Cardamom", 3]],
  "mughalai chicken curry": [["Chicken", 170], ["Onion", 50], ["Tomato", 50], ["Cream", 30], ["Cashews", 15], ["Ghee", 10], ["Garam Masala", 5], ["Ginger", 10], ["Garlic", 10], ["Cooking Oil", 15], ["Salt", 5], ["Curd", 20], ["Green Cardamom", 3]],
  "prawns fry": [["Prawns", 170], ["Onion", 50], ["Ginger", 10], ["Garlic", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Curry Leaves", 10], ["Cooking Oil", 30], ["Salt", 5], ["Cornflour", 10]],
  "prawns curry": [["Prawns", 170], ["Onion", 75], ["Tomato", 75], ["Ginger", 10], ["Garlic", 10], ["Tamarind", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Cooking Oil", 20], ["Salt", 5], ["Curry Leaves", 5], ["Cumin Seeds", 3]],
  "gongura prawns": [["Prawns", 170], ["Gongura", 50], ["Onion", 50], ["Garlic", 10], ["Green Chilli", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "mutton curry": [["Mutton", 200], ["Onion", 75], ["Tomato", 75], ["Ginger", 10], ["Garlic", 10], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 5], ["Cooking Oil", 20], ["Salt", 8], ["Cumin Seeds", 3]],
  "gongura mutton": [["Mutton", 200], ["Gongura", 50], ["Onion", 50], ["Garlic", 10], ["Green Chilli", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Garam Masala", 3], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "mutton kheema curry": [["Mutton", 170], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Green Peas", 30], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Coriander Powder", 5], ["Garam Masala", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "gongura mutton curry": [["Mutton", 200], ["Gongura", 50], ["Onion", 50], ["Tomato", 30], ["Garlic", 10], ["Green Chilli", 10], ["Red Chilli Powder", 5], ["Turmeric Powder", 3], ["Garam Masala", 3], ["Curry Leaves", 5], ["Cooking Oil", 20], ["Salt", 5]],
  "egg kheema curry": [["Egg", 3], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Green Chilli", 5], ["Turmeric Powder", 3], ["Red Chilli Powder", 5], ["Garam Masala", 3], ["Cooking Oil", 20], ["Salt", 5], ["Coriander Leaves", 5]],
  "kadai mutton curry": [["Mutton", 200], ["Capsicum", 50], ["Onion", 50], ["Tomato", 50], ["Ginger", 10], ["Garlic", 10], ["Coriander Powder", 5], ["Red Chilli Powder", 5], ["Garam Masala", 5], ["Cooking Oil", 20], ["Salt", 5], ["Kasuri Methi", 3]],

  // INDIAN BREADS
  "pulka": [["Atta", 80], ["Salt", 2]],
  "plain roti": [["Atta", 80], ["Salt", 2]],
  "butter roti": [["Atta", 80], ["Salt", 2], ["Butter", 10]],
  "plain naan": [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5]],
  "butter naan": [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Butter", 15]],
  "garlic naan": [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Butter", 15], ["Garlic", 10], ["Coriander Leaves", 5]],
  "methi naan": [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Butter", 15], ["Kasuri Methi", 5]],
  "methi paratha": [["Atta", 80], ["Salt", 2], ["Kasuri Methi", 5], ["Cooking Oil", 5]],
  "paneer kulcha": [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Paneer", 30], ["Coriander Leaves", 5]],
  "masala kulcha": [["Maida", 100], ["Salt", 2], ["Curd", 15], ["Cooking Oil", 5], ["Onion", 20], ["Coriander Leaves", 5], ["Green Chilli", 3]],

  // ICE CREAM
  "strawberry ice cream": [["Ice Cream", 100], ["Sugar", 10]],
  "vanilla ice cream": [["Ice Cream", 100], ["Sugar", 10]],
  "chocolate ice cream": [["Ice Cream", 100], ["Chocolate", 20], ["Sugar", 5]],
  "butterscotch ice cream": [["Ice Cream", 100], ["Sugar", 10], ["Butter", 5]],
  "butter scoh ice cream": [["Ice Cream", 100], ["Sugar", 10], ["Butter", 5]],
  "pista ice cream": [["Ice Cream", 100], ["Cashews", 10], ["Sugar", 5]],
  "mango ice cream": [["Ice Cream", 100], ["Sugar", 10]],
  "black currant ice cream": [["Ice Cream", 100], ["Sugar", 10]],
  "black current ice cream": [["Ice Cream", 100], ["Sugar", 10]],
  "american nuts ice cream": [["Ice Cream", 100], ["Cashews", 15], ["Sugar", 5]],
  "italian bounty ice cream": [["Ice Cream", 100], ["Chocolate", 15], ["Coconut", 10], ["Sugar", 5]],
  "caramel ice cream": [["Ice Cream", 100], ["Sugar", 15], ["Butter", 5]],
  "melto ice cream": [["Ice Cream", 100], ["Chocolate", 10], ["Sugar", 10]],

  // MILKSHAKES & LASSI
  "mango lassi": [["Curd", 100], ["Milk", 50], ["Sugar", 15]],
  "lassi": [["Curd", 100], ["Milk", 50], ["Sugar", 15]],
  "vanilla milkshake": [["Milk", 200], ["Ice Cream", 50], ["Sugar", 15]],
  "strawberry milkshake": [["Milk", 200], ["Ice Cream", 50], ["Sugar", 15]],
  "chocolate milkshake": [["Milk", 200], ["Ice Cream", 50], ["Chocolate", 20], ["Sugar", 10]],
  "chocklate milkshake": [["Milk", 200], ["Ice Cream", 50], ["Chocolate", 20], ["Sugar", 10]],
  "pista milkshake": [["Milk", 200], ["Ice Cream", 50], ["Cashews", 10], ["Sugar", 10]],
  "black currant milkshake": [["Milk", 200], ["Ice Cream", 50], ["Sugar", 10]],
  "black current milkshake": [["Milk", 200], ["Ice Cream", 50], ["Sugar", 10]],
  "mango milkshake": [["Milk", 200], ["Ice Cream", 50], ["Sugar", 15]],
  "butterscotch milkshake": [["Milk", 200], ["Ice Cream", 50], ["Butter", 5], ["Sugar", 10]],
  "butter soh milkshake": [["Milk", 200], ["Ice Cream", 50], ["Butter", 5], ["Sugar", 10]],
  "butter milk": [["Curd", 80], ["Salt", 3], ["Cumin Powder", 2], ["Curry Leaves", 3], ["Ginger", 5]],

  // DRINKS (non-alcoholic, non-pre-packaged)
  "fresh lime soda salt": [["Lemon", 1], ["Sugar", 5], ["Salt", 3]],
  "fresh lime soda sweet": [["Lemon", 1], ["Sugar", 20]],
  "fresh lime sweet & salt": [["Lemon", 1], ["Sugar", 10], ["Salt", 2]],
  "mojitho": [["Lemon", 1], ["Sugar", 10], ["Mint Leaves", 10]],
};

// ── Flagged dishes (uncertain recipes — need user confirmation) ──────────────
export const FLAGGED_DISHES: Record<string, string> = {
  "chicken afghani": "White-cream gravy variant vs green-curry variant. Current: cream+cashew+curd white gravy. Alternative: spinach+cream green gravy.",
  "chicken priya pasand": "House specialty — no standard recipe. Current: rich cream-cashew-butter gravy. Confirm actual preparation.",
  "chicken maharani": "House specialty — no standard recipe. Current: cream-cashew-butter gravy similar to mughlai. Confirm actual preparation.",
  "chicken maharani curry": "Same as chicken maharani — confirm recipe.",
  "kashmiri chicken": "Regional variation: saffron-cream vs red-coconut gravy. Current: saffron+cream+cashew. Alternative: red chilli+coconut milk.",
  "chicken shahi kurma": "Mughlai shahi kurma vs South Indian kurma. Current: cream+cashew+ghee Mughlai style. Alternative: coconut+poppy seed South Indian style.",
  "veg shahi kurma": "Same ambiguity as chicken shahi kurma.",
  "shahi kurma": "Same ambiguity as chicken shahi kurma.",
  "v grand special tandoori platter": "House special — composition varies. Current: mixed chicken+mutton platter. Confirm actual components.",
  "v grand spl cream of chicken soup": "House special — confirm actual recipe vs standard cream of chicken.",
  "v grans spl cream of chicken soup": "House special — confirm actual recipe vs standard cream of chicken.",
  "v grand spl chicken fried rice": "House special — confirm additional ingredients vs standard chicken fried rice.",
  "v grand spcl chicken fried rice": "House special — confirm additional ingredients vs standard chicken fried rice.",
};

// ── Pre-packaged items (no recipe needed) ────────────────────────────────────
export const PREPACKAGED_ITEMS = new Set([
  "water", "water bottel", "water bottle", "coke", "coca cola",
  "sprite", "limca", "thums up", "maaza", "pulpy orange", "soda",
]);

// ── Find a dish recipe by item name ──────────────────────────────────────────
export function findDishRecipe(
  itemName: string,
): { ingredients: IngredientEntry[]; flagged: boolean } | null {
  const normalized = normalizeDishName(itemName);

  // Check pre-packaged
  if (PREPACKAGED_ITEMS.has(normalized)) return null;

  // Check exact normalized match
  if (DISH_RECIPES[normalized]) {
    return { ingredients: DISH_RECIPES[normalized], flagged: normalized in FLAGGED_DISHES };
  }

  // Try without "starter" suffix (e.g. "fish fry starter" → "fish fry")
  const withoutStarter = normalized.replace(/\bstarter\b/g, "").trim();
  if (DISH_RECIPES[withoutStarter]) {
    return { ingredients: DISH_RECIPES[withoutStarter], flagged: withoutStarter in FLAGGED_DISHES };
  }

  // Try without "boneless" (boneless modifier is handled separately in generateRecipe)
  const withoutBoneless = normalized.replace(/\bboneless\b/g, "").trim();
  if (DISH_RECIPES[withoutBoneless]) {
    return { ingredients: DISH_RECIPES[withoutBoneless], flagged: withoutBoneless in FLAGGED_DISHES };
  }

  // Try without both "starter" and "boneless"
  const withoutBoth = withoutStarter.replace(/\bboneless\b/g, "").trim();
  if (DISH_RECIPES[withoutBoth]) {
    return { ingredients: DISH_RECIPES[withoutBoth], flagged: withoutBoth in FLAGGED_DISHES };
  }

  return null;
}

