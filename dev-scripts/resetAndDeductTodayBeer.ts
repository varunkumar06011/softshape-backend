// Reset barInventoryDeducted=false on today's settled orders containing beer,
// then run deductInventoryForOrder for each to actually deduct the stock.
//
// Only touches orders from today. Only affects bar inventory (beer).
//
// Usage: npx tsx dev-scripts/resetAndDeductTodayBeer.ts [restaurantId]

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma';
import { getKolkataDateString } from '../src/utils/date';
import { deductInventoryForOrder } from '../src/services/inventoryService';

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
  const todayStart = new Date(today + 'T00:00:00+05:30');
  const todayEnd = new Date(today + 'T23:59:59+05:30');

  console.log(`\n=== Reset & deduct today's beer orders for ${restaurantId} ===`);
  console.log(`Date: ${today}\n`);

  // 1. Find today's settled orders containing beer
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
    orderBy: { createdAt: 'asc' },
  });

  // Filter to only orders that have beer items
  const beerOrders = todayOrders.filter((o) =>
    o.items.some((it: any) => isBeerItem(it.menuItem))
  );

  console.log(`Today's settled orders with beer: ${beerOrders.length}\n`);

  if (beerOrders.length === 0) {
    console.log('No beer orders to process today.');
    return;
  }

  // 2. Show beer stock before
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { name: true } } },
  });
  const beerInv = invItems.filter((i) => isBeerItem(i.menuItem));
  console.log('--- Beer stock BEFORE deduction ---\n');
  for (const inv of beerInv) {
    console.log(`  ${inv.menuItem?.name?.padEnd(35)} ${String(inv.currentStock).padStart(10)}ml`);
  }

  // 3. Reset barInventoryDeducted=false on each order, then run deduction
  console.log('\n--- Processing orders ---\n');
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const order of beerOrders) {
    const beerItems = order.items.filter((it: any) => isBeerItem(it.menuItem));
    console.log(`Order ${order.id.slice(0, 8)} (barInventoryDeducted was ${order.barInventoryDeducted}):`);
    for (const it of beerItems) {
      console.log(`  ${it.quantity} x "${it.menuItem.name}" @ ₹${it.price}`);
    }

    // Reset the flag so deductInventoryForOrder will process bar items
    await prisma.order.update({
      where: { id: order.id },
      data: { barInventoryDeducted: false },
    });

    // Run the deduction in a transaction
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        return await deductInventoryForOrder(order.id, restaurantId, tx, null);
      }, { timeout: 15000, maxWait: 20000 });

      if (result.barDeductionErrors.length > 0) {
        console.log(`  -> ERRORS:`);
        for (const err of result.barDeductionErrors) {
          console.log(`     ${err}`);
          errors.push(`Order ${order.id}: ${err}`);
        }
        failed++;
      } else {
        console.log(`  -> SUCCESS: ${result.inventoryUpdates.length} inventory items updated`);
        for (const u of result.inventoryUpdates) {
          console.log(`     ${u.name}: stock now ${u.currentStock}ml${u.isLowStock ? ' (LOW STOCK)' : ''}`);
        }
        succeeded++;
      }
    } catch (err: any) {
      console.log(`  -> FAILED: ${err.message}`);
      errors.push(`Order ${order.id}: ${err.message}`);
      failed++;
    }
    console.log('');
  }

  // 4. Show beer stock after
  const beerInvAfter = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    include: { menuItem: { select: { name: true } } },
  });
  const beerAfter = beerInvAfter.filter((i) => isBeerItem(i.menuItem));
  console.log('--- Beer stock AFTER deduction ---\n');
  for (const inv of beerAfter) {
    const before = beerInv.find((i) => i.id === inv.id);
    const diff = Number(inv.currentStock) - Number(before?.currentStock || 0);
    const diffStr = diff !== 0 ? `  (${diff > 0 ? '+' : ''}${diff}ml)` : '';
    console.log(`  ${inv.menuItem?.name?.padEnd(35)} ${String(inv.currentStock).padStart(10)}ml${diffStr}`);
  }

  // 5. Summary
  console.log(`\n--- Summary ---`);
  console.log(`  Orders processed: ${beerOrders.length}`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed: ${failed}`);
  if (errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of errors) console.log(`    - ${e}`);
  }

  console.log('\n=== Done ===\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
