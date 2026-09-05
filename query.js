const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const outlet = await prisma.outlet.findFirst({
    where: { restaurantCode: 'Z3695J' },
    select: { id: true },
  });
  if (!outlet) { console.log('Outlet not found'); return; }

  const items = await prisma.menuItem.findMany({
    where: {
      restaurantId: outlet.id,
      name: { contains: 'Royal Stag', mode: 'insensitive' },
    },
    select: { id: true, name: true, menuType: true, isAvailable: true, isDeleted: true, showInMenu: true },
  });
  console.log('All Royal Stag menu items:');
  for (const i of items) {
    console.log(`  ${i.name} | menuType=${i.menuType} | available=${i.isAvailable} | showInMenu=${i.showInMenu} | deleted=${i.isDeleted}`);
  }
}
main().then(() => prisma.$disconnect()).catch(e => { console.error(e); process.exit(1); });
