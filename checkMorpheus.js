require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const item = await prisma.menuItem.findFirst({ where: { name: { contains: 'Morpheus' } } });
  console.log(item);
}
main().finally(() => prisma.$disconnect());
