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

  const allItems = await prisma.menuItem.findMany({ select: { id: true, name: true } });

  const nameToIds = {};
  for (const item of allItems) {
    if (!item.name) continue;
    const n = item.name.toLowerCase().trim();
    if (!nameToIds[n]) nameToIds[n] = [];
    nameToIds[n].push(item.id);
  }

  const updates = [];
  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[1]) continue;

    const itemName = String(row[1]).toLowerCase().trim();
    const itemIds = nameToIds[itemName];

    if (!itemIds) continue;
    
    for (const [colIndex, venueId] of Object.entries(venueMap)) {
      const priceVal = row[colIndex];
      if (priceVal === undefined || priceVal === null || priceVal === '') continue;
      const price = Number(priceVal);
      if (isNaN(price)) continue;

      for (const id of itemIds) {
        updates.push({ venueId, menuItemId: id, price });
      }
    }
  }

  console.log(`Executing ${updates.length} records concurrently in chunks of 50...`);
  
  const chunkSize = 50;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    await Promise.all(chunk.map(u => 
      prisma.venuePrice.upsert({
        where: { venueId_menuItemId: { venueId: u.venueId, menuItemId: u.menuItemId } },
        create: { venueId: u.venueId, menuItemId: u.menuItemId, price: u.price, isActive: true },
        update: { price: u.price, isActive: true }
      })
    ));
    console.log(`Processed ${Math.min(i + chunkSize, updates.length)} / ${updates.length}`);
  }

  console.log('Fast script completed.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
