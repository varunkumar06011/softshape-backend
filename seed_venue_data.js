require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();
const RESTAURANT_CODE = '00001';

const VENUES = [
  { name: 'Bar AC Hall', tag: 'venue-bar-ac-hall', tables: 8 },
  { name: 'Bar Conference', tag: 'venue-bar-conference', tables: 4 },
  { name: 'Bar PDR', tag: 'venue-bar-pdr', tables: 4 },
  { name: 'Bar Rooms', tag: 'venue-bar-rooms', tables: 6 },
  { name: 'Bar Parcel', tag: 'venue-bar-parcel', tables: 2 },
  { name: 'Family Restaurant', tag: 'venue-family-restaurant', tables: 10 },
  { name: 'Restaurant Parcel', tag: 'venue-restaurant-parcel', tables: 2 },
];

const CATEGORIES = [
  { name: 'Starters', printerTarget: 'KOT_PRINTER' },
  { name: 'Main Course', printerTarget: 'KOT_PRINTER' },
  { name: 'Breads', printerTarget: 'KOT_PRINTER' },
  { name: 'Desserts', printerTarget: 'KOT_PRINTER' },
  { name: 'Beverages', printerTarget: 'BAR_PRINTER' },
];

const MENU_ITEMS = [
  { name: 'Chicken Biryani', category: 'Main Course', isVeg: false, menuType: 'FOOD', basePrice: 280 },
  { name: 'Paneer Butter Masala', category: 'Main Course', isVeg: true, menuType: 'FOOD', basePrice: 240 },
  { name: 'Chicken 65', category: 'Starters', isVeg: false, menuType: 'FOOD', basePrice: 220 },
  { name: 'Veg Spring Roll', category: 'Starters', isVeg: true, menuType: 'FOOD', basePrice: 180 },
  { name: 'Butter Naan', category: 'Breads', isVeg: true, menuType: 'FOOD', basePrice: 45 },
  { name: 'Gulab Jamun', category: 'Desserts', isVeg: true, menuType: 'FOOD', basePrice: 90 },
  { name: 'Whisky (30ml)', category: 'Beverages', isVeg: true, menuType: 'LIQUOR', basePrice: 150 },
  { name: 'Kingfisher Beer (650ml)', category: 'Beverages', isVeg: true, menuType: 'LIQUOR', basePrice: 180 },
];

const VENUE_MULTIPLIERS = {
  'venue-bar-ac-hall': 1.2,
  'venue-bar-conference': 1.3,
  'venue-bar-pdr': 1.5,
  'venue-bar-rooms': 1.25,
  'venue-bar-parcel': 1.0,
  'venue-family-restaurant': 1.0,
  'venue-restaurant-parcel': 1.0,
};

async function main() {
  const restaurant = await p.restaurant.findUnique({ where: { restaurantCode: RESTAURANT_CODE } });
  if (!restaurant) throw new Error(`Restaurant ${RESTAURANT_CODE} not found. Run seed_test_user.js first.`);
  
  console.log(`Seeding venue data for ${restaurant.name} (${restaurant.id})`);

  for (const venue of VENUES) {
    let section = await p.section.findFirst({ where: { restaurantId: restaurant.id, name: venue.name } });
    if (!section) {
      section = await p.section.create({ data: { name: venue.name, restaurantId: restaurant.id } });
      console.log(`Created section: ${venue.name}`);
    } else {
      console.log(`Section exists: ${venue.name}`);
    }

    const existingTableCount = await p.table.count({ where: { sectionId: section.id } });
    for (let i = existingTableCount + 1; i <= venue.tables; i++) {
      await p.table.create({
        data: {
          number: i,
          sectionId: section.id,
          restaurantId: restaurant.id,
          sectionTag: venue.tag,
          capacity: 4,
        },
      });
    }
    console.log(`  Tables: ${venue.tables} in ${venue.name}`);
  }

  const categoryMap = {};
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    let category = await p.category.findFirst({ where: { restaurantId: restaurant.id, name: cat.name } });
    if (!category) {
      category = await p.category.create({
        data: { name: cat.name, restaurantId: restaurant.id, sortOrder: i, printerTarget: cat.printerTarget },
      });
      console.log(`Created category: ${cat.name}`);
    }
    categoryMap[cat.name] = category.id;
  }

  for (const item of MENU_ITEMS) {
    const categoryId = categoryMap[item.category];
    let menuItem = await p.menuItem.findFirst({
      where: { restaurantId: restaurant.id, name: item.name, categoryId },
    });

    if (!menuItem) {
      menuItem = await p.menuItem.create({
        data: {
          name: item.name,
          categoryId,
          restaurantId: restaurant.id,
          basePrice: String(item.basePrice),
          isVeg: item.isVeg,
          menuType: item.menuType,
          isAvailable: true,
          variants: {
            create: { name: 'Regular', price: String(item.basePrice), isDefault: true },
          },
        },
      });
      console.log(`Created menu item: ${item.name} (₹${item.basePrice})`);
    } else {
      console.log(`Menu item exists: ${item.name}`);
    }

    for (const [venueId, multiplier] of Object.entries(VENUE_MULTIPLIERS)) {
      const price = Math.round(item.basePrice * multiplier);
      await p.venuePrice.upsert({
        where: { venueId_menuItemId: { venueId, menuItemId: menuItem.id } },
        create: { venueId, menuItemId: menuItem.id, restaurantId: restaurant.id, price: String(price), isActive: true },
        update: { price: String(price), isActive: true },
      });
    }
  }

  console.log('Venue seeding complete.');
}

main()
  .catch(e => { console.error('Seed failed:', e); process.exit(1); })
  .finally(() => p.$disconnect());
