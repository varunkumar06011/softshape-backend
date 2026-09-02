const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RESTAURANT_ID = 'cmqy60ci200027dscyj9ubg8h';

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  
  // Find all morpheus items
  const morpheusItems = items.filter(i => i.menuItem?.name?.toLowerCase().includes('morpheus'));
  console.log('Morpheus items:');
  morpheusItems.forEach(i => console.log(`  ${i.menuItem.name} | size: ${i.bottleSize}ml | opening: ${i.openingStock} | cost: ${i.costPerBottle}`));

  // Find all items with "morpheus" normalized base
  const normalizeBase = (name) => String(name).toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
    .replace(/\s*\b(full\s+bottle|bottle|can)\b\s*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  console.log('\nNormalized bases for morpheus items:');
  morpheusItems.forEach(i => console.log(`  "${normalizeBase(i.menuItem?.name)}" → ${i.menuItem.name}`));

  // Also check what "not found" brands from stock sheet might match
  console.log('\nAll items with "morpheus" in normalized base:');
  items.forEach(i => {
    const base = normalizeBase(i.menuItem?.name || '');
    if (base.includes('morpheus')) {
      console.log(`  base: "${base}" | name: ${i.menuItem.name} | size: ${i.bottleSize}ml | opening: ${i.openingStock}`);
    }
  });

  await p.$disconnect();
})();
