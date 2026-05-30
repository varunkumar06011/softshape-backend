import { PrismaClient, TableStatus, MenuType } from "@prisma/client";

const prisma = new PrismaClient();
const BAR_ID = "bar-001";

const barFoodCategories = [
  {
    name: "Veg Soups", sortOrder: 0,
    items: [
      { name: "Tomato Soup", isVeg: true, variants: [{ name: "Regular", price: 150, isDefault: true }] },
      { name: "Sweet Corn Soup", isVeg: true, variants: [{ name: "Half", price: 160, isDefault: true }, { name: "Full", price: 180, isDefault: false }] },
      { name: "Manchow Soup", isVeg: true, variants: [{ name: "Half", price: 160, isDefault: true }, { name: "Full", price: 180, isDefault: false }] },
      { name: "Hot & Sour Soup", isVeg: true, variants: [{ name: "Half", price: 160, isDefault: true }, { name: "Full", price: 180, isDefault: false }] },
      { name: "Dragon Soup", isVeg: true, variants: [{ name: "Half", price: 160, isDefault: true }, { name: "Full", price: 180, isDefault: false }] },
    ]
  },
  {
    name: "Non Veg Soups", sortOrder: 1,
    items: [
      { name: "Sweet Corn Soup (NV)", isVeg: false, variants: [{ name: "Half", price: 170, isDefault: true }, { name: "Full", price: 190, isDefault: false }] },
      { name: "Manchow Soup (NV)", isVeg: false, variants: [{ name: "Half", price: 170, isDefault: true }, { name: "Full", price: 190, isDefault: false }] },
      { name: "Hot & Sour Soup (NV)", isVeg: false, variants: [{ name: "Half", price: 170, isDefault: true }, { name: "Full", price: 190, isDefault: false }] },
      { name: "Dragon Soup (NV)", isVeg: false, variants: [{ name: "Half", price: 170, isDefault: true }, { name: "Full", price: 190, isDefault: false }] },
      { name: "V Grand Spl Chicken Soup", isVeg: false, variants: [{ name: "Regular", price: 190, isDefault: true }] },
      { name: "Mutton Soup", isVeg: false, variants: [{ name: "Half", price: 200, isDefault: true }, { name: "Full", price: 220, isDefault: false }] },
    ]
  },
  {
    name: "Veg Snacks", sortOrder: 2,
    items: [
      { name: "Veg Manchurian", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "Crispy Corn", isVeg: true, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Finger Chips", isVeg: true, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Gobi Manchurian", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "Chilli Gobi", isVeg: true, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Gobi 65", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "Paneer Manchurian", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Chilli Paneer", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Paneer 65", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Paneer Mejestick", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "Mushroom Manchurian", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Chilli Mushroom", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Mushroom 65", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Pepper Mushroom", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "Mushroom Fry", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "Baby Corn Manchurian", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "Chilli Baby Corn", isVeg: true, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "Baby Corn 65", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
    ]
  },
  {
    name: "Non Veg Snacks", sortOrder: 3,
    items: [
      { name: "Egg Fry", isVeg: false, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Boiled Egg", isVeg: false, variants: [{ name: "Regular", price: 120, isDefault: true }] },
      { name: "Egg Burji", isVeg: false, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "Egg Roast", isVeg: false, variants: [{ name: "Regular", price: 120, isDefault: true }] },
      { name: "Chilli Egg", isVeg: false, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "Egg Manchurian", isVeg: false, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "Egg 65", isVeg: false, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "Velvet Egg", isVeg: false, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "Chicken Fry / Roast", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "Chilli Chicken", isVeg: false, variants: [{ name: "Bone", price: 330, isDefault: true }, { name: "Boneless", price: 350, isDefault: false }] },
      { name: "Chicken Manchurian", isVeg: false, variants: [{ name: "Regular", price: 340, isDefault: true }] },
      { name: "Chicken 65", isVeg: false, variants: [{ name: "Bone", price: 330, isDefault: true }, { name: "Boneless", price: 350, isDefault: false }] },
      { name: "Chicken Wings", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Chilli Wings", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Dragon Chicken", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "Chicken Lollipop", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "Chicken Drums", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Chicken Drumstick", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Pepper Chicken", isVeg: false, variants: [{ name: "Bone", price: 370, isDefault: true }, { name: "Boneless", price: 400, isDefault: false }] },
      { name: "Chicken Mejestick", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "Prawns Fry", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "Chilli Prawns", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "Loose Prawns", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "Golden Fried Prawns", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "Dragon Prawns", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "Velvet Prawns", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "Chilli Fish", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "Apollo Fish", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Fish Fry", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Tawa Fish", isVeg: false, variants: [{ name: "Regular", price: 399, isDefault: true }] },
      { name: "Chilli Mutton", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Mutton Fry", isVeg: false, variants: [{ name: "Regular", price: 480, isDefault: true }] },
      { name: "Basket Mutton", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
    ]
  },
  {
    name: "Tandoori", sortOrder: 4,
    items: [
      { name: "Tandoori Chicken", isVeg: false, variants: [{ name: "Half", price: 390, isDefault: true }, { name: "Full", price: 640, isDefault: false }] },
      { name: "Tangdi Kebab", isVeg: false, variants: [{ name: "Half", price: 280, isDefault: true }, { name: "Full", price: 500, isDefault: false }] },
      { name: "Chicken Tikka", isVeg: false, variants: [{ name: "Regular", price: 340, isDefault: true }] },
      { name: "Paneer Tikka", isVeg: true, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "Today Spl Tandoori", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
    ]
  },
  {
    name: "Veg Curries", sortOrder: 5,
    items: [
      { name: "Tomato Curry", isVeg: true, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "Methi Chaman", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Paneer Butter Masala", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Kadai Paneer", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Mixed Veg Curry", isVeg: true, variants: [{ name: "Regular", price: 250, isDefault: true }] },
      { name: "Veg Kheema Curry", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Mushroom Curry", isVeg: true, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "Cashewnut Curry", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Cashew Tomato Curry", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Cashew Paneer Curry", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
    ]
  },
  {
    name: "Non Veg Curries", sortOrder: 6,
    items: [
      { name: "Boiled Egg Curry", isVeg: false, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "Omlet Curry", isVeg: false, variants: [{ name: "Regular", price: 240, isDefault: true }] },
      { name: "Egg Kheema Curry", isVeg: false, variants: [{ name: "Regular", price: 250, isDefault: true }] },
      { name: "Chicken Curry", isVeg: false, variants: [{ name: "Bone", price: 350, isDefault: true }, { name: "Boneless", price: 370, isDefault: false }] },
      { name: "Andhra Chicken Curry", isVeg: false, variants: [{ name: "Bone", price: 350, isDefault: true }, { name: "Boneless", price: 370, isDefault: false }] },
      { name: "Kadai Chicken Curry", isVeg: false, variants: [{ name: "Bone", price: 350, isDefault: true }, { name: "Boneless", price: 370, isDefault: false }] },
      { name: "Cashew Chicken Curry", isVeg: false, variants: [{ name: "Boneless", price: 390, isDefault: true }] },
      { name: "Moghalai Chicken Curry", isVeg: false, variants: [{ name: "Boneless", price: 410, isDefault: true }] },
      { name: "Butter Chicken Curry", isVeg: false, variants: [{ name: "Bone", price: 370, isDefault: true }, { name: "Boneless", price: 390, isDefault: false }] },
      { name: "Prawns Curry", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "Fish Curry", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Mutton Curry", isVeg: false, variants: [{ name: "Regular", price: 480, isDefault: true }] },
      { name: "Andhra Mutton Curry", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Kadai Mutton Curry", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
    ]
  },
  {
    name: "Biryanis", sortOrder: 7,
    items: [
      { name: "Veg Biryani", isVeg: true, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "Spl Veg Biryani", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "Paneer Biryani", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "Mushroom Biryani", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "Cashewnut Biryani", isVeg: true, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "Boneless Chicken Biryani", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "Chicken Fry Biryani", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "Chicken Dum Biryani", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "Lollipop Biryani", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "Moghalai Chicken Biryani", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Dilkush Biryani", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Rambo Biryani", isVeg: false, variants: [{ name: "Regular", price: 400, isDefault: true }] },
      { name: "Raju Gari Biryani", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Tikka Biryani", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Prawns Biryani", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "Fish Biryani", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "Mutton Fry Biryani", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
      { name: "Mutton Dum Biryani", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
      { name: "Mutton Kheema Biryani", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
    ]
  },
  {
    name: "Rice Items", sortOrder: 8,
    items: [
      { name: "White Rice", isVeg: true, variants: [{ name: "Regular", price: 130, isDefault: true }] },
      { name: "Sambhar Rice", isVeg: true, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Curd Rice", isVeg: true, variants: [{ name: "Half", price: 170, isDefault: true }, { name: "Full", price: 180, isDefault: false }] },
      { name: "Spl Curd Rice", isVeg: true, variants: [{ name: "Half", price: 190, isDefault: true }, { name: "Full", price: 220, isDefault: false }] },
      { name: "Jeera Rice", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "Veg Fried Rice", isVeg: true, variants: [{ name: "Regular", price: 250, isDefault: true }] },
      { name: "Paneer Fried Rice", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Mushroom Fried Rice", isVeg: true, variants: [{ name: "Regular", price: 300, isDefault: true }] },
      { name: "Cashewnut Fried Rice", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Shezwan Veg Fried Rice", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Egg Fried Rice", isVeg: false, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "Shezwan Egg Fried Rice", isVeg: false, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "Chicken Fried Rice", isVeg: false, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Shezwan Chicken Fried Rice", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "V Grand Spl Chicken Fried Rice", isVeg: false, variants: [{ name: "Regular", price: 340, isDefault: true }] },
    ]
  },
  {
    name: "Noodles", sortOrder: 9,
    items: [
      { name: "Veg Noodles", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "Shezwan Veg Noodles", isVeg: true, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "Egg Noodles", isVeg: false, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Shezwan Egg Noodles", isVeg: false, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Chicken Noodles", isVeg: false, variants: [{ name: "Regular", price: 300, isDefault: true }] },
      { name: "Shezwan Chicken Noodles", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
    ]
  },
  {
    name: "Breads", sortOrder: 10,
    items: [
      { name: "Pulka", isVeg: true, variants: [{ name: "Regular", price: 50, isDefault: true }] },
      { name: "Plain Roti", isVeg: true, variants: [{ name: "Regular", price: 65, isDefault: true }] },
      { name: "Butter Roti", isVeg: true, variants: [{ name: "Regular", price: 80, isDefault: true }] },
      { name: "Plain Naan", isVeg: true, variants: [{ name: "Regular", price: 65, isDefault: true }] },
      { name: "Butter Naan", isVeg: true, variants: [{ name: "Regular", price: 80, isDefault: true }] },
      { name: "Garlic Naan", isVeg: true, variants: [{ name: "Regular", price: 85, isDefault: true }] },
      { name: "Masala Kulcha", isVeg: true, variants: [{ name: "Regular", price: 90, isDefault: true }] },
      { name: "Paneer Kulcha", isVeg: true, variants: [{ name: "Regular", price: 95, isDefault: true }] },
    ]
  },
];

const barLiquorCategories = [
  {
    name: "Brandy", sortOrder: 11,
    items: [
      { name: "Mansion House", variants: [{ name: "30ml", price: 58, isDefault: true }] },
      { name: "Mansion House Orange", variants: [{ name: "30ml", price: 63, isDefault: true }] },
      { name: "Morpheus", variants: [{ name: "30ml", price: 71, isDefault: true }] },
      { name: "Morpheus Blue", variants: [{ name: "30ml", price: 90, isDefault: true }] },
      { name: "Kyron", variants: [{ name: "30ml", price: 73, isDefault: true }] },
      { name: "Courier Napolean Red", variants: [{ name: "30ml", price: 62, isDefault: true }] },
      { name: "Courier Napolean Green", variants: [{ name: "30ml", price: 78, isDefault: true }] },
      { name: "Black & Gold", variants: [{ name: "30ml", price: 52, isDefault: true }] },
      { name: "MC Brandy", variants: [{ name: "30ml", price: 45, isDefault: true }] },
    ]
  },
  {
    name: "Whisky", sortOrder: 12,
    items: [
      { name: "Royal Stag", variants: [{ name: "30ml", price: 61, isDefault: true }] },
      { name: "Royal Challenge", variants: [{ name: "30ml", price: 61, isDefault: true }] },
      { name: "Royal Green", variants: [{ name: "30ml", price: 90, isDefault: true }] },
      { name: "Antiquity Blue", variants: [{ name: "30ml", price: 93, isDefault: true }] },
      { name: "8 PM Black", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "Aristo Superior", variants: [{ name: "30ml", price: 78, isDefault: true }] },
      { name: "Imperial Blue", variants: [{ name: "30ml", price: 48, isDefault: true }] },
      { name: "AC Premium", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "MC Whisky", variants: [{ name: "30ml", price: 48, isDefault: true }] },
      { name: "Sterling Reserve B7", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "Sterling Reserve B10", variants: [{ name: "30ml", price: 82, isDefault: true }] },
      { name: "Legacy", variants: [{ name: "30ml", price: 90, isDefault: true }] },
      { name: "Blenders Pride", variants: [{ name: "30ml", price: 92, isDefault: true }] },
      { name: "British Empire Whisky", variants: [{ name: "30ml", price: 58, isDefault: true }] },
      { name: "William Lawsons", variants: [{ name: "30ml", price: 145, isDefault: true }] },
      { name: "100 Pipers", variants: [{ name: "30ml", price: 166, isDefault: true }] },
      { name: "Teacher's Highland", variants: [{ name: "30ml", price: 161, isDefault: true }] },
      { name: "Black & White", variants: [{ name: "30ml", price: 162, isDefault: true }] },
      { name: "Signature", variants: [{ name: "30ml", price: 94, isDefault: true }] },
      { name: "Black Dog", variants: [{ name: "30ml", price: 169, isDefault: true }] },
      { name: "Ballantines", variants: [{ name: "30ml", price: 173, isDefault: true }] },
      { name: "VAT 69", variants: [{ name: "30ml", price: 146, isDefault: true }] },
      { name: "Red Label", variants: [{ name: "30ml", price: 183, isDefault: true }] },
      { name: "Black Label", variants: [{ name: "30ml", price: 330, isDefault: true }] },
      { name: "Johnnie Blonde", variants: [{ name: "30ml", price: 273, isDefault: true }] },
      { name: "Chivas Regal", variants: [{ name: "30ml", price: 350, isDefault: true }] },
    ]
  },
  {
    name: "Vodka", sortOrder: 13,
    items: [
      { name: "Magic Moment Orange", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "Magic Moment Green", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "Smirnoff Orange", variants: [{ name: "30ml", price: 78, isDefault: true }] },
      { name: "Absolut", variants: [{ name: "30ml", price: 170, isDefault: true }] },
    ]
  },
  {
    name: "Rum", sortOrder: 14,
    items: [
      { name: "Old Monk", variants: [{ name: "30ml", price: 56, isDefault: true }] },
    ]
  },
  {
    name: "Wine", sortOrder: 15,
    items: [
      { name: "Sidu's Red", variants: [{ name: "30ml", price: 43, isDefault: true }] },
      { name: "Elite Red", variants: [{ name: "30ml", price: 55, isDefault: true }] },
      { name: "Kyra Red", variants: [{ name: "30ml", price: 60, isDefault: true }] },
    ]
  },
  {
    name: "Beer", sortOrder: 16,
    items: [
      { name: "Brezer", variants: [{ name: "Bottle", price: 240, isDefault: true }] },
      { name: "Bacardi Brezer", variants: [{ name: "Bottle", price: 260, isDefault: true }] },
      { name: "KF Strong", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "KF Ultra", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "KF Storm", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "KF Lite", variants: [{ name: "Bottle", price: 310, isDefault: true }] },
      { name: "Kalyani Black Label", variants: [{ name: "Bottle", price: 330, isDefault: true }] },
      { name: "Karjura", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "British Empire Beer", variants: [{ name: "Bottle", price: 330, isDefault: true }] },
      { name: "Budweiser", variants: [{ name: "Bottle", price: 450, isDefault: true }] },
      { name: "Budweiser Magnum", variants: [{ name: "Bottle", price: 495, isDefault: true }] },
    ]
  },
];

async function main() {
  console.log("Seeding Bar data for bar-001...");

  // Delete orders and order items first to avoid foreign key constraint violations
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: BAR_ID } } });
  await prisma.order.deleteMany({ where: { restaurantId: BAR_ID } });
  
  await prisma.menuItemAddon.deleteMany({ where: { menuItem: { restaurantId: BAR_ID } } });
  await prisma.menuItemVariant.deleteMany({ where: { menuItem: { restaurantId: BAR_ID } } });
  await prisma.menuItem.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.category.deleteMany({ where: { restaurantId: BAR_ID } });

  let totalItems = 0;

  for (const cat of barFoodCategories) {
    const category = await prisma.category.create({
      data: { name: cat.name, sortOrder: cat.sortOrder, restaurantId: BAR_ID },
    });
    for (let i = 0; i < cat.items.length; i++) {
      const item = cat.items[i];
      await prisma.menuItem.create({
        data: {
          name: item.name,
          isVeg: item.isVeg,
          isAvailable: true,
          sortOrder: i,
          menuType: MenuType.FOOD,
          categoryId: category.id,
          restaurantId: BAR_ID,
          variants: { create: item.variants },
        },
      });
      totalItems++;
    }
  }

  // Cleanup: delete any existing non-30ml variants for LIQUOR items
  await prisma.menuItemVariant.deleteMany({
    where: {
      menuItem: { restaurantId: BAR_ID, menuType: MenuType.LIQUOR },
      name: { not: "30ml" }
    }
  });

  for (const cat of barLiquorCategories) {
    const category = await prisma.category.create({
      data: { name: cat.name, sortOrder: cat.sortOrder, restaurantId: BAR_ID },
    });
    for (let i = 0; i < cat.items.length; i++) {
      const item = cat.items[i];
      await prisma.menuItem.create({
        data: {
          name: item.name,
          isVeg: false,
          isAvailable: true,
          sortOrder: i,
          menuType: MenuType.LIQUOR,
          categoryId: category.id,
          restaurantId: BAR_ID,
          variants: { create: item.variants },
        },
      });
      totalItems++;
    }
  }

  console.log(`Seeded ${totalItems} bar menu items.`);

  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: BAR_ID } } });
  await prisma.order.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.table.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.section.deleteMany({ where: { restaurantId: BAR_ID } });

  const barHall = await prisma.section.create({
    data: { name: "Bar Hall", restaurantId: BAR_ID },
  });

  for (let i = 1; i <= 25; i++) {
    await prisma.table.create({
      data: {
        number: i,
        capacity: 4,
        status: TableStatus.AVAILABLE,
        sectionId: barHall.id,
        restaurantId: BAR_ID,
      },
    });
  }

  console.log('Seeded 1 section ("Bar Hall") and 25 bar tables.');
}

main()
  .catch((e) => { console.error(e); })
  .finally(async () => { await prisma.$disconnect(); });
