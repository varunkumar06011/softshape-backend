const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Items to update: [name, bottleSize (0=auto), soldBtl, sellingPrice, purchaseRate]
const ITEMS_TO_UPDATE = [
  ['BUDWEISER BEER', 650, 12, 450, 234.46],
  ['BLEDERS PRIDE', 0, 44, 92, 1158.55],
  ['KINGFISHER ULTRA', 0, 13, 350, 191.38],
  ['KINGFISHER STRONG', 0, 14, 350, 173.72],
  ['COURRIER NAPOLEON', 0, 10, 62, 1031.25],
  ['BREEZER', 0, 1, 240, 112.72],
  ['BUDWEISER MAGNUM', 0, 1, 495, 260.61],
  ['RED LABEL', 0, 8, 183, 2370.86],
  ['MORPHEUS', 0, 16, 71, 936.16],
  ['VAT 69', 0, 10, 146, 1679],
  ['KARJURA', 0, 2, 350, 156.3],
  ['ROYAL STAG', 750, 49, 61, 745.39],
  ['MORPHEUS BLUE', 0, 26, 90, 1166.75],
  ['MANSION HOUSE', 0, 15, 51, 675.87],
  ['MC WHISKY', 180, 1, 288, 173.42],
  ['KYRON BRANDY', 0, 16, 73, 935.61],
  ['STOCK STRONG', 0, 1, 350, 162.42],
  ['MC WHISKY', 750, 19, 48, 632.18],
  ['IMPERIAL BLUE', 0, 24, 48, 632.18],
  ['BUDWEISER MAGNUM TIN', 0, 1, 300, 328.04],
  ['100 PIPERS', 0, 7, 196, 2172.55],
  ['SIGNATURE', 0, 44, 94, 1149.32],
  ['MAGIC MOMENTS OR', 180, 2, 250, 216.74],
  ['ABSOLUTE', 0, 4, 170, 2242.21],
  ['BACARDI CRANBERRY', 0, 1, 260, 129.67],
  ['BLACK LABEL', 750, 2, 330, 4340.22],
];

// Name matching: user name → database name pattern
const NAME_MAP = {
  'BUDWEISER BEER': 'budweiser beer',
  'BLEDERS PRIDE': 'blenders pride',
  'KINGFISHER ULTRA': 'kf ultra',
  'KINGFISHER STRONG': 'kf strong',
  'COURRIER NAPOLEON': 'courrier napoleon',
  'BREEZER': 'breezer',
  'BUDWEISER MAGNUM': 'budweiser magnum',
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
  'BUDWEISER MAGNUM TIN': 'budweiser tin',
  '100 PIPERS': '100 pipers',
  'SIGNATURE': 'signature',
  'MAGIC MOMENTS OR': 'magic moments orange',
  'ABSOLUTE': 'absolut',
  'BACARDI CRANBERRY': 'bacardi cranberry',
  'BLACK LABEL': 'black label',
};

