require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const tables = await prisma.table.findMany({ where: { number: 999 } });
  console.log(tables);
}
main().finally(() => prisma.$disconnect());
