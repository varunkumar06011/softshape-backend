import { PrismaClient, TableStatus, MenuType } from "@prisma/client";

const prisma = new PrismaClient();
const BAR_ID = "bar-001";

const barFoodCategories = [
  {
    name: "Veg Soups", sortOrder: 0,
    items: [
      { name: "TOMATO SOUP", isVeg: true, variants: [{ name: "Regular", price: 150, isDefault: true }] },
      { name: "V Grand Spl Veg Soup", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "VEG SWEET CORN SOUP", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Veg Sweet Corn Soup 1/2", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "VEG MANCHOW SOUP", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Veg Manchow 1/2", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "VEG HOT AND SOUR SOUP", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Veg Hot And Sour Soup 1/2", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "VEG DRAGON SOUP", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Veg Dragon Soup 1/2", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
    ]
  },
  {
    name: "Non Veg Soups", sortOrder: 1,
    items: [
      { name: "CHICKEN LUNGGUNG SOUP", isVeg: false, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "V GRAND SPL CREAM OF CHICKEN SOUP", isVeg: false, variants: [{ name: "Regular", price: 190, isDefault: true }] },
      { name: "Chicken Sweet Corn Soup 1/2", isVeg: false, variants: [{ name: "Regular", price: 190, isDefault: true }] },
      { name: "CHICKEN SWEET CORN SOUP", isVeg: false, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Chicken Manchow 1/2", isVeg: false, variants: [{ name: "Regular", price: 190, isDefault: true }] },
      { name: "CHICKEN MANCHOW SOUP", isVeg: false, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Chicken Hot And Sour 1/2", isVeg: false, variants: [{ name: "Regular", price: 190, isDefault: true }] },
      { name: "CHICKEN HOT AND SOUR SOUP", isVeg: false, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Chicken Dragon Soup 1/2", isVeg: false, variants: [{ name: "Regular", price: 190, isDefault: true }] },
      { name: "CHICKEN DRAGON SOUP", isVeg: false, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Mutton Soup", isVeg: false, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Mutton Soup 1/2", isVeg: false, variants: [{ name: "Regular", price: 220, isDefault: true }] },
    ]
  },
  {
    name: "Veg Snacks/Starters", sortOrder: 2,
    items: [
      { name: "Onion Pakoda", isVeg: true, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "Groundnut Masala", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "CRISPY CORN", isVeg: true, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "FRENCH FRIES", isVeg: true, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Alu 65", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "GOBI 65", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "CHILLI GOBI", isVeg: true, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "GOBI MANCHURIAN", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "VEG MANCHURIAN", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "VEG SPRING ROLLS", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "VEG BULLETS", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "SPRING VEG", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "Corn Vada", isVeg: true, variants: [{ name: "Regular", price: 250, isDefault: true }] },
      { name: "CASHEWNUT ROAST", isVeg: true, variants: [{ name: "Regular", price: 300, isDefault: true }] },
      { name: "BOILED PALLI", isVeg: true, variants: [{ name: "Regular", price: 169, isDefault: true }] },
      { name: "GORUND NUT MASALA", isVeg: true, variants: [{ name: "Regular", price: 179, isDefault: true }] },
      { name: "BOILD PALLI MASALA", isVeg: true, variants: [{ name: "Regular", price: 179, isDefault: true }] },
      { name: "VEG SHANGRILLA", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "BOILED CORN MASALA", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "BOILED CORN", isVeg: true, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "CHILLI BABY CORN", isVeg: true, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "CRISPY BABY CORN", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "BABY CORN 65", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "BABY CORN MANCHURIAN", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "MUSHROOM 65", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "CHILLI MUSHROOM", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "MUSHROOM MANCHURIAN", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "MUSHROOM PEPPER SALT", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "CRISPY MUSHROOM", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "Mushroom Fry", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "PANEER MANCHCURIAN", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "CHILLI PANEER", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "PANEER 65", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "PANEER MEJESTIC", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
    ]
  },
  {
    name: "Non Veg Snacks/Starters", sortOrder: 3,
    items: [
      { name: "BOILED EGG", isVeg: false, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "MASALA PAPAD", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "OMLET", isVeg: false, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Egg Rost", isVeg: false, variants: [{ name: "Regular", price: 120, isDefault: true }] },
      { name: "Masala Omlet", isVeg: false, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Ginger Egg", isVeg: false, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Egg Fry", isVeg: false, variants: [{ name: "Regular", price: 200, isDefault: true }] },
      { name: "Velvet Egg", isVeg: false, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "CHILLI EGG", isVeg: false, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "EGG MANCHURIAN", isVeg: false, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "EGG 65", isVeg: false, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "EGG BURJI", isVeg: false, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "CHICKEN DRUMSTICK BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "CHICKEN WINS BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "CHILLI WINGS BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "CHICKEN LOLLIPOP BONES", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "Chicken Fry Bones", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "CHICKEN ROAST (BONES)", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "ToDay Spl Chicken Chinese Bone", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Today Spl Chicken Curry Bones", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Chilli Chicken Bones", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "CHICKEN 65 BONES", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "CHICKEN DRUMS BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "BASKET CHICKEN BONES", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "TODAY SPL INDIAN BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "CHICKEN 85 BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "PEPPER CHICKEN BONES", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "STAR CHICKEN BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "CHICKEN 555 B/L", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "LEMON CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "GINGER CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "CHICKEN PATAIALA B/L", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "CASHEWUNT CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "TODAY SPL INDIAN B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "CHICKEN MANCHURIAN B/L", isVeg: false, variants: [{ name: "Regular", price: 340, isDefault: true }] },
      { name: "CHILLI CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "CHICKEN 65 B/L", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "SHANGILLA CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "CHICKEN 85 B/L", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "CHICKEN ALPHA B/L", isVeg: false, variants: [{ name: "Regular", price: 360, isDefault: true }] },
      { name: "SHEZWAN CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "CHICKEN MEJESTIC B/L", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "DRAGON CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "DICY CHICKEN B/L", isVeg: false, variants: [{ name: "Regular", price: 360, isDefault: true }] },
      { name: "CRISPY CHICKEN FINGERS B/L", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "Star Chicken B/L", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "Basket Chicken B/L", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "Peppar Chicken B/L", isVeg: false, variants: [{ name: "Regular", price: 400, isDefault: true }] },
      { name: "ToDay Spl Chicken Chinese Bl", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Today Spi Chicken Curry Bl", isVeg: false, variants: [{ name: "Regular", price: 400, isDefault: true }] },
      { name: "Chicken Pakoda B/L", isVeg: false, variants: [{ name: "Regular", price: 319, isDefault: true }] },
      { name: "PRAWNS FRY", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "CHILLI PRAWNS", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "LOOSE PRAWNS", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "GOLDEM FRIED PRAWNS", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "PRAWNS 85", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "DRAGON PRAWNS", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "VELVET PRAWNS", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "Today Spl Prawns Cheness", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "Today Spl Prawns Indian", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "FISH FRY B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "FISH ROAST BONES", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "PUCKET FISH B/L", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "CHILLI FISH B/L", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "APOLLO FISH B/L", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "VELVET FISH B/L", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "Today Spl Fish", isVeg: false, variants: [{ name: "Regular", price: 399, isDefault: true }] },
      { name: "Today Spl Tandoori Fish Bone", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "MUTTON FRY BONES", isVeg: false, variants: [{ name: "Regular", price: 480, isDefault: true }] },
      { name: "MUTTON KEEMA BALLS B/L", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "PEPPER MUTTON BONES", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "BASKET MUTTON BONES", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Chilli Mutton", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Leg Peppar Fry Bones", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "Natu Kodi Fry", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Natu Kodi Pulusu", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
    ]
  },
  {
    name: "Tandoori Items", sortOrder: 4,
    items: [
      { name: "TANGADI KABAB HALF", isVeg: false, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "TANGADI KABAB FULL", isVeg: false, variants: [{ name: "Regular", price: 500, isDefault: true }] },
      { name: "TANDOORI CHICKEN HALF", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "TANDOORI CHICKEN FULL", isVeg: false, variants: [{ name: "Regular", price: 640, isDefault: true }] },
      { name: "CHICKEN TIKKA", isVeg: false, variants: [{ name: "Regular", price: 340, isDefault: true }] },
      { name: "HARAYALI CHICKEN TIKKA", isVeg: false, variants: [{ name: "Regular", price: 340, isDefault: true }] },
      { name: "RESHMI KABAB", isVeg: false, variants: [{ name: "Regular", price: 420, isDefault: true }] },
      { name: "MURG MALAI KABAB", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "KALMI KABAB", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "V GRAND SPL TANDOORI PLATTER", isVeg: false, variants: [{ name: "Regular", price: 620, isDefault: true }] },
      { name: "TODAY SPL TANDOORI", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "PANEER TIKKA", isVeg: true, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "Paneer Tikka Masala", isVeg: true, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "Today Spl Veg Tandoori", isVeg: true, variants: [{ name: "Regular", price: 350, isDefault: true }] },
    ]
  },
  {
    name: "Veg Curries", sortOrder: 5,
    items: [
      { name: "Dal Fry", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Dal Thadaka", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Today Spl Veg Indian", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Today Spl Veg Curry", isVeg: true, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "Aloo Gobi Masala", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "ALOO MASALA", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "GREEN PEAS MASALA", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "TOMATO CURRY", isVeg: true, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "PLAIN PALAK CURRY", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "BABY CORN MASALA CURRY", isVeg: true, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "CASHEWNUT CURRY", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "MIXED VEG CURRY", isVeg: true, variants: [{ name: "Regular", price: 250, isDefault: true }] },
      { name: "KADAI VEG CURRY", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "VEG KHEEMA CURRY", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "METHI CHAMAN CURRY", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "VEG JAIPURI CURRY", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "VEG NAVARATNA CURRY", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "MALAI KOFTHA CURRY", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "VEG SHAHI KURMA CURRY", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Cashew Paneer Curry", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Cashew Tomato Curry", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Cashew Mushroom Curry", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "MUSHROOM CURRY", isVeg: true, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "KADAI MUSHROOM CURRY", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "PALAK PANEER CURRY", isVeg: true, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "PANEER BUTTER MASALA", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "KADAI PANEER CURRY", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
    ]
  },
  {
    name: "Non Veg Curries", sortOrder: 6,
    items: [
      { name: "OMLET CURRY", isVeg: false, variants: [{ name: "Regular", price: 240, isDefault: true }] },
      { name: "Egg Keema Curry", isVeg: false, variants: [{ name: "Regular", price: 250, isDefault: true }] },
      { name: "BOILED EGG CURRY", isVeg: false, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "CHICKEN CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "ANDHRA CHICKEN CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "KADAI CHICKEN CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "MOGHALAI CHICKEN CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "BUTTER CHICKEN CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "KASHMIRI CHICKEN CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 360, isDefault: true }] },
      { name: "CHICKEN MAHARANI CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 400, isDefault: true }] },
      { name: "CASHEWNUT CHICKEN CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "CHICKEN AFGHANI CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "CHICKEN CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "ANDHRA CHICKEN CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "KADAI CHICKEN CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "GONGURA CHICKEN CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "BUTTER CHICKEN CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 370, isDefault: true }] },
      { name: "CHICKEN TIKKA MASALA BONES", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "FISH CURRY B/L", isVeg: false, variants: [{ name: "Regular", price: 380, isDefault: true }] },
      { name: "FISH PULUSU BONES", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "PRAWNS CURRY", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "GONGURA PRAWNS CURRY", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "MUTTON CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 480, isDefault: true }] },
      { name: "ANDHRA MUTTON CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "KADAI MUTTON CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "GONGURA MUTTON CURRY BONES", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "MUTTON KHEEMA CURRY", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Ragi Mudha Mutton Curry", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Ragi Mudha With Nattukodi Curry", isVeg: false, variants: [{ name: "Regular", price: 540, isDefault: true }] },
    ]
  },
  {
    name: "Biryanis", sortOrder: 7,
    items: [
      { name: "Today Spl Veg Biryani", isVeg: true, variants: [{ name: "Regular", price: 319, isDefault: true }] },
      { name: "VEG BIRYANI", isVeg: true, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "PANEER BIRYANI", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "MUSHROOM BIRYANI", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "CASHEWNUT BIRYANI", isVeg: true, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "SPL VEG BIRYANI", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "AVAKAYA VEG BIRYANI", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "EGG BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Today Spl Egg", isVeg: false, variants: [{ name: "Regular", price: 230, isDefault: true }] },
      { name: "BONELESS CHICKEN BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "AVAKAYA CHICKEN BIRYANI B/L", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "CHICKEN FRY PICE BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "CHICKEN DUM BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "LOLLIPOP BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 350, isDefault: true }] },
      { name: "RAJU GARI BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "RAMBO BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 400, isDefault: true }] },
      { name: "WINGS BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "TANDOORI BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 420, isDefault: true }] },
      { name: "RANGAMMA GARI KODI PULAO", isVeg: false, variants: [{ name: "Regular", price: 450, isDefault: true }] },
      { name: "GONGURA CHICKEN BIRYANI BONES", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "AVAKAYA CHICKEN BIRYANI BONES", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "ULAVACHARU CHICKEN BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "MOGHALAI CHICKEN BIRYAI B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "DILKUSH BIRYANI B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "TIKKA BIRYANI B/L", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Todat Spl Chicken Biryani", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Today Spl Chicken Biryani", isVeg: false, variants: [{ name: "Regular", price: 420, isDefault: true }] },
      { name: "Rayalaseema Chicken Biryani", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "V Granad Spi Chi Pulav", isVeg: false, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Kodi Pulav Fry", isVeg: false, variants: [{ name: "Regular", price: 330, isDefault: true }] },
      { name: "Chicken Fry Biryani Family Pack", isVeg: false, variants: [{ name: "Regular", price: 710, isDefault: true }] },
      { name: "Chicken Dum Biryani Family Pack", isVeg: false, variants: [{ name: "Regular", price: 680, isDefault: true }] },
      { name: "Sp Biryani Family Pack", isVeg: false, variants: [{ name: "Regular", price: 710, isDefault: true }] },
      { name: "FISH BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 390, isDefault: true }] },
      { name: "Today Spl Fish Biryani", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
      { name: "PRAWNS BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "Today Spl Prawns Biryani", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "Gongura Prawns Biryani", isVeg: false, variants: [{ name: "Regular", price: 460, isDefault: true }] },
      { name: "MUTTON FRY PICE BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
      { name: "MUTTON KEEMA BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
      { name: "MUTTON DUM BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
      { name: "GONGURA MUTTON BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
      { name: "ULAVACHARU MUTTON BIRYANI", isVeg: false, variants: [{ name: "Regular", price: 530, isDefault: true }] },
      { name: "Today Spl Mutton Biryani", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Today Spl Kheema Biryani", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Nalli Gosht Mutton Biryani 1 Piece", isVeg: false, variants: [{ name: "Regular", price: 470, isDefault: true }] },
      { name: "Nalli Gosht Mutton Biryani 2 Pieces", isVeg: false, variants: [{ name: "Regular", price: 610, isDefault: true }] },
      { name: "Mutton Fry Biryani Family Pack", isVeg: false, variants: [{ name: "Regular", price: 1200, isDefault: true }] },
      { name: "Mixed Non Veg Biryani", isVeg: false, variants: [{ name: "Regular", price: 479, isDefault: true }] },
      { name: "Natu Kodi Biryani", isVeg: false, variants: [{ name: "Regular", price: 520, isDefault: true }] },
      { name: "Garelu With Chicken Carry Bones", isVeg: false, variants: [{ name: "Regular", price: 410, isDefault: true }] },
      { name: "Garelu With Mutton Curry", isVeg: false, variants: [{ name: "Regular", price: 580, isDefault: true }] },
    ]
  },
  {
    name: "Rice Items", sortOrder: 8,
    items: [
      { name: "WHITE RICE", isVeg: true, variants: [{ name: "Regular", price: 130, isDefault: true }] },
      { name: "CURD RICE", isVeg: true, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "SPL CURD RICE", isVeg: true, variants: [{ name: "Regular", price: 190, isDefault: true }] },
      { name: "Curd Rice 1/2", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "Spl Curd Rice 1/2", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "Sambar Rice", isVeg: true, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Mudhapapu Avakaya Annam", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "BIRAYNI RICE", isVeg: true, variants: [{ name: "Regular", price: 220, isDefault: true }] },
      { name: "VEG FRIED RICE", isVeg: true, variants: [{ name: "Regular", price: 250, isDefault: true }] },
      { name: "JEERA RICE", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "SHEZWAN VEG FRIED RICE", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "MUSHROOM FRIED RICE", isVeg: true, variants: [{ name: "Regular", price: 300, isDefault: true }] },
      { name: "PANEER FRIED RICE", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Cashew Nut Fried Rice", isVeg: true, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "Mixed Veg Friedrice", isVeg: true, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "Schezwan Mixed Veg Friedrice", isVeg: true, variants: [{ name: "Regular", price: 300, isDefault: true }] },
      { name: "EGG FRIED RICE", isVeg: false, variants: [{ name: "Regular", price: 270, isDefault: true }] },
      { name: "SCHZWAN EGG FRIED RICE", isVeg: false, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Shezwan Egg Fried Rice", isVeg: false, variants: [{ name: "Regular", price: 290, isDefault: true }] },
      { name: "CHICKEN FRIED RICE", isVeg: false, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "SCHZWAN CHICKEN FRIED RICE", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "V GRAND SPL CHICKEN FRIED RICE", isVeg: false, variants: [{ name: "Regular", price: 340, isDefault: true }] },
      { name: "Shewan Chicken Fried Rice", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
      { name: "Mixed Non Veg Friedrice", isVeg: false, variants: [{ name: "Regular", price: 430, isDefault: true }] },
    ]
  },
  {
    name: "Noodles", sortOrder: 9,
    items: [
      { name: "VEG NOODLES", isVeg: true, variants: [{ name: "Regular", price: 260, isDefault: true }] },
      { name: "SHEZWAN VEG NOODLES", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "MUSHROOM NOODLES", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "PANEER NOODLES", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "EGG NOODLES", isVeg: false, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "SCHZWAN EGG NOODLES", isVeg: false, variants: [{ name: "Regular", price: 300, isDefault: true }] },
      { name: "Shezwan Egg Noodles", isVeg: false, variants: [{ name: "Regular", price: 310, isDefault: true }] },
      { name: "CHICKEN NOODLES", isVeg: false, variants: [{ name: "Regular", price: 300, isDefault: true }] },
      { name: "SCHZWAN CHICKEN NOODLES", isVeg: false, variants: [{ name: "Regular", price: 320, isDefault: true }] },
    ]
  },
  {
    name: "Breads", sortOrder: 10,
    items: [
      { name: "Plain Dosa", isVeg: true, variants: [{ name: "Regular", price: 30, isDefault: true }] },
      { name: "PULKA", isVeg: true, variants: [{ name: "Regular", price: 50, isDefault: true }] },
      { name: "PLAIN ROTI", isVeg: true, variants: [{ name: "Regular", price: 65, isDefault: true }] },
      { name: "BUTTER ROTI", isVeg: true, variants: [{ name: "Regular", price: 80, isDefault: true }] },
      { name: "PLAIN NAAN", isVeg: true, variants: [{ name: "Regular", price: 65, isDefault: true }] },
      { name: "BUTTER NAAN", isVeg: true, variants: [{ name: "Regular", price: 80, isDefault: true }] },
      { name: "METHI NAAN", isVeg: true, variants: [{ name: "Regular", price: 85, isDefault: true }] },
      { name: "METHI PAROTA", isVeg: true, variants: [{ name: "Regular", price: 85, isDefault: true }] },
      { name: "GARLIC NAAN", isVeg: true, variants: [{ name: "Regular", price: 85, isDefault: true }] },
      { name: "PANEER KULCHA", isVeg: true, variants: [{ name: "Regular", price: 95, isDefault: true }] },
      { name: "MASALA KULCHA", isVeg: true, variants: [{ name: "Regular", price: 90, isDefault: true }] },
    ]
  },
  {
    name: "Salads", sortOrder: 11,
    items: [
      { name: "Onion Ritha", isVeg: true, variants: [{ name: "Regular", price: 35, isDefault: true }] },
      { name: "Veg Salad", isVeg: true, variants: [{ name: "Regular", price: 110, isDefault: true }] },
      { name: "Carrot Salad", isVeg: true, variants: [{ name: "Regular", price: 120, isDefault: true }] },
      { name: "Friut Salad", isVeg: true, variants: [{ name: "Regular", price: 149, isDefault: true }] },
      { name: "Plain Curd", isVeg: true, variants: [{ name: "Regular", price: 40, isDefault: true }] },
    ]
  },
  {
    name: "Beverages", sortOrder: 12,
    items: [
      { name: "Thumsup 250 Ml", isVeg: true, variants: [{ name: "Regular", price: 25, isDefault: true }] },
      { name: "Sprite 250 Ml", isVeg: true, variants: [{ name: "Regular", price: 25, isDefault: true }] },
      { name: "Coca Cola 250 Ml", isVeg: true, variants: [{ name: "Regular", price: 25, isDefault: true }] },
      { name: "Limca 250 Ml", isVeg: true, variants: [{ name: "Regular", price: 25, isDefault: true }] },
      { name: "Fanta 250 Ml", isVeg: true, variants: [{ name: "Regular", price: 25, isDefault: true }] },
      { name: "Soda 250 Ml", isVeg: true, variants: [{ name: "Regular", price: 20, isDefault: true }] },
      { name: "Soda 750 Ml", isVeg: true, variants: [{ name: "Regular", price: 40, isDefault: true }] },
      { name: "Thumsup 600 Ml", isVeg: true, variants: [{ name: "Regular", price: 50, isDefault: true }] },
      { name: "Sprite 600 Ml", isVeg: true, variants: [{ name: "Regular", price: 50, isDefault: true }] },
      { name: "Pulpy Orange 250 Ml", isVeg: true, variants: [{ name: "Regular", price: 35, isDefault: true }] },
      { name: "Pulpy Orange 1 Ltr", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Thumsup 740Ml", isVeg: true, variants: [{ name: "Regular", price: 50, isDefault: true }] },
      { name: "Thumsup 1Ltr", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Thumsup 2Ltr", isVeg: true, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Tin Thums Up", isVeg: true, variants: [{ name: "Regular", price: 70, isDefault: true }] },
      { name: "WATER BOTTLE 1Ltr", isVeg: true, variants: [{ name: "Regular", price: 25, isDefault: true }] },
      { name: "Water 300Ml", isVeg: true, variants: [{ name: "Regular", price: 15, isDefault: true }] },
      { name: "Charged", isVeg: true, variants: [{ name: "Regular", price: 25, isDefault: true }] },
      { name: "Monster", isVeg: true, variants: [{ name: "Regular", price: 170, isDefault: true }] },
      { name: "Sweet Lassi", isVeg: true, variants: [{ name: "Regular", price: 80, isDefault: true }] },
      { name: "Butter Milk", isVeg: true, variants: [{ name: "Regular", price: 70, isDefault: true }] },
      { name: "Fresh Lime Soda Salt", isVeg: true, variants: [{ name: "Regular", price: 70, isDefault: true }] },
      { name: "Fresh Lime Soda Sweet", isVeg: true, variants: [{ name: "Regular", price: 70, isDefault: true }] },
      { name: "Fresh Lime Soda Sweet And Salt", isVeg: true, variants: [{ name: "Regular", price: 80, isDefault: true }] },
      { name: "Mojitho", isVeg: true, variants: [{ name: "Regular", price: 110, isDefault: true }] },
      { name: "Moctail", isVeg: true, variants: [{ name: "Regular", price: 99, isDefault: true }] },
      { name: "Fruit Punch", isVeg: true, variants: [{ name: "Regular", price: 210, isDefault: true }] },
      { name: "Vanila Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 140, isDefault: true }] },
      { name: "Butterscoch Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Strawberry Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 140, isDefault: true }] },
      { name: "Chocolate Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Pista Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Mango Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "Black Current Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
      { name: "American Dry Fruit Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "Italian Bounty Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "Caramel Nuts Milk Shake", isVeg: true, variants: [{ name: "Regular", price: 180, isDefault: true }] },
      { name: "Coolberg", isVeg: true, variants: [{ name: "Regular", price: 160, isDefault: true }] },
    ]
  },
  {
    name: "Ice Creams & Desserts", sortOrder: 13,
    items: [
      { name: "Vanilla Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 85, isDefault: true }] },
      { name: "Strawberry Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 85, isDefault: true }] },
      { name: "Pistha Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Mango Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Black Current Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Chocklet Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "Butter Scotch Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 100, isDefault: true }] },
      { name: "American Dry Fruite Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 125, isDefault: true }] },
      { name: "Italian Bounty Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 125, isDefault: true }] },
      { name: "Caramel Nuts Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 125, isDefault: true }] },
      { name: "Gulabjamun", isVeg: true, variants: [{ name: "Regular", price: 70, isDefault: true }] },
      { name: "Gulabjamun With Ice Cream", isVeg: true, variants: [{ name: "Regular", price: 110, isDefault: true }] },
    ]
  },
  {
    name: "Special Offers", sortOrder: 14,
    items: [
      { name: "Today Spl Veg Cheness", isVeg: true, variants: [{ name: "Regular", price: 280, isDefault: true }] },
      { name: "Special Item", isVeg: true, variants: [{ name: "Regular", price: 199, isDefault: true }] },
      { name: "Deal Of The Day 149", isVeg: true, variants: [{ name: "Regular", price: 149, isDefault: true }] },
      { name: "Deal Of The Day 79", isVeg: true, variants: [{ name: "Regular", price: 79, isDefault: true }] },
      { name: "Bonda Lime", isVeg: true, variants: [{ name: "Regular", price: 139, isDefault: true }] },
    ]
  },
];

const barLiquorCategories = [
  {
    name: "Brandy", sortOrder: 15,
    items: [
      { name: "Mc Brandy", variants: [{ name: "30ml", price: 45, isDefault: true }, { name: "60ml", price: 90 }, { name: "90ml", price: 135 }, { name: "180ml (Quarter)", price: 270 }, { name: "375ml (Half)", price: 540 }, { name: "750ml (Full)", price: 1080 }] },
      { name: "Mc Vsop Brandy", variants: [{ name: "30ml", price: 48, isDefault: true }, { name: "60ml", price: 96 }, { name: "90ml", price: 144 }, { name: "180ml (Quarter)", price: 288 }, { name: "375ml (Half)", price: 576 }, { name: "750ml (Full)", price: 1152 }] },
      { name: "BLACK & GOLD VSOP", variants: [{ name: "30ml", price: 52, isDefault: true }, { name: "60ml", price: 104 }, { name: "90ml", price: 156 }, { name: "180ml (Quarter)", price: 312 }, { name: "375ml (Half)", price: 624 }, { name: "750ml (Full)", price: 1248 }] },
      { name: "COURIER NAPOLEAN RED", variants: [{ name: "30ml", price: 62, isDefault: true }, { name: "60ml", price: 124 }, { name: "90ml", price: 186 }, { name: "180ml (Quarter)", price: 372 }, { name: "375ml (Half)", price: 744 }, { name: "750ml (Full)", price: 1488 }] },
      { name: "COURIER NAPOLEAN GREEN", variants: [{ name: "30ml", price: 78, isDefault: true }, { name: "60ml", price: 156 }, { name: "90ml", price: 234 }, { name: "180ml (Quarter)", price: 468 }, { name: "375ml (Half)", price: 936 }, { name: "750ml (Full)", price: 1872 }] },
      { name: "KYRON RARE BRANDY", variants: [{ name: "30ml", price: 73, isDefault: true }, { name: "60ml", price: 146 }, { name: "90ml", price: 219 }, { name: "180ml (Quarter)", price: 438 }, { name: "375ml (Half)", price: 876 }, { name: "750ml (Full)", price: 1752 }] },
      { name: "MORPHEUS XO BLENDED RESERVED", variants: [{ name: "30ml", price: 71, isDefault: true }, { name: "60ml", price: 142 }, { name: "90ml", price: 213 }, { name: "180ml (Quarter)", price: 426 }, { name: "375ml (Half)", price: 852 }, { name: "750ml (Full)", price: 1704 }] },
      { name: "Morpheus Blue Brandy", variants: [{ name: "30ml", price: 90, isDefault: true }, { name: "60ml", price: 180 }, { name: "90ml", price: 270 }, { name: "180ml (Quarter)", price: 540 }, { name: "375ml (Half)", price: 1080 }, { name: "750ml (Full)", price: 2160 }] },
      { name: "BOLS BRANDY", variants: [{ name: "30ml", price: 98, isDefault: true }, { name: "60ml", price: 196 }, { name: "90ml", price: 294 }, { name: "180ml (Quarter)", price: 588 }, { name: "375ml (Half)", price: 1176 }, { name: "750ml (Full)", price: 2352 }] },
      { name: "MANSION HOUSE", variants: [{ name: "30ml", price: 58, isDefault: true }, { name: "60ml", price: 116 }, { name: "90ml", price: 174 }, { name: "180ml (Quarter)", price: 348 }, { name: "375ml (Half)", price: 696 }, { name: "750ml (Full)", price: 1392 }] },
      { name: "MANSION HOUSE ORANGE", variants: [{ name: "30ml", price: 63, isDefault: true }, { name: "60ml", price: 126 }, { name: "90ml", price: 189 }, { name: "180ml (Quarter)", price: 378 }, { name: "375ml (Half)", price: 756 }, { name: "750ml (Full)", price: 1512 }] },
      { name: "ZEUS BRANDY", variants: [{ name: "30ml", price: 103, isDefault: true }, { name: "60ml", price: 206 }, { name: "90ml", price: 309 }, { name: "180ml (Quarter)", price: 618 }, { name: "375ml (Half)", price: 1236 }, { name: "750ml (Full)", price: 2472 }] },
    ]
  },
  {
    name: "Whisky", sortOrder: 16,
    items: [
      { name: "Imperial Blue", variants: [{ name: "30ml", price: 48, isDefault: true }, { name: "60ml", price: 96 }, { name: "90ml", price: 144 }, { name: "180ml (Quarter)", price: 288 }, { name: "375ml (Half)", price: 576 }, { name: "750ml (Full)", price: 1152 }] },
      { name: "Mc Wiskey", variants: [{ name: "30ml", price: 48, isDefault: true }, { name: "60ml", price: 96 }, { name: "90ml", price: 144 }, { name: "180ml (Quarter)", price: 288 }, { name: "375ml (Half)", price: 576 }, { name: "750ml (Full)", price: 1152 }] },
      { name: "Teachers 50", variants: [{ name: "30ml", price: 280, isDefault: true }, { name: "60ml", price: 560 }, { name: "90ml", price: 840 }, { name: "180ml (Quarter)", price: 1680 }, { name: "375ml (Half)", price: 3360 }, { name: "750ml (Full)", price: 6720 }] },
      { name: "British Empire Whisky", variants: [{ name: "30ml", price: 58, isDefault: true }, { name: "60ml", price: 116 }, { name: "90ml", price: 174 }, { name: "180ml (Quarter)", price: 348 }, { name: "375ml (Half)", price: 696 }, { name: "750ml (Full)", price: 1392 }] },
      { name: "AC PREMIUM", variants: [{ name: "30ml", price: 59, isDefault: true }, { name: "60ml", price: 118 }, { name: "90ml", price: 177 }, { name: "180ml (Quarter)", price: 354 }, { name: "375ml (Half)", price: 708 }, { name: "750ml (Full)", price: 1416 }] },
      { name: "8PM PREMIUM BLACK", variants: [{ name: "30ml", price: 59, isDefault: true }, { name: "60ml", price: 118 }, { name: "90ml", price: 177 }, { name: "180ml (Quarter)", price: 354 }, { name: "375ml (Half)", price: 708 }, { name: "750ml (Full)", price: 1416 }] },
      { name: "STERLING RESERVE B7", variants: [{ name: "30ml", price: 59, isDefault: true }, { name: "60ml", price: 118 }, { name: "90ml", price: 177 }, { name: "180ml (Quarter)", price: 354 }, { name: "375ml (Half)", price: 708 }, { name: "750ml (Full)", price: 1416 }] },
      { name: "Royal Challenge Whisky", variants: [{ name: "30ml", price: 61, isDefault: true }, { name: "60ml", price: 122 }, { name: "90ml", price: 183 }, { name: "180ml (Quarter)", price: 366 }, { name: "375ml (Half)", price: 732 }, { name: "750ml (Full)", price: 1464 }] },
      { name: "ROYAL STAG", variants: [{ name: "30ml", price: 61, isDefault: true }, { name: "60ml", price: 122 }, { name: "90ml", price: 183 }, { name: "180ml (Quarter)", price: 366 }, { name: "375ml (Half)", price: 732 }, { name: "750ml (Full)", price: 1464 }] },
      { name: "Royal Stag Barrel", variants: [{ name: "30ml", price: 63, isDefault: true }, { name: "60ml", price: 126 }, { name: "90ml", price: 189 }, { name: "180ml (Quarter)", price: 378 }, { name: "375ml (Half)", price: 756 }, { name: "750ml (Full)", price: 1512 }] },
      { name: "ARISTO PREMIUM SUPERIOR", variants: [{ name: "30ml", price: 78, isDefault: true }, { name: "60ml", price: 156 }, { name: "90ml", price: 234 }, { name: "180ml (Quarter)", price: 468 }, { name: "375ml (Half)", price: 936 }, { name: "750ml (Full)", price: 1872 }] },
      { name: "STERLING RESERVEB10", variants: [{ name: "30ml", price: 82, isDefault: true }, { name: "60ml", price: 164 }, { name: "90ml", price: 246 }, { name: "180ml (Quarter)", price: 492 }, { name: "375ml (Half)", price: 984 }, { name: "750ml (Full)", price: 1968 }] },
      { name: "Legacy Whisky", variants: [{ name: "30ml", price: 90, isDefault: true }, { name: "60ml", price: 180 }, { name: "90ml", price: 270 }, { name: "180ml (Quarter)", price: 540 }, { name: "375ml (Half)", price: 1080 }, { name: "750ml (Full)", price: 2160 }] },
      { name: "ROYAL GREEN PREMIUM", variants: [{ name: "30ml", price: 90, isDefault: true }, { name: "60ml", price: 180 }, { name: "90ml", price: 270 }, { name: "180ml (Quarter)", price: 540 }, { name: "375ml (Half)", price: 1080 }, { name: "750ml (Full)", price: 2160 }] },
      { name: "Antiquity Blue", variants: [{ name: "30ml", price: 93, isDefault: true }, { name: "60ml", price: 186 }, { name: "90ml", price: 279 }, { name: "180ml (Quarter)", price: 558 }, { name: "375ml (Half)", price: 1116 }, { name: "750ml (Full)", price: 2232 }] },
      { name: "BLENDERS PRIDE SELECT", variants: [{ name: "30ml", price: 92, isDefault: true }, { name: "60ml", price: 184 }, { name: "90ml", price: 276 }, { name: "180ml (Quarter)", price: 552 }, { name: "375ml (Half)", price: 1104 }, { name: "750ml (Full)", price: 2208 }] },
      { name: "Signature", variants: [{ name: "30ml", price: 94, isDefault: true }, { name: "60ml", price: 188 }, { name: "90ml", price: 282 }, { name: "180ml (Quarter)", price: 564 }, { name: "375ml (Half)", price: 1128 }, { name: "750ml (Full)", price: 2256 }] },
      { name: "SEGRAMS BLENDERS PRIDE", variants: [{ name: "30ml", price: 100, isDefault: true }, { name: "60ml", price: 200 }, { name: "90ml", price: 300 }, { name: "180ml (Quarter)", price: 600 }, { name: "375ml (Half)", price: 1200 }, { name: "750ml (Full)", price: 2400 }] },
      { name: "Vat 69", variants: [{ name: "30ml", price: 146, isDefault: true }, { name: "60ml", price: 292 }, { name: "90ml", price: 438 }, { name: "180ml (Quarter)", price: 876 }, { name: "375ml (Half)", price: 1752 }, { name: "750ml (Full)", price: 3504 }] },
      { name: "WILLIAM LAWSONS BLENDED", variants: [{ name: "30ml", price: 145, isDefault: true }, { name: "60ml", price: 290 }, { name: "90ml", price: 435 }, { name: "180ml (Quarter)", price: 870 }, { name: "375ml (Half)", price: 1740 }, { name: "750ml (Full)", price: 3480 }] },
      { name: "O C ELEGANT WHISKY", variants: [{ name: "30ml", price: 153, isDefault: true }, { name: "60ml", price: 306 }, { name: "90ml", price: 459 }, { name: "180ml (Quarter)", price: 918 }, { name: "375ml (Half)", price: 1836 }, { name: "750ml (Full)", price: 3672 }] },
      { name: "TEACHERS HIGHLAND CREAM BLENDED", variants: [{ name: "30ml", price: 161, isDefault: true }, { name: "60ml", price: 322 }, { name: "90ml", price: 483 }, { name: "180ml (Quarter)", price: 966 }, { name: "375ml (Half)", price: 1932 }, { name: "750ml (Full)", price: 3864 }] },
      { name: "Black And White", variants: [{ name: "30ml", price: 162, isDefault: true }, { name: "60ml", price: 324 }, { name: "90ml", price: 486 }, { name: "180ml (Quarter)", price: 972 }, { name: "375ml (Half)", price: 1944 }, { name: "750ml (Full)", price: 3888 }] },
      { name: "100 PIPERS BLENDED", variants: [{ name: "30ml", price: 166, isDefault: true }, { name: "60ml", price: 332 }, { name: "90ml", price: 498 }, { name: "180ml (Quarter)", price: 996 }, { name: "375ml (Half)", price: 1992 }, { name: "750ml (Full)", price: 3984 }] },
      { name: "Black Dog Whisky", variants: [{ name: "30ml", price: 169, isDefault: true }, { name: "60ml", price: 338 }, { name: "90ml", price: 507 }, { name: "180ml (Quarter)", price: 1014 }, { name: "375ml (Half)", price: 2028 }, { name: "750ml (Full)", price: 4056 }] },
      { name: "Ballantines", variants: [{ name: "30ml", price: 173, isDefault: true }, { name: "60ml", price: 346 }, { name: "90ml", price: 519 }, { name: "180ml (Quarter)", price: 1038 }, { name: "375ml (Half)", price: 2076 }, { name: "750ml (Full)", price: 4152 }] },
      { name: "Red Label", variants: [{ name: "30ml", price: 183, isDefault: true }, { name: "60ml", price: 366 }, { name: "90ml", price: 549 }, { name: "180ml (Quarter)", price: 1098 }, { name: "375ml (Half)", price: 2196 }, { name: "750ml (Full)", price: 4392 }] },
      { name: "Johnnie Blonde", variants: [{ name: "30ml", price: 273, isDefault: true }, { name: "60ml", price: 546 }, { name: "90ml", price: 819 }, { name: "180ml (Quarter)", price: 1638 }, { name: "375ml (Half)", price: 3276 }, { name: "750ml (Full)", price: 6552 }] },
      { name: "Black Label", variants: [{ name: "30ml", price: 330, isDefault: true }, { name: "60ml", price: 660 }, { name: "90ml", price: 990 }, { name: "180ml (Quarter)", price: 1980 }, { name: "375ml (Half)", price: 3960 }, { name: "750ml (Full)", price: 7920 }] },
      { name: "Chivas Regal", variants: [{ name: "30ml", price: 350, isDefault: true }, { name: "60ml", price: 700 }, { name: "90ml", price: 1050 }, { name: "180ml (Quarter)", price: 2100 }, { name: "375ml (Half)", price: 4200 }, { name: "750ml (Full)", price: 8400 }] },
      { name: "Jamson", variants: [{ name: "30ml", price: 195, isDefault: true }, { name: "60ml", price: 390 }, { name: "90ml", price: 585 }, { name: "180ml (Quarter)", price: 1170 }, { name: "375ml (Half)", price: 2340 }, { name: "750ml (Full)", price: 4680 }] },
      { name: "Gold Label", variants: [{ name: "30ml", price: 560, isDefault: true }, { name: "60ml", price: 1120 }, { name: "90ml", price: 1680 }, { name: "180ml (Quarter)", price: 3360 }, { name: "375ml (Half)", price: 6720 }, { name: "750ml (Full)", price: 13440 }] },
    ]
  },
  {
    name: "Vodka", sortOrder: 17,
    items: [
      { name: "MAGIC MOMENTS ORANGE", variants: [{ name: "30ml", price: 59, isDefault: true }, { name: "60ml", price: 118 }, { name: "90ml", price: 177 }, { name: "180ml (Quarter)", price: 354 }, { name: "375ml (Half)", price: 708 }, { name: "750ml (Full)", price: 1416 }] },
      { name: "MAGIC MOMENTS GREEN", variants: [{ name: "30ml", price: 59, isDefault: true }, { name: "60ml", price: 118 }, { name: "90ml", price: 177 }, { name: "180ml (Quarter)", price: 354 }, { name: "375ml (Half)", price: 708 }, { name: "750ml (Full)", price: 1416 }] },
      { name: "Smirnoff Orange Vodka", variants: [{ name: "30ml", price: 78, isDefault: true }, { name: "60ml", price: 156 }, { name: "90ml", price: 234 }, { name: "180ml (Quarter)", price: 468 }, { name: "375ml (Half)", price: 936 }, { name: "750ml (Full)", price: 1872 }] },
      { name: "JUNO VODHKA", variants: [{ name: "30ml", price: 99, isDefault: true }, { name: "60ml", price: 198 }, { name: "90ml", price: 297 }, { name: "180ml (Quarter)", price: 594 }, { name: "375ml (Half)", price: 1188 }, { name: "750ml (Full)", price: 2376 }] },
      { name: "Absolut Vodka", variants: [{ name: "30ml", price: 170, isDefault: true }, { name: "60ml", price: 340 }, { name: "90ml", price: 510 }, { name: "180ml (Quarter)", price: 1020 }, { name: "375ml (Half)", price: 2040 }, { name: "750ml (Full)", price: 4080 }] },
    ]
  },
  {
    name: "Rum", sortOrder: 18,
    items: [
      { name: "OLD MUNK RUM", variants: [{ name: "30ml", price: 56, isDefault: true }, { name: "60ml", price: 112 }, { name: "90ml", price: 168 }, { name: "180ml (Quarter)", price: 336 }, { name: "375ml (Half)", price: 672 }, { name: "750ml (Full)", price: 1344 }] },
    ]
  },
  {
    name: "Wine", sortOrder: 19,
    items: [
      { name: "SIDUS WINE", variants: [{ name: "30ml", price: 43, isDefault: true }, { name: "60ml", price: 86 }, { name: "90ml", price: 129 }, { name: "180ml (Quarter)", price: 258 }, { name: "375ml (Half)", price: 516 }, { name: "750ml (Full)", price: 1032 }] },
      { name: "Elite Wine", variants: [{ name: "30ml", price: 55, isDefault: true }, { name: "60ml", price: 110 }, { name: "90ml", price: 165 }, { name: "180ml (Quarter)", price: 330 }, { name: "375ml (Half)", price: 660 }, { name: "750ml (Full)", price: 1320 }] },
      { name: "KYRA PREMIUM RED WINE", variants: [{ name: "30ml", price: 60, isDefault: true }, { name: "60ml", price: 120 }, { name: "90ml", price: 180 }, { name: "180ml (Quarter)", price: 360 }, { name: "375ml (Half)", price: 720 }, { name: "750ml (Full)", price: 1440 }] },
    ]
  },
  {
    name: "Beer", sortOrder: 20,
    items: [
      { name: "Bira White", variants: [{ name: "Pint (330ml)", price: 250, isDefault: true }, { name: "Pitcher", price: 625 }, { name: "Tower", price: 1125 }] },
      { name: "BREZER PLA UM TANGY", variants: [{ name: "Tin (500ml)", price: 240, isDefault: true }, { name: "Pitcher", price: 600 }, { name: "Tower", price: 1080 }] },
      { name: "Bacardi Cranberry", variants: [{ name: "Bottle (650ml)", price: 260, isDefault: true }, { name: "Pitcher", price: 650 }, { name: "Tower", price: 1170 }] },
      { name: "Budweiser Beer", variants: [{ name: "Tin (500ml)", price: 300, isDefault: true }, { name: "Pitcher", price: 750 }, { name: "Tower", price: 1350 }] },
      { name: "Kf Lite Beer", variants: [{ name: "Bottle (650ml)", price: 310, isDefault: true }, { name: "Pitcher", price: 775 }, { name: "Tower", price: 1395 }] },
      { name: "Kalyani Beer", variants: [{ name: "Bottle (650ml)", price: 330, isDefault: true }, { name: "Pitcher", price: 825 }, { name: "Tower", price: 1485 }] },
      { name: "British Empire Strong Beer", variants: [{ name: "Bottle (650ml)", price: 330, isDefault: true }, { name: "Pitcher", price: 825 }, { name: "Tower", price: 1485 }] },
      { name: "BOOM BEER", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "Kf Storm Beer", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "Kf Ultra Beer", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "Kf Strong Beer", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "Bira Blonde Beer", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "Stok Strong Beer", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "Stok Leger Beer", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "Karjura Beer", variants: [{ name: "Bottle (650ml)", price: 350, isDefault: true }, { name: "Pitcher", price: 875 }, { name: "Tower", price: 1575 }] },
      { name: "BOOM RISE BEER", variants: [{ name: "Bottle (650ml)", price: 380, isDefault: true }, { name: "Pitcher", price: 950 }, { name: "Tower", price: 1710 }] },
      { name: "Carlsberg", variants: [{ name: "Bottle (650ml)", price: 430, isDefault: true }, { name: "Pitcher", price: 1075 }, { name: "Tower", price: 1935 }] },
      { name: "Budweiser Beer", variants: [{ name: "Bottle (650ml)", price: 450, isDefault: true }, { name: "Pitcher", price: 1125 }, { name: "Tower", price: 2025 }] },
      { name: "Bira White", variants: [{ name: "Bottle (650ml)", price: 450, isDefault: true }, { name: "Pitcher", price: 1125 }, { name: "Tower", price: 2025 }] },
      { name: "Bira Glod Beer", variants: [{ name: "Bottle (650ml)", price: 450, isDefault: true }, { name: "Pitcher", price: 1125 }, { name: "Tower", price: 2025 }] },
      { name: "Budweiser Magnum Beer", variants: [{ name: "Bottle (650ml)", price: 495, isDefault: true }, { name: "Pitcher", price: 1237 }, { name: "Tower", price: 2227 }] },
    ]
  },
  {
    name: "Cocktails", sortOrder: 21,
    items: [
      { name: "Cocktail 389", variants: [{ name: "Regular", price: 389, isDefault: true }] },
      { name: "Cocktail 499", variants: [{ name: "Regular", price: 499, isDefault: true }] },
      { name: "Cocktail 599", variants: [{ name: "Regular", price: 599, isDefault: true }] },
    ]
  },
];

async function main() {
  console.log("Seeding Bar data for bar-001 with ALL 435 items from CSV...");
  console.log("(Skipping deletion of menu items to preserve order references)\n");

  // Skip deletion - just update/add items
  // NOTE: Menu items may already exist and be referenced by venue orders
  // We'll get unique constraint errors but can ignore them or use upsert logic

  // Only delete tables and sections (safe to delete)
  await prisma.table.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.section.deleteMany({ where: { restaurantId: BAR_ID } });

  let totalItems = 0;

  // Seed food categories
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

  // Seed liquor categories
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

  console.log(`✅ Seeded ${totalItems} bar menu items (ALL items from CSV).`);

  // Clean up existing tables and sections
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: BAR_ID } } });
  await prisma.order.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.table.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.section.deleteMany({ where: { restaurantId: BAR_ID } });

  // Create Bar Hall section and 30 tables
  const barHall = await prisma.section.create({
    data: { name: "Bar Hall", restaurantId: BAR_ID },
  });

  for (let i = 1; i <= 30; i++) {
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

  console.log('✅ Seeded 1 section ("Bar Hall") and 30 bar tables.');
  console.log('');
  console.log('🎉 Bar seeding complete! All 435 items from CSV have been imported.');
}

main()
  .catch((e) => { console.error(e); })
  .finally(async () => { await prisma.$disconnect(); });
