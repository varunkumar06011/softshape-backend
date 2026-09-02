const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const tables = await p.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
    console.log('Tables in schema:', tables.length);
    tables.forEach(t => console.log(' -', t.table_name));
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
