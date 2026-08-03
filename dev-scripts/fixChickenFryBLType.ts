/// <reference types="node" />
import { PrismaClient, MenuType } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const itemId = '563c2857-1833-4c0e-b2fe-aa70665bd4d5';

  const updated = await prisma.menuItem.update({
    where: { id: itemId },
    data: {
      menuType: MenuType.FOOD,
      printerTarget: null,
      printerName: null,
    },
    select: { id: true, name: true, menuType: true, printerTarget: true, printerName: true, category: { select: { name: true, printerTarget: true } } },
  });

  console.log('Updated:');
  console.log(`  ${updated.name} | menuType=${updated.menuType} | printerTarget=${updated.printerTarget} | category=${updated.category?.name} | category.printerTarget=${updated.category?.printerTarget}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
