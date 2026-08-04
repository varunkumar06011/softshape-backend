// Check ONLY today's settled orders containing beer, and whether bar deduction happened.
// Also shows current beer inventory state.
//
// Usage: npx tsx dev-scripts/checkTodayBeerDeduction.ts [restaurantId]

import prisma from '../src/lib/prisma';
import { getKolkataDateString } from '../src/utils/date';

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

async function main() {
  const restaurantId = process.argv[2] || 'cmqy60ci200027dscyj9ubg8h';
  const today = getKolkataDateString();
  console.log(`\n=== Today's (${today}) beer deduction check for ${restaurantId} ===\n`);

  // 1. Current beer inventory state
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { include: { variants: true, category: { select: { name: true } } } } },
  });
  const beerInv = invItems.filter((i) => isBeerItem(i.menuItem));

  console.log('--- Current beer inventory ---\n');
  console.log('Inventory Item Name'.padEnd(35) + ' | Stock (ml)   | Bottles | BottleSize');
  console.log('-'.repeat(80));
  for (const inv of beerInv) {
    const stock = Number(inv.currentStock);
    const bottles = inv.bottleSize > 0 ? (stock / inv.bottleSize).toFixed(1) : '0';
    console.log(
      inv.menuItem.name.padEnd(35) +
      ' | ' + String(stock).padStart(10) + 'ml' +
      ' | ' + String(bottles).padStart(6) +
      ' | ' + inv.bottleSize + 'ml'
    );
  }

  // 2. Today's settled orders containing beer
  console.log('\n\n--- Today\'s settled orders containing beer ---\n');

  // Get today's date range (start of today to now)
  const todayStart = new Date(today + 'T00:00:00+05:30');
  const todayEnd = new Date(today + 'T23:59:59+05:30');

  const todayOrders = await prisma.order.findMany({
    where: {
      restaurantId,
      status: 'PAID',
      createdAt: { gte: todayStart, lte: todayEnd },
      items: { some: { menuItem: { menuType: 'LIQUOR' } } },
    },
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: { include: { category: { select: { name: true } } } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (todayOrders.length === 0) {
    console.log('  No settled orders with liquor items found for today yet.\n');
  }

  let beerOrderCount = 0;
  for (const o of todayOrders) {
    const beerItems = o.items.filter((it: any) => isBeerItem(it.menuItem));
    if (beerItems.length === 0) continue;
    beerOrderCount++;

    console.log(`\n  Order ${o.id}`);
    console.log(`    createdAt: ${o.createdAt.toISOString()}  paidAt: ${(o as any).paidAt ?? '(null)'}`);
    console.log(`    barInventoryDeducted: ${(o as any).barInventoryDeducted}`);

    for (const it of beerItems) {
      const mi: any = it.menuItem;
      console.log(`    ordered: ${it.quantity} x "${mi.name}" @ ₹${it.price}`);
    }

    // Check bar deduction logs for this order
    const logs = await prisma.barDeductionLog.findMany({
      where: { orderId: o.id },
      include: { inventoryItem: { include: { menuItem: { select: { name: true } } } } },
    });
    const beerLogs = logs.filter((l: any) => isBeerItem(l.inventoryItem?.menuItem));

    if (beerLogs.length === 0) {
      console.log(`    -> NO beer deduction log (deduction did NOT happen for beer)`);
    } else {
      for (const l of beerLogs) {
        console.log(`    -> deduction: inv="${l.inventoryItem?.menuItem?.name}"  qty=${l.quantity}ml  status=${l.status}${l.error ? `  err=${l.error}` : ''}`);
      }
    }
  }

  if (beerOrderCount === 0 && todayOrders.length > 0) {
    console.log('  (settled orders today had liquor but no beer items)');
  }

  // 3. Today's inventory transactions for beer (SALE type)
  console.log('\n\n--- Today\'s SALE transactions on beer inventory ---\n');
  const beerInvIds = beerInv.map((i) => i.id);
  const todayTxns = await prisma.inventoryTransaction.findMany({
    where: {
      itemId: { in: beerInvIds },
      type: 'SALE',
      transactionDate: { gte: todayStart, lte: todayEnd },
    },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
    orderBy: { transactionDate: 'desc' },
  });

  if (todayTxns.length === 0) {
    console.log('  No SALE transactions on beer inventory today yet.\n');
  } else {
    for (const t of todayTxns) {
      console.log(`  ${t.transactionDate.toISOString()}  "${t.item?.menuItem?.name}"  change=${t.quantityChange}ml  notes="${t.notes}"`);
    }
  }

  // 4. Today's daily snapshots for beer (sold > 0 means deduction happened)
  console.log('\n\n--- Today\'s daily snapshots for beer (sold > 0) ---\n');
  const todaySnapshots = await prisma.dailyInventorySnapshot.findMany({
    where: {
      restaurantId,
      snapshotDate: today,
      itemId: { in: beerInvIds },
      sold: { gt: 0 },
    },
    include: { item: { include: { menuItem: { select: { name: true } } } } },
  });

  if (todaySnapshots.length === 0) {
    console.log('  No beer snapshots with sold > 0 today (no beer has been deducted today).\n');
  } else {
    for (const s of todaySnapshots) {
      console.log(`  "${s.item?.menuItem?.name}"  opening=${s.openingStock}ml  sold=${s.sold}ml  closing=${s.closingStock}ml`);
    }
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
