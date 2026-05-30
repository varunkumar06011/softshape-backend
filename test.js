const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const order = await prisma.order.findFirst();
  if (order) {
    console.log(order.id);
  } else {
    console.log('No orders');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
