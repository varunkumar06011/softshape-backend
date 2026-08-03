/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const venues = await prisma.venue.findMany({
    where: { restaurantId: outletId, isDeleted: false },
    select: { id: true, name: true, priceProfileId: true },
  });
  console.log('Venues:');
  for (const v of venues) {
    console.log(`  ${v.id} | ${v.name} | pp=${v.priceProfileId}`);
  }

  // Check current prices for Chicken Fry B/L
  const item = await prisma.menuItem.findFirst({
    where: { restaurantId: outletId, name: { equals: 'Chicken Fry B/L', mode: 'insensitive' }, isDeleted: false },
    select: { id: true, name: true },
  });
  if (item) {
    console.log(`\nItem: ${item.name} (${item.id})`);
    const ppItems = await prisma.priceProfileItem.findMany({
      where: { menuItemId: item.id },
      include: { priceProfile: { select: { id: true, name: true, venue: { select: { id: true, name: true } } } } },
    });
    for (const pp of ppItems) {
      console.log(`  venue=${pp.priceProfile.venue?.name || pp.priceProfile.name} | price=₹${pp.price}`);
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
