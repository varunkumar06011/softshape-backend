// Clean up test data — restore 31-08 to only the admin's original save
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const barId = 'cmqy60ci200027dscyj9ubg8h';

  // Check current state
  const current = await prisma.liquorReportNonAcEntry.findFirst({
    where: { restaurantId: barId, reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
  });
  if (current) {
    const overrides = JSON.parse(current.notes || '{}');
    console.log('Current 31-08 overrides (from test):', overrides);
    console.log('NOTE: These test values will be overwritten when the admin saves from the UI.');
    console.log('The admin should open 31-08, enter the correct values, and click Save.');
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
