/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const ownerVenueId = 'cmqy60g55000u7dsc5rphkkix';
  const dryRun = process.argv.includes('--dry-run');

  // 1. Find the existing item
  const item = await prisma.menuItem.findFirst({
    where: {
      restaurantId: outletId,
      name: { equals: 'BLACK LABEL 750ML JOHNNIE W', mode: 'insensitive' },
    },
    include: { category: { select: { name: true } } },
  });

  if (!item) {
    console.log('⚠ Item "BLACK LABEL 750ML JOHNNIE W" not found.');
    return;
  }

  console.log(`Found: ${item.name} (${item.id}) | menuType=${item.menuType} | category=${item.category?.name} | isDeleted=${item.isDeleted} | isAvailable=${item.isAvailable}`);

  // 2. Rename
  const newName = 'Black Label 750Ml  Johnnie W';
  console.log(`\nRenaming to: "${newName}"`);
  if (!dryRun) {
    await prisma.menuItem.update({ where: { id: item.id }, data: { name: newName } });
    console.log('  ✓ Renamed');
  } else {
    console.log('  [DRY] Would rename');
  }

  // 3. Unhide — set isAvailable=true and isDeleted=false
  console.log(`\nUnhiding (isAvailable=true, isDeleted=false)`);
  if (!dryRun) {
    await prisma.menuItem.update({ where: { id: item.id }, data: { isAvailable: true, isDeleted: false } });
    console.log('  ✓ Unhidden');
  } else {
    console.log('  [DRY] Would unhide');
  }

  // 4. Set venue price ₹5050 for Owner
  const venue = await prisma.venue.findUnique({ where: { id: ownerVenueId } });
  if (!venue) { console.log('⚠ Owner venue not found'); return; }

  let ppId = venue.priceProfileId;
  if (!ppId) {
    if (dryRun) { console.log('  [DRY] Would create PriceProfile'); return; }
    const pp = await prisma.priceProfile.create({ data: { restaurantId: outletId, name: venue.name } });
    await prisma.venue.update({ where: { id: venue.id }, data: { priceProfileId: pp.id } });
    ppId = pp.id;
    console.log(`  Created PriceProfile for "${venue.name}" (${ppId})`);
  }

  const existingPP = await prisma.priceProfileItem.findUnique({
    where: { priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId: item.id } },
  });

  if (existingPP) {
    if (Number(existingPP.price) === 5050) {
      console.log(`  Owner price already ₹5050 — no change.`);
    } else if (!dryRun) {
      await prisma.priceProfileItem.update({ where: { id: existingPP.id }, data: { price: 5050 } });
      console.log(`  Updated Owner price: ₹${existingPP.price} → ₹5050`);
    } else {
      console.log(`  [DRY] Would update Owner price → ₹5050`);
    }
  } else if (!dryRun) {
    await prisma.priceProfileItem.create({ data: { priceProfileId: ppId, menuItemId: item.id, price: 5050, restaurantId: outletId } });
    console.log('  Set Owner price → ₹5050');
  } else {
    console.log('  [DRY] Would set Owner price → ₹5050');
  }

  // 5. Also check VenueMenuItemAvailability for Owner — make sure it's available
  const avail = await prisma.venueMenuItemAvailability.findUnique({
    where: { venueId_menuItemId: { venueId: ownerVenueId, menuItemId: item.id } },
  });
  if (avail && !avail.isAvailable) {
    console.log(`\nVenueMenuItemAvailability: isAvailable=false — fixing`);
    if (!dryRun) {
      await prisma.venueMenuItemAvailability.update({ where: { id: avail.id }, data: { isAvailable: true } });
      console.log('  ✓ Set isAvailable=true');
    } else {
      console.log('  [DRY] Would set isAvailable=true');
    }
  } else if (!avail) {
    console.log(`\nNo VenueMenuItemAvailability for Owner — creating with isAvailable=true`);
    if (!dryRun) {
      await prisma.venueMenuItemAvailability.create({ data: { venueId: ownerVenueId, menuItemId: item.id, restaurantId: outletId, isAvailable: true } });
      console.log('  ✓ Created');
    } else {
      console.log('  [DRY] Would create');
    }
  } else {
    console.log(`\nVenueMenuItemAvailability already isAvailable=true — ok`);
  }

  console.log('\nDone!');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
