import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId },
    include: { menuItem: { select: { name: true, menuType: true } } },
    orderBy: { menuItem: { name: 'asc' } },
  });
  console.log(`Inventory items for ${outletId}: ${items.length}`);
  for (const i of items) {
    console.log(`  ${i.id}  |  ${i.menuItem?.name}  |  stock=${i.currentStock}  |  bottleSize=${i.bottleSize}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
