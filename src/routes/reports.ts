import { Router } from 'express';
import prisma from '../lib/prisma';
import { formatTxnDisplayId } from '../utils/date';
import { cacheMiddleware } from '../lib/cache';
import { optionalAuth } from '../middleware/auth';

const router = Router();

/**
 * Returns the authenticated user's restaurantId as a single-element array.
 */
function getTenantRestaurantIds(req: any): string[] {
  const user = req.user;
  if (!user) {
    return [];
  }
  return [user.activeRestaurantId ?? user.restaurantId];
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTRange(startDate: string, endDate: string) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startIST = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { startIST, endIST };
}

const outletNameCache = new Map<string, string>();

function mapRestaurantTypeToOutlet(type: string | null | undefined): string {
  switch (type) {
    case 'BAR_LOUNGE':
    case 'BAR_WITH_DINING':
      return 'bar';
    case 'CAFE':
      return 'venue';
    case 'DINE_IN':
    case 'CLOUD_KITCHEN':
    default:
      return 'restaurant';
  }
}

async function warmOutletNameCache(restaurantIds: string[]): Promise<void> {
  const missing = restaurantIds.filter(id => !outletNameCache.has(id));
  if (missing.length === 0) return;

  const restaurants = await prisma.outlet.findMany({
    where: { id: { in: missing } },
    select: { id: true, restaurantType: true },
  });

  for (const r of restaurants) {
    outletNameCache.set(r.id, mapRestaurantTypeToOutlet(r.restaurantType));
  }
  // Cache unknown IDs too to avoid repeated queries for non-existent IDs
  for (const id of missing) {
    if (!outletNameCache.has(id)) {
      outletNameCache.set(id, 'restaurant');
    }
  }
}

function getOutletName(restaurantId: string): string {
  return outletNameCache.get(restaurantId) || 'restaurant';
}

