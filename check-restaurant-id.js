const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // Check what restaurantId is stored in the 31-08 __SUMMARY__ entry
  const e31 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
    select: { id: true, restaurantId: true, reportDate: true, notes: true },
  });
  console.log('31-08 entry restaurantId:', e31?.restaurantId);
  console.log('31-08 entry notes:', e31?.notes);

  // Check all restaurant IDs that have liquorReportNonAcEntry
  const allRestaurants = await prisma.liquorReportNonAcEntry.findMany({
    where: { categoryName: '__SUMMARY__' },
    select: { restaurantId: true, reportDate: true },
    distinct: ['restaurantId', 'reportDate'],
    orderBy: { reportDate: 'desc' },
    take: 10,
  });
  console.log('\nAll __SUMMARY__ entries by restaurant:');
  for (const r of allRestaurants) {
    console.log(`  restaurantId=${r.restaurantId}, date=${r.reportDate}`);
  }

  // Check what the barId would be for the authenticated user
  // The user's restaurant ID from the logs is cmqy60ci200027dscyj9ubg8h
  const userRestaurantId = 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\nUser restaurantId: ${userRestaurantId}`);
  console.log(`Match with 31-08 entry: ${e31?.restaurantId === userRestaurantId ? 'YES' : 'NO'}`);

  // Also check if there are any entries for 01-09
  const e01 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-09-01' },
  });
  console.log(`\n01-09 entries: ${e01 ? 'EXISTS' : 'NONE'}`);

  await prisma.$disconnect();
})();