(async () => {
  // Use the most recent date with full snapshots
  const reportDate = '2026-08-31';
  console.log('Report Date:', reportDate);
  console.log('');

  // Get all active inventory items with their menu items
  const allItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: { menuItem: { select: { name: true, category: { select: { name: true } } } } },
  });

  // Filter out soft drinks
  const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
  const isSoftDrink = (inv) => {
    const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
    const itemName = String(inv.menuItem?.name || '').toLowerCase();
    return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
           SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
  };
  const liquorItems = allItems.filter(inv => !isSoftDrink(inv));

  console.log('Total liquor items:', liquorItems.length);

  // Match items
  const matchedItems = [];  // {item, soldBtl, sellingPrice, purchaseRate}
  const unmatchedUserItems = [];

  for (const [userItem, userQty, soldBtl, sellingPrice, purchaseRate] of ITEMS_TO_UPDATE) {
    const searchName = NAME_MAP[userItem] || userItem.toLowerCase();
    // Find candidates
    let candidates = liquorItems.filter(inv => {
      const dbName = String(inv.menuItem?.name || '').toLowerCase();
      return dbName.includes(searchName);
    });

    // Filter by bottle size if specified
    if (userQty > 0) {
      candidates = candidates.filter(inv => Number(inv.bottleSize) === userQty);
    }

    if (candidates.length === 0) {
      // Try broader match
      const words = searchName.split(' ');
      candidates = liquorItems.filter(inv => {
        const dbName = String(inv.menuItem?.name || '').toLowerCase();
        return words.every(w => dbName.includes(w));
      });
      if (userQty > 0) {
        candidates = candidates.filter(inv => Number(inv.bottleSize) === userQty);
      }
    }

    if (candidates.length === 0) {
      unmatchedUserItems.push(userItem);
      console.log(`✗ NO MATCH: ${userItem} (qty=${userQty}, sold=${soldBtl})`);
    } else if (candidates.length === 1) {
      matchedItems.push({ item: candidates[0], soldBtl, sellingPrice, purchaseRate });
      console.log(`✓ MATCHED: ${userItem} → ${candidates[0].menuItem?.name} (${candidates[0].bottleSize}ml)`);
    } else {
      // Pick the first match (closest by bottle size if unspecified)
      const picked = candidates[0];
      matchedItems.push({ item: picked, soldBtl, sellingPrice, purchaseRate });
      console.log(`⚠ MULTIPLE: ${userItem} → picked "${picked.menuItem?.name}" (${picked.bottleSize}ml) from ${candidates.length} matches: ${candidates.map(c => `${c.menuItem?.name}(${c.bottleSize}ml)`).join(', ')}`);
    }
  }

  console.log('');
  console.log(`Matched: ${matchedItems.length}, Unmatched: ${unmatchedUserItems.length}`);

  if (unmatchedUserItems.length > 0) {
    console.log('Unmatched items:', unmatchedUserItems.join(', '));
  }

  // Get IDs of matched items
  const matchedIds = new Set(matchedItems.map(m => m.item.id));

  // Items to hide = all liquor items NOT in matchedIds
  const itemsToHide = liquorItems.filter(inv => !matchedIds.has(inv.id));
  console.log('');
  console.log(`Items to show: ${matchedIds.size}`);
  console.log(`Items to hide: ${itemsToHide.length}`);

  // ── UPDATE DATABASE ──
  console.log('');
  console.log('=== UPDATING DATABASE ===');

  // 1. Update matched items: set acSellingPrice, costPerBottle, isHiddenFromReport=false
  for (const { item, soldBtl, sellingPrice, purchaseRate } of matchedItems) {
    const bottleSize = Number(item.bottleSize) || 0;
    const soldMl = bottleSize > 0 ? soldBtl * bottleSize : 0;

    await prisma.inventoryItem.update({
      where: { id: item.id },
      data: {
        acSellingPrice: sellingPrice,
        costPerBottle: purchaseRate,
        isHiddenFromReport: false,
      },
    });
    console.log(`✓ Updated item: ${item.menuItem?.name} | acSellingPrice=${sellingPrice} | cost=${purchaseRate} | visible`);

    // 2. Update/create daily snapshot with soldMl
    const existingSnap = await prisma.dailyInventorySnapshot.findFirst({
      where: { itemId: item.id, snapshotDate: reportDate },
    });

    if (existingSnap) {
      await prisma.dailyInventorySnapshot.update({
        where: { id: existingSnap.id },
        data: { sold: soldMl },
      });
      console.log(`  ✓ Updated snapshot: sold=${soldMl}ml (${soldBtl} btl × ${bottleSize}ml)`);
    } else {
      // Create snapshot if doesn't exist
      await prisma.dailyInventorySnapshot.create({
        data: {
          itemId: item.id,
          restaurantId: item.restaurantId,
          snapshotDate: reportDate,
          openingStock: 0,
          purchased: 0,
          sold: soldMl,
          closingStock: 0,
          wastage: 0,
          adjusted: 0,
        },
      });
      console.log(`  ✓ Created snapshot: sold=${soldMl}ml (${soldBtl} btl × ${bottleSize}ml)`);
    }
  }

  // 3. Hide all other liquor items
  let hiddenCount = 0;
  for (const item of itemsToHide) {
    if (item.isHiddenFromReport !== true) {
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { isHiddenFromReport: true },
      });
      hiddenCount++;
    }
  }
  console.log('');
  console.log(`✓ Hidden ${hiddenCount} items (already hidden: ${itemsToHide.length - hiddenCount})`);

  console.log('');
  console.log('=== DONE ===');
  console.log(`Date: ${reportDate}`);
  console.log(`Items shown in report: ${matchedIds.size}`);
  console.log(`Items hidden: ${itemsToHide.length}`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
