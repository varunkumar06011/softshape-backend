// update-ac-report-31-08.js
// Comprehensive update of AC report for 2026-08-31 to match the provided image.
// This script:
//   1. Updates inventory items (names, bottle sizes, costs, selling prices, visibility)
//   2. Updates daily inventory snapshots (sold + closingStock recalculated)
//   3. Creates AcReportAdjustment records with exact values from the image
//   4. Hides all other AC liquor items
//
// Usage: node update-ac-report-31-08.js [--dry-run]

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const REPORT_DATE = '2026-08-31';
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h'; // Vgrand Lounge Bar (Z3695J)

// Items from the image: [displayName, bottleSize (0=auto/750), saleQty, sellingPrice, purchaseCost, isBottleSold]
// isBottleSold = true where consumption = sale * purchaseCost (beer, 180ml bottles, other bottle items)
// isBottleSold = false where consumption = sale * purchaseCost * 30 / bottleSize (750ml spirits sold by 30ml pegs)
const ITEMS_FROM_IMAGE = [
  // Bottle-sold items (consumption = sale * purchaseCost)
  { displayName: 'BUDWISER BEER', bottleSize: 650, saleQty: 12, sellingPrice: 450, purchaseCost: 234.46, isBottleSold: true },
  { displayName: 'KINGFISHER ULTRA', bottleSize: 0, saleQty: 13, sellingPrice: 350, purchaseCost: 191.38, isBottleSold: true },
  { displayName: 'KINGFISHER STRONG', bottleSize: 0, saleQty: 14, sellingPrice: 350, purchaseCost: 173.72, isBottleSold: true },
  { displayName: 'BREEZER', bottleSize: 0, saleQty: 1, sellingPrice: 240, purchaseCost: 112.72, isBottleSold: true },
  { displayName: 'BUDWISER MAGNUM', bottleSize: 0, saleQty: 1, sellingPrice: 495, purchaseCost: 260.61, isBottleSold: true },
  { displayName: 'KARJURA', bottleSize: 0, saleQty: 2, sellingPrice: 350, purchaseCost: 156.3, isBottleSold: true },
  { displayName: 'STOCK STRONG', bottleSize: 0, saleQty: 1, sellingPrice: 350, purchaseCost: 162.42, isBottleSold: true },
  { displayName: 'BUDWISER MAGNUM TIN', bottleSize: 0, saleQty: 1, sellingPrice: 300, purchaseCost: 328.04, isBottleSold: true },
  { displayName: 'BACARDI CRANBERRY', bottleSize: 0, saleQty: 1, sellingPrice: 260, purchaseCost: 129.67, isBottleSold: true },
  { displayName: 'MC WHISKY', bottleSize: 180, saleQty: 1, sellingPrice: 288, purchaseCost: 173.42, isBottleSold: true },
  { displayName: 'MAGIC MOMENTS OR', bottleSize: 180, saleQty: 2, sellingPrice: 250, purchaseCost: 216.74, isBottleSold: true },

  // Peg-sold spirit items (consumption = sale * purchaseCost * 30 / bottleSize)
  { displayName: 'BLEDERSPRIDE', bottleSize: 750, saleQty: 44, sellingPrice: 92, purchaseCost: 1158.55, isBottleSold: false },
  { displayName: 'COURRIER NAPOLEAN', bottleSize: 750, saleQty: 10, sellingPrice: 62, purchaseCost: 1031.25, isBottleSold: false },
  { displayName: 'RED LABEL', bottleSize: 750, saleQty: 8, sellingPrice: 183, purchaseCost: 2370.86, isBottleSold: false },
  { displayName: 'MORPHEUS', bottleSize: 750, saleQty: 16, sellingPrice: 71, purchaseCost: 936.16, isBottleSold: false },
  { displayName: 'VAT 69', bottleSize: 750, saleQty: 10, sellingPrice: 146, purchaseCost: 1679, isBottleSold: false },
  { displayName: 'ROYAL STAG', bottleSize: 750, saleQty: 49, sellingPrice: 61, purchaseCost: 745.39, isBottleSold: false },
  { displayName: 'MORPHEUS BLUE', bottleSize: 750, saleQty: 26, sellingPrice: 90, purchaseCost: 1166.75, isBottleSold: false },
  { displayName: 'MANSION HOUSE', bottleSize: 750, saleQty: 15, sellingPrice: 51, purchaseCost: 675.87, isBottleSold: false },
  { displayName: 'KYRON BRANDY', bottleSize: 750, saleQty: 16, sellingPrice: 73, purchaseCost: 935.61, isBottleSold: false },
  { displayName: 'MC WHISKY', bottleSize: 750, saleQty: 19, sellingPrice: 48, purchaseCost: 632.18, isBottleSold: false },
  { displayName: 'IMPERIAL BLUE', bottleSize: 750, saleQty: 24, sellingPrice: 48, purchaseCost: 632.18, isBottleSold: false },
  { displayName: '100 PIPERS', bottleSize: 750, saleQty: 7, sellingPrice: 196, purchaseCost: 2172.55, isBottleSold: false },
  { displayName: 'SIGNATURE', bottleSize: 750, saleQty: 44, sellingPrice: 94, purchaseCost: 1149.32, isBottleSold: false },
  { displayName: 'ABSOLUTE', bottleSize: 750, saleQty: 4, sellingPrice: 170, purchaseCost: 2242.21, isBottleSold: false },
  { displayName: 'BLACK LABEL', bottleSize: 750, saleQty: 2, sellingPrice: 330, purchaseCost: 4340.22, isBottleSold: false },
];

