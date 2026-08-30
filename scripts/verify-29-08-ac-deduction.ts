/**
 * READ-ONLY verification script for 29-08-2026 AC liquor deduction.
 * 
 * Cross-checks:
 *  1. POS sold quantity (from OrderItem of PAID orders)
 *  2. Inventory AC Sold quantity (from DailyInventorySnapshot.sold)
 *  3. BarDeductionLog entries
 *  4. AC Sale Amount, Selling Rate, Purchase Rate, Consumption, Profit
 * 
 * Usage: npx tsx scripts/verify-29-08-ac-deduction.ts
 */

import prisma, { basePrisma } from '../src/lib/prisma';

const REPORT_DATE = '2026-08-29';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDateToUTCStart(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
}
function istDateToUTCEnd(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS);
}

async function main() {
  const startUTC = istDateToUTCStart(REPORT_DATE);
  const endUTC = istDateToUTCEnd(REPORT_DATE);

  // 1. Find all outlets to identify Vgrand Lounge
  const outlets = await basePrisma.outlet.findMany({
    select: { id: true, name: true, restaurantType: true },
  });
  console.log('\n=== OUTLETS ===');
  for (const o of outlets) {
    console.log(`  ${o.id} | ${o.name} | ${o.restaurantType}`);
  }

  // Find Vgrand Lounge by exact name match (case-insensitive)
  const vgrandOutlets = outlets.filter(o => o.name.toLowerCase().trim() === 'vgrand lounge');
  if (vgrandOutlets.length === 0) {
    console.error('\nERROR: Could not find "Vgrand Lounge" outlet. Available outlets listed above.');
    process.exit(1);
  }
  if (vgrandOutlets.length > 1) {
    console.log(`\n⚠️  Found ${vgrandOutlets.length} "Vgrand Lounge" outlets — verifying ALL of them:`);
    for (const o of vgrandOutlets) {
      console.log(`  ${o.id} | ${o.name} | ${o.restaurantType}`);
    }
  }
  // If multiple, run verification for each
  const barIds = vgrandOutlets.map(o => o.id);
  for (const barId of barIds) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`VERIFYING OUTLET: ${vgrandOutlets.find(o => o.id === barId)!.name} (${barId})`);
    console.log(`${'='.repeat(80)}`);
    await verifyOutlet(barId, startUTC, endUTC);
  }
  return;
}

