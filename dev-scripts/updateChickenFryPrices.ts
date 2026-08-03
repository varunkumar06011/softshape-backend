/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const menuItemId = '563c2857-1833-4c0e-b2fe-aa70665bd4d5';
  const outletId = 'cmqy60ci200027dscyj9ubg8h';

  // Venue name → price mapping
  const priceMap: Record<string, number> = {
    'Bar':                  350,  // Bar AC Hall
    'Conference':           370,  // Conference Hall
    'Private Dining Rooms': 400,  // PDR
    'Room':                 370,  // Rooms
    'Owner':                350,  // Parcel
  };

  const venues = await prisma.venue.findMany({
    where: { restaurantId: outletId, isDeleted: false },
  });

  for (const venue of venues) {
    const price = priceMap[venue.name];
    if (price === undefined) {
      console.log(`  ⚠ No price mapping for venue "${venue.name}" — skipping.`);
      continue;
    }

    let ppId = venue.priceProfileId;
    if (!ppId) {
      const pp = await prisma.priceProfile.create({ data: { restaurantId: outletId, name: venue.name } });
      await prisma.venue.update({ where: { id: venue.id }, data: { priceProfileId: pp.id } });
      ppId = pp.id;
      console.log(`  Created PriceProfile for "${venue.name}" (${ppId})`);
    }

    const existing = await prisma.priceProfileItem.findUnique({
      where: { priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId } },
    });

    if (existing) {
      if (Number(existing.price) === price) {
        console.log(`  "${venue.name}" already ₹${price} — no change.`);
      } else {
        await prisma.priceProfileItem.update({
          where: { id: existing.id },
          data: { price },
        });
        console.log(`  Updated "${venue.name}": ₹${existing.price} → ₹${price}`);
      }
    } else {
      await prisma.priceProfileItem.create({
        data: { priceProfileId: ppId, menuItemId, price, restaurantId: outletId },
      });
      console.log(`  Set "${venue.name}" → ₹${price}`);
    }
  }

  console.log('\nDone!');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
