// Backfill / suggestion script for BarItemMapping.
//
// For each restaurant, loads liquor menu items and inventory items, runs the
// shared findInventoryForOrderedItem matcher to find a candidate inventory
// match per (menuItemId, variantPrice), and inserts AUTO_SUGGESTED mapping
// rows. Items with no match are written to unmapped-bar-items.csv for manual
// review.
//
// Read-only against MenuItem / MenuItemVariant / InventoryItem / OrderItem.
// Writes only to bar_item_mappings. Idempotent on (menuItemId, variantPrice).
//
// Usage: npx tsx dev-scripts/generateBarMappingSuggestions.ts [restaurantId]

import prisma from '../src/lib/prisma';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import {
  buildInventoryByName,
  buildDualVariantMap,
  findInventoryForOrderedItem,
  computeMlPerUnit,
} from '../src/utils/barMatching';

async function main() {
  const restaurantFilter = process.argv[2];
  const restaurants = await prisma.outlet.findMany({
    where: restaurantFilter ? { id: restaurantFilter } : undefined,
    select: { id: true },
  });

  let totalInserted = 0;
  let totalUnmapped = 0;
  const unmappedRows: string[] = ['menuItemName,variantPrice,restaurantId'];

  for (const r of restaurants) {
    const restaurantId = r.id;
    console.log(`\n[Restaurant ${restaurantId}] Processing...`);

    // Load liquor menu items with variants
    const liquorMenuItems = await prisma.menuItem.findMany({
      where: { restaurantId, menuType: 'LIQUOR', isDeleted: false },
      include: { variants: true },
    });
    console.log(`  Found ${liquorMenuItems.length} liquor menu items`);

    if (liquorMenuItems.length === 0) continue;

    // Load all inventory items for this restaurant (same shape as live path)
    const allInventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId },
      include: { menuItem: { include: { variants: true, category: { select: { name: true } } } } },
    });
    console.log(`  Found ${allInventoryItems.length} inventory items`);

    const inventoryByName = buildInventoryByName(allInventoryItems);
    const dualVariantMap = buildDualVariantMap(inventoryByName);

    // Load existing mappings so we skip already-mapped (menuItemId, variantPrice) pairs
    const existingMappings = await prisma.barItemMapping.findMany({
      where: { restaurantId },
      select: { menuItemId: true, variantPrice: true },
    });
    const existingKeys = new Set(
      existingMappings.map(m => `${m.menuItemId}:${Number(m.variantPrice)}`)
    );

    let inserted = 0;
    let unmapped = 0;

    for (const menuItem of liquorMenuItems) {
      // Enumerate distinct variant prices for this menu item
      let prices: number[] = [];
      if (menuItem.variants.length > 0) {
        prices = [...new Set(menuItem.variants.map(v => Number(v.price)))];
      }
      // Fallback: distinct historical OrderItem.price values
      if (prices.length === 0) {
        const historicalPrices = await prisma.orderItem.findMany({
          where: { menuItemId: menuItem.id, removedFromBill: false, quantity: { gt: 0 } },
          select: { price: true },
          distinct: ['price'],
          take: 20,
        });
        prices = historicalPrices.map(o => Number(o.price));
      }
      // If still no prices, use basePrice as a single price
      if (prices.length === 0) {
        prices = [Number(menuItem.basePrice)];
      }

      // Run the matcher once for this menu item name
      const { primary: primaryInv, secondary: secondaryInv } = findInventoryForOrderedItem(
        menuItem.name,
        inventoryByName,
        dualVariantMap,
        `[Backfill ${restaurantId}]`,
        (m) => console.log(m),
      );

      if (!primaryInv) {
        for (const price of prices) {
          unmappedRows.push(`"${menuItem.name}",${price},${restaurantId}`);
          unmapped++;
        }
        continue;
      }

      for (const price of prices) {
        const key = `${menuItem.id}:${price}`;
        if (existingKeys.has(key)) {
          continue; // idempotent — skip already-mapped
        }

        // Compute mlPerUnit using the same shared logic as the live path
        const { mlPerUnit } = computeMlPerUnit(
          primaryInv,
          price,
          menuItem.name,
          `[Backfill ${restaurantId}]`,
          (m) => console.log(m),
        );

        await prisma.barItemMapping.create({
          data: {
            menuItemId: menuItem.id,
            restaurantId,
            variantPrice: new Prisma.Decimal(price),
            primaryInvId: primaryInv.id,
            secondaryInvId: secondaryInv?.id ?? null,
            mlPerUnit: new Prisma.Decimal(mlPerUnit),
            source: 'AUTO_SUGGESTED',
          },
        });
        existingKeys.add(key);
        inserted++;
      }
    }

    console.log(`  Inserted ${inserted} AUTO_SUGGESTED mappings, ${unmapped} unmapped (name, price) pairs`);
    totalInserted += inserted;
    totalUnmapped += unmapped;
  }

  if (totalUnmapped > 0) {
    fs.writeFileSync('unmapped-bar-items.csv', unmappedRows.join('\n') + '\n');
    console.log(`\nWrote ${totalUnmapped} unmapped rows to unmapped-bar-items.csv`);
  }

  console.log(`\nDone. Total inserted: ${totalInserted}, total unmapped: ${totalUnmapped}`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
