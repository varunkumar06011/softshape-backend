// Read-only inspection: verify beer items, their bar inventory, variants,
// and simulate the deduction logic in inventoryService.ts to confirm a
// settled beer order will deduct from bar inventory stock.
//
// Usage: npx tsx dev-scripts/checkBeerDeduction.ts [restaurantId]
//
// Safe: only runs SELECT queries and in-memory simulation. No writes.

import { PrismaClient } from '@prisma/client';
import prisma from '../src/lib/prisma';

// Mirror of isBeerItem from src/utils/itemHelpers.ts
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
  const beerKeywords = [
    'beer', 'lager', 'ale', 'bira', 'carlsberg', 'budweiser',
    'kingfisher', 'kf', 'coolberg', 'stok', 'draught'
  ];
  return beerKeywords.some(keyword => name.includes(keyword));
}

const BAR_UNIT_ML = 30;

async function main() {
  const restaurantId = process.argv[2];
  if (!restaurantId) {
    console.error('Usage: npx tsx dev-scripts/checkBeerDeduction.ts <restaurantId>');
    process.exit(1);
  }

  console.log(`\n=== Beer deduction check for restaurant ${restaurantId} ===\n`);

  // 1. Find all bar inventory items whose menu item is beer
  const inventoryItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: {
      menuItem: {
        include: {
          variants: true,
          category: { select: { name: true } },
        },
      },
    },
    orderBy: { menuItem: { name: 'asc' } },
  });

  const beerInvItems = inventoryItems.filter((i: any) => isBeerItem(i.menuItem));
  const nonBeerLiquorInv = inventoryItems.filter(
    (i: any) => !isBeerItem(i.menuItem) && (i.menuItem?.menuType === 'LIQUOR' || i.menuItem?.menuType === 'BAR')
  );

  console.log(`Total bar inventory items: ${inventoryItems.length}`);
  console.log(`Beer inventory items: ${beerInvItems.length}`);
  console.log(`Non-beer liquor inventory items: ${nonBeerLiquorInv.length}\n`);

  if (beerInvItems.length === 0) {
    console.log('!! No beer items found in bar inventory for this restaurant.');
    console.log('   Possible reasons:');
    console.log('   - Beer menu items exist but no inventory item was created (Opening Stock not added)');
    console.log('   - Beer category name does not contain "beer" and name has no beer keyword');
    console.log('   - Wrong restaurantId');
    return;
  }

  // 2. Detailed report per beer inventory item
  console.log('--- Beer inventory items ---');
  for (const inv of beerInvItems) {
    const mi: any = inv.menuItem;
    const detected = isBeerItem(mi);
    const reason = mi.category?.name?.toLowerCase().includes('beer')
      ? `category="${mi.category?.name}"`
      : `name keyword match`;

    console.log(`\n  • ${mi.name}  (id=${mi.id})`);
    console.log(`    menuType:        ${mi.menuType}`);
    console.log(`    category:        ${mi.category?.name ?? '(none)'}`);
    console.log(`    isBeerItem:      ${detected}  [${reason}]`);
    console.log(`    bottleSize:      ${inv.bottleSize} ml`);
    console.log(`    openingStock:    ${inv.openingStock} ml  (${Number(inv.openingStock) / Number(inv.bottleSize)} bottles)`);
    console.log(`    currentStock:    ${inv.currentStock} ml  (${Number(inv.currentStock) / Number(inv.bottleSize)} bottles)`);
    console.log(`    reorderLevel:    ${inv.reorderLevel}`);
    console.log(`    variants:`);
    if (!mi.variants || mi.variants.length === 0) {
      console.log(`      (none)  -> deduction will default to 650ml per unit`);
    } else {
      for (const v of mi.variants) {
        const parsedMl = parseInt(String(v.name).replace(/[^0-9]/g, ''), 10);
        const effectiveMl = isNaN(parsedMl) || parsedMl <= 0 ? 650 : parsedMl;
        console.log(`      - "${v.name}"  price=₹${v.price}  -> parsed mlPerUnit=${effectiveMl}`);
      }
    }

    // menuType check
    if (mi.menuType !== 'LIQUOR' && mi.menuType !== 'BAR') {
      console.log(`    !! WARNING: menuType is "${mi.menuType}" — this item will NOT be treated as liquor`);
      console.log(`       and will be SKIPPED by deductInventoryForOrder (only LIQUOR/BAR items deduct).`);
    }
  }

  // 3. Find recent settled orders that contained beer, and check whether deduction happened
  console.log('\n\n--- Recent settled orders containing beer (last 10) ---');
  const recentOrders = await prisma.order.findMany({
    where: {
      restaurantId,
      status: 'PAID',
      items: { some: { menuItem: { menuType: 'LIQUOR' } } },
    },
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: { include: { category: { select: { name: true } } } } },
      },
    },
    orderBy: { paidAt: 'desc' },
    take: 50,
  });

  let shown = 0;
  for (const o of recentOrders) {
    if (shown >= 10) break;
    const beerItems = o.items.filter((it: any) => isBeerItem(it.menuItem));
    if (beerItems.length === 0) continue;
    shown++;

    console.log(`\n  Order ${o.id}  paidAt=${o.paidAt?.toISOString()}  barInventoryDeducted=${(o as any).barInventoryDeducted}`);

    // Check bar deduction logs for this order
    const logs = await prisma.barDeductionLog.findMany({
      where: { orderId: o.id },
      include: { inventoryItem: { include: { menuItem: { select: { name: true } } } } },
    });
    const beerLogs = logs.filter((l: any) => isBeerItem(l.inventoryItem?.menuItem));

    for (const it of beerItems) {
      const mi: any = it.menuItem;
      console.log(`    ordered: ${it.quantity} x ${mi.name} @ ₹${it.price}`);
    }
    if (beerLogs.length === 0) {
      console.log(`    -> NO bar deduction log for beer on this order`);
    } else {
      for (const l of beerLogs) {
        console.log(`    -> deduction log: inv="${l.inventoryItem?.menuItem?.name}"  qty=${l.quantity}ml  status=${l.status}${l.error ? `  err=${l.error}` : ''}`);
      }
    }
  }

  if (shown === 0) {
    console.log('  (no settled orders containing beer found in recent history)');
  }

  // 4. Simulation: pick the first beer inventory item and simulate a 2-bottle settle
  if (beerInvItems.length > 0) {
    const inv = beerInvItems[0];
    const mi: any = inv.menuItem;
    console.log(`\n\n--- Simulation: settle 2 x ${mi.name} (650ml variant) ---`);
    const matchedVariant = mi.variants?.find((v: any) => Number(v.price) === Number(mi.variants?.[0]?.price));
    const parsedMl = matchedVariant ? parseInt(String(matchedVariant.name).replace(/[^0-9]/g, ''), 10) : NaN;
    const mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? 650 : parsedMl;
    const totalMl = mlPerUnit * 2;
    const stockBefore = Number(inv.currentStock);
    const stockAfter = stockBefore - totalMl;

    console.log(`    mlPerUnit:        ${mlPerUnit}`);
    console.log(`    totalMl to deduct:${totalMl}`);
    console.log(`    currentStock:     ${stockBefore} ml  (before)`);
    console.log(`    after deduction:  ${stockAfter} ml  (after)`);
    if (stockBefore < totalMl) {
      console.log(`    !! Insufficient stock — settlement would FAIL with 409 and the order would not settle.`);
    } else {
      console.log(`    -> OK: deduction would succeed. Stock reduces by ${totalMl} ml.`);
    }
  }

  console.log('\n=== Done ===\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
