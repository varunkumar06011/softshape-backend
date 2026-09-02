const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';
const REPORT_DATE = '2026-08-31';

// The 26 items from the image (matched IDs from previous runs)
const IMAGE_ITEM_NAMES = [
  'BUDWISER BEER','KINGFISHER ULTRA','KINGFISHER STRONG','BREEZER',
  'BUDWISER MAGNUM','KARJURA','STOCK STRONG','BUDWISER MAGNUM TIN',
  'BACARDI CRANBERRY','MC WHISKY','MAGIC MOMENTS OR','BLEDERSPRIDE',
  'COURRIER NAPOLEAN','RED LABEL','MORPHEUS','VAT 69','ROYAL STAG',
  'MORPHEUS BLUE','MANSION HOUSE','KYRON BRANDY','MC WHISKY',
  'IMPERIAL BLUE','100 PIPERS','SIGNATURE','ABSOLUTE','BLACK LABEL'
];

async function main() {
  console.log('=== RESET AND FIX AC REPORT ===');
  
  // 1. Get all inventory items
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: true },
  });
  
  // 2. Identify image items (by name match)
  const imageItems = [];
  const nonImageItems = [];
  
  for (const item of items) {
    const name = String(item.menuItem?.name || '').toUpperCase().trim();
    const isImageItem = IMAGE_ITEM_NAMES.some(imgName => 
      name === imgName || name.includes(imgName) || imgName.includes(name)
    );
    if (isImageItem) {
      imageItems.push(item);
    } else {
      nonImageItems.push(item);
    }
  }
  
  console.log(`Image items found: ${imageItems.length}`);
  console.log(`Non-image items: ${nonImageItems.length}`);
  
  // 3. Force ALL non-image items to hidden
  console.log('\nHiding all non-image items...');
  for (const item of nonImageItems) {
    await prisma.inventoryItem.update({
      where: { id: item.id },
      data: { isHiddenFromReport: true },
    });
  }
  console.log(`  Hidden ${nonImageItems.length} items`);
  
  // 4. Force ALL image items to visible
  console.log('\nShowing all image items...');
  for (const item of imageItems) {
    await prisma.inventoryItem.update({
      where: { id: item.id },
      data: { isHiddenFromReport: false },
    });
  }
  console.log(`  Showed ${imageItems.length} items`);
  
  // 5. Delete all AcReportAdjustment for this date
  console.log('\nDeleting old adjustments...');
  const deleted = await prisma.acReportAdjustment.deleteMany({
    where: { restaurantId: RESTAURANT_ID, entryDate: REPORT_DATE },
  });
  console.log(`  Deleted ${deleted.count} adjustments`);
  
  // 6. Delete all DailyInventorySnapshot for this date (will be recreated by script)
  console.log('\nDeleting old snapshots...');
  const deletedSnaps = await prisma.dailyInventorySnapshot.deleteMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: REPORT_DATE },
  });
  console.log(`  Deleted ${deletedSnaps.count} snapshots`);
  
  console.log('\n=== RESET COMPLETE ===');
  console.log('Now run: node update-ac-report-31-08.js');
  
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
