const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

async function main() {
  // Get start/end of Aug 31, 2026 in UTC
  const start = new Date('2026-08-31T00:00:00Z');
  const end = new Date('2026-09-01T00:00:00Z');
  
  // Find POS transactions for this date
  const txns = await prisma.transaction.findMany({
    where: {
      status: 'COMPLETED',
      paidAt: { gte: start, lt: end },
      order: { restaurantId: RESTAURANT_ID, isDeleted: false }
    },
    select: { id: true, grandTotal: true, amount: true, paidAt: true }
  });
  console.log('Transactions:', txns.length, 'Total:', txns.reduce((s,t) => s + (Number(t.grandTotal)||Number(t.amount)||0), 0));
  
  // Find order items
  const orderItems = await prisma.orderItem.findMany({
    where: {
      removedFromBill: false,
      order: {
        status: 'PAID',
        isDeleted: false,
        restaurantId: RESTAURANT_ID,
        transactions: {
          status: 'COMPLETED',
          paidAt: { gte: start, lt: end }
        }
      }
    },
    include: {
      menuItem: { select: { name: true, category: { select: { name: true } } } }
    }
  });
  
  console.log('\n=== POS Order Items ===');
  const itemMap = new Map();
  for (const oi of orderItems) {
    const name = oi.menuItem?.name || 'Unknown';
    const price = Number(oi.price) * (oi.quantity || 0);
    itemMap.set(name, (itemMap.get(name) || 0) + price);
  }
  
  let total = 0;
  for (const [name, rev] of [...itemMap.entries()].sort((a,b) => b[1] - a[1])) {
    total += rev;
    console.log(name.padEnd(30), '₹' + rev.toFixed(2));
  }
  console.log('Total POS Revenue: ₹' + total.toFixed(2));
  
  await prisma.$disconnect();
}
main().catch(console.error);
