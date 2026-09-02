const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLET_ID = 'cmqy60ci200027dscyj9ubg8h';

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: OUTLET_ID, isActive: true },
    include: { menuItem: { include: { category: true, variants: true } } },
  });
  const cats = new Map();
  for (const inv of items) {
    const cat = inv.menuItem?.category?.name || 'Unknown';
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push({ name: inv.menuItem?.name, bottleSize: inv.bottleSize, has30ml: inv.menuItem?.variants?.some(v => v.name.trim().toLowerCase() === '30ml') });
  }
  for (const [cat, list] of cats) {
    console.log(`\n=== ${cat} (${list.length} items) ===`);
    for (const i of list) {
      console.log(`  ${i.name} (btl=${i.bottleSize}, 30ml=${i.has30ml})`);
    }
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
