import { PrismaClient, TableStatus, MenuType } from "@prisma/client";
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const BAR_ID = "bar-001";

function categorizeItem(name: string): { categoryName: string; isVeg: boolean; menuType: MenuType } {
  const lowerName = name.toLowerCase();
  
  // 1. Veg / Non-Veg
  const nonVegKeywords = ['chicken', 'mutton', 'prawn', 'fish', 'egg', 'kheema', 'natu kodi', 'bones', 'b/l', 'nv', 'non veg', 'kodi'];
  const isVeg = !nonVegKeywords.some(kw => lowerName.includes(kw));

  // 2. MenuType & Category Name
  let categoryName = 'Others';
  let menuType: MenuType = MenuType.FOOD;

  // Soft Drinks / Mixers
  if (/(thumsup|sprite|coca cola|limca|fanta|soda|water|red bull|monster|charged|pulpy orange|mojito|mocktail|moctail|fruit punch|lassi|butter milk)/.test(lowerName)) {
    categoryName = 'Beverages & Soft Drinks';
  }
  // Beer
  else if (/(beer|bira|carlsberg|budweiser|kf|kingfisher|coolberg|stok)/.test(lowerName)) {
    categoryName = 'Beer';
    menuType = MenuType.LIQUOR;
  }
  // Spirits / Liquor / Wine
  else if (/(whisky|brandy|vodka|rum|wine|gin|tequila|label|signature|royal stag|blenders pride|antiquity|smirnoff|magic moments|100 pipers|chivas|mansion house|morpheus|teachers|vat69|vat 69|absolut|mc|legacy|imperial blue|bacardi|brezer|breezer|cocktail|peg|shot|pint|cork|napolean|kyron|oab|bp|cnb|blue|reserve)/.test(lowerName)) {
    categoryName = 'Spirits & Liquor';
    menuType = MenuType.LIQUOR;
  }
  // Soups
  else if (/(soup)/.test(lowerName)) {
    categoryName = 'Soups';
  }
  // Biryani & Rice
  else if (/(biryani|rice|pulav|pulao|annam)/.test(lowerName)) {
    categoryName = 'Biryani & Rice';
  }
  // Breads
  else if (/(roti|naan|kulcha|parota|paratha|pulka)/.test(lowerName)) {
    categoryName = 'Breads';
  }
  // Desserts
  else if (/(ice cream|shake|gulabjamun|sweet|jamun|brownie)/.test(lowerName)) {
    categoryName = 'Desserts & Shakes';
  }
  // Curries
  else if (/(curry|masala|kurma|korma|gravy|kadai|pulusu|salan)/.test(lowerName)) {
    categoryName = 'Curries';
  }
  // Starters
  else if (/(fry|roast|65|chilli|manchurian|tikka|kebab|wings|lollipop|pepper|apollo|bullet|spring roll|starter|pakoda|drumstick|corn|fingers|shangrilla|shangilla|alpha|mejestic|dragon|dicy|basket|loose|golden|palli)/.test(lowerName)) {
    categoryName = 'Starters';
  }
  // Platters / Buffets
  else if (/(platter|plater|buffet|thali)/.test(lowerName)) {
    categoryName = 'Platters & Buffet';
  }
  else if (lowerName.includes("dosa")) {
    categoryName = "Tiffins";
  }
  else if (lowerName.includes("omlet") || lowerName.includes("egg")) {
    categoryName = "Starters"; 
  }
  else {
    categoryName = 'Specials & Others';
  }

  return { categoryName, isVeg, menuType };
}

