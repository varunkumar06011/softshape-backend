import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL?.replace(/:.+@/, ':****@'));
  
  const totalOutlets = await prisma.outlet.count();
  console.log('\nTotal outlets in database:', totalOutlets);
  
  const allOutlets = await prisma.outlet.findMany({
    take: 20,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      restaurantCode: true,
      slug: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    }
  });
  
  console.log('\nRecent outlets:');
  console.log(allOutlets);
  
  const specificOutlet = await prisma.outlet.findFirst({
    where: {
      OR: [
        { restaurantCode: '87KJ70' },
        { slug: { contains: 'grand' } },
      ]
    },
    select: {
      id: true,
      name: true,
      restaurantCode: true,
      slug: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    }
  });
  
  if (specificOutlet) {
    console.log('\nFound matching outlet:', specificOutlet);
  } else {
    console.log('\nNo outlet found with restaurantCode 87KJ70 or slug containing "grand"');
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
