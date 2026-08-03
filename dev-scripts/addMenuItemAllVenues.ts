/// <reference types="node" />
/**
 * Adds a bar menu item with the same price across ALL venues in an outlet.
 * Does NOT connect to bar inventory — just creates the menu item + venue prices.
 *
 * Usage:
 *   npx tsx dev-scripts/addMenuItemAllVenues.ts --outlet=cmqy60ci200027dscyj9ubg8h --item="Cocktai 699" --price=699 --dry-run
 *   npx tsx dev-scripts/addMenuItemAllVenues.ts --outlet=cmqy60ci200027dscyj9ubg8h --item="Cocktai 699" --price=699
 */
import { PrismaClient, MenuType } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORY_NAME = 'Liquor';
const PRINTER_TARGET = 'BAR_PRINTER';

function getArgValue(name: string): string | null {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}

const ITEM_NAME = getArgValue('item') || 'Cocktai 699';
const PRICE = getArgValue('price') ? parseInt(getArgValue('price')!, 10) : 699;
const OUTLET_ID = getArgValue('outlet') || 'cmqy60ci200027dscyj9ubg8h';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(dryRun ? '=== DRY RUN ===' : '=== LIVE RUN ===');
  console.log(`Outlet: ${OUTLET_ID}`);
  console.log(`Item: "${ITEM_NAME}" at ₹${PRICE} (all venues, no inventory)`);

  const outlet = await prisma.outlet.findUnique({ where: { id: OUTLET_ID } });
  if (!outlet) {
    console.log(`⚠ Outlet ${OUTLET_ID} not found.`);
    return;
  }

  // Find or create the "Liquor" category
  let category = await prisma.category.findFirst({
    where: {
      restaurantId: OUTLET_ID,
      name: { equals: CATEGORY_NAME, mode: 'insensitive' },
    },
  });
  if (!category) {
    if (dryRun) {
      console.log(`  [DRY] Would create category "${CATEGORY_NAME}"`);
      return;
    }
    category = await prisma.category.create({
      data: {
        name: CATEGORY_NAME,
        restaurantId: OUTLET_ID,
        sortOrder: 999,
        printerTarget: PRINTER_TARGET,
      },
    });
    console.log(`  Created category "${CATEGORY_NAME}" (${category.id})`);
  } else {
    console.log(`  Category "${CATEGORY_NAME}" already exists (${category.id})`);
  }

  // Check if menu item already exists
  const existing = await prisma.menuItem.findFirst({
    where: {
      restaurantId: OUTLET_ID,
      name: { equals: ITEM_NAME, mode: 'insensitive' },
      isDeleted: false,
    },
    include: { variants: true },
  });

  let menuItemId: string;

  if (existing) {
    console.log(`  Menu item "${ITEM_NAME}" already exists (${existing.id}) — skipping creation.`);
    menuItemId = existing.id;
  } else if (dryRun) {
    console.log(`  [DRY] Would create menu item "${ITEM_NAME}" at ₹${PRICE}`);
    menuItemId = '__DRY__';
  } else {
    const created = await prisma.menuItem.create({
      data: {
        name: ITEM_NAME,
        isVeg: true,
        isAvailable: true,
        menuType: MenuType.LIQUOR,
        basePrice: PRICE,
        unit: 'ml',
        printerTarget: PRINTER_TARGET,
        gstEnabled: false,
        restaurantId: OUTLET_ID,
        categoryId: category!.id,
        isDeleted: false,
        variants: {
          create: {
            name: 'Regular',
            price: PRICE,
            isDefault: true,
            restaurantId: OUTLET_ID,
          },
        },
      },
    });
    console.log(`  Created menu item "${ITEM_NAME}" (${created.id})`);
    menuItemId = created.id;
  }

  // Get ALL venues for this outlet
  const venues = await prisma.venue.findMany({
    where: { restaurantId: OUTLET_ID, isDeleted: false },
  });
  console.log(`  Found ${venues.length} venue(s)`);

  for (const venue of venues) {
    await ensureVenuePrice(menuItemId, venue, OUTLET_ID, dryRun);
  }

  console.log('\nDone!');
}

async function ensureVenuePrice(
  menuItemId: string,
  venue: { id: string; name: string; priceProfileId: string | null },
  restaurantId: string,
  dryRun: boolean,
) {
  if (menuItemId === '__DRY__') {
    console.log(`    [DRY] Would set venue price ₹${PRICE} for "${venue.name}"`);
    return;
  }
  let ppId = venue.priceProfileId;
  if (!ppId) {
    if (dryRun) {
      console.log(`    [DRY] Would create PriceProfile for venue "${venue.name}"`);
      return;
    }
    const pp = await prisma.priceProfile.create({
      data: { restaurantId, name: venue.name },
    });
    await prisma.venue.update({
      where: { id: venue.id },
      data: { priceProfileId: pp.id },
    });
    ppId = pp.id;
    console.log(`    Created PriceProfile for venue "${venue.name}" (${ppId})`);
  }

  const existing = await prisma.priceProfileItem.findUnique({
    where: { priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId } },
  });
  if (existing) {
    if (Number(existing.price) === PRICE) {
      console.log(`    Venue "${venue.name}" price already ₹${PRICE} — no change.`);
      return;
    }
    if (dryRun) {
      console.log(`    [DRY] Would update venue "${venue.name}" price from ₹${existing.price} → ₹${PRICE}`);
      return;
    }
    await prisma.priceProfileItem.update({
      where: { id: existing.id },
      data: { price: PRICE },
    });
    console.log(`    Updated venue "${venue.name}" price ₹${existing.price} → ₹${PRICE}`);
  } else {
    if (dryRun) {
      console.log(`    [DRY] Would set venue price ₹${PRICE} for "${venue.name}"`);
      return;
    }
    await prisma.priceProfileItem.create({
      data: { priceProfileId: ppId, menuItemId, price: PRICE, restaurantId },
    });
    console.log(`    Set venue price ₹${PRICE} for "${venue.name}"`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
