const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const e31 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
  });
  const e01 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-09-01', categoryName: '__SUMMARY__' },
  });
  console.log('31-08 __SUMMARY__:', e31 ? JSON.parse(e31.notes || '{}') : 'NONE');
  console.log('01-09 __SUMMARY__:', e01 ? JSON.parse(e01.notes || '{}') : 'NONE');
  console.log('31-08 updatedAt:', e31?.updatedAt);
  console.log('01-09 updatedAt:', e01?.updatedAt);
  await prisma.$disconnect();
})();