async function main() {
  console.log("Seeding Bar data for bar-001 from CSV...");

  // Read CSV
  const csvPath = path.join(__dirname, '../RATES BAR - Sheet1.csv');
  const fileContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = fileContent.split('\n').map(l => l.trim()).filter(Boolean);
  
  // Header is at line 3 (index 2)
  // Item name,Bar Ac Hall,Conference Hall,pdr,rooms,parcel
  const itemsStartIndex = 3;

  // Delete all existing items in BAR_ID
  console.log("Cleaning up old items...");
  await prisma.venuePrice.deleteMany({ where: { venueId: { in: ['venue-bar', 'venue-conference1', 'venue-pdr', 'venue-rooms', 'venue-parcel'] } } });
  await prisma.menuItemVariant.deleteMany({ where: { menuItem: { restaurantId: BAR_ID } } });
  await prisma.menuItem.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.category.deleteMany({ where: { restaurantId: BAR_ID } });
  
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: BAR_ID } } });
  await prisma.order.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.table.deleteMany({ where: { restaurantId: BAR_ID } });
  await prisma.section.deleteMany({ where: { restaurantId: BAR_ID } });

  console.log("Creating categories dynamically...");
  const categoryMap = new Map<string, string>();

  let totalItems = 0;
  
  for (let i = itemsStartIndex; i < lines.length; i++) {
    const line = lines[i];
    const columns = line.split(',');
    
    // Some lines might not have 6 columns if empty
    if (columns.length < 6) continue;
    
    const name = columns[0].trim();
    if (!name) continue;

    const barPrice = parseFloat(columns[1]) || 0;
    const confPrice = parseFloat(columns[2]) || 0;
    const pdrPrice = parseFloat(columns[3]) || 0;
    const roomsPrice = parseFloat(columns[4]) || 0;
    const parcelPrice = parseFloat(columns[5]) || 0;

    // Only create item if at least one venue has a price > 0
    if (barPrice > 0 || confPrice > 0 || pdrPrice > 0 || roomsPrice > 0 || parcelPrice > 0) {
      const { categoryName, isVeg, menuType } = categorizeItem(name);

      let catId = categoryMap.get(categoryName);
      if (!catId) {
        const newCat = await prisma.category.create({
          data: { name: categoryName, sortOrder: categoryMap.size, restaurantId: BAR_ID }
        });
        catId = newCat.id;
        categoryMap.set(categoryName, catId);
      }

      // Base price is the first valid price found
      const basePrice = barPrice > 0 ? barPrice : 
                        (confPrice > 0 ? confPrice : 
                        (pdrPrice > 0 ? pdrPrice : 
                        (roomsPrice > 0 ? roomsPrice : parcelPrice)));

      const createdItem = await prisma.menuItem.create({
        data: {
          name: name,
          basePrice: basePrice,
          isVeg,
          isAvailable: true,
          sortOrder: i,
          menuType,
          categoryId: catId,
          restaurantId: BAR_ID,
          variants: { create: [{ name: "Regular", price: basePrice, isDefault: true }] },
        },
      });
      totalItems++;

      // Create VenuePrices
      const venuePricesData = [];
      if (barPrice > 0) venuePricesData.push({ venueId: 'venue-bar', menuItemId: createdItem.id, price: barPrice });
      if (confPrice > 0) venuePricesData.push({ venueId: 'venue-conference1', menuItemId: createdItem.id, price: confPrice });
      if (pdrPrice > 0) venuePricesData.push({ venueId: 'venue-pdr', menuItemId: createdItem.id, price: pdrPrice });
      if (roomsPrice > 0) venuePricesData.push({ venueId: 'venue-rooms', menuItemId: createdItem.id, price: roomsPrice });
      if (parcelPrice > 0) venuePricesData.push({ venueId: 'venue-parcel', menuItemId: createdItem.id, price: parcelPrice });

      if (venuePricesData.length > 0) {
        await prisma.venuePrice.createMany({
          data: venuePricesData
        });
      }
    }
  }

  console.log(`✅ Created ${categoryMap.size} unique categories.`);
  console.log(`✅ Seeded ${totalItems} items and their specific Venue Prices.`);

  // Create 5 sections and tables
  console.log("Creating Sections and Tables...");
  
  const barHall = await prisma.section.create({ data: { name: "Bar Hall", restaurantId: BAR_ID } });
  for (let i = 1; i <= 30; i++) {
    await prisma.table.create({ data: { number: i, capacity: 4, status: TableStatus.AVAILABLE, sectionId: barHall.id, restaurantId: BAR_ID } });
  }

  const confHall = await prisma.section.create({ data: { name: "Conference Hall", restaurantId: BAR_ID } });
  await prisma.table.create({ data: { number: 1, capacity: 10, status: TableStatus.AVAILABLE, sectionId: confHall.id, restaurantId: BAR_ID } });

  const pdrHall = await prisma.section.create({ data: { name: "PDR", restaurantId: BAR_ID } });
  await prisma.table.create({ data: { number: 1, capacity: 6, status: TableStatus.AVAILABLE, sectionId: pdrHall.id, restaurantId: BAR_ID } });

  const roomsHall = await prisma.section.create({ data: { name: "Rooms", restaurantId: BAR_ID } });
  for (let i = 1; i <= 4; i++) {
    await prisma.table.create({ data: { number: i, capacity: 2, status: TableStatus.AVAILABLE, sectionId: roomsHall.id, restaurantId: BAR_ID } });
  }

  const parcelHall = await prisma.section.create({ data: { name: "Parcel", restaurantId: BAR_ID } });
  await prisma.table.create({ data: { number: 1, capacity: 1, status: TableStatus.AVAILABLE, sectionId: parcelHall.id, restaurantId: BAR_ID } });

  console.log('✅ Seeded Sections: Bar(30), Conference(1), PDR(1), Rooms(4), Parcel(1).');
  console.log(`🎉 Bar CSV seeding complete!`);
}

main()
  .catch((e) => { console.error(e); })
  .finally(async () => { await prisma.$disconnect(); });
