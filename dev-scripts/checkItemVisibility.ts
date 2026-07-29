/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';

  // Check category
  const cat = await prisma.category.findFirst({
    where: { restaurantId: outletId, name: { equals: 'Liquor', mode: 'insensitive' } },
  });
  console.log('Category:', cat?.id, '| name:', cat?.name, '| isActive:', cat?.isActive, '| printerTarget:', cat?.printerTarget);

  // Check the two 180ml items specifically
  const items = await prisma.menuItem.findMany({
    where: {
      restaurantId: outletId,
      name: { contains: '180Ml', mode: 'insensitive' },
      isDeleted: false,
    },
    select: { id: true, name: true, isAvailable: true, isDeleted: true, menuType: true, printerTarget: true, categoryId: true, sortOrder: true, basePrice: true },
  });
  console.log('\n180Ml items:');
  for (const item of items) {
    console.log(`  ${item.id}  |  ${item.name}  |  isAvailable=${item.isAvailable}  |  isDeleted=${item.isDeleted}  |  sortOrder=${item.sortOrder}  |  categoryId=${item.categoryId}`);
  }

  // Check if category isActive
  if (cat) {
    const catItems = await prisma.menuItem.count({
      where: { categoryId: cat.id, isDeleted: false },
    });
    console.log(`\nCategory "${cat.name}" has ${catItems} non-deleted items, isActive=${cat.isActive}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
