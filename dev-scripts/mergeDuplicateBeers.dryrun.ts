// DRY-RUN ONLY: Identify duplicate beer menu items — correctly-spelled ones (ordered, no inventory)
// vs misspelled ones (have inventory/Opening Stock). Proposes stock transfers.
//
// Does NOT write anything. Prints a plan for review.
//
// Usage: npx tsx dev-scripts/mergeDuplicateBeers.dryrun.ts [restaurantId]

import prisma from '../src/lib/prisma';

function isBeerItem(item: any): boolean {
  if (!item) return false;
  const categoryObj = item.category;
  let category = '';
  if (categoryObj && typeof categoryObj === 'object' && 'name' in categoryObj) {
    category = String(categoryObj.name || '').toLowerCase();
  } else if (typeof categoryObj === 'string') {
    category = categoryObj.toLowerCase();
  }
  if (category.includes('beer')) return true;
  const name = String(item.name || '').toLowerCase();
  const beerKeywords = ['beer', 'lager', 'ale', 'bira', 'carlsberg', 'budweiser', 'kingfisher', 'kf', 'coolberg', 'stok', 'draught'];
  return beerKeywords.some(keyword => name.includes(keyword));
}

// Levenshtein distance for fuzzy name comparison
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Normalize name for comparison: lowercase, remove extra spaces, common misspellings
function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  console.log(`\n=== Duplicate beer merge DRY-RUN for ${restaurantId} ===\n`);

  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId, menuType: 'LIQUOR' },
    include: {
      category: { select: { name: true } },
      variants: { select: { id: true, name: true, price: true } },
      inventoryItem: { select: { id: true, currentStock: true, openingStock: true, bottleSize: true } },
    },
  });
  const beerMenuItems = menuItems.filter((m) => isBeerItem(m));

  // Split: ones WITH inventory (have Opening Stock) vs ones WITHOUT
  const withInventory = beerMenuItems.filter((m) => (m as any).inventoryItem);
  const withoutInventory = beerMenuItems.filter((m) => !(m as any).inventoryItem);

  console.log(`Beer menu items total:       ${beerMenuItems.length}`);
  console.log(`  With inventory (has stock):  ${withInventory.length}`);
  console.log(`  Without inventory (no stock):${withoutInventory.length}\n`);

  // Count how many orders each menu item appears in (to identify which ones are actually ordered)
  const orderCounts = new Map<string, number>();
  for (const m of beerMenuItems) {
    const count = await prisma.orderItem.count({
      where: { menuItemId: m.id, removedFromBill: false, quantity: { gt: 0 } },
    });
    orderCounts.set(m.id, count);
  }

  console.log('--- All beer menu items with order counts ---\n');
  console.log('Name'.padEnd(35) + ' | Orders | Has Inv | Stock (ml)');
  console.log('-'.repeat(75));
  for (const m of [...beerMenuItems].sort((a, b) => a.name.localeCompare(b.name))) {
    const inv = (m as any).inventoryItem;
    const orders = orderCounts.get(m.id) || 0;
    console.log(
      m.name.padEnd(35) +
      ' | ' + String(orders).padStart(6) +
      ' | ' + (inv ? 'YES' : 'NO ').padEnd(7) +
      ' | ' + (inv ? `${inv.currentStock}` : '-')
    );
  }

  // Propose pairs: for each "without inventory" item that has orders,
  // find the closest "with inventory" item by name similarity
  console.log('\n\n--- Proposed merge pairs ---\n');
  const proposals: Array<{
    source: typeof withInventory[0];
    target: typeof withoutInventory[0];
    distance: number;
    sourceStock: string;
  }> = [];

  for (const target of withoutInventory) {
    const targetOrders = orderCounts.get(target.id) || 0;
    if (targetOrders === 0) continue; // skip items never ordered

    const targetNorm = normalizeName(target.name);
    let bestMatch: typeof withInventory[0] | null = null;
    let bestDist = Infinity;

    for (const source of withInventory) {
      const sourceNorm = normalizeName(source.name);
      const dist = levenshtein(targetNorm, sourceNorm);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = source;
      }
    }

    if (bestMatch && bestDist <= 3) {
      proposals.push({
        source: bestMatch,
        target,
        distance: bestDist,
        sourceStock: (bestMatch as any).inventoryItem.currentStock,
      });
    } else if (bestMatch) {
      console.log(`  ? "${target.name}" (orders=${targetOrders}) — closest match "${bestMatch.name}" but distance=${bestDist} too large, skipping`);
    } else {
      console.log(`  ! "${target.name}" (orders=${targetOrders}) — no inventory item to merge from. Need to add Opening Stock directly.`);
    }
  }

  for (const p of proposals) {
    const sourceInv = (p.source as any).inventoryItem;
    const targetOrders = orderCounts.get(p.target.id) || 0;
    const sourceOrders = orderCounts.get(p.source.id) || 0;
    console.log(`\n  MERGE: "${p.source.name}" → "${p.target.name}"  (levenshtein=${p.distance})`);
    console.log(`    SOURCE (has stock):  id=${p.source.id}  orders=${sourceOrders}  stock=${sourceInv.currentStock}ml  bottleSize=${sourceInv.bottleSize}`);
    console.log(`    TARGET (gets orders):id=${p.target.id}  orders=${targetOrders}  stock=(none)`);
    console.log(`    PLAN: Create inventory item on TARGET with openingStock=${sourceInv.currentStock}ml, bottleSize=${sourceInv.bottleSize}`);
    console.log(`          then delete/deactivate SOURCE inventory item (and optionally the SOURCE menu item)`);
  }

  // Items with inventory but 0 orders — these are pure duplicates that can be removed
  console.log('\n\n--- Inventory items with 0 orders (pure duplicates, safe to remove) ---\n');
  for (const m of withInventory) {
    const orders = orderCounts.get(m.id) || 0;
    if (orders === 0) {
      const inv = (m as any).inventoryItem;
      console.log(`  "${m.name}"  id=${m.id}  invId=${inv.id}  stock=${inv.currentStock}ml`);
    }
  }

  // Items without inventory AND 0 orders — harmless, no action needed
  console.log('\n\n--- Items with no inventory and 0 orders (no action needed) ---\n');
  for (const m of withoutInventory) {
    const orders = orderCounts.get(m.id) || 0;
    if (orders === 0) {
      console.log(`  "${m.name}"  id=${m.id}`);
    }
  }

  // Items without inventory but WITH orders and no merge candidate — need Opening Stock added directly
  console.log('\n\n--- Items with orders but no inventory and no merge candidate (need Opening Stock added) ---\n');
  const mergedTargetIds = new Set(proposals.map((p) => p.target.id));
  for (const m of withoutInventory) {
    const orders = orderCounts.get(m.id) || 0;
    if (orders > 0 && !mergedTargetIds.has(m.id)) {
      console.log(`  "${m.name}"  id=${m.id}  orders=${orders}  — NO matching inventory to merge from`);
    }
  }

  console.log('\n=== DRY-RUN complete — no changes made ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
