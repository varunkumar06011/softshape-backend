const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const outlets = await p.outlet.findMany();
  console.log('All outlets:');
  outlets.forEach(r => {
    console.log(`  id: ${r.id} | name: ${r.name} | slug: ${r.slug}`);
    console.log(`    keys: ${Object.keys(r).join(', ')}`);
  });
  await p.$disconnect();
})();
