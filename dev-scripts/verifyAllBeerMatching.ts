// Verify beer matching for ALL beer menu items that could be ordered,
// against ALL beer inventory items. Simulates the findInventoryForOrderedItem
// logic to confirm every orderable beer will match its inventory.
//
// Usage: npx tsx dev-scripts/verifyAllBeerMatching.ts [restaurantId]

import prisma from '../src/lib/prisma';

const BEER_NAME_KEYWORDS = [
  'beer', 'lager', 'ale', 'bira', 'carlsberg', 'budweiser',
  'kingfisher', 'kf', 'coolberg', 'stok', 'draught',
];

function nameLooksLikeBeer(name: string): boolean {
  return BEER_NAME_KEYWORDS.some((k) => name.toLowerCase().includes(k));
}

function normalizeBeerName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/[aeiou]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Replicate the full findInventoryForOrderedItem logic
function findMatch(
  orderedName: string,
  inventoryByName: Map<string, any>,
  dualVariantMap: Map<string, { inv750: any; inv180: any }>,
): { match: any | null; method: string } {
  const normalized = orderedName.toLowerCase().trim();

  // 1. Exact match
  const direct = inventoryByName.get(normalized);
  if (direct) return { match: direct, method: 'exact' };

  // 2. Dual-variant match
  for (const [baseName, { inv750, inv180 }] of dualVariantMap.entries()) {
    if (normalized === baseName || normalized.startsWith(baseName)) {
      return { match: inv750 ?? inv180 ?? null, method: 'dual-variant' };
    }
  }

  // 3. Suffix-stripped match
  const stripped = normalized.replace(/\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i, '').trim();
  if (stripped !== normalized) {
    const partialMatch = inventoryByName.get(stripped);
    if (partialMatch) return { match: partialMatch, method: 'suffix-stripped' };
    const variant750 = inventoryByName.get(`${stripped} 750ml`);
    if (variant750) return { match: variant750, method: 'suffix-stripped→750ml' };
  }

  // 4. Beer fuzzy match (vowel-normalized)
  if (nameLooksLikeBeer(normalized)) {
    const normalizedOrdered = normalizeBeerName(normalized);
    for (const [invName, inv] of inventoryByName.entries()) {
      if (!nameLooksLikeBeer(invName)) continue;
      if (normalizeBeerName(invName) === normalizedOrdered) {
        return { match: inv, method: 'beer-fuzzy' };
      }
    }
  }

  // 5. Fuzzy prefix match
  for (const [invName, inv] of inventoryByName.entries()) {
    if (invName === normalized) continue;
    if (invName.startsWith(normalized + ' ') || normalized.startsWith(invName + ' ')) {
      return { match: inv, method: 'prefix' };
    }
  }

  return { match: null, method: 'NO MATCH' };
}

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';

  // 1. Load all beer inventory items
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { include: { variants: true, category: { select: { name: true } } } } },
  });
  const beerInv = invItems.filter((i) => nameLooksLikeBeer(i.menuItem?.name || ''));

  const inventoryByName = new Map<string, any>();
  for (const inv of beerInv) {
    const name = (inv.menuItem?.name || '').toLowerCase().trim();
    if (name) inventoryByName.set(name, inv);
  }

  const dualVariantMap = new Map<string, { inv750: any; inv180: any }>();
  for (const [invName, inv] of inventoryByName.entries()) {
    const match750 = invName.match(/^(.+)\s+750ml$/);
    const match180 = invName.match(/^(.+)\s+180ml$/);
    if (match750) {
      const base = match750[1];
      const inv180 = inventoryByName.get(`${base} 180ml`);
      if (inv180) dualVariantMap.set(base, { inv750: inv, inv180 });
    } else if (match180) {
      const base = match180[1];
      const inv750 = inventoryByName.get(`${base} 750ml`);
      if (inv750 && !dualVariantMap.has(base)) dualVariantMap.set(base, { inv750, inv180: inv });
    }
  }

  // 2. Load ALL beer menu items that could be ordered (not deleted, isAvailable)
  const allBeerMenuItems = await prisma.menuItem.findMany({
    where: { restaurantId, isDeleted: false, menuType: 'LIQUOR' },
    include: { category: { select: { name: true } } },
  });
  const orderableBeers = allBeerMenuItems.filter((m) => nameLooksLikeBeer(m.name || ''));

  console.log(`\n=== Beer matching verification for ${restaurantId} ===\n`);
  console.log(`Beer inventory items: ${beerInv.length}`);
  console.log(`Orderable beer menu items: ${orderableBeers.length}\n`);

  // 3. Test matching for each orderable beer
  console.log('--- Matching results ---\n');
  console.log('Ordered Beer Name'.padEnd(35) + ' | Matched Inventory Name'.padEnd(35) + ' | Method'.padEnd(16) + ' | Stock');
  console.log('-'.repeat(110));

  let allMatch = true;
  for (const beer of orderableBeers) {
    const { match, method } = findMatch(beer.name, inventoryByName, dualVariantMap);
    if (match) {
      const stock = Number(match.currentStock);
      const stockStr = stock > 0 ? `${stock}ml` : '0ml (NO STOCK!)';
      console.log(
        beer.name.padEnd(35) +
        ' | ' + (match.menuItem?.name || '?').padEnd(35) +
        ' | ' + method.padEnd(16) +
        ' | ' + stockStr
      );
      if (stock === 0) allMatch = false;
    } else {
      console.log(
        beer.name.padEnd(35) +
        ' | ' + '(NO MATCH)'.padEnd(35) +
        ' | ' + method.padEnd(16) +
        ' | N/A'
      );
      allMatch = false;
    }
  }

  // 4. Also check: are there any beer inventory items NOT matched by any orderable beer?
  console.log('\n\n--- Inventory items coverage check ---\n');
  const matchedInvIds = new Set<string>();
  for (const beer of orderableBeers) {
    const { match } = findMatch(beer.name, inventoryByName, dualVariantMap);
    if (match) matchedInvIds.add(match.id);
  }
  for (const inv of beerInv) {
    const covered = matchedInvIds.has(inv.id);
    console.log(`  ${inv.menuItem?.name?.padEnd(35)} ${covered ? 'COVERED' : 'NOT COVERED by any orderable beer'}  stock=${inv.currentStock}ml`);
  }

  // 5. Summary
  console.log('\n\n--- Summary ---\n');
  const matched = orderableBeers.filter((b) => findMatch(b.name, inventoryByName, dualVariantMap).match !== null).length;
  const unmatched = orderableBeers.length - matched;
  console.log(`  Orderable beers: ${orderableBeers.length}`);
  console.log(`  Matched:         ${matched}`);
  console.log(`  Unmatched:       ${unmatched}`);
  console.log(`  All have stock:  ${allMatch ? 'YES' : 'NO (some have 0 stock)'}`);

  if (unmatched > 0) {
    console.log('\n  UNMATCHED BEERS:');
    for (const beer of orderableBeers) {
      const { match, method } = findMatch(beer.name, inventoryByName, dualVariantMap);
      if (!match) {
        console.log(`    - "${beer.name}" (menuItemId: ${beer.id})`);
        console.log(`      Normalized: "${normalizeBeerName(beer.name)}"`);
        console.log(`      Available inventory beer names:`);
        for (const [invName] of inventoryByName.entries()) {
          console.log(`        "${invName}" → normalized: "${normalizeBeerName(invName)}"`);
        }
      }
    }
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
