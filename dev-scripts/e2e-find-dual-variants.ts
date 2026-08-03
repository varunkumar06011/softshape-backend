// Find restaurants with dual-variant bar inventory pairs (750ml + 180ml)
import prisma from '../src/lib/prisma';

async function main() {
  const restaurants = await prisma.outlet.findMany({ select: { id: true, name: true } });
  for (const r of restaurants) {
    const barInv = await prisma.inventoryItem.findMany({
      where: { restaurantId: r.id },
      include: { menuItem: { select: { name: true } } },
    });
    const invByName = new Map<string, any>();
    for (const inv of barInv) {
      const name = (inv.menuItem?.name || '').toLowerCase().trim();
      if (name) invByName.set(name, inv);
    }
    for (const [name, inv] of invByName.entries()) {
      const m750 = name.match(/^(.+)\s+750ml$/);
      if (m750) {
        const base = m750[1];
        const inv180 = invByName.get(`${base} 180ml`);
        if (inv180) {
          console.log(`Restaurant: ${r.name} (${r.id})`);
          console.log(`  750ml: ${inv.menuItem?.name} (stock: ${inv.currentStock}ml)`);
          console.log(`  180ml: ${inv180.menuItem?.name} (stock: ${inv180.currentStock}ml)`);
          // Check if there's a matching liquor menu item
          const liquorItems = await prisma.menuItem.findMany({
            where: { restaurantId: r.id, menuType: 'LIQUOR', isDeleted: false },
            include: { variants: true },
          });
          const matchingLiquor = liquorItems.find(li => {
            const ln = li.name.toLowerCase().trim();
            return ln === base || ln.startsWith(base);
          });
          if (matchingLiquor) {
            console.log(`  Matching liquor menu item: ${matchingLiquor.name} (variants: ${matchingLiquor.variants.map(v => v.name + '=₹' + v.price).join(', ')})`);
          } else {
            console.log(`  No matching liquor menu item found for base name "${base}"`);
          }
          console.log('');
        }
      }
    }
  }
  await prisma.$disconnect();
}
main();
