const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    // Get all inventory items with their menu items
    const items = await p.inventoryItem.findMany({
      include: { menuItem: { select: { name: true, menuType: true, category: true } } },
      orderBy: { menuItem: { name: 'asc' } },
    });

    console.log(`Total inventory items: ${items.length}`);
    console.log('\n--- All items (name | bottleSize | menuType | category) ---');
    items.forEach(i => {
      console.log(`  ${i.menuItem?.name} | ${i.bottleSize}ml | ${i.menuItem?.menuType} | ${i.menuItem?.category || 'N/A'} | stock: ${i.currentStock}`);
    });

    // Check for items with wrong bottle sizes (name says one size, bottleSize is different)
    console.log('\n--- Items with MISMATCHED bottle size (name vs bottleSize) ---');
    let mismatches = 0;
    items.forEach(i => {
      const name = i.menuItem?.name || '';
      const mlMatch = name.match(/(\d+)\s*ml/i);
      if (mlMatch) {
        const nameSize = parseInt(mlMatch[1], 10);
        if (nameSize !== Number(i.bottleSize)) {
          console.log(`  MISMATCH: "${name}" → name says ${nameSize}ml but bottleSize is ${i.bottleSize}ml`);
          mismatches++;
        }
      }
    });
    console.log(`Total mismatches: ${mismatches}`);

    // Group by base brand name to see what sizes exist per brand
    const normalizeBase = (name) => {
      return String(name).toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
        .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const brandMap = new Map();
    items.forEach(i => {
      const base = normalizeBase(i.menuItem?.name || '');
      if (!base) return;
      if (!brandMap.has(base)) brandMap.set(base, []);
      brandMap.get(base).push({
        name: i.menuItem?.name,
        bottleSize: Number(i.bottleSize),
        itemId: i.id,
        menuType: i.menuItem?.menuType,
      });
    });

    console.log('\n--- Brands and their available sizes ---');
    const sortedBrands = [...brandMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    sortedBrands.forEach(([brand, sizes]) => {
      const sizeList = sizes.map(s => `${s.bottleSize}ml`).join(', ');
      const types = [...new Set(sizes.map(s => s.menuType))];
      console.log(`  ${brand} [${types.join(',')}] → ${sizeList}`);
    });

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
