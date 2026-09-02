const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const LIQUOR_PRICES = {
  'ballantines': { 180: 0, 375: 0, 750: 2632.79 },
};

function normalizeBase(name) {
  return String(name).toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  const items = await p.inventoryItem.findMany({
    where: { restaurantId: 'cmqy60ci200027dscyj9ubg8h', isActive: true, bottleSize: 750 },
    include: { menuItem: { select: { name: true } } },
  });
  const ballantines = items.find(i => (i.menuItem?.name || '').toLowerCase().includes('ballan'));
  if (ballantines) {
    const name = ballantines.menuItem.name;
    const base = normalizeBase(name);
    console.log('Name:', JSON.stringify(name));
    console.log('Normalized base:', JSON.stringify(base));
    console.log('In LIQUOR_PRICES:', base in LIQUOR_PRICES);
    console.log('LIQUOR_PRICES[base]:', LIQUOR_PRICES[base]);
    console.log('LIQUOR_PRICES[base][750]:', LIQUOR_PRICES[base] ? LIQUOR_PRICES[base][750] : 'N/A');
  }
  await p.$disconnect();
})();
