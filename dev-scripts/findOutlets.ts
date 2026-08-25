import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // List all outlets to find the ones matching z3695j and 9o3n45
  const allOutlets = await prisma.outlet.findMany({
    select: { id: true, name: true, restaurantType: true, organizationId: true },
  });

  console.log(`Total outlets: ${allOutlets.length}`);
  console.log('\nAll outlets:');
  for (const o of allOutlets) {
    console.log(`  ${o.id} | ${o.name} | ${o.restaurantType || 'N/A'}`);
  }

  // Check if any outlet id or name contains these strings
  const search1 = 'z3695j';
  const search2 = '9o3n45';
  const matches1 = allOutlets.filter(o =>
    o.id.toLowerCase().includes(search1.toLowerCase()) ||
    o.name.toLowerCase().includes(search1.toLowerCase())
  );
  const matches2 = allOutlets.filter(o =>
    o.id.toLowerCase().includes(search2.toLowerCase()) ||
    o.name.toLowerCase().includes(search2.toLowerCase())
  );
  console.log(`\nMatches for "${search1}":`, matches1.length);
  console.log(`Matches for "${search2}":`, matches2.length);

  // Also check User table for these as codes
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { id: { contains: search1, mode: 'insensitive' } },
        { id: { contains: search2, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, email: true, outletId: true },
  });
  console.log(`\nUser matches:`, users.length);
  for (const u of users) {
    console.log(`  ${u.id} | ${u.name} | ${u.email} | outlet: ${u.outletId}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
