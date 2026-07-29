/**
 * Adds "Magic Moments Orange 180Ml" bar menu item at ₹250 with
 * printerTarget = BAR_PRINTER (Liquor category → Bar Printer).
 *
 * The item is linked to the existing "Magic Moments Orange 750Ml" bar
 * inventory for stock deduction.  The deduction logic in
 * inventoryService.ts strips the "180ml" suffix and falls back to
 * "<base> 750ml" in the inventory-by-name map, so ordering the 180ml
 * menu item will correctly deduct 180 ml from the 750 ml bottle stock.
 *
 * Usage:
 *   npx tsx dev-scripts/addMagicMomentsOrange180.ts --list-venues          # list all venues
 *   npx tsx dev-scripts/addMagicMomentsOrange180.ts --venue=<VENUE_ID>     # live
 *   npx tsx dev-scripts/addMagicMomentsOrange180.ts --venue=<VENUE_ID> --dry-run  # preview
 */
import { PrismaClient, MenuType } from '@prisma/client';

const prisma = new PrismaClient();

const PRICE = 250;
const CATEGORY_NAME = 'Liquor';
const PRINTER_TARGET = 'BAR_PRINTER';

function getArgValue(name: string): string | null {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}

// Item name and inventory name can be overridden via CLI args
const ITEM_NAME = getArgValue('item') || 'Magic Moments Orange 180Ml';
const INVENTORY_NAME = getArgValue('inv') || 'Magic Moments Orange';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const listOnly = process.argv.includes('--list-venues');
  const targetVenueId = getArgValue('venue');

  const outlets = await prisma.outlet.findMany();
  console.log(`Found ${outlets.length} outlet(s)`);

  // ── List-venues mode: print all venues and exit ──
  if (listOnly) {
    console.log('\n=== ALL VENUES ===');
    for (const outlet of outlets) {
      const venues = await prisma.venue.findMany({
        where: { restaurantId: outlet.id, isDeleted: false },
        select: { id: true, name: true, venueType: true, priceProfileId: true },
      });
      console.log(`\n  Outlet: ${outlet.name} (${outlet.id})`);
      if (venues.length === 0) {
        console.log('    (no venues)');
      } else {
        for (const v of venues) {
          console.log(`    ${v.id}  |  ${v.name}  |  type=${v.venueType}  |  priceProfile=${v.priceProfileId || '(none)'}`);
        }
      }
    }
    console.log('\nDone!');
    return;
  }

  if (!targetVenueId) {
    console.log('\n⚠ No --venue=<ID> argument provided.');
    console.log('  Run with --list-venues to see all available venue IDs, then:');
    console.log('  npx tsx dev-scripts/addMagicMomentsOrange180.ts --venue=<VENUE_ID>');
    console.log('Done!');
    return;
  }

  console.log(dryRun ? '=== DRY RUN ===' : '=== LIVE RUN ===');
  console.log(`Target venue ID: ${targetVenueId}`);

  // Find the target venue across all outlets
  const targetVenue = await prisma.venue.findUnique({
    where: { id: targetVenueId },
  });
  if (!targetVenue || targetVenue.isDeleted) {
    console.log(`⚠ Venue ${targetVenueId} not found or deleted.`);
    return;
  }

  const outlet = outlets.find(o => o.id === targetVenue.restaurantId);
  if (!outlet) {
    console.log(`⚠ Outlet ${targetVenue.restaurantId} not found for venue.`);
    return;
  }

  console.log(`\n--- Outlet: ${outlet.name} (${outlet.id}) ---`);
  console.log(`  Venue: ${targetVenue.name} (${targetVenue.id})`);

  // 2. Find or create the "Liquor" category
  let category = await prisma.category.findFirst({
    where: {
      restaurantId: outlet.id,
      name: { equals: CATEGORY_NAME, mode: 'insensitive' },
    },
  });
  if (!category) {
    if (dryRun) {
      console.log(`  [DRY] Would create category "${CATEGORY_NAME}"`);
    } else {
      category = await prisma.category.create({
        data: {
          name: CATEGORY_NAME,
          restaurantId: outlet.id,
          sortOrder: 999,
          printerTarget: PRINTER_TARGET,
        },
      });
      console.log(`  Created category "${CATEGORY_NAME}" (${category.id})`);
    }
  } else {
    console.log(`  Category "${CATEGORY_NAME}" already exists (${category.id})`);
  }

  // 3. Check if the menu item already exists
  const existing = await prisma.menuItem.findFirst({
    where: {
      restaurantId: outlet.id,
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
        restaurantId: outlet.id,
        categoryId: category!.id,
        isDeleted: false,
        variants: {
          create: {
            name: 'Regular',
            price: PRICE,
            isDefault: true,
            restaurantId: outlet.id,
          },
        },
      },
    });
    console.log(`  Created menu item "${ITEM_NAME}" (${created.id})`);
    menuItemId = created.id;
  }

  // Set venue price
  await ensureVenuePrice(menuItemId, targetVenue, outlet.id, dryRun);

  // 4. Verify the 750ml inventory item exists for deduction
  const allInv = await prisma.inventoryItem.findMany({
    where: { restaurantId: outlet.id },
    include: { menuItem: true },
  });
  const match750 = allInv.find(i =>
    (i.menuItem?.name || '').toLowerCase().trim() === INVENTORY_NAME.toLowerCase()
  );
  if (match750) {
    console.log(`  ✓ Found inventory "${match750.menuItem?.name}" (${match750.id}) — stock: ${match750.currentStock} ml`);
  } else {
    console.log(`  ⚠ No inventory item named "${INVENTORY_NAME}" found — deduction will not work until it exists.`);
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
    console.log(`  [DRY] Would set venue price ₹${PRICE} for "${venue.name}"`);
    return;
  }
  let ppId = venue.priceProfileId;
  if (!ppId) {
    if (dryRun) {
      console.log(`  [DRY] Would create PriceProfile for venue "${venue.name}"`);
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
    console.log(`  Created PriceProfile for venue "${venue.name}" (${ppId})`);
  }

  const existing = await prisma.priceProfileItem.findUnique({
    where: { priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId } },
  });
  if (existing) {
    if (Number(existing.price) === PRICE) {
      console.log(`  Venue price already ₹${PRICE} — no change.`);
      return;
    }
    if (dryRun) {
      console.log(`  [DRY] Would update venue price from ₹${existing.price} → ₹${PRICE}`);
      return;
    }
    await prisma.priceProfileItem.update({
      where: { id: existing.id },
      data: { price: PRICE },
    });
    console.log(`  Updated venue price ₹${existing.price} → ₹${PRICE}`);
  } else {
    if (dryRun) {
      console.log(`  [DRY] Would create venue price ₹${PRICE}`);
      return;
    }
    await prisma.priceProfileItem.create({
      data: { priceProfileId: ppId, menuItemId, price: PRICE, restaurantId },
    });
    console.log(`  Set venue price ₹${PRICE} for "${venue.name}"`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
