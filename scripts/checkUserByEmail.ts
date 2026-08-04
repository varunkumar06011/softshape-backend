import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const email = process.argv[2]?.trim().toLowerCase();
const restaurantCode = process.argv[3]?.trim().toUpperCase();

if (!email || !restaurantCode) {
  console.log('Usage: npx ts-node scripts/checkUserByEmail.ts <email> <restaurantCode>');
  process.exit(1);
}

async function main() {
  const outlet = await prisma.outlet.findUnique({
    where: { restaurantCode },
  });

  if (!outlet) {
    console.log('Outlet not found for restaurantCode:', restaurantCode);
    return;
  }

  console.log('Outlet found:', outlet.id, outlet.name, 'active:', outlet.isActive);

  const user = await prisma.user.findFirst({
    where: { email, outletId: outlet.id },
    include: { outlet: true, outletAccess: { include: { outlet: true } } },
  });

  if (!user) {
    console.log('User not found for email:', email, 'outletId:', outlet.id);
    console.log('\nSearching by email only (any outlet):');
    const allUsers = await prisma.user.findMany({
      where: { email },
      select: { id: true, email: true, role: true, isActive: true, outletId: true, createdAt: true },
    });
    console.log(allUsers);
    return;
  }

  console.log('User found:', {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    hasPasswordHash: !!user.passwordHash,
    outletId: user.outletId,
    outletName: user.outlet?.name,
    outletAccessCount: user.outletAccess.length,
    outletAccess: user.outletAccess.map(oa => ({ id: oa.outlet.id, name: oa.outlet.name, code: oa.outlet.restaurantCode })),
  });
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
