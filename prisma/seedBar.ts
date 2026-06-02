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
      { name: "Mc Brandy 30Ml", variants: [{ name: "30ml", price: 45, isDefault: true }] },
      { name: "Mc Vsop Brandy 30Ml", variants: [{ name: "30ml", price: 48, isDefault: true }] },
      { name: "BLACK & GOLD VSOP 30ML", variants: [{ name: "30ml", price: 52, isDefault: true }] },
      { name: "COURIER NAPOLEAN RED 30ML", variants: [{ name: "30ml", price: 62, isDefault: true }] },
      { name: "COURIER NAPOLEAN GREEN 30ML", variants: [{ name: "30ml", price: 78, isDefault: true }] },
      { name: "KYRON RARE BRANDY 30ML", variants: [{ name: "30ml", price: 73, isDefault: true }] },
      { name: "MORPHEUS XO BLENDED RESERVED 30ML", variants: [{ name: "30ml", price: 71, isDefault: true }] },
      { name: "Morpheus Blue Brandy 30Ml", variants: [{ name: "30ml", price: 90, isDefault: true }] },
      { name: "BOLS BRANDY 30ML", variants: [{ name: "30ml", price: 98, isDefault: true }] },
      { name: "MANSION HOUSE 30ML", variants: [{ name: "30ml", price: 58, isDefault: true }] },
      { name: "MANSION HOUSE ORANGE 30ML", variants: [{ name: "30ml", price: 63, isDefault: true }] },
      { name: "ZEUS BRANDY 30ML", variants: [{ name: "30ml", price: 103, isDefault: true }] },
    ]
  },
  {
    name: "Whisky", sortOrder: 16,
    items: [
      { name: "Imperial Blue", variants: [{ name: "30ml", price: 48, isDefault: true }] },
      { name: "Mc Wiskey 30Ml", variants: [{ name: "30ml", price: 48, isDefault: true }] },
      { name: "Teachers 50 30Ml", variants: [{ name: "30ml", price: 280, isDefault: true }] },
      { name: "British Empire Whisky", variants: [{ name: "30ml", price: 58, isDefault: true }] },
      { name: "AC PREMIUM 30ML", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "8PM PREMIUM BLACK 30ML", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "STERLING RESERVE B7 30ML", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "Royal Challenge Whisky 30 Ml", variants: [{ name: "30ml", price: 61, isDefault: true }] },
      { name: "ROYAL STAG 30ML", variants: [{ name: "30ml", price: 61, isDefault: true }] },
      { name: "Royal Stag Barrel 30Ml", variants: [{ name: "30ml", price: 63, isDefault: true }] },
      { name: "ARISTO PREMIUM SUPERIOR 30ML", variants: [{ name: "30ml", price: 78, isDefault: true }] },
      { name: "STERLING RESERVEB10 30ML", variants: [{ name: "30ml", price: 82, isDefault: true }] },
      { name: "Legacy Whisky 30Ml", variants: [{ name: "30ml", price: 90, isDefault: true }] },
      { name: "ROYAL GREEN PREMIUM 30ML", variants: [{ name: "30ml", price: 90, isDefault: true }] },
      { name: "Antiquity Blue 30Ml", variants: [{ name: "30ml", price: 93, isDefault: true }] },
      { name: "BLENDERS PRIDE SELECT 30ML", variants: [{ name: "30ml", price: 92, isDefault: true }] },
      { name: "Signature 30Ml", variants: [{ name: "30ml", price: 94, isDefault: true }] },
      { name: "SEGRAMS BLENDERS PRIDE 30ML", variants: [{ name: "30ml", price: 100, isDefault: true }] },
      { name: "Vat 69 30Ml", variants: [{ name: "30ml", price: 146, isDefault: true }] },
      { name: "WILLIAM LAWSONS BLENDED 30ML", variants: [{ name: "30ml", price: 145, isDefault: true }] },
      { name: "O C ELEGANT WHISKY 30ML", variants: [{ name: "30ml", price: 153, isDefault: true }] },
      { name: "TEACHERS HIGHLAND CREAM BLENDED 30ML", variants: [{ name: "30ml", price: 161, isDefault: true }] },
      { name: "Black And White 30Ml", variants: [{ name: "30ml", price: 162, isDefault: true }] },
      { name: "100 PIPERS BLENDED 30ML", variants: [{ name: "30ml", price: 166, isDefault: true }] },
      { name: "Black Dog Whisky 30 Ml", variants: [{ name: "30ml", price: 169, isDefault: true }] },
      { name: "Ballantines 30Ml", variants: [{ name: "30ml", price: 173, isDefault: true }] },
      { name: "Red Label 30Ml", variants: [{ name: "30ml", price: 183, isDefault: true }] },
      { name: "Johnnie Blonde 30Ml", variants: [{ name: "30ml", price: 273, isDefault: true }] },
      { name: "Black Label", variants: [{ name: "30ml", price: 330, isDefault: true }] },
      { name: "Chivas Regal", variants: [{ name: "30ml", price: 350, isDefault: true }] },
      { name: "Jamson 30Ml", variants: [{ name: "30ml", price: 195, isDefault: true }] },
      { name: "Gold Label 30Ml", variants: [{ name: "30ml", price: 560, isDefault: true }] },
    ]
  },
  {
    name: "Vodka", sortOrder: 17,
    items: [
      { name: "MAGIC MOMENTS ORANGE 30ML", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "MAGIC MOMENTS GREEN 30ML", variants: [{ name: "30ml", price: 59, isDefault: true }] },
      { name: "Smirnoff Orange Vodka 30Ml", variants: [{ name: "30ml", price: 78, isDefault: true }] },
      { name: "JUNO VODHKA 30ML", variants: [{ name: "30ml", price: 99, isDefault: true }] },
      { name: "Absolut Vodka 30Ml", variants: [{ name: "30ml", price: 170, isDefault: true }] },
    ]
  },
  {
    name: "Rum", sortOrder: 18,
    items: [
      { name: "OLD MUNK RUM 30ML", variants: [{ name: "30ml", price: 56, isDefault: true }] },
    ]
  },
  {
    name: "Wine", sortOrder: 19,
    items: [
      { name: "SIDUS WINE 30ML", variants: [{ name: "30ml", price: 43, isDefault: true }] },
      { name: "Elite Wine 30Ml", variants: [{ name: "30ml", price: 55, isDefault: true }] },
      { name: "KYRA PREMIUM RED WINE 30ML", variants: [{ name: "30ml", price: 60, isDefault: true }] },
    ]
  },
  {
    name: "Beer", sortOrder: 20,
    items: [
      { name: "Bira White Small 330 Ml", variants: [{ name: "Bottle", price: 250, isDefault: true }] },
      { name: "BREZER PLATINUM TANGY", variants: [{ name: "Bottle", price: 240, isDefault: true }] },
      { name: "Bacardi Cranberry", variants: [{ name: "Bottle", price: 260, isDefault: true }] },
      { name: "Budweiser Tin Beer", variants: [{ name: "Bottle", price: 300, isDefault: true }] },
      { name: "Kf Lite Beer", variants: [{ name: "Bottle", price: 310, isDefault: true }] },
      { name: "Kalyani Beer 650Ml", variants: [{ name: "Bottle", price: 330, isDefault: true }] },
      { name: "British Empire Strong Beer", variants: [{ name: "Bottle", price: 330, isDefault: true }] },
      { name: "BOOM BEER", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "Kf Storm Beer", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "Kf Ultra Beer", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "Kf Strong Beer", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "Bira Blonde Beer", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "Stok Strong Beer", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "Stok Leger Beer", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "Karjura Beer", variants: [{ name: "Bottle", price: 350, isDefault: true }] },
      { name: "BOOM RISE BEER", variants: [{ name: "Bottle", price: 380, isDefault: true }] },
      { name: "Carlsberg", variants: [{ name: "Bottle", price: 430, isDefault: true }] },
      { name: "Budweiser Beer", variants: [{ name: "Bottle", price: 450, isDefault: true }] },
      { name: "Bira White", variants: [{ name: "Bottle", price: 450, isDefault: true }] },
      { name: "Bira Glod Beer", variants: [{ name: "Bottle", price: 450, isDefault: true }] },
      { name: "Budweiser Magnum Beer", variants: [{ name: "Bottle", price: 495, isDefault: true }] },
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

  // Delete orders and order items first to avoid foreign key constraint violations
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: BAR_ID } } });
  await prisma.order.deleteMany({ where: { restaurantId: BAR_ID } });

  await prisma.menuItemAddon.deleteMany({ where: { menuItem: { restaurantId: BAR_ID } } });
  await prisma.menuItemVariant.deleteMany({ where: { menuItem: { restaurantId: BAR_ID } } });
  await prisma.menuItem.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.category.deleteMany({ where: { restaurantId: BAR_ID } });

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