function num(val: any): number {
  if (val == null) return 0;
  return typeof val === 'number' ? val : Number(val);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Route 1: Daily Sales ────────────────────────────────────────────────
router.get('/daily-sales', optionalAuth, cacheMiddleware('reports:daily-sales', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = getTenantRestaurantIds(req);

    const transactions = await prisma.transaction.findMany({
      where: {
        restaurantId: { in: tenantIds },
        paidAt: { gte: startIST, lte: endIST },
      },
      orderBy: { paidAt: 'desc' },
    });

    const totalRevenue = transactions.reduce((s, t) => s + num(t.grandTotal ?? t.amount), 0);
    const totalTransactions = transactions.length;
    const totalSubtotal = transactions.reduce((s, t) => s + num(t.subtotal), 0);
    const totalDiscount = transactions.reduce((s, t) => s + num(t.discountAmount), 0);
    const totalCGST = transactions.reduce((s, t) => s + num(t.cgst), 0);
    const totalSGST = transactions.reduce((s, t) => s + num(t.sgst), 0);
    const totalGrandTotal = transactions.reduce((s, t) => s + num(t.grandTotal ?? t.amount), 0);
    const avgBill = totalTransactions > 0 ? totalGrandTotal / totalTransactions : 0;

    let highestBill: any = null;
    let lowestBill: any = null;
    for (const t of transactions) {
      const amt = num(t.grandTotal ?? t.amount);
      if (highestBill == null || amt > highestBill.amount) {
        highestBill = {
          amount: round2(amt),
          txnNumber: t.txnNumber,
          txnDate: t.txnDate,
          tableNumber: t.tableNumber,
          method: t.method,
        };
      }
      if (lowestBill == null || amt < lowestBill.amount) {
        lowestBill = {
          amount: round2(amt),
          txnNumber: t.txnNumber,
          txnDate: t.txnDate,
          tableNumber: t.tableNumber,
          method: t.method,
        };
      }
    }

    await warmOutletNameCache(transactions.map(t => t.restaurantId));

    const byMethod: Record<string, { count: number; amount: number }> = {};
    const byOutlet: Record<string, { count: number; amount: number }> = {};
    const byDayMap: Record<string, { revenue: number; transactions: number }> = {};

    for (const t of transactions) {
      const amt = num(t.grandTotal ?? t.amount);
      const method = t.method || 'UNKNOWN';
      byMethod[method] = byMethod[method] || { count: 0, amount: 0 };
      byMethod[method].count += 1;
      byMethod[method].amount += amt;

      const outlet = getOutletName(t.restaurantId);
      byOutlet[outlet] = byOutlet[outlet] || { count: 0, amount: 0 };
      byOutlet[outlet].count += 1;
      byOutlet[outlet].amount += amt;

      const day = t.txnDate || start;
      byDayMap[day] = byDayMap[day] || { revenue: 0, transactions: 0 };
      byDayMap[day].revenue += amt;
      byDayMap[day].transactions += 1;
    }

    const byDay = Object.entries(byDayMap)
      .map(([date, v]) => ({ date, revenue: round2(v.revenue), transactions: v.transactions }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      summary: {
        totalRevenue: round2(totalRevenue),
        totalTransactions,
        averageBillValue: Math.round(avgBill),
        totalSubtotal: round2(totalSubtotal),
        totalDiscount: round2(totalDiscount),
        totalCGST: round2(totalCGST),
        totalSGST: round2(totalSGST),
        totalGrandTotal: round2(totalGrandTotal),
        highestBill,
        lowestBill,
      },
      byMethod,
      byOutlet,
      byDay,
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    console.error('[Reports] daily-sales error:', err);
    res.status(500).json({ error: 'Failed to fetch daily sales report' });
  }
});

// ── Route 2: Item-wise Sales ────────────────────────────────────────────
router.get('/itemwise-sales', optionalAuth, cacheMiddleware('reports:itemwise-sales', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate, outletType } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const typeFilter = String(outletType || 'all').toLowerCase();
    const tenantIds = getTenantRestaurantIds(req);

    const orderItems = await prisma.orderItem.findMany({
      where: {
        removedFromBill: false,
        order: {
          paidAt: { gte: startIST, lte: endIST },
          status: 'PAID',
          isDeleted: false,
          restaurantId: { in: tenantIds },
        },
        ...(typeFilter !== 'all' ? {
          menuItem: {
            menuType: typeFilter === 'liquor' ? 'LIQUOR' : 'FOOD',
          },
        } : {}),
      },
      include: {
        menuItem: { include: { category: true } },
        order: { select: { paidAt: true, restaurantId: true } },
      },
    });

    const itemMap = new Map<string, {
      name: string;
      category: string;
      menuType: string;
      quantitySold: number;
      unitPrice: number;
      totalRevenue: number;
      orderIds: Set<string>;
    }>();

    for (const oi of orderItems) {
      const mi = oi.menuItem;
      if (!mi) continue;
      const key = mi.name;
      const qty = oi.quantity || 0;
      const revenue = num(oi.price) * qty;
      if (!itemMap.has(key)) {
        itemMap.set(key, {
          name: mi.name,
          category: mi.category?.name || 'Uncategorized',
          menuType: mi.menuType,
          quantitySold: 0,
          unitPrice: num(mi.basePrice),
          totalRevenue: 0,
          orderIds: new Set(),
        });
      }
      const rec = itemMap.get(key)!;
      rec.quantitySold += qty;
      rec.totalRevenue += revenue;
      rec.orderIds.add(oi.orderId);
    }

    const totalRevenueAll = Array.from(itemMap.values()).reduce((s, it) => s + it.totalRevenue, 0);
    const totalQuantityAll = Array.from(itemMap.values()).reduce((s, it) => s + it.quantitySold, 0);

    const items = Array.from(itemMap.values())
      .map(it => ({
        name: it.name,
        category: it.category,
        menuType: it.menuType,
        quantitySold: it.quantitySold,
        unitPrice: it.unitPrice,
        totalRevenue: round2(it.totalRevenue),
        revenuePercent: totalRevenueAll > 0 ? round2((it.totalRevenue / totalRevenueAll) * 100) : 0,
        orderCount: it.orderIds.size,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const foodRevenue = items.filter(i => i.menuType === 'FOOD').reduce((s, i) => s + i.totalRevenue, 0);
    const liquorRevenue = items.filter(i => i.menuType === 'LIQUOR').reduce((s, i) => s + i.totalRevenue, 0);

    res.json({
      items,
      summary: {
        totalItems: items.length,
        totalQuantity: totalQuantityAll,
        totalRevenue: round2(totalRevenueAll),
        foodRevenue: round2(foodRevenue),
        liquorRevenue: round2(liquorRevenue),
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    console.error('[Reports] itemwise-sales error:', err);
    res.status(500).json({ error: 'Failed to fetch itemwise sales report' });
  }
});

// ── Route 3: Category-wise Sales ────────────────────────────────────────
router.get('/categorywise-sales', optionalAuth, cacheMiddleware('reports:categorywise-sales', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = getTenantRestaurantIds(req);

    const orderItems = await prisma.orderItem.findMany({
      where: {
        removedFromBill: false,
        order: {
          paidAt: { gte: startIST, lte: endIST },
          status: 'PAID',
          isDeleted: false,
          restaurantId: { in: tenantIds },
        },
      },
      include: {
        menuItem: true,
      },
    });

    const catMap = new Map<string, {
      name: string;
      itemCount: number;
      totalQuantity: number;
      totalRevenue: number;
    }>();

    for (const oi of orderItems) {
      const mi = oi.menuItem;
      if (!mi) continue;
      const key = mi.menuType === 'LIQUOR' ? 'Liquor' : 'Food';
      const qty = oi.quantity || 0;
      const revenue = num(oi.price) * qty;
      if (!catMap.has(key)) {
        catMap.set(key, {
          name: key,
          itemCount: 0,
          totalQuantity: 0,
          totalRevenue: 0,
        });
      }
      const rec = catMap.get(key)!;
      rec.itemCount += 1;
      rec.totalQuantity += qty;
      rec.totalRevenue += revenue;
    }

    const totalRevenueAll = Array.from(catMap.values()).reduce((s, c) => s + c.totalRevenue, 0);
    const totalQuantityAll = Array.from(catMap.values()).reduce((s, c) => s + c.totalQuantity, 0);

    const categories = Array.from(catMap.values())
      .map(c => ({
        name: c.name,
        itemCount: c.itemCount,
        totalQuantity: c.totalQuantity,
        totalRevenue: round2(c.totalRevenue),
        revenuePercent: totalRevenueAll > 0 ? round2((c.totalRevenue / totalRevenueAll) * 100) : 0,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    res.json({
      categories,
      summary: { totalRevenue: round2(totalRevenueAll), totalQuantity: totalQuantityAll },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    console.error('[Reports] categorywise-sales error:', err);
    res.status(500).json({ error: 'Failed to fetch categorywise sales report' });
  }
});

// ── Route 4: Payment Methods ────────────────────────────────────────────
router.get('/payment-methods', optionalAuth, cacheMiddleware('reports:payment-methods', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = getTenantRestaurantIds(req);

    const transactions = await prisma.transaction.findMany({
      where: {
        restaurantId: { in: tenantIds },
        paidAt: { gte: startIST, lte: endIST },
      },
      select: {
        method: true,
        amount: true,
        grandTotal: true,
        txnDate: true,
      },
    });

    const methodMap: Record<string, { count: number; amount: number }> = {};
    const byDayMap: Record<string, Record<string, number>> = {};

    for (const t of transactions) {
      const amt = num(t.grandTotal ?? t.amount);
      const method = t.method || 'UNKNOWN';
      methodMap[method] = methodMap[method] || { count: 0, amount: 0 };
      methodMap[method].count += 1;
      methodMap[method].amount += amt;

      const day = t.txnDate || start;
      byDayMap[day] = byDayMap[day] || {};
      byDayMap[day][method] = (byDayMap[day][method] || 0) + amt;
    }

    const totalAmount = transactions.reduce((s, t) => s + num(t.grandTotal ?? t.amount), 0);
    const totalTransactions = transactions.length;

    const methods = Object.entries(methodMap)
      .map(([method, v]) => ({
        method,
        count: v.count,
        amount: round2(v.amount),
        percent: totalAmount > 0 ? round2((v.amount / totalAmount) * 100) : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    const allMethods = ['CASH', 'UPI', 'CARD', 'SPLIT'];
    const byDay = Object.entries(byDayMap)
      .map(([date, dayMap]) => ({
        date,
        ...Object.fromEntries(allMethods.map(m => [m, round2(dayMap[m] || 0)])),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      methods,
      byDay,
      summary: {
        totalAmount: round2(totalAmount),
        totalTransactions,
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    console.error('[Reports] payment-methods error:', err);
    res.status(500).json({ error: 'Failed to fetch payment methods report' });
  }
});

// ── Route 5: Discount Report ────────────────────────────────────────────
router.get('/discount-report', optionalAuth, cacheMiddleware('reports:discount-report', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = getTenantRestaurantIds(req);

    const transactions = await prisma.transaction.findMany({
      where: {
        restaurantId: { in: tenantIds },
        paidAt: { gte: startIST, lte: endIST },
        discountAmount: { gt: 0 },
      },
      orderBy: { paidAt: 'desc' },
    });

    await warmOutletNameCache(transactions.map(t => t.restaurantId));

    const items = transactions.map(t => ({
      txnId: t.id,
      billRef: formatTxnDisplayId(t.txnDate, t.txnNumber),
      txnDate: t.txnDate,
      tableNumber: t.tableNumber,
      restaurantId: t.restaurantId,
      outlet: getOutletName(t.restaurantId),
      subtotal: round2(num(t.subtotal)),
      discountPercent: round2(num(t.discountPercent)),
      discountAmount: round2(num(t.discountAmount)),
      grandTotal: round2(num(t.grandTotal ?? t.amount)),
      method: t.method,
      paidAt: t.paidAt,
    }));

    const totalDiscountGiven = items.reduce((s, it) => s + it.discountAmount, 0);
    const totalTransactionsWithDiscount = items.length;
    const avgDiscountPercent = totalTransactionsWithDiscount > 0
      ? round2(items.reduce((s, it) => s + it.discountPercent, 0) / totalTransactionsWithDiscount)
      : 0;

    res.json({
      transactions: items,
      summary: {
        totalDiscountGiven: round2(totalDiscountGiven),
        totalTransactionsWithDiscount,
        averageDiscountPercent: avgDiscountPercent,
        totalRevenueLost: round2(totalDiscountGiven),
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    console.error('[Reports] discount-report error:', err);
    res.status(500).json({ error: 'Failed to fetch discount report' });
  }
});

// ── Route 6: GST Report ─────────────────────────────────────────────────
router.get('/gst-report', optionalAuth, cacheMiddleware('reports:gst-report', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = getTenantRestaurantIds(req);
    const primaryId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) || '';

    const [restaurant, transactions] = await Promise.all([
      prisma.outlet.findFirst({ where: { id: primaryId } }),
      prisma.transaction.findMany({
        where: {
          restaurantId: { in: tenantIds },
          paidAt: { gte: startIST, lte: endIST },
          cgst: { not: null },
        },
        orderBy: { paidAt: 'desc' },
      }),
    ]);

    const gstin = restaurant?.gstin || 'Not configured';

    await warmOutletNameCache(transactions.map(t => t.restaurantId));

    const items = transactions.map(t => {
      const subtotal = num(t.subtotal);
      const discountAmount = num(t.discountAmount);
      const cgst = num(t.cgst);
      const sgst = num(t.sgst);
      // Taxable amount must be derived from the already-correct cgst+sgst,
      // because subtotal includes liquor (0% GST) — recomputing from subtotal
      // would overstate the taxable base and make the displayed rate look wrong.
      const taxableAmount = (cgst + sgst) / 0.05;
      return {
        billRef: formatTxnDisplayId(t.txnDate, t.txnNumber),
        txnDate: t.txnDate,
        tableNumber: t.tableNumber,
        outlet: getOutletName(t.restaurantId),
        subtotal: round2(subtotal),
        discountAmount: round2(discountAmount),
        taxableAmount: round2(taxableAmount),
        cgst: round2(cgst),
        sgst: round2(sgst),
        totalTax: round2(cgst + sgst),
        grandTotal: round2(num(t.grandTotal ?? t.amount)),
        method: t.method,
      };
    });

    const totalTaxableAmount = items.reduce((s, it) => s + it.taxableAmount, 0);
    const totalCGST = items.reduce((s, it) => s + it.cgst, 0);
    const totalSGST = items.reduce((s, it) => s + it.sgst, 0);
    const totalTax = items.reduce((s, it) => s + it.totalTax, 0);
    const totalGrandTotal = items.reduce((s, it) => s + it.grandTotal, 0);

    const byDayMap: Record<string, { taxableAmount: number; cgst: number; sgst: number; totalTax: number }> = {};
    for (const it of items) {
      const day = it.txnDate || start;
      byDayMap[day] = byDayMap[day] || { taxableAmount: 0, cgst: 0, sgst: 0, totalTax: 0 };
      byDayMap[day].taxableAmount += it.taxableAmount;
      byDayMap[day].cgst += it.cgst;
      byDayMap[day].sgst += it.sgst;
      byDayMap[day].totalTax += it.totalTax;
    }

    const byDay = Object.entries(byDayMap)
      .map(([date, v]) => ({
        date,
        taxableAmount: round2(v.taxableAmount),
        cgst: round2(v.cgst),
        sgst: round2(v.sgst),
        totalTax: round2(v.totalTax),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      gstin,
      transactions: items,
      summary: {
        totalTaxableAmount: round2(totalTaxableAmount),
        totalCGST: round2(totalCGST),
        totalSGST: round2(totalSGST),
        totalTax: round2(totalTax),
        totalGrandTotal: round2(totalGrandTotal),
        transactionCount: items.length,
      },
      byDay,
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    console.error('[Reports] gst-report error:', err);
    res.status(500).json({ error: 'Failed to fetch GST report' });
  }
});

// ── Route: Daily Reconciliation ─────────────────────────────────────────
router.get('/reconcile', optionalAuth, async (req: any, res) => {
  try {
    const { date } = req.query;
    const targetDate = String(date || '');
    if (!targetDate) {
      return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    }

    const tenantIds = getTenantRestaurantIds(req);
    if (tenantIds.length === 0) {
      return res.status(403).json({ error: 'Authentication required' });
    }
    const restaurantId = tenantIds[0];

    // Sales from transactions on that date
    const transactions = await prisma.transaction.findMany({
      where: { restaurantId, txnDate: targetDate },
    });

    const totalSales = transactions.reduce((s, t) => s + num(t.grandTotal ?? t.amount), 0);
    const totalCGST = transactions.reduce((s, t) => s + num(t.cgst), 0);
    const totalSGST = transactions.reduce((s, t) => s + num(t.sgst), 0);
    const totalDiscount = transactions.reduce((s, t) => s + num(t.discountAmount), 0);

    // Bar inventory deductions
    const { startIST, endIST } = toISTRange(targetDate, targetDate);
    const barInventoryTxns = await prisma.inventoryTransaction.findMany({
      where: { restaurantId, transactionDate: { gte: startIST, lte: endIST } },
    });
    const barDeductions = barInventoryTxns.length;

    // Kitchen inventory entries for that date
    const kitchenEntries = await prisma.inventoryDailyEntry.findMany({
      where: { restaurantId, entryDate: targetDate },
    });
    const kitchenConsumed = kitchenEntries.reduce((s, e) => s + num(e.consumedStock), 0);

    // Payroll obligations for that month
    const monthYear = targetDate.slice(0, 7);
    const payrollRecords = await prisma.payrollRecord.findMany({
      where: { restaurantId, monthYear },
    });
    const totalPayable = payrollRecords.reduce((s, r) => s + num(r.netPayable), 0);
    const totalPaid = payrollRecords.reduce((s, r) => s + num(r.paidAmount), 0);

    res.json({
      date: targetDate,
      sales: {
        transactionCount: transactions.length,
        totalSales: round2(totalSales),
        totalCGST: round2(totalCGST),
        totalSGST: round2(totalSGST),
        totalDiscount: round2(totalDiscount),
      },
      inventory: {
        barDeductions,
        kitchenEntries: kitchenEntries.length,
        kitchenConsumed: round2(kitchenConsumed),
      },
      payroll: {
        monthYear,
        employeeCount: payrollRecords.length,
        totalPayable: round2(totalPayable),
        totalPaid: round2(totalPaid),
        totalOutstanding: round2(totalPayable - totalPaid),
      },
    });
  } catch (err) {
    console.error('[Reports] reconcile error:', err);
    res.status(500).json({ error: 'Failed to fetch reconciliation report' });
  }
});

function getHighestSellingItem(items: any[]): { name: string; quantity: number } | null {
  if (!items.length) return null;
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = String(item?.name || item?.n || '').trim();
    if (!name) continue;
    const qty = Number(item?.quantity || item?.q || 1);
    counts.set(name, (counts.get(name) || 0) + qty);
  }
  let best: { name: string; quantity: number } | null = null;
  for (const [name, quantity] of counts) {
    if (!best || quantity > best.quantity) best = { name, quantity };
  }
  return best;
}

// ── Route: Online Orders ───────────────────────────────────────────────
router.get('/online-orders', optionalAuth, cacheMiddleware('reports:online-orders', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = getTenantRestaurantIds(req);
    if (tenantIds.length === 0) {
      return res.status(403).json({ error: 'Authentication required' });
    }

    const onlinePlatforms = ['SWIGGY', 'ZOMATO', 'MAGICPIN', 'EAT_CLUB', 'INSTAMART', 'BLINKIT', 'ZEPTO', 'BAR_MENU'];

    const transactions = await prisma.transaction.findMany({
      where: {
        restaurantId: { in: tenantIds },
        paidAt: { gte: startIST, lte: endIST },
        OR: [
          { platform: { in: onlinePlatforms } },
          { order: { platform: { in: onlinePlatforms } } },
        ],
      },
      select: {
        platform: true,
        order: { select: { platform: true } },
        amount: true,
        grandTotal: true,
        items: true,
      },
    });

    const platformTotals = new Map<string, { orders: number; sales: number }>();
    const allItems: any[] = [];
    for (const t of transactions) {
      const platform = t.platform || t.order?.platform || 'DINE_IN';
      if (!onlinePlatforms.includes(platform)) continue;
      const existing = platformTotals.get(platform) || { orders: 0, sales: 0 };
      existing.orders += 1;
      existing.sales += num(t.grandTotal ?? t.amount);
      platformTotals.set(platform, existing);
      try {
        const parsed = Array.isArray(t.items) ? t.items : (typeof t.items === 'string' ? JSON.parse(t.items) : []);
        allItems.push(...parsed);
      } catch {}
    }

    const platforms = Array.from(platformTotals.entries()).map(([platform, stats]) => ({
      platform,
      orders: stats.orders,
      sales: round2(stats.sales),
    }));

    const highestSellingItem = getHighestSellingItem(allItems);

    res.json({
      startDate: start,
      endDate: end,
      totalOrders: transactions.length,
      totalSales: round2(platforms.reduce((s, p) => s + p.sales, 0)),
      platforms,
      highestSellingItem,
    });
  } catch (err) {
    console.error('[Reports] online-orders error:', err);
    res.status(500).json({ error: 'Failed to fetch online orders report' });
  }
});

// ── Route: Captain Performance ─────────────────────────────────────────
router.get('/captain-performance', optionalAuth, cacheMiddleware('reports:captain-performance', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = getTenantRestaurantIds(req);
    if (tenantIds.length === 0) {
      return res.status(403).json({ error: 'Authentication required' });
    }

    const transactions = await prisma.transaction.findMany({
      where: {
        restaurantId: { in: tenantIds },
        paidAt: { gte: startIST, lte: endIST },
      },
      select: {
        captainId: true,
        grandTotal: true,
        amount: true,
        itemCount: true,
        items: true,
        paidAt: true,
      },
    });

    const captainIds = Array.from(new Set(transactions.map(t => t.captainId).filter((id): id is string => !!id)));
    const users = await prisma.user.findMany({
      where: { id: { in: captainIds } },
      select: { id: true, name: true },
    });
    const captainNameMap = new Map(users.map(u => [u.id, u.name]));

    const byCaptain = new Map<string, {
      captainId: string;
      totalSales: number;
      orderCount: number;
      itemCount: number;
      items: any[];
    }>();
    const trendBuckets = new Map<string, number>();

    for (const t of transactions) {
      const cid = t.captainId || 'N/A';
      const existing = byCaptain.get(cid) || { captainId: cid, totalSales: 0, orderCount: 0, itemCount: 0, items: [] };
      existing.totalSales += num(t.grandTotal ?? t.amount);
      existing.orderCount += 1;
      existing.itemCount += t.itemCount || 0;
      try {
        const parsed = Array.isArray(t.items) ? t.items : (typeof t.items === 'string' ? JSON.parse(t.items) : []);
        existing.items.push(...parsed);
      } catch {}
      byCaptain.set(cid, existing);

      const day = t.paidAt
        ? new Date(t.paidAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' })
        : 'unknown';
      trendBuckets.set(day, (trendBuckets.get(day) || 0) + num(t.grandTotal ?? t.amount));
    }

    const result = Array.from(byCaptain.values()).map(c => ({
      id: c.captainId,
      name: captainNameMap.get(c.captainId) || 'Unknown Captain',
      sales: round2(c.totalSales),
      orders: c.orderCount,
      items: c.itemCount,
      highestSellingItem: getHighestSellingItem(c.items),
    }));

    const trends = Array.from(trendBuckets.entries())
      .map(([day, sales]) => ({ day, sales: round2(sales) }))
      .sort((a, b) => {
        const [dA, mA] = a.day.split('/').map(Number);
        const [dB, mB] = b.day.split('/').map(Number);
        return new Date(2025, (mA || 1) - 1, dA || 1).getTime() - new Date(2025, (mB || 1) - 1, dB || 1).getTime();
      });

    res.json({ startDate: start, endDate: end, captains: result, trends });
  } catch (err) {
    console.error('[Reports] captain-performance error:', err);
    res.status(500).json({ error: 'Failed to fetch captain performance' });
  }
});

export default router;