async function verifyOutlet(barId: string, startUTC: Date, endUTC: Date) {
  const vgrandName = (await basePrisma.outlet.findFirst({ where: { id: barId }, select: { name: true } }))?.name || 'Unknown';
  console.log(`\nUsing outlet: ${vgrandName} (${barId})`);

  // 2. Fetch ALL POS liquor order items for 29-08 (PAID, COMPLETED)
  const posOrderItems = await basePrisma.orderItem.findMany({
    where: {
      removedFromBill: false,
      order: {
        status: 'PAID',
        isDeleted: false,
        restaurantId: barId,
        transactions: {
          status: 'COMPLETED',
          paidAt: { gte: startUTC, lte: endUTC },
        },
      },
    },
    include: {
      menuItem: { select: { id: true, name: true, menuType: true, basePrice: true } },
      order: {
        select: {
          id: true,
          billNumber: true,
          barInventoryDeducted: true,
          transactions: { select: { discountPercent: true, paidAt: true } },
        },
      },
    },
  });

  // Filter to LIQUOR only
  const liquorPosItems = posOrderItems.filter(oi => oi.menuItem?.menuType === 'LIQUOR');

  console.log(`\n=== POS LIQUOR ORDER ITEMS (${REPORT_DATE}) ===`);
  console.log(`Total liquor order items: ${liquorPosItems.length}`);

  // Aggregate by menuItemId
  const posByMenuItem = new Map<string, { name: string; qty: number; grossRevenue: number; netRevenue: number; discountPct: number }>();
  let posTotalQty = 0;
  let posTotalRevenue = 0;
  for (const oi of liquorPosItems) {
    const mi = oi.menuItem;
    if (!mi) continue;
    const qty = oi.quantity || 0;
    const orderDiscountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
    const discountFactor = orderDiscountPercent > 0 ? (1 - orderDiscountPercent / 100) : 1;
    const grossLineRevenue = Math.round(Number(oi.price) * qty * 100) / 100;
    const revenue = Math.round(grossLineRevenue * discountFactor * 100) / 100;
    posTotalQty += qty;
    posTotalRevenue += revenue;
    const existing = posByMenuItem.get(mi.id) || { name: mi.name, qty: 0, grossRevenue: 0, netRevenue: 0, discountPct: orderDiscountPercent };
    existing.qty += qty;
    existing.grossRevenue += grossLineRevenue;
    existing.netRevenue += revenue;
    posByMenuItem.set(mi.id, existing);
  }

  console.log('\n--- POS per-item breakdown ---');
  console.log('MenuItemID | Item Name | Qty | Gross Rev | Net Rev | Discount%');
  for (const [miId, data] of posByMenuItem) {
    console.log(`  ${miId} | ${data.name} | ${data.qty} | ₹${data.grossRevenue} | ₹${data.netRevenue} | ${data.discountPct}%`);
  }
  console.log(`\nPOS TOTAL: qty=${posTotalQty}, revenue=₹${posTotalRevenue}`);

  // Check barInventoryDeducted flags
  const ordersNotDeducted = [...new Set(liquorPosItems.map(oi => oi.order))].filter(o => !o.barInventoryDeducted);
  if (ordersNotDeducted.length > 0) {
    console.log(`\n⚠️  WARNING: ${ordersNotDeducted.length} orders with barInventoryDeducted=false:`);
    for (const o of ordersNotDeducted) {
      console.log(`    Order #${o.id} (Bill: ${o.billNumber || 'N/A'}) — barInventoryDeducted=false`);
    }
  } else {
    console.log('\n✅ All orders have barInventoryDeducted=true');
  }

  // 3. Fetch DailyInventorySnapshot for 29-08
  const snapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId: barId, snapshotDate: REPORT_DATE },
  });
  console.log(`\n=== DAILY INVENTORY SNAPSHOTS (${REPORT_DATE}) ===`);
  console.log(`Total snapshots: ${snapshots.length}`);

  // Load inventory items for mapping
  const inventoryItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: barId, isActive: true },
    include: { menuItem: { select: { id: true, name: true, menuType: true, basePrice: true } } },
  });

  console.log('\n--- Snapshot per-item ---');
  console.log('InvItemID | Item Name | MenuItemID | BottleSize | Opening(ml) | Purchased(ml) | Sold(ml) | Closing(ml) | CostPerBottle | AcSellingPrice');
  let snapTotalSoldMl = 0;
  for (const snap of snapshots) {
    const inv = inventoryItems.find(i => i.id === snap.itemId);
    const btlSize = inv?.bottleSize ? Number(inv.bottleSize) : 0;
    const soldMl = Number(snap.sold);
    snapTotalSoldMl += soldMl;
    console.log(`  ${snap.itemId} | ${snap.itemName} | ${inv?.menuItemId || 'N/A'} | ${btlSize}ml | ${Number(snap.openingStock)} | ${Number(snap.purchased)} | ${soldMl} | ${Number(snap.closingStock)} | ${inv?.costPerBottle || 'N/A'} | ${inv?.acSellingPrice || 'N/A'}`);
  }
  console.log(`\nSnapshot TOTAL sold: ${snapTotalSoldMl}ml`);

  // 4. Fetch BarDeductionLog entries for this date
  const deductionLogs = await prisma.barDeductionLog.findMany({
    where: { restaurantId: barId },
    include: { order: { select: { id: true, billNumber: true, settledAt: true, transactions: { select: { paidAt: true } } } } },
  });
  // Filter to orders settled on 29-08
  const logsForDate = deductionLogs.filter(l => {
    const paidAt = l.order?.transactions?.[0]?.paidAt;
    if (!paidAt) return false;
    return paidAt >= startUTC && paidAt <= endUTC;
  });
  console.log(`\n=== BAR DEDUCTION LOGS (${REPORT_DATE}) ===`);
  console.log(`Total deduction logs: ${logsForDate.length}`);
  console.log('\n--- Deduction log per-item ---');
  console.log('OrderID | InvItemID | MenuItemID | Quantity(ml) | Status');
  let logTotalMl = 0;
  for (const l of logsForDate) {
    const qty = Number(l.quantity || 0);
    if (l.status === 'SUCCESS') logTotalMl += qty;
    console.log(`  ${l.orderId} | ${l.inventoryItemId} | ${l.menuItemId} | ${qty}ml | ${l.status}`);
  }
  console.log(`\nDeduction log TOTAL (SUCCESS): ${logTotalMl}ml`);

  // 5. Cross-check: POS qty vs Snapshot sold vs Deduction log
  console.log('\n=== CROSS-CHECK: POS vs SNAPSHOT vs DEDUCTION LOG ===');

  // Build inventory item lookup by menuItemId
  const invByMenuItemId = new Map<string, any>();
  for (const inv of inventoryItems) {
    if (inv.menuItemId) {
      // Note: multiple inventory items could map to the same menuItemId (variants)
      // For verification, list all
      if (!invByMenuItemId.has(inv.menuItemId)) {
        invByMenuItemId.set(inv.menuItemId, []);
      }
      invByMenuItemId.get(inv.menuItemId).push(inv);
    }
  }

  // For each POS item, find the corresponding snapshot(s)
  console.log('\n--- Per-menuItem reconciliation ---');
  console.log('MenuItemID | Item Name | POS Qty | POS Rev | Snap Sold(ml) | Snap Sold(btl) | DeductLog(ml) | BottleSize | Match?');

  let allMatch = true;
  for (const [miId, posData] of posByMenuItem) {
    const invItems = invByMenuItemId.get(miId) || [];
    let snapSoldMl = 0;
    let deductLogMl = 0;
    let btlSize = 0;
    for (const inv of invItems) {
      const snap = snapshots.find(s => s.itemId === inv.id);
      if (snap) snapSoldMl += Number(snap.sold);
      btlSize = btlSize || (inv.bottleSize ? Number(inv.bottleSize) : 0);
      const logs = logsForDate.filter(l => l.inventoryItemId === inv.id && l.status === 'SUCCESS');
      for (const l of logs) deductLogMl += Number(l.quantity || 0);
    }
    const snapSoldBtl = btlSize > 0 ? Math.round(snapSoldMl / btlSize * 100) / 100 : 0;
    const match = snapSoldMl === deductLogMl;
    if (!match) allMatch = false;
    console.log(`  ${miId} | ${posData.name} | ${posData.qty} | ₹${posData.netRevenue} | ${snapSoldMl}ml | ${snapSoldBtl}btl | ${deductLogMl}ml | ${btlSize}ml | ${match ? '✅' : '⚠️ MISMATCH'}`);
  }

  // 6. Check for snapshots with sold > 0 but no corresponding POS sale
  console.log('\n--- Snapshots with sold > 0 but no POS sale ---');
  for (const snap of snapshots) {
    if (Number(snap.sold) > 0) {
      const inv = inventoryItems.find(i => i.id === snap.itemId);
      const miId = inv?.menuItemId;
      const hasPos = miId ? posByMenuItem.has(miId) : false;
      if (!hasPos) {
        console.log(`  ⚠️  ${snap.itemName} (inv: ${snap.itemId}, menu: ${miId}) — sold=${Number(snap.sold)}ml but NO POS sale found`);
        allMatch = false;
      }
    }
  }

  // 7. Check for POS items with no snapshot deduction
  console.log('\n--- POS items with no snapshot deduction ---');
  for (const [miId, posData] of posByMenuItem) {
    const invItems = invByMenuItemId.get(miId) || [];
    let totalSnapSold = 0;
    for (const inv of invItems) {
      const snap = snapshots.find(s => s.itemId === inv.id);
      if (snap) totalSnapSold += Number(snap.sold);
    }
    if (totalSnapSold === 0) {
      console.log(`  ⚠️  ${posData.name} (menu: ${miId}) — POS qty=${posData.qty} but NO snapshot deduction`);
      allMatch = false;
    }
  }

  // 8. Check for double deductions (same order+item in BarDeductionLog more than once)
  console.log('\n--- Double deduction check ---');
  const logByKey = new Map<string, number>();
  for (const l of logsForDate) {
    const key = `${l.orderId}:${l.inventoryItemId}`;
    logByKey.set(key, (logByKey.get(key) || 0) + 1);
  }
  let hasDouble = false;
  for (const [key, count] of logByKey) {
    if (count > 1) {
      console.log(`  ⚠️  ${key} appears ${count} times in BarDeductionLog`);
      hasDouble = true;
      allMatch = false;
    }
  }
  if (!hasDouble) console.log('  ✅ No double deductions found');

  // 9. AC Sales amount verification
  console.log('\n=== AC SALES AMOUNT VERIFICATION ===');
  console.log('\n--- Per-item: POS Revenue vs Snapshot-based calculation ---');
  let totalPosRevenue = 0;
  let totalConsumption = 0;
  let totalProfit = 0;

  for (const [miId, posData] of posByMenuItem) {
    const invItems = invByMenuItemId.get(miId) || [];
    for (const inv of invItems) {
      const snap = snapshots.find(s => s.itemId === inv.id);
      if (!snap || Number(snap.sold) === 0) continue;
      const btlSize = inv.bottleSize ? Number(inv.bottleSize) : 0;
      const costPerBottle = inv.costPerBottle ? Number(inv.costPerBottle) : 0;
      const costPerMl = btlSize > 0 ? costPerBottle / btlSize : 0;
      const soldMl = Number(snap.sold);
      const soldBtl = btlSize > 0 ? soldMl / btlSize : 0;
      const consumption = Math.round(soldMl * costPerMl * 100) / 100;
      const acSellingPrice = inv.acSellingPrice ? Number(inv.acSellingPrice) : (inv.menuItem?.basePrice ? Number(inv.menuItem.basePrice) : null);
      // Sale amount from POS
      const saleAmount = posData.netRevenue;
      const profit = Math.round((saleAmount - consumption) * 100) / 100;
      totalPosRevenue += saleAmount;
      totalConsumption += consumption;
      totalProfit += profit;
      console.log(`  ${posData.name} | Sold: ${soldMl}ml (${soldBtl}btl) | SellingRate: ₹${acSellingPrice || 'N/A'} | SaleAmount: ₹${saleAmount} | PurchaseRate: ₹${costPerBottle} | Consumption: ₹${consumption} | Profit: ₹${profit}`);
    }
  }
  console.log(`\nTOTALS: Revenue=₹${totalPosRevenue}, Consumption=₹${totalConsumption}, Profit=₹${totalProfit}`);

  // 10. Check AC vs Non-AC separation
  console.log('\n=== AC / NON-AC SEPARATION CHECK ===');
  const nonAcEntries = await prisma.nonAcDailyEntry.findMany({
    where: { restaurantId: barId, entryDate: REPORT_DATE },
  });
  if (nonAcEntries.length > 0) {
    console.log(`Non-AC entries found for ${REPORT_DATE}: ${nonAcEntries.length}`);
    for (const e of nonAcEntries) {
      console.log(`  ItemID: ${e.itemId} | Deduction: ${Number(e.adminDeduction)}btl | Date: ${e.entryDate}`);
    }
  } else {
    console.log('✅ No Non-AC entries for this date (clean AC-only verification)');
  }

  // 11. Final reconciliation summary
  console.log('\n=== FINAL RECONCILIATION ===');
  console.log(`POS total AC sold (items): ${posTotalQty}`);
  console.log(`POS total AC revenue: ₹${posTotalRevenue}`);
  console.log(`Snapshot total sold: ${snapTotalSoldMl}ml`);
  console.log(`Deduction log total (SUCCESS): ${logTotalMl}ml`);
  console.log(`Snapshot vs Deduction Log match: ${snapTotalSoldMl === logTotalMl ? '✅ YES' : '⚠️ NO (diff: ' + (snapTotalSoldMl - logTotalMl) + 'ml)'}`);
  console.log(`\nOverall: ${allMatch ? '✅ ALL CHECKS PASSED' : '⚠️ DISCREPANCIES FOUND — review above'}`);
}

main().then(async () => {
  await prisma.$disconnect();
  await basePrisma.$disconnect();
}).catch(async (err) => {
  console.error('Verification failed:', err);
  await prisma.$disconnect();
  await basePrisma.$disconnect();
  process.exit(1);
});
