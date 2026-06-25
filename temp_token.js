require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const p = new PrismaClient();

async function main() {
  const user = await p.user.findFirst({
    where: { email: 'user-a@test.com' },
    include: { restaurant: true }
  });
  if (!user) { console.log('No user found'); process.exit(1); }

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, restaurantId: user.restaurantId, restaurantCode: user.restaurant.restaurantCode, slug: user.restaurant.slug },
    process.env.JWT_SECRET || 'softshape-secret-key-2024',
    { expiresIn: '24h' }
  );
  console.log(token);
  await p.$disconnect();
}
main();
