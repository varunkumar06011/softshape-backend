const xlsx = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// bar item name → Excel row name
const MANUAL_MAP = {
  'Finger Chips': null,                    // No match in Excel - skip
  'Paneer Manchurian': 'PANEER MANCHCURIAN', // typo in Excel: "MANCHCURIAN"
  'Paneer Mejestick': 'PANEER MEJESTIC',     // typo: "MEJESTIC" vs "Mejestick"
  'Pepper Mushroom': null,                   // Not in Excel
  'Chicken Mejestick': 'CHICKEN MEJESTIC B/L', // "MEJESTIC B/L"
  'Tawa Fish': null,                         // Not in Excel
  'Tandoori Chicken': 'TANDOORI CHICKEN HALF', // Half portion
  'Tangdi Kebab': null,                      // Not in Excel
  'Cashew Chicken Curry': null,              // Not in Excel  
  'Moghalai Chicken Biryani': null,          // Not in Excel as biryani
  'Mutton Fry Biryani': 'MUTTON FRY PICE BIRYANI',
  'Mutton Kheema Biryani': null,             // Not in Excel
  'Shezwan Chicken Noodles': null,           // Not in Excel
};

const VENUE_COLUMNS = {
  4: 'venue-bar', 5: 'venue-conference1', 6: 'venue-conference2',
  7: 'venue-pdr', 10: 'venue-parcel',
};

async function main() {
  try {
    const wb = xlsx.readFile('rates_bar.xlsx');
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    
    const excelMap = new Map();
    for (let i = 3; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[1] || typeof row[1] !== 'string') continue;
      excelMap.set(row[1].trim().toLowerCase(), row);
    }
    
    const barRes = await fetch('http://localhost:3000/api/bar/menu/items');
    const barItems = await barRes.json();
    const barItemMap = new Map();
    barItems.forEach(item => barItemMap.set(item.name, item));
    
    const batch = [];
    let matched = 0;
    
    for (const [barName, excelName] of Object.entries(MANUAL_MAP)) {
      if (!excelName) {
        console.log('⏭️  ' + barName + ' → No Excel match (will use bar base price)');
        continue;
      }
      
      const barItem = barItemMap.get(barName);
      if (!barItem) { console.log('Bar item not found: ' + barName); continue; }
      
      const excelRow = excelMap.get(excelName.toLowerCase());
      if (!excelRow) { console.log('Excel not found: ' + excelName); continue; }
      
      matched++;
      for (const [colIdx, venueId] of Object.entries(VENUE_COLUMNS)) {
        const price = excelRow[Number(colIdx)];
        if (typeof price === 'number' && !isNaN(price) && price > 0) {
          batch.push({ venueId, menuItemId: barItem.id, price });
        }
      }
      console.log('✅ ' + barName + ' → ' + excelName + ' (pdr:' + excelRow[7] + ')');
    }
    
    console.log('\nMatched: ' + matched);
    
    if (batch.length > 0) {
      for (const record of batch) {
        await prisma.venuePrice.upsert({
          where: { venueId_menuItemId: { venueId: record.venueId, menuItemId: record.menuItemId } },
          create: record,
          update: { price: record.price },
        });
      }
      console.log('✅ Inserted/updated ' + batch.length + ' prices');
    }
    
    // For items with no Excel match, create venue prices equal to bar base price
    // These items have the same price across all venues
    const noMatchItems = Object.entries(MANUAL_MAP).filter(([_, v]) => v === null);
    let baseMatched = 0;
    for (const [barName] of noMatchItems) {
      const barItem = barItemMap.get(barName);
      if (!barItem) continue;
      
      const basePrice = Number(barItem.price);
      if (basePrice <= 0) continue;
      
      baseMatched++;
      for (const venueId of Object.values(VENUE_COLUMNS)) {
        // Use the bar price as default for all venues since we don't have venue-specific data
        await prisma.venuePrice.upsert({
          where: { venueId_menuItemId: { venueId, menuItemId: barItem.id } },
          create: { venueId, menuItemId: barItem.id, price: basePrice },
          update: { price: basePrice },
        });
      }
      console.log('📋 ' + barName + ' → using base price ₹' + basePrice + ' for all venues');
    }
    
    // Final coverage check
    const allPricesRes = await fetch('http://localhost:3000/api/venue/all-prices');
    const allPrices = await allPricesRes.json();
    const pdr = allPrices['venue-pdr'] || {};
    
    const barFood = barItems.filter(i => i.menuType === 'FOOD');
    let covered = 0;
    const stillMissing = [];
    for (const item of barFood) {
      if (pdr[item.id] !== undefined) covered++;
      else stillMissing.push(item.name);
    }
    console.log('\nFinal coverage: ' + covered + '/' + barFood.length + ' bar FOOD items have venue prices');
    if (stillMissing.length > 0) {
      console.log('Still missing: ' + stillMissing.join(', '));
    } else {
      console.log('🎉 100% coverage!');
    }
    
    await prisma.$disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
