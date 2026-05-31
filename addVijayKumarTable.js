require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const BAR_ID = 'bar-001';
  let section = await prisma.section.findFirst({ where: { name: 'Counter', restaurantId: BAR_ID } });
  if (!section) {
    section = await prisma.section.create({ data: { name: 'Counter', restaurantId: BAR_ID } });
  }

  const existing = await prisma.table.findFirst({ where: { number: 999, restaurantId: BAR_ID } });
  if (!existing) {
    await prisma.table.create({
      data: {
        number: 999,
        capacity: 0,
        status: 'AVAILABLE',
        sectionId: section.id,
        restaurantId: BAR_ID,
      }
    });
    console.log('Added Table 999 (Vijay Kumar)');
  } else {
    console.log('Table 999 already exists');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
