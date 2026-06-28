import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL?.replace(/:.+@/, ':****@'));
  
  const counts = await prisma.$transaction([
    prisma.outlet.count(),
    prisma.user.count(),
    prisma.user.count({ where: { email: 'vgrandlounge@gmail.com' } }),
    prisma.organization.count(),
    prisma.order.count(),
    prisma.menuItem.count(),
    prisma.table.count(),
    prisma.category.count(),
  ]);

  console.log('\nDatabase counts:');
  console.log('  Outlets:', counts[0]);
  console.log('  Users:', counts[1]);
  console.log('  Users with vgrandlounge@gmail.com:', counts[2]);
  console.log('  Organizations:', counts[3]);
  console.log('  Orders:', counts[4]);
  console.log('  MenuItems:', counts[5]);
  console.log('  Tables:', counts[6]);
  console.log('  Categories:', counts[7]);

  const allUsers = await prisma.user.findMany({
    where: { email: 'vgrandlounge@gmail.com' },
    select: { id: true, email: true, name: true, role: true, isActive: true, outletId: true, createdAt: true },
  });
  console.log('\nUsers with vgrandlounge@gmail.com:', allUsers);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
