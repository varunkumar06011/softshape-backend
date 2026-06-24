const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw`
    SELECT s.name as "sectionName", t."sectionTag", COUNT(*)::int as count
    FROM "Table" t
    JOIN "Section" s ON s.id = t."sectionId"
    WHERE t."restaurantId" = 'venue-001'
    GROUP BY s.name, t."sectionTag"
    ORDER BY s.name
  `;
  console.log('DB sectionTag state:');
  console.table(rows);

  // Also show a few sample tables
  const samples = await prisma.table.findMany({
    where: { restaurantId: 'venue-001' },
    include: { section: { select: { name: true } } },
    take: 5,
    orderBy: { number: 'asc' },
  });
  console.log('\nSample tables:');
  samples.forEach(t => {
    console.log(`  Table ${t.number} | section: ${t.section?.name} | sectionTag: ${t.sectionTag}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
