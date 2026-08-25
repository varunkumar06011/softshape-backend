import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const search1 = 'z3695j';
  const search2 = '9o3n45';

  const outlets = await prisma.outlet.findMany({
    where: {
      OR: [
        { restaurantCode: { contains: search1, mode: 'insensitive' } },
        { restaurantCode: { contains: search2, mode: 'insensitive' } },
        { slug: { contains: search1, mode: 'insensitive' } },
        { slug: { contains: search2, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, restaurantCode: true, slug: true, restaurantType: true },
  });
  console.log(`Code/Slug matches:`, outlets.length);
  for (const o of outlets) {
    console.log(`  id=${o.id} | name=${o.name} | code=${o.restaurantCode} | slug=${o.slug} | type=${o.restaurantType}`);
  }

  // Also list all restaurantCodes
  const all = await prisma.outlet.findMany({
    select: { id: true, name: true, restaurantCode: true, slug: true },
  });
  console.log(`\nAll outlet codes:`);
  for (const o of all) {
    console.log(`  ${o.id} | ${o.name} | code=${o.restaurantCode || 'N/A'} | slug=${o.slug || 'N/A'}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