// Name matching: image display name → database search pattern
const NAME_MAP = {
  'BUDWISER BEER': 'budweiser beer',
  'BLEDERSPRIDE': 'blenders pride',
  'KINGFISHER ULTRA': 'kf ultra',
  'KINGFISHER STRONG': 'kf strong',
  'COURRIER NAPOLEAN': 'courrier napoleon',
  'BREEZER': 'breezer',
  'BUDWISER MAGNUM': 'budweiser magnum',
  'RED LABEL': 'red label',
  'MORPHEUS': 'morpheus xo rare',
  'VAT 69': 'vat 69',
  'KARJURA': 'karjura',
  'ROYAL STAG': 'royal stag',
  'MORPHEUS BLUE': 'morpheus blue',
  'MANSION HOUSE': 'mansion house',
  'MC WHISKY': 'mc whisky',
  'KYRON BRANDY': 'kyron brandy',
  'STOCK STRONG': 'stok strong',
  'IMPERIAL BLUE': 'imperial blue',
  'BUDWISER MAGNUM TIN': 'budweiser tin',
  '100 PIPERS': '100 pipers',
  'SIGNATURE': 'signature',
  'MAGIC MOMENTS OR': 'magic moments orange',
  'ABSOLUTE': 'absolut',
  'BACARDI CRANBERRY': 'bacardi cranberry',
  'BLACK LABEL': 'black label',
};

function computeSoldMl(item, actualBottleSize = 0) {
  const btlSize = actualBottleSize > 0 ? actualBottleSize : item.bottleSize;
  if (item.isBottleSold) {
    return item.saleQty * btlSize;
  }
  // Spirits: saleQty is number of 30ml pegs
  return item.saleQty * 30;
}

function computeConsumption(item) {
  if (item.isBottleSold) {
    return Math.round(item.saleQty * item.purchaseCost * 100) / 100;
  }
  // Spirits: consumption = pegs * (purchaseCost * 30 / bottleSize)
  const costPer30ml = item.purchaseCost * 30 / item.bottleSize;
  return Math.round(item.saleQty * costPer30ml * 100) / 100;
}

function computeSaleAmount(item) {
  return Math.round(item.saleQty * item.sellingPrice * 100) / 100;
}

