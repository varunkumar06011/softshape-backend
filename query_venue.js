const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('SECTIONS:');
  const sections = await prisma.section.findMany({ where: { restaurantId: 'venue-001' } });
  console.dir(sections, { depth: null });

  console.log('TABLES:');
  const tables = await prisma.table.findMany({ where: { restaurantId: 'venue-001' } });
  console.dir(tables, { depth: null });
}

main().catch(console.error).finally(() => prisma.$disconnect());
