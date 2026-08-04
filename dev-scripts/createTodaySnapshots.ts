// Create today's DailyInventorySnapshot for all bar inventory items that don't have one yet.
// This removes the "carried over" mark by giving each item a snapshot for today.
// Uses currentStock as both opening and closing (no transactions happened today).
//
// Usage: npx tsx dev-scripts/createTodaySnapshots.ts [restaurantId]

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';
import { getKolkataDateString } from '../src/utils/date';

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  const today = getKolkataDateString();
  console.log(`\n=== Creating today's (${today}) snapshots for ${restaurantId} ===\n`);

  const allItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { name: true } } },
  });
  console.log(`Total bar inventory items: ${allItems.length}`);

  // Find which ones already have a snapshot for today
  const existingSnapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId, snapshotDate: today },
    select: { itemId: true },
  });
  const withSnapshot = new Set(existingSnapshots.map((s) => s.itemId));
  const missing = allItems.filter((i) => !withSnapshot.has(i.id));
  console.log(`Already have today's snapshot: ${withSnapshot.size}`);
  console.log(`Missing today's snapshot:      ${missing.length}\n`);

  if (missing.length === 0) {
    console.log('All items already have a snapshot for today. Nothing to do.');
    return;
  }

  let created = 0;
  for (const item of missing) {
    const stock = Number(item.currentStock);
    await prisma.dailyInventorySnapshot.create({
      data: {
        restaurantId,
        itemId: item.id,
        snapshotDate: today,
        itemName: item.menuItem?.name || 'Unknown',
        openingStock: new Prisma.Decimal(stock),
        purchased: new Prisma.Decimal(0),
        sold: new Prisma.Decimal(0),
        wastage: new Prisma.Decimal(0),
        adjusted: new Prisma.Decimal(0),
        closingStock: new Prisma.Decimal(stock),
      },
    });
    created++;
    console.log(`  Created snapshot: "${item.menuItem?.name}"  stock=${stock}ml`);
  }

  console.log(`\nDone. Created ${created} snapshots.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
