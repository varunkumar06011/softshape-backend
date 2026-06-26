require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const p = new PrismaClient();

const RESTAURANT_CODE = '00001';
const EMAIL = 'Varun34@gmail.com';
const PASSWORD = 'Varun098';
const NAME = 'Test Owner';

// Set to true if you want to update an existing user with this email
// (this will change their password and move them to the test restaurant)
const FORCE_UPDATE = process.env.FORCE_UPDATE === 'true';

async function main() {
  let restaurant = await p.restaurant.findUnique({
    where: { restaurantCode: RESTAURANT_CODE }
  });

  if (!restaurant) {
    restaurant = await p.restaurant.create({
      data: {
        restaurantCode: RESTAURANT_CODE,
        name: 'Test Restaurant',
        slug: 'test-restaurant',
        isActive: true,
        plan: 'starter',
        billingStatus: 'trialing',
        paymentStatus: 'LEGACY_EXEMPT',
      }
    });
    console.log('Created test restaurant:', restaurant.id, restaurant.restaurantCode);
  } else {
    console.log('Test restaurant already exists:', restaurant.id, restaurant.restaurantCode);
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const emailNormalized = EMAIL.trim().toLowerCase();

  const existingUser = await p.user.findUnique({
    where: { email: emailNormalized }
  });

  if (existingUser) {
    if (FORCE_UPDATE) {
      await p.user.update({
        where: { email: emailNormalized },
        data: {
          passwordHash,
          isActive: true,
          role: 'OWNER',
          restaurantId: restaurant.id,
          name: NAME
        }
      });
      console.log('Updated existing user:', emailNormalized);
    } else {
      console.log('User already exists with this email.');
      console.log('Run with FORCE_UPDATE=true to update their password and move them to the test restaurant.');
      console.log('Existing user restaurantId:', existingUser.restaurantId);
      console.log('Existing user role:', existingUser.role);
      console.log('Has passwordHash:', !!existingUser.passwordHash);
      return;
    }
  } else {
    await p.user.create({
      data: {
        email: emailNormalized,
        name: NAME,
        passwordHash,
        role: 'OWNER',
        isActive: true,
        restaurantId: restaurant.id
      }
    });
    console.log('Created test user:', emailNormalized);
  }

  console.log('Test credentials ready:');
  console.log('  Restaurant Code:', RESTAURANT_CODE);
  console.log('  Email:', EMAIL);
  console.log('  Password:', PASSWORD);
}

main()
  .catch(e => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
