const { PrismaClient } = require('@prisma/client');
const xlsx = require('xlsx');

const prisma = new PrismaClient();

const venueMap = {
  4: 'venue-bar',
  5: 'venue-conference1',
  6: 'venue-conference2',
  7: 'venue-pdr',
  10: 'venue-parcel'
};

async function main() {
  try {
    const workbook = xlsx.readFile('rates_bar.xlsx');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const menuItems = await prisma.menuItem.findMany({
      select: { id: true, name: true, basePrice: true }
    });

    const nameMap = new Map();
    for (const item of menuItems) {
      nameMap.set(item.name.toLowerCase().trim(), item);
    }

    let inserted = 0;
    const batch = [];

    for (let i = 3; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[1] || typeof row[1] !== 'string') continue;

      const itemName = row[1].toLowerCase().trim();
      const menuItem = nameMap.get(itemName);

      if (!menuItem) {
        continue;
      }

      for (const [colIdx, venueId] of Object.entries(venueMap)) {
        let price = row[colIdx];
        if (typeof price === 'number' && !isNaN(price)) {
          batch.push({
            venueId,
            menuItemId: menuItem.id,
            price: price
          });
        }
      }
    }

    console.log(`Found ${batch.length} price overrides to insert.`);
    
    // Clear existing prices to prevent duplicates
    await prisma.venuePrice.deleteMany({});
    
    // Insert in batches of 1000
    for (let i = 0; i < batch.length; i += 1000) {
      const chunk = batch.slice(i, i + 1000);
      await prisma.venuePrice.createMany({
        data: chunk,
        skipDuplicates: true
      });
      inserted += chunk.length;
    }

    console.log(`Successfully inserted ${inserted} venue prices.`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
