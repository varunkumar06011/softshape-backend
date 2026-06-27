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
  let outlet = await p.outlet.findUnique({
    where: { restaurantCode: RESTAURANT_CODE }
  });

  if (!outlet) {
    let organization = await p.organization.findFirst({
      where: { name: 'Test Organization' }
    });

    if (!organization) {
      organization = await p.organization.create({
        data: {
          name: 'Test Organization',
          plan: 'starter',
          billingStatus: 'trialing',
          paymentStatus: 'LEGACY_EXEMPT',
        }
      });
      console.log('Created test organization:', organization.id);
    }

    outlet = await p.outlet.create({
      data: {
        restaurantCode: RESTAURANT_CODE,
        name: 'Test Restaurant',
        slug: 'test-restaurant',
        isActive: true,
        organizationId: organization.id,
      }
    });
    console.log('Created test outlet:', outlet.id, outlet.restaurantCode);
  } else {
    console.log('Test outlet already exists:', outlet.id, outlet.restaurantCode);
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const emailNormalized = EMAIL.trim().toLowerCase();

  const existingUser = await p.user.findFirst({
    where: { email: emailNormalized, outletId: outlet.id }
  });

  if (existingUser) {
    if (FORCE_UPDATE) {
      await p.user.update({
        where: { id: existingUser.id },
        data: {
          passwordHash,
          isActive: true,
          role: 'OWNER',
          outletId: outlet.id,
          name: NAME
        }
      });
      console.log('Updated existing user:', emailNormalized);
    } else {
      console.log('User already exists with this email.');
      console.log('Run with FORCE_UPDATE=true to update their password and move them to the test outlet.');
      console.log('Existing user outletId:', existingUser.outletId);
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
        outletId: outlet.id
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
