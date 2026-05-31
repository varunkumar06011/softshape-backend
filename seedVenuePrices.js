const { PrismaClient } = require('@prisma/client');
const xlsx = require('xlsx');

const prisma = new PrismaClient();

async function main() {
  console.log('Loading Excel file...');
  const wb = xlsx.readFile('rates_bar.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

  const venueMap = {
    4: 'venue-bar',
    5: 'venue-conference1',
    6: 'venue-conference2',
    7: 'venue-pdr',
    10: 'venue-parcel',
  };

  console.log('Fetching all menu items from database...');
  const allItems = await prisma.menuItem.findMany({
    select: { id: true, name: true }
  });

  const nameToIds = {};
  for (const item of allItems) {
    if (!item.name) continue;
    const n = item.name.toLowerCase().trim();
    if (!nameToIds[n]) nameToIds[n] = [];
    nameToIds[n].push(item.id);
  }

  const updates = [];
  let unmatched = 0;
  let matched = 0;

  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[1]) continue;

    const itemName = String(row[1]).toLowerCase().trim();
    const itemIds = nameToIds[itemName];

    if (!itemIds) {
      unmatched++;
      continue;
    }

    matched++;
    
    for (const [colIndex, venueId] of Object.entries(venueMap)) {
      const priceVal = row[colIndex];
      if (priceVal === undefined || priceVal === null || priceVal === '') continue;
      const price = Number(priceVal);
      if (isNaN(price)) continue;

      for (const id of itemIds) {
        updates.push({
          venueId,
          menuItemId: id,
          price
        });
      }
    }
  }

  console.log(`Found ${matched} matched items and ${unmatched} unmatched items from Excel.`);
  console.log(`Preparing ${updates.length} venue price records...`);

  // We can upsert in batches
  let count = 0;
  for (const u of updates) {
    await prisma.venuePrice.upsert({
      where: { venueId_menuItemId: { venueId: u.venueId, menuItemId: u.menuItemId } },
      create: { venueId: u.venueId, menuItemId: u.menuItemId, price: u.price, isActive: true },
      update: { price: u.price, isActive: true }
    });
    count++;
    if (count % 500 === 0) console.log(`Inserted ${count}/${updates.length}...`);
  }

  console.log('Done mapping venue prices!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
