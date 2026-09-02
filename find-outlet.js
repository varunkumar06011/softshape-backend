// Find outlet Z3695J and its inventory items
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find outlet with restaurantCode Z3695J
  const outlets = await prisma.outlet.findMany({
    select: { id: true, name: true, restaurantCode: true }
  });
  console.log('All outlets:');
  for (const o of outlets) {
    console.log(`  id=${o.id}, name=${o.name}, code=${o.restaurantCode}`);
  }

  const match = outlets.find(o => o.restaurantCode === 'Z3695J');
  if (match) {
    console.log('\n=== Match found ===');
    console.log('Outlet ID:', match.id);
    console.log('Name:', match.name);
    console.log('Code:', match.restaurantCode);
  } else {
    console.log('\nNo exact match for Z3695J');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
