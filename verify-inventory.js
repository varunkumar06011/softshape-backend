const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    // Active items only
    const active = await p.inventoryItem.findMany({
      where: { isActive: true },
      include: { menuItem: { select: { name: true } } },
    });
    console.log(`Active inventory items: ${active.length}`);

    // Group by bottle size
    const sizes = {};
    active.forEach(i => {
      const s = Number(i.bottleSize);
      sizes[s] = (sizes[s] || 0) + 1;
    });
    console.log('\nActive bottle size distribution:');
    Object.keys(sizes).sort((a,b) => a-b).forEach(s => console.log(`  ${s}ml: ${sizes[s]} items`));

    // Check 30ml items are inactive
    const inactive30 = await p.inventoryItem.findMany({
      where: { isActive: false, bottleSize: 30 },
    });
    console.log(`\nInactive 30ml items: ${inactive30.length} (hidden from inventory view)`);

    // Verify every liquor brand has 180+375+750
    const normalizeBase = (name) => String(name).toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\s*\d+\s*(?:ml|l(?:tr|itre|iter)?|l)\b/gi, ' ')
      .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, ' ')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    const BEER_KEYWORDS = ['beer','bira','boom','carlsberg','kf ','kingfisher','budweiser','stok','coolberg','corona','heineken','tuborg','kalyani','karjura','british empire strong','british ultra'];
    const BREEZER_KEYWORDS = ['breezer','bacardi cranberry'];
    const TIN_KEYWORDS = ['tin'];
    const SOFT_DRINK_KEYWORDS = ['coca cola','cola','fanta','limca','maaza','monster','pulpy','rimzim','soda','sprite','thums up','thumbs up','energy'];
    const WATER_KEYWORDS = ['water','kinley'];
    const isNonLiquor = (name) => {
      const n = name.toLowerCase();
      return BEER_KEYWORDS.some(k=>n.includes(k)) || BREEZER_KEYWORDS.some(k=>n.includes(k))
        || TIN_KEYWORDS.some(k=>n.includes(k)) || SOFT_DRINK_KEYWORDS.some(k=>n.includes(k))
        || WATER_KEYWORDS.some(k=>n.includes(k));
    };

    const brandMap = new Map();
    active.forEach(i => {
      const name = i.menuItem?.name || '';
      if (isNonLiquor(name)) return;
      const base = normalizeBase(name);
      if (!base) return;
      if (!brandMap.has(base)) brandMap.set(base, new Set());
      brandMap.get(base).add(Number(i.bottleSize));
    });

    console.log('\n--- Liquor brands size check ---');
    let allGood = true;
    for (const [brand, sizes] of brandMap.entries()) {
      const has750 = sizes.has(750);
      const has180 = sizes.has(180);
      const has375 = sizes.has(375);
      const extra = [...sizes].filter(s => ![750,180,375].includes(s));
      const status = (has750 && has180 && has375) ? 'OK' : 'MISSING';
      if (status === 'MISSING' || extra.length > 0) allGood = false;
      const missing = [];
      if (!has750) missing.push('750');
      if (!has180) missing.push('180');
      if (!has375) missing.push('375');
      console.log(`  ${status === 'OK' && extra.length === 0 ? '✓' : '✗'} ${brand} → ${[...sizes].sort((a,b)=>a-b).join(', ')}ml${missing.length ? ' MISSING: ' + missing.join(',') : ''}${extra.length ? ' EXTRA: ' + extra.join(',') : ''}`);
    }
    console.log(`\nAll liquor brands have 180+375+750: ${allGood ? 'YES' : 'NO'}`);

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
