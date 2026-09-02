const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const vc = await p.vendor.count();
    console.log('Vendor count:', vc);
    const pc = await p.purchaseOrder.count();
    console.log('PO count:', pc);
    const ec = await p.expenditure.count();
    console.log('Expenditure count:', ec);
    const rc = await p.restaurant.count();
    console.log('Restaurant count:', rc);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
