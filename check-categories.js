const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: ['cmrdzuy0h00114hyclflzsd0m', 'cmthi14pj003n10j0f8o8qkec'] } },
    include: { menuItem: { include: { category: true, variants: true } } },
  });
  for (const inv of items) {
    console.log(`${inv.menuItem?.name}:`);
    console.log(`  category: ${inv.menuItem?.category?.name}`);
    console.log(`  bottleSize: ${inv.bottleSize}`);
    console.log(`  variants:`, inv.menuItem?.variants?.map(v => ({ name: v.name, price: v.price })));
    console.log();
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
