/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';

  // Check existing starter items for printerTarget and menuType
  const starters = await prisma.menuItem.findMany({
    where: {
      restaurantId: outletId,
      isDeleted: false,
      category: { name: { equals: 'Starters', mode: 'insensitive' } },
    },
    select: { id: true, name: true, menuType: true, printerTarget: true, printerName: true, category: { select: { name: true, printerTarget: true } } },
    take: 10,
  });
  console.log('Starters items:');
  for (const s of starters) {
    console.log(`  ${s.name} | menuType=${s.menuType} | printerTarget=${s.printerTarget} | printerName=${s.printerName} | category.printerTarget=${s.category?.printerTarget}`);
  }

  // Check the current Chicken Fry B/L item
  const item = await prisma.menuItem.findFirst({
    where: { restaurantId: outletId, name: { equals: 'Chicken Fry B/L', mode: 'insensitive' }, isDeleted: false },
    include: { category: true },
  });
  if (item) {
    console.log(`\nCurrent Chicken Fry B/L:`);
    console.log(`  id=${item.id} | menuType=${item.menuType} | printerTarget=${item.printerTarget} | category=${item.category?.name} | category.printerTarget=${item.category?.printerTarget}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