function computeProfit(item) {
  const saleAmount = computeSaleAmount(item);
  const consumption = computeConsumption(item);
  return Math.round((saleAmount - consumption) * 100) / 100;
}

async function main() {
  console.log(`\n=== Update AC Report for ${REPORT_DATE} ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'APPLY'}\n`);

  // Get all active inventory items for this restaurant
  const allItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: {
      menuItem: { select: { id: true, name: true, category: { select: { name: true } } } },
    },
  });

  const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
  const isSoftDrink = (inv) => {
    const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
    const itemName = String(inv.menuItem?.name || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };
  const liquorItems = allItems.filter(inv => !isSoftDrink(inv));

  console.log(`Total liquor items for restaurant: ${liquorItems.length}`);

  // Load existing snapshots for the date
  const existingSnaps = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: REPORT_DATE },
  });
  const snapMap = new Map(existingSnaps.map(s => [s.itemId, s]));

  // Load existing adjustments for the date
  const existingAdjs = await prisma.acReportAdjustment.findMany({
    where: { restaurantId: RESTAURANT_ID, entryDate: REPORT_DATE },
  });
  const adjMap = new Map(existingAdjs.map(a => [a.itemId, a]));

  // Match image items to database items
  const matchedItems = []; // { imageItem, dbItem, soldMl, consumption, saleAmount, profit }
  const unmatchedImageItems = [];

  for (const imageItem of ITEMS_FROM_IMAGE) {
    const searchName = NAME_MAP[imageItem.displayName] || imageItem.displayName.toLowerCase();
    const displayNameLower = imageItem.displayName.toLowerCase();
    let candidates = liquorItems.filter(inv => {
      const dbName = String(inv.menuItem?.name || '').toLowerCase();
      return dbName.includes(searchName) || dbName.includes(displayNameLower);
    });

    // Prefer exact or closer matches (e.g. "BUDWISER MAGNUM" over "BUDWISER MAGNUM TIN")
    if (candidates.length > 1) {
      candidates.sort((a, b) => {
        const aName = String(a.menuItem?.name || '').toLowerCase();
        const bName = String(b.menuItem?.name || '').toLowerCase();
        const aExact = aName === displayNameLower ? 1 : 0;
        const bExact = bName === displayNameLower ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        // Prefer shorter name (more exact match)
        return aName.length - bName.length;
      });
    }

    // Filter by bottle size if specified — only if it doesn't eliminate all candidates
    if (imageItem.bottleSize > 0 && candidates.length > 0) {
      const sizeMatches = candidates.filter(inv => Number(inv.bottleSize) === imageItem.bottleSize);
      if (sizeMatches.length > 0) {
        candidates = sizeMatches;
      }
    }

    if (candidates.length === 0) {
      // Try broader match with individual words
      const words = searchName.split(' ').filter(w => w.length > 2);
      candidates = liquorItems.filter(inv => {
        const dbName = String(inv.menuItem?.name || '').toLowerCase();
        return words.every(w => dbName.includes(w));
      });
      // Also try display name words
      if (candidates.length === 0) {
        const displayWords = displayNameLower.split(' ').filter(w => w.length > 2);
        candidates = liquorItems.filter(inv => {
          const dbName = String(inv.menuItem?.name || '').toLowerCase();
          return displayWords.every(w => dbName.includes(w));
        });
      }
    }

    if (candidates.length === 0) {
      unmatchedImageItems.push(imageItem.displayName);
      console.log(`✗ NO MATCH: ${imageItem.displayName} (qty=${imageItem.bottleSize}, sold=${imageItem.saleQty})`);
    } else if (candidates.length === 1) {
      const dbItem = candidates[0];
      const actualBottleSize = Number(dbItem.bottleSize) || 0;
      const soldMl = computeSoldMl(imageItem, actualBottleSize);
      const consumption = computeConsumption(imageItem);
      const saleAmount = computeSaleAmount(imageItem);
      const profit = computeProfit(imageItem);
      matchedItems.push({ imageItem, dbItem, soldMl, consumption, saleAmount, profit });
      console.log(`✓ MATCHED: ${imageItem.displayName} → ${dbItem.menuItem?.name} (${dbItem.bottleSize}ml)`);
    } else {
      const picked = candidates[0];
      const actualBottleSize = Number(picked.bottleSize) || 0;
      const soldMl = computeSoldMl(imageItem, actualBottleSize);
      const consumption = computeConsumption(imageItem);
      const saleAmount = computeSaleAmount(imageItem);
      const profit = computeProfit(imageItem);
      matchedItems.push({ imageItem, dbItem: picked, soldMl, consumption, saleAmount, profit });
      console.log(`⚠ MULTIPLE: ${imageItem.displayName} → picked "${picked.menuItem?.name}" (${picked.bottleSize}ml) from ${candidates.length} matches: ${candidates.map(c => `${c.menuItem?.name}(${c.bottleSize}ml)`).join(', ')}`);
    }
  }

  console.log(`\nMatched: ${matchedItems.length}, Unmatched: ${unmatchedImageItems.length}`);
  if (unmatchedImageItems.length > 0) {
    console.log('Unmatched items:', unmatchedImageItems.join(', '));
  }

  const matchedIds = new Set(matchedItems.map(m => m.dbItem.id));
  const itemsToHide = liquorItems.filter(inv => !matchedIds.has(inv.id));

  console.log(`\nItems to show: ${matchedIds.size}`);
  console.log(`Items to hide: ${itemsToHide.length}`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: Computed Values ---');
    let totalConsumption = 0;
    let totalSaleAmount = 0;
    let totalProfit = 0;
    for (const { imageItem, dbItem, soldMl, consumption, saleAmount, profit } of matchedItems) {
      console.log(`${imageItem.displayName}: soldMl=${soldMl}, consumption=${consumption}, saleAmount=${saleAmount}, profit=${profit}`);
      totalConsumption += consumption;
      totalSaleAmount += saleAmount;
      totalProfit += profit;
    }
    console.log(`\nTOTALS: consumption=${Math.round(totalConsumption * 100) / 100}, saleAmount=${Math.round(totalSaleAmount * 100) / 100}, profit=${Math.round(totalProfit * 100) / 100}`);
    console.log('\nDRY RUN complete. Run without --dry-run to apply.');
    await prisma.$disconnect();
    return;
  }

  // === APPLY CHANGES ===
  console.log('\n=== APPLYING DATABASE CHANGES ===');

  let updatedInvCount = 0;
  let updatedSnapCount = 0;
  let createdSnapCount = 0;
  let updatedAdjCount = 0;
  let createdAdjCount = 0;
  let updatedMenuNameCount = 0;
  let hiddenCount = 0;

  for (const { imageItem, dbItem, soldMl, consumption, saleAmount, profit } of matchedItems) {
    // 1. Update MenuItem name if different
    const currentName = dbItem.menuItem?.name || '';
    if (currentName !== imageItem.displayName) {
      await prisma.menuItem.update({
        where: { id: dbItem.menuItemId },
        data: { name: imageItem.displayName },
      });
      console.log(`  ✓ Updated menu name: "${currentName}" → "${imageItem.displayName}"`);
      updatedMenuNameCount++;
    }

    // 2. Update InventoryItem (cost, price, bottleSize, visibility)
    await prisma.inventoryItem.update({
      where: { id: dbItem.id },
      data: {
        costPerBottle: imageItem.purchaseCost,
        acSellingPrice: imageItem.sellingPrice,
        bottleSize: imageItem.bottleSize,
        isHiddenFromReport: false,
      },
    });
    console.log(`  ✓ Updated inventory: cost=${imageItem.purchaseCost}, selling=${imageItem.sellingPrice}, bottleSize=${imageItem.bottleSize}, visible`);
    updatedInvCount++;

    // 3. Update/create DailyInventorySnapshot
    const existingSnap = snapMap.get(dbItem.id);
    if (existingSnap) {
      const opening = Number(existingSnap.openingStock);
      const purchased = Number(existingSnap.purchased);
      const wastage = Number(existingSnap.wastage);
      const adjusted = Number(existingSnap.adjusted);
      const newClosing = opening + purchased - soldMl - wastage + adjusted;

      await prisma.dailyInventorySnapshot.update({
        where: { id: existingSnap.id },
        data: {
          sold: soldMl,
          closingStock: newClosing,
          itemName: imageItem.displayName,
        },
      });
      console.log(`  ✓ Updated snapshot: sold=${soldMl}ml, closing=${newClosing}ml`);
      updatedSnapCount++;
    } else {
      // Create snapshot
      await prisma.dailyInventorySnapshot.create({
        data: {
          restaurantId: RESTAURANT_ID,
          snapshotDate: REPORT_DATE,
          itemId: dbItem.id,
          itemName: imageItem.displayName,
          openingStock: 0,
          purchased: 0,
          sold: soldMl,
          closingStock: -soldMl, // opening(0) + purchased(0) - sold - wastage(0) + adjusted(0)
          wastage: 0,
          adjusted: 0,
        },
      });
      console.log(`  ✓ Created snapshot: sold=${soldMl}ml`);
      createdSnapCount++;
    }

    // 4. Create/update AcReportAdjustment with exact values
    const saleBtl = imageItem.bottleSize > 0 ? Math.round((soldMl / imageItem.bottleSize) * 10000) / 10000 : 0;
    const existingAdj = adjMap.get(dbItem.id);

    const adjData = {
      adjustedSaleBtl: saleBtl,
      adjustedPurchaseCost: imageItem.purchaseCost,
      adjustedSellingPrice: imageItem.sellingPrice,
      adjustedConsumption: consumption,
      adjustedSaleAmount: saleAmount,
      adjustedProfit: profit,
      adjustedClosingBtl: saleBtl, // closing = stock - sold; if no stock, closing = -saleBtl
      notes: JSON.stringify({ displaySale: imageItem.saleQty, displayUnit: imageItem.isBottleSold ? 'btl' : 'peg' }),
    };

    if (existingAdj) {
      await prisma.acReportAdjustment.update({
        where: { id: existingAdj.id },
        data: adjData,
      });
      console.log(`  ✓ Updated adjustment: saleBtl=${saleBtl}, consumption=${consumption}, saleAmount=${saleAmount}, profit=${profit}`);
      updatedAdjCount++;
    } else {
      await prisma.acReportAdjustment.create({
        data: {
          restaurantId: RESTAURANT_ID,
          itemId: dbItem.id,
          entryDate: REPORT_DATE,
          ...adjData,
        },
      });
      console.log(`  ✓ Created adjustment: saleBtl=${saleBtl}, consumption=${consumption}, saleAmount=${saleAmount}, profit=${profit}`);
      createdAdjCount++;
    }
  }

  // 5. Hide all other liquor items
  for (const item of itemsToHide) {
    if (!item.isHiddenFromReport) {
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { isHiddenFromReport: true },
      });
      hiddenCount++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Updated menu names: ${updatedMenuNameCount}`);
  console.log(`Updated inventory items: ${updatedInvCount}`);
  console.log(`Updated snapshots: ${updatedSnapCount}`);
  console.log(`Created snapshots: ${createdSnapCount}`);
  console.log(`Updated adjustments: ${updatedAdjCount}`);
  console.log(`Created adjustments: ${createdAdjCount}`);
  console.log(`Hidden items: ${hiddenCount}`);
  console.log(`Total items in report: ${matchedItems.length}`);
  console.log(`\nDate: ${REPORT_DATE}`);
  console.log('Done.');

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
