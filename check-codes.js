const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const outlets = await p.outlet.findMany({ select: { id: true, name: true, slug: true, restaurantCode: true } });
  outlets.forEach(r => {
    console.log(`  ${r.id} | ${r.name} | slug: ${r.slug} | code: ${r.restaurantCode || 'NULL'}`);
  });
  await p.$disconnect();
})();
