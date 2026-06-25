const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const restaurants = await p.restaurant.findMany({
    select: { id: true, name: true, restaurantCode: true, slug: true, isActive: true }
  });
  console.log('All Restaurants:', JSON.stringify(restaurants, null, 2));

  const users = await p.user.findMany({
    select: { id: true, email: true, role: true, restaurantId: true, isActive: true }
  });
  console.log('All Users:', JSON.stringify(users, null, 2));

  await p.$disconnect();
}
main();
