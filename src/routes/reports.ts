// ─────────────────────────────────────────────────────────────────────────────
// Reports Routes — Sales reports, GST reports, and analytics exports
// ─────────────────────────────────────────────────────────────────────────────
// Generates detailed reports for restaurant management:
//   - Daily/monthly sales summaries with GST breakdown
//   - Captain performance reports (revenue, discounts, order counts)
//   - Section-wise revenue reports
//   - Payment method summaries (cash/card/UPI)
//   - GST tax liability reports (CGST/SGST split)
//   - Discount analysis reports
//   - Transaction-level detail exports
//
// Uses optionalAuth so reports can be embedded in shareable links.
// All reports support date range filtering (per-day or per-month in IST).
// Cached for 60 seconds to handle repeated report views.
//
// Endpoints:
//   GET /api/reports/daily?date=YYYY-MM-DD        — daily sales summary
//   GET /api/reports/monthly?month=YYYY-MM        — monthly sales summary
//   GET /api/reports/captains?date=YYYY-MM-DD     — captain performance
//   GET /api/reports/sections?date=YYYY-MM-DD     — section-wise revenue
//   GET /api/reports/gst?month=YYYY-MM            — GST liability report
//   GET /api/reports/payments?date=YYYY-MM-DD     — payment method summary
//   GET /api/reports/discounts?month=YYYY-MM      — discount analysis
//   GET /api/reports/transactions?date=YYYY-MM-DD — transaction detail export
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import logger from "../lib/logger";
import { basePrisma } from '../lib/prisma';
import { formatTxnDisplayId } from '../utils/date';
import { cacheMiddleware } from '../lib/cache';
import { optionalAuth, authenticate } from '../middleware/auth';
import { resolveTenantContext, resolveKitchenRestaurantId } from '../lib/tenantContext';
import { completedTxnWhere } from '../lib/transactionHelpers';
import { LRUCache } from 'lru-cache';

const router = Router();

// Beverage keywords used to classify soft drinks / cool drinks / mocktails in reports.
const BEVERAGE_KEYWORDS = [
  'water', 'sprite', 'thums up', 'thumsup', 'tin thums', 'soda', 'cola', 'coke', 'pepsi',
  'limca', 'fanta', 'mirinda', '7up', 'pulpy orange', 'fresh lime', 'mojitho', 'mojito',
  'moctail', 'mocktail', 'fruit punch', 'lassi', 'butter milk', 'buttermilk', 'milk shake',
  'milkshake', 'monster', 'charged', 'red bull', 'coolberg', 'juice',
];

const BEVERAGE_ALIASES: Record<string, string> = {
  'thumsup': 'thums up',
  'thums': 'thums up',
  'tin thums': 'thums up',
  'butter milk': 'buttermilk',
  'milk shake': 'milkshake',
  'moctail': 'mocktail',
  'mojitho': 'mojito',
};

function normalizeBeverageName(name: string): string {
  let normalized = String(name || '').toLowerCase();
  // Remove container words and size suffixes
  normalized = normalized
    .replace(/\b(tin|bottle|bottel|pet|can|glass|pack|packs)\b/g, ' ')
    .replace(/\s+\d+(\.\d+)?\s*(ml|mls|milliliter|millilitre|l|ltr|liter|litre|lt|lts)\b/g, ' ')
    .replace(/\s+\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Map common aliases to canonical beverage names
  return BEVERAGE_ALIASES[normalized] || normalized;
}

function getReportCategory(menuItem: any): 'Liquor' | 'Food' | 'Beverages' {
  if (menuItem.menuType === 'LIQUOR') return 'Liquor';
  const normalizedName = normalizeBeverageName(String(menuItem.name || ''));
  if (BEVERAGE_KEYWORDS.some((k) => normalizedName.includes(k))) return 'Beverages';
  return 'Food';
}

/**
 * Returns all outlet IDs in the authenticated user's organization.
 * Uses resolveTenantContext to get allIds (including sibling outlets).
 * Returns [] if unauthenticated.
 */
async function getTenantRestaurantIds(req: any): Promise<string[]> {
  const user = req.user;
  if (!user) {
    return [];
  }
  const effectiveId = user.activeRestaurantId ?? user.restaurantId;
  if (!effectiveId) return [];
  const ctx = await resolveTenantContext(effectiveId);
  return ctx.allIds;
}

/**
 * Returns the list of restaurant IDs to filter on, based on the outletId query param.
 * If outletId is 'all', undefined, or not in the tenant's outlet list, returns all tenant IDs.
 * If outletId is a specific valid outlet ID, returns just that ID.
 */
export async function resolveOutletFilter(req: any): Promise<string[]> {
  const tenantIds = await getTenantRestaurantIds(req);
  if (tenantIds.length === 0) return [];
  const outletId = req.query.outletId as string | undefined;
  if (outletId && outletId !== 'all' && tenantIds.includes(outletId)) {
    return [outletId];
  }
  return tenantIds;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTRange(startDate: string, endDate: string) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startIST = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { startIST, endIST };
}

const outletNameCache = new LRUCache<string, string>({
  max: 500,
  ttl: 2 * 60 * 60 * 1000, // 2 hours
});

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
  const missing = restaurantIds.filter(id => outletNameCache.get(id) === undefined);
  if (missing.length === 0) return;

  const restaurants = await basePrisma.outlet.findMany({
    where: { id: { in: missing } },
    select: { id: true, restaurantType: true },
  });

  for (const r of restaurants) {
    outletNameCache.set(r.id, mapRestaurantTypeToOutlet(r.restaurantType));
  }
  // Cache unknown IDs too to avoid repeated queries for non-existent IDs
  for (const id of missing) {
    if (outletNameCache.get(id) === undefined) {
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

export async function getDailySalesData(tenantIds: string[], startIST: Date, endIST: Date) {
  const txnWhere = completedTxnWhere(tenantIds, {
    paidAt: { gte: startIST, lte: endIST },
  });

  const [aggTotals, byMethodRows, byDayRows, byOutletRows, highestBillRow, lowestBillRow] = await Promise.all([
    basePrisma.transaction.aggregate({
      where: txnWhere,
      _sum: {
        grandTotal: true,
        amount: true,
        subtotal: true,
        discountAmount: true,
        cgst: true,
        sgst: true,
      },
      _count: { id: true },
    }),

    basePrisma.transaction.groupBy({
      by: ['method'],
      where: txnWhere,
      _sum: { grandTotal: true, amount: true },
      _count: { id: true },
    }),

    basePrisma.transaction.groupBy({
      by: ['txnDate'],
      where: txnWhere,
      _sum: { grandTotal: true, amount: true },
      _count: { id: true },
    }),

    basePrisma.transaction.groupBy({
      by: ['restaurantId'],
      where: txnWhere,
      _sum: { grandTotal: true, amount: true },
      _count: { id: true },
    }),

    basePrisma.transaction.findFirst({
      where: { ...txnWhere, grandTotal: { not: null } },
      orderBy: { grandTotal: 'desc' },
      select: { txnNumber: true, txnDate: true, tableNumber: true, method: true, grandTotal: true },
    }),

    basePrisma.transaction.findFirst({
      where: { ...txnWhere, grandTotal: { not: null } },
      orderBy: { grandTotal: 'asc' },
      select: { txnNumber: true, txnDate: true, tableNumber: true, method: true, grandTotal: true },
    }),
  ]);

  const totalTransactions = aggTotals._count.id;
  const totalGrandTotal = num(aggTotals._sum.grandTotal) || num(aggTotals._sum.amount);
  const totalRevenue = totalGrandTotal;
  const totalSales = totalGrandTotal;
  const totalSubtotal = num(aggTotals._sum.subtotal);
  const totalDiscount = num(aggTotals._sum.discountAmount);
  const totalCGST = num(aggTotals._sum.cgst);
  const totalSGST = num(aggTotals._sum.sgst);
  const netSales = Math.round((totalSubtotal - totalDiscount) * 100) / 100;
  const avgBill = totalTransactions > 0 ? totalGrandTotal / totalTransactions : 0;

  const highestBill = highestBillRow ? {
    amount: round2(num(highestBillRow.grandTotal)),
    txnNumber: highestBillRow.txnNumber,
    txnDate: highestBillRow.txnDate,
    tableNumber: highestBillRow.tableNumber,
    method: highestBillRow.method,
  } : null;

  const lowestBill = lowestBillRow ? {
    amount: round2(num(lowestBillRow.grandTotal)),
    txnNumber: lowestBillRow.txnNumber,
    txnDate: lowestBillRow.txnDate,
    tableNumber: lowestBillRow.tableNumber,
    method: lowestBillRow.method,
  } : null;

  await warmOutletNameCache(byOutletRows.map(r => r.restaurantId));

  const byMethod: Record<string, { count: number; amount: number }> = {};
  for (const r of byMethodRows) {
    const amt = num(r._sum.grandTotal) || num(r._sum.amount);
    byMethod[r.method || 'UNKNOWN'] = { count: r._count.id, amount: round2(amt) };
  }

  const byOutlet: Record<string, { count: number; amount: number }> = {};
  for (const r of byOutletRows) {
    const amt = num(r._sum.grandTotal) || num(r._sum.amount);
    const outlet = getOutletName(r.restaurantId);
    byOutlet[outlet] = { count: r._count.id, amount: round2(amt) };
  }

  const byDay = byDayRows
    .map(r => ({
      date: r.txnDate || '',
      revenue: round2(num(r._sum.grandTotal) || num(r._sum.amount)),
      transactions: r._count.id,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    summary: {
      totalRevenue: round2(totalRevenue),
      totalSales: round2(totalSales),
      netSales: round2(netSales),
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
  };
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
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const data = await getDailySalesData(tenantIds, startIST, endIST);

    res.json({
      ...data,
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] daily-sales error:');
    res.status(500).json({ error: 'Failed to fetch daily sales report' });
  }
});

export async function getItemwiseSalesData(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
  options?: { outletType?: string; itemName?: string },
) {
  const typeFilter = String(options?.outletType || 'all').toLowerCase();
  const itemNameFilter = options?.itemName?.trim();

  const orderItems = await basePrisma.orderItem.findMany({
    where: {
      removedFromBill: false,
      order: {
        paidAt: { gte: startIST, lte: endIST },
        status: 'PAID',
        isDeleted: false,
        restaurantId: { in: tenantIds },
      },
      ...(itemNameFilter ? {
        menuItem: {
          name: { contains: itemNameFilter, mode: 'insensitive' },
        },
      } : {}),
    },
    include: {
      menuItem: { include: { category: true } },
      order: { select: { paidAt: true, restaurantId: true, transactions: { select: { discountPercent: true } } } },
    },
  });

  const itemMap = new Map<string, {
    id: string;
    name: string;
    category: string;
    menuType: string;
    reportCategory: 'Liquor' | 'Food' | 'Beverages';
    quantitySold: number;
    unitPrice: number;
    totalRevenue: number;
    orderIds: Set<string>;
  }>();

  for (const oi of orderItems) {
    const mi = oi.menuItem;
    if (!mi) continue;
    const reportCategory = getReportCategory(mi);
    const key = reportCategory === 'Beverages' ? normalizeBeverageName(mi.name) : mi.name;
    const qty = oi.quantity || 0;
    const orderDiscountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
    const discountFactor = orderDiscountPercent > 0 ? (1 - orderDiscountPercent / 100) : 1;
    const revenue = Math.round(num(oi.price) * qty * discountFactor * 100) / 100;
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        id: mi.id,
        name: reportCategory === 'Beverages' ? key : mi.name,
        category: reportCategory === 'Beverages' ? 'Beverages' : (mi.category?.name || 'Uncategorized'),
        menuType: mi.menuType,
        reportCategory,
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

  let workingItems = Array.from(itemMap.values());

  if (typeFilter === 'food') {
    workingItems = workingItems.filter((it) => it.reportCategory === 'Food');
  } else if (typeFilter === 'liquor') {
    workingItems = workingItems.filter((it) => it.reportCategory === 'Liquor');
  } else if (typeFilter === 'beverages') {
    workingItems = workingItems.filter((it) => it.reportCategory === 'Beverages');
  }

  const totalRevenueAll = workingItems.reduce((s, it) => s + it.totalRevenue, 0);
  const totalQuantityAll = workingItems.reduce((s, it) => s + it.quantitySold, 0);

  const foodRevenue = workingItems.filter((i) => i.reportCategory === 'Food').reduce((s, i) => s + i.totalRevenue, 0);
  const liquorRevenue = workingItems.filter((i) => i.reportCategory === 'Liquor').reduce((s, i) => s + i.totalRevenue, 0);
  const beveragesRevenue = workingItems.filter((i) => i.reportCategory === 'Beverages').reduce((s, i) => s + i.totalRevenue, 0);

  const items = workingItems
    .map((it) => ({
      id: it.id,
      name: it.name,
      category: it.category,
      menuType: it.menuType,
      reportCategory: it.reportCategory,
      quantitySold: it.quantitySold,
      unitPrice: it.quantitySold > 0 ? round2(it.totalRevenue / it.quantitySold) : it.unitPrice,
      totalRevenue: round2(it.totalRevenue),
      revenuePercent: totalRevenueAll > 0 ? round2((it.totalRevenue / totalRevenueAll) * 100) : 0,
      orderCount: it.orderIds.size,
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  return {
    items,
    summary: {
      totalItems: items.length,
      totalQuantity: totalQuantityAll,
      totalRevenue: round2(totalRevenueAll),
      foodRevenue: round2(foodRevenue),
      liquorRevenue: round2(liquorRevenue),
      beveragesRevenue: round2(beveragesRevenue),
    },
  };
}

// ── Route 2: Item-wise Sales ────────────────────────────────────────────
router.get('/itemwise-sales', optionalAuth, cacheMiddleware('reports:itemwise-sales-v2', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate, outletType } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const data = await getItemwiseSalesData(tenantIds, startIST, endIST, { outletType });

    res.json({
      ...data,
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] itemwise-sales error:');
    res.status(500).json({ error: 'Failed to fetch itemwise sales report' });
  }
});

// ── Route 3: Category-wise Sales ────────────────────────────────────────
router.get('/categorywise-sales', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const orderItems = await basePrisma.orderItem.findMany({
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
      const key = getReportCategory(mi);
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
    logger.error({ err }, '[Reports] categorywise-sales error:');
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
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const txnWhere = {
      restaurantId: { in: tenantIds },
      paidAt: { gte: startIST, lte: endIST },
    };

    const [byDayMethodRows, xReports, tipAgg, tipsByMethodRows] = await Promise.all([
      // Day + method breakdown for counts and fallback amounts
      basePrisma.transaction.groupBy({
        by: ['txnDate', 'method'],
        where: txnWhere,
        _sum: { grandTotal: true, amount: true },
        _count: { id: true },
      }),

      // X-Report is the source of truth for cash/card split per day
      (basePrisma as any).xReport.findMany({
        where: {
          restaurantId: { in: tenantIds },
          reportDate: { gte: start, lte: end },
        },
        select: {
          reportDate: true,
          totalSales: true,
          expenditureAmount: true,
          cardAmount: true,
          cashAmount: true,
          upiAmount: true,
          otherAmount: true,
          totalAmount: true,
        },
      }),

      // Total tips across all transactions in range
      basePrisma.transaction.aggregate({
        where: txnWhere,
        _sum: { tipAmount: true },
        _count: { id: true },
      }),

      // Tips broken down by payment method
      basePrisma.transaction.groupBy({
        by: ['method'],
        where: { ...txnWhere, tipAmount: { gt: 0 } },
        _sum: { tipAmount: true },
        _count: { id: true },
      }),
    ]);

    const xReportMap = new Map<string, any>(xReports.map((x: any) => [x.reportDate, x]));

    const allDays = new Set<string>();
    for (const r of byDayMethodRows) allDays.add(r.txnDate || start);
    for (const x of xReports) allDays.add(x.reportDate);

    const methodTotals = {
      CASH: { amount: 0, count: 0 },
      CARD: { amount: 0, count: 0 },
      UPI: { amount: 0, count: 0 },
      OTHER: { amount: 0, count: 0 },
    };
    const byDay: any[] = [];

    for (const date of Array.from(allDays).sort()) {
      const xReport: any = xReportMap.get(date);
      const dayRows = byDayMethodRows.filter((r: any) => (r.txnDate || start) === date);
      const dayTotalCount = dayRows.reduce((sum: number, r: any) => sum + r._count.id, 0);

      let cashAmount = 0;
      let cardAmount = 0;
      let upiAmount = 0;
      let otherAmount = 0;
      if (xReport) {
        // X-Report is authoritative for cash/card/upi/other split (no expenditure double-counting)
        cashAmount = num(xReport.cashAmount);
        cardAmount = num(xReport.cardAmount);
        upiAmount = num(xReport.upiAmount);
        otherAmount = num(xReport.otherAmount);
      } else {
        // Fallback: derive from transaction methods for days without X-Report
        cashAmount = dayRows
          .filter((r: any) => r.method === 'CASH')
          .reduce((sum: number, r: any) => sum + (num(r._sum.grandTotal) || num(r._sum.amount)), 0);
        cardAmount = dayRows
          .filter((r: any) => r.method === 'CARD')
          .reduce((sum: number, r: any) => sum + (num(r._sum.grandTotal) || num(r._sum.amount)), 0);
        upiAmount = dayRows
          .filter((r: any) => r.method === 'UPI')
          .reduce((sum: number, r: any) => sum + (num(r._sum.grandTotal) || num(r._sum.amount)), 0);
        otherAmount = dayRows
          .filter((r: any) => r.method === 'OTHER')
          .reduce((sum: number, r: any) => sum + (num(r._sum.grandTotal) || num(r._sum.amount)), 0);
      }

      methodTotals.CASH.count += dayRows
        .filter((r: any) => r.method === 'CASH')
        .reduce((sum: number, r: any) => sum + r._count.id, 0);
      methodTotals.CARD.count += dayRows
        .filter((r: any) => r.method === 'CARD')
        .reduce((sum: number, r: any) => sum + r._count.id, 0);
      methodTotals.UPI.count += dayRows
        .filter((r: any) => r.method === 'UPI')
        .reduce((sum: number, r: any) => sum + r._count.id, 0);
      methodTotals.OTHER.count += dayRows
        .filter((r: any) => r.method === 'OTHER')
        .reduce((sum: number, r: any) => sum + r._count.id, 0);
      methodTotals.CASH.amount += cashAmount;
      methodTotals.CARD.amount += cardAmount;
      methodTotals.UPI.amount += upiAmount;
      methodTotals.OTHER.amount += otherAmount;

      byDay.push({
        date,
        CASH: round2(cashAmount),
        CARD: round2(cardAmount),
        UPI: round2(upiAmount),
        OTHER: round2(otherAmount),
        count: dayTotalCount,
        total: round2(cashAmount + cardAmount + upiAmount + otherAmount),
      });
    }

    const totalAmount = methodTotals.CASH.amount + methodTotals.CARD.amount + methodTotals.UPI.amount + methodTotals.OTHER.amount;
    const totalTransactions = byDayMethodRows.reduce((sum: number, r: any) => sum + r._count.id, 0);

    const methods = [
      {
        method: 'CASH',
        count: methodTotals.CASH.count,
        amount: round2(methodTotals.CASH.amount),
        percent: totalAmount > 0 ? round2((methodTotals.CASH.amount / totalAmount) * 100) : 0,
      },
      {
        method: 'CARD',
        count: methodTotals.CARD.count,
        amount: round2(methodTotals.CARD.amount),
        percent: totalAmount > 0 ? round2((methodTotals.CARD.amount / totalAmount) * 100) : 0,
      },
      {
        method: 'UPI',
        count: methodTotals.UPI.count,
        amount: round2(methodTotals.UPI.amount),
        percent: totalAmount > 0 ? round2((methodTotals.UPI.amount / totalAmount) * 100) : 0,
      },
      {
        method: 'OTHER',
        count: methodTotals.OTHER.count,
        amount: round2(methodTotals.OTHER.amount),
        percent: totalAmount > 0 ? round2((methodTotals.OTHER.amount / totalAmount) * 100) : 0,
      },
    ].sort((a, b) => b.amount - a.amount);

    // Tips summary
    const totalTips = num(tipAgg._sum.tipAmount);
    const tipsByMethod: Record<string, { amount: number; count: number }> = {};
    for (const r of tipsByMethodRows) {
      tipsByMethod[r.method] = {
        amount: round2(num(r._sum.tipAmount)),
        count: r._count.id,
      };
    }

    res.json({
      methods,
      byDay,
      summary: {
        totalAmount: round2(totalAmount),
        totalTransactions,
        totalTips: round2(totalTips),
        tipsByMethod,
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] payment-methods error:');
    res.status(500).json({ error: 'Failed to fetch payment methods report' });
  }
});

export async function getDiscountReportData(tenantIds: string[], startIST: Date, endIST: Date) {
  const txnWhere = {
    restaurantId: { in: tenantIds },
    paidAt: { gte: startIST, lte: endIST },
    discountAmount: { gt: 0 },
  };

  const [transactions, aggTotals] = await Promise.all([
    basePrisma.transaction.findMany({
      where: txnWhere,
      orderBy: { paidAt: 'desc' },
      select: {
        id: true,
        method: true,
        amount: true,
        grandTotal: true,
        subtotal: true,
        discountAmount: true,
        discountPercent: true,
        txnDate: true,
        txnNumber: true,
        tableNumber: true,
        restaurantId: true,
        paidAt: true,
      },
    }),
    basePrisma.transaction.aggregate({
      where: txnWhere,
      _sum: { discountAmount: true, discountPercent: true },
      _count: { id: true },
    }),
  ]);

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

  const totalDiscountGiven = num(aggTotals._sum.discountAmount);
  const totalTransactionsWithDiscount = aggTotals._count.id;
  const avgDiscountPercent = totalTransactionsWithDiscount > 0
    ? round2(num(aggTotals._sum.discountPercent) / totalTransactionsWithDiscount)
    : 0;

  return {
    transactions: items,
    summary: {
      totalDiscountGiven: round2(totalDiscountGiven),
      totalTransactionsWithDiscount,
      averageDiscountPercent: avgDiscountPercent,
      totalRevenueLost: round2(totalDiscountGiven),
    },
  };
}

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
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const data = await getDiscountReportData(tenantIds, startIST, endIST);

    res.json({
      ...data,
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] discount-report error:');
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
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const primaryId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) || '';

    const [restaurant, transactions] = await Promise.all([
      basePrisma.outlet.findFirst({ where: { id: primaryId } }),
      basePrisma.transaction.findMany({
        where: {
          ...completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
          cgst: { not: null },
        },
        orderBy: { paidAt: 'desc' },
        select: {
          txnDate: true,
          txnNumber: true,
          tableNumber: true,
          subtotal: true,
          discountAmount: true,
          cgst: true,
          sgst: true,
          grandTotal: true,
          amount: true,
          method: true,
          restaurantId: true,
        },
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
    logger.error({ err }, '[Reports] gst-report error:');
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

    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const restaurantId = tenantIds[0];

    // Sales from transactions on that date
    const transactions = await basePrisma.transaction.findMany({
      where: completedTxnWhere(restaurantId, { txnDate: targetDate }),
      take: 5000,
      select: {
        grandTotal: true,
        amount: true,
        cgst: true,
        sgst: true,
        discountAmount: true,
      },
    });

    const totalSales = transactions.reduce((s, t) => s + num(t.grandTotal ?? t.amount), 0);
    const totalCGST = transactions.reduce((s, t) => s + num(t.cgst), 0);
    const totalSGST = transactions.reduce((s, t) => s + num(t.sgst), 0);
    const totalDiscount = transactions.reduce((s, t) => s + num(t.discountAmount), 0);

    // Bar inventory deductions
    const { startIST, endIST } = toISTRange(targetDate, targetDate);
    const barInventoryTxns = await basePrisma.inventoryTransaction.findMany({
      where: { restaurantId, transactionDate: { gte: startIST, lte: endIST } },
    });
    const barDeductions = barInventoryTxns.length;

    // Kitchen inventory entries for that date
    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
    const kitchenEntries = await basePrisma.inventoryDailyEntry.findMany({
      where: { restaurantId: kitchenRestaurantId, entryDate: targetDate },
    });
    const kitchenConsumed = kitchenEntries.reduce((s, e) => s + num(e.consumedStock), 0);

    // Payroll obligations for that month
    const monthYear = targetDate.slice(0, 7);
    const payrollRecords = await basePrisma.payrollRecord.findMany({
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
    logger.error({ err }, '[Reports] reconcile error:');
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
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const onlinePlatforms = ['SWIGGY', 'ZOMATO', 'MAGICPIN', 'EAT_CLUB', 'INSTAMART', 'BLINKIT', 'ZEPTO', 'BAR_MENU'];

    const transactions = await basePrisma.transaction.findMany({
      where: {
        ...completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
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
    logger.error({ err }, '[Reports] online-orders error:');
    res.status(500).json({ error: 'Failed to fetch online orders report' });
  }
});

// Sort trend days chronologically. Day format: DD/MM/YYYY (en-IN).
function sortTrends(trends: { day: string; sales: number }[]): { day: string; sales: number }[] {
  return trends.sort((a, b) => {
    const parse = (s: string) => {
      const [d, m, y] = s.split('/').map(Number);
      return new Date(y || 2000, (m || 1) - 1, d || 1).getTime();
    };
    return parse(a.day) - parse(b.day);
  });
}

// ── Route: Captain Performance ─────────────────────────────────────────
router.get('/captain-performance', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Fetch all captains in the tenant outlets so we always show them, even with 0 sales
    const captainUsers = await basePrisma.user.findMany({
      where: {
        outletId: { in: tenantIds },
        role: 'CAPTAIN',
      },
      select: { id: true, name: true },
    });

    const byCaptain = new Map<string, {
      captainId: string;
      name: string;
      totalSales: number;
      orderCount: number;
      itemCount: number;
      items: any[];
    }>();
    for (const u of captainUsers) {
      byCaptain.set(u.id, { captainId: u.id, name: u.name, totalSales: 0, orderCount: 0, itemCount: 0, items: [] });
    }

    const captainIds = Array.from(byCaptain.keys());
    const transactions = captainIds.length > 0
      ? await basePrisma.transaction.findMany({
          where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
          include: {
            order: { select: { captainId: true } },
          },
        })
      : [];

    const trendsByCaptain = new Map<string, Map<string, number>>();

    for (const t of transactions) {
      const cid = (t as any).order?.captainId || t.captainId;
      if (!cid || !byCaptain.has(cid)) continue;
      const existing = byCaptain.get(cid)!;
      existing.totalSales += num(t.grandTotal ?? t.amount);
      existing.orderCount += 1;
      existing.itemCount += t.itemCount || 0;
      try {
        const parsed = Array.isArray(t.items) ? t.items : (typeof t.items === 'string' ? JSON.parse(t.items) : []);
        existing.items.push(...parsed);
      } catch {}
      byCaptain.set(cid, existing);

      const day = t.paidAt
        ? new Date(t.paidAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' })
        : 'unknown';
      if (!trendsByCaptain.has(cid)) trendsByCaptain.set(cid, new Map());
      const captainTrend = trendsByCaptain.get(cid)!;
      captainTrend.set(day, (captainTrend.get(day) || 0) + num(t.grandTotal ?? t.amount));
    }

    const result = Array.from(byCaptain.values()).map(c => ({
      id: c.captainId,
      name: c.name,
      sales: round2(c.totalSales),
      orders: c.orderCount,
      items: c.itemCount,
      highestSellingItem: getHighestSellingItem(c.items),
      trends: sortTrends(Array.from((trendsByCaptain.get(c.captainId) || new Map()).entries()).map(([day, sales]) => ({ day, sales: round2(sales) }))),
    }));

    res.json({ startDate: start, endDate: end, captains: result });
  } catch (err) {
    logger.error({ err }, '[Reports] captain-performance error:');
    res.status(500).json({ error: 'Failed to fetch captain performance' });
  }
});

// ── Route: All Captains Group Report Card ───────────────────────────────
// Returns a shareable report-card page aggregating top captains.
router.get('/captain-performance-group', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurant = await basePrisma.outlet.findFirst({
      where: { id: tenantIds[0] },
      select: { id: true, name: true },
    });

    const captains = await basePrisma.user.findMany({
      where: { outletId: { in: tenantIds }, role: 'CAPTAIN' },
      select: { id: true, name: true },
    });

    const captainMap = new Map(captains.map((c) => [c.id, c]));
    const captainStats = new Map<string, {
      id: string;
      name: string;
      totalSales: number;
      orders: number;
      items: number;
      tips: number;
      workingDays: Set<string>;
    }>();

    const transactions = await basePrisma.transaction.findMany({
      where: {
        ...completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
        OR: [{ order: { captainId: { in: Array.from(captainMap.keys()) } } }, { captainId: { in: Array.from(captainMap.keys()) } }],
      },
      include: { order: { select: { captainId: true } } },
    });

    const trendBuckets = new Map<string, number>();
    const categoryTotals = new Map<string, number>();
    const itemTotals = new Map<string, { name: string; quantity: number; image?: string }>();
    let totalSales = 0;
    let totalOrders = 0;
    let totalItems = 0;
    let totalTips = 0;

    for (const t of transactions) {
      const captainId = (t as any).order?.captainId || t.captainId;
      const captain = captainMap.get(captainId);
      if (!captain) continue;

      const amount = num(t.grandTotal ?? t.amount);
      totalSales += amount;
      totalOrders += 1;
      totalItems += t.itemCount || 0;
      totalTips += num(t.tipAmount);

      if (!captainStats.has(captainId)) {
        captainStats.set(captainId, {
          id: captainId,
          name: captain.name,
          totalSales: 0,
          orders: 0,
          items: 0,
          tips: 0,
          workingDays: new Set(),
        });
      }
      const cs = captainStats.get(captainId)!;
      cs.totalSales += amount;
      cs.orders += 1;
      cs.items += t.itemCount || 0;
      cs.tips += num(t.tipAmount);

      const day = t.paidAt
        ? new Date(t.paidAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' })
        : 'unknown';
      cs.workingDays.add(day);
      trendBuckets.set(day, (trendBuckets.get(day) || 0) + amount);

      try {
        const parsed = Array.isArray(t.items) ? t.items : (typeof t.items === 'string' ? JSON.parse(t.items) : []);
        for (const item of parsed) {
          const name = String(item?.name || item?.n || '').trim();
          const qty = Number(item?.quantity || item?.q || 1);
          if (!name) continue;
          const cat = String(item?.category || item?.reportCategory || 'Others').trim() || 'Others';
          const price = Number(item?.price || item?.p || 0);
          categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + price * qty);
          const existing = itemTotals.get(name);
          if (existing) {
            existing.quantity += qty;
          } else {
            itemTotals.set(name, { name, quantity: qty, image: item?.image });
          }
        }
      } catch {}
    }

    const rankedCaptains = Array.from(captainStats.values())
      .map((c) => ({
        id: c.id,
        name: c.name,
        totalSales: round2(c.totalSales),
        orders: c.orders,
        items: c.items,
        avgSalesPerDay: round2(c.workingDays.size > 0 ? c.totalSales / c.workingDays.size : 0),
        tips: round2(c.tips),
        workingDays: c.workingDays.size,
      }))
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, 4);

    const categoryRevenue = Array.from(categoryTotals.entries())
      .map(([name, revenue]) => ({ name, revenue: round2(revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
    const categoryTotal = categoryRevenue.reduce((s, c) => s + c.revenue, 0);
    const categories = categoryRevenue.map((c) => ({
      ...c,
      percent: categoryTotal > 0 ? round2((c.revenue / categoryTotal) * 100) : 0,
    }));

    const itemsSold = Array.from(itemTotals.values()).sort((a, b) => b.quantity - a.quantity);
    const totalQtySold = itemsSold.reduce((s, it) => s + it.quantity, 0);
    const topItems = itemsSold.slice(0, 5).map((it) => ({
      ...it,
      percent: totalQtySold > 0 ? round2((it.quantity / totalQtySold) * 100) : 0,
    }));

    const daysWithSales = trendBuckets.size;
    const avgDailySales = daysWithSales > 0 ? totalSales / daysWithSales : 0;
    const avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;
    const salesByDayArr = Array.from(trendBuckets.entries());
    const peakDay = salesByDayArr.length > 0
      ? salesByDayArr.reduce((max, [day, sales]) => sales > max.sales ? { day, sales } : max, { day: '-', sales: 0 })
      : { day: '-', sales: 0 };
    const busyDays = salesByDayArr.filter(([_, sales]) => sales > avgDailySales).length;
    const trends = sortTrends(salesByDayArr.map(([day, sales]) => ({ day, sales: round2(sales) })));

    const cancelledOrders = await basePrisma.order.count({
      where: {
        restaurantId: { in: tenantIds },
        status: 'CANCELLED',
        createdAt: { gte: startIST, lte: endIST },
      },
    });

    res.json({
      restaurantName: restaurant?.name || 'Restaurant',
      startDate: start,
      endDate: end,
      totalSales: round2(totalSales),
      totalOrders,
      totalItems,
      totalTips: round2(totalTips),
      captains: rankedCaptains,
      trends,
      categories,
      topItems,
      activity: {
        workingDays: daysWithSales,
        busyDays,
        peakSalesDay: peakDay.day,
        peakSalesAmount: round2(peakDay.sales),
        avgOrderValue: round2(avgOrderValue),
        cancelledOrders,
      },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] captain-performance-group error:');
    res.status(500).json({ error: 'Failed to fetch group captain report' });
  }
});

// ── Route: Single Captain Report Card ──────────────────────────────────
// Returns detailed report-card data for a specific captain over a date range.
router.get('/captain-performance/:captainId', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const captainId = req.params.captainId as string;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const captain = await basePrisma.user.findFirst({
      where: { id: captainId, outletId: { in: tenantIds }, role: 'CAPTAIN' },
      select: { id: true, name: true },
    });
    if (!captain) {
      return res.status(404).json({ error: 'Captain not found' });
    }

    const transactions = await basePrisma.transaction.findMany({
      where: {
        ...completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
        OR: [{ order: { captainId } }, { captainId }],
      },
      include: { order: { select: { captainId: true } } },
    });

    let totalSales = 0;
    let orderCount = 0;
    let itemCount = 0;
    let tipsEarned = 0;
    const itemsSold: { name: string; quantity: number; image?: string }[] = [];
    const itemTotals = new Map<string, { name: string; quantity: number; image?: string }>();
    const trendBuckets = new Map<string, number>();
    const topBills: { date: string; amount: number }[] = [];

    for (const t of transactions) {
      const txnCaptainId = (t as any).order?.captainId || t.captainId;
      if (txnCaptainId !== captainId) continue;

      const amount = num(t.grandTotal ?? t.amount);
      totalSales += amount;
      orderCount += 1;
      itemCount += t.itemCount || 0;
      tipsEarned += num(t.tipAmount);

      const day = t.paidAt
        ? new Date(t.paidAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' })
        : 'unknown';
      trendBuckets.set(day, (trendBuckets.get(day) || 0) + amount);

      topBills.push({ date: day, amount });

      try {
        const parsed = Array.isArray(t.items) ? t.items : (typeof t.items === 'string' ? JSON.parse(t.items) : []);
        for (const item of parsed) {
          const name = String(item?.name || item?.n || '').trim();
          const qty = Number(item?.quantity || item?.q || 1);
          if (!name) continue;
          const existing = itemTotals.get(name);
          if (existing) {
            existing.quantity += qty;
          } else {
            itemTotals.set(name, { name, quantity: qty, image: item?.image });
          }
        }
      } catch {}
    }

    for (const v of itemTotals.values()) itemsSold.push(v);
    itemsSold.sort((a, b) => b.quantity - a.quantity);

    topBills.sort((a, b) => b.amount - a.amount);

    const daysWithSales = trendBuckets.size;
    const avgSalesPerDay = daysWithSales > 0 ? totalSales / daysWithSales : 0;
    const trends = sortTrends(Array.from(trendBuckets.entries()).map(([day, sales]) => ({ day, sales: round2(sales) })));

    // ── Previous period for growth comparison ──
    const prevDuration = endIST.getTime() - startIST.getTime();
    const prevStart = new Date(startIST.getTime() - prevDuration - 1);
    const prevEnd = new Date(startIST.getTime() - 1);
    const prevTransactions = await basePrisma.transaction.findMany({
      where: {
        ...completedTxnWhere(tenantIds, { paidAt: { gte: prevStart, lte: prevEnd } }),
        OR: [{ order: { captainId } }, { captainId }],
      },
      include: { order: { select: { captainId: true } } },
    });
    let prevSales = 0;
    let prevOrders = 0;
    let prevItems = 0;
    let prevTips = 0;
    for (const t of prevTransactions) {
      const txnCaptainId = (t as any).order?.captainId || t.captainId;
      if (txnCaptainId !== captainId) continue;
      prevSales += num(t.grandTotal ?? t.amount);
      prevOrders += 1;
      prevItems += t.itemCount || 0;
      prevTips += num(t.tipAmount);
    }
    const prevAvg = prevOrders > 0 ? prevSales / prevOrders : 0;
    const growth = {
      totalSales: prevSales > 0 ? round2(((totalSales - prevSales) / prevSales) * 100) : 0,
      orders: prevOrders > 0 ? round2(((orderCount - prevOrders) / prevOrders) * 100) : 0,
      avgSalesPerDay: prevAvg > 0 ? round2(((avgSalesPerDay - prevAvg) / prevAvg) * 100) : 0,
      items: prevItems > 0 ? round2(((itemCount - prevItems) / prevItems) * 100) : 0,
      tips: prevTips > 0 ? round2(((tipsEarned - prevTips) / prevTips) * 100) : 0,
    };

    // ── Sales by category ──
    const categoryTotals = new Map<string, number>();
    for (const t of transactions) {
      const txnCaptainId = (t as any).order?.captainId || t.captainId;
      if (txnCaptainId !== captainId) continue;
      try {
        const parsed = Array.isArray(t.items) ? t.items : (typeof t.items === 'string' ? JSON.parse(t.items) : []);
        for (const item of parsed) {
          const cat = String(item?.category || item?.reportCategory || 'Others').trim() || 'Others';
          const price = Number(item?.price || item?.p || 0);
          const qty = Number(item?.quantity || item?.q || 1);
          categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + price * qty);
        }
      } catch {}
    }
    const categoryRevenue = Array.from(categoryTotals.entries()).map(([name, revenue]) => ({
      name,
      revenue: round2(revenue),
    })).sort((a, b) => b.revenue - a.revenue);
    const categoryTotal = categoryRevenue.reduce((s, c) => s + c.revenue, 0);
    const categories = categoryRevenue.map((c) => ({
      ...c,
      percent: categoryTotal > 0 ? round2((c.revenue / categoryTotal) * 100) : 0,
    }));

    // ── Top items with percent of total qty ──
    const totalQtySold = itemsSold.reduce((s, it) => s + it.quantity, 0);
    const topItems = itemsSold.slice(0, 5).map((it) => ({
      ...it,
      percent: totalQtySold > 0 ? round2((it.quantity / totalQtySold) * 100) : 0,
    }));

    // ── Activity summary ──
    const avgDailySales = daysWithSales > 0 ? totalSales / daysWithSales : 0;
    const salesByDayArr = Array.from(trendBuckets.entries());
    const peakDay = salesByDayArr.length > 0
      ? salesByDayArr.reduce((max, [day, sales]) => sales > max.sales ? { day, sales } : max, { day: '-', sales: 0 })
      : { day: '-', sales: 0 };
    const busyDays = salesByDayArr.filter(([_, sales]) => sales > avgDailySales).length;
    const avgOrderValue = orderCount > 0 ? totalSales / orderCount : 0;

    const cancelledOrders = await basePrisma.order.count({
      where: {
        restaurantId: { in: tenantIds },
        captainId,
        createdAt: { gte: startIST, lte: endIST },
        status: 'CANCELLED',
      },
    });

    // ── Performance score (0-100) ──
    const salesScore = Math.min(totalSales / 100000, 1) * 50;
    const orderScore = Math.min(orderCount / 200, 1) * 30;
    const itemScore = Math.min(itemCount / 1000, 1) * 20;
    const performanceScore = Math.round(salesScore + orderScore + itemScore);

    res.json({
      captainId: captain.id,
      name: captain.name,
      startDate: start,
      endDate: end,
      totalSales: round2(totalSales),
      avgSalesPerDay: round2(avgSalesPerDay),
      orders: orderCount,
      items: itemCount,
      tipsEarned: round2(tipsEarned),
      workingDays: daysWithSales,
      growth,
      trends,
      categories,
      topBills: topBills.slice(0, 5),
      itemsSold: itemsSold.slice(0, 10),
      topItems,
      activity: {
        workingDays: daysWithSales,
        busyDays,
        peakSalesDay: peakDay.day,
        peakSalesAmount: round2(peakDay.sales),
        avgOrderValue: round2(avgOrderValue),
        cancelledOrders,
      },
      performanceScore,
    });
  } catch (err) {
    logger.error({ err }, '[Reports] captain-performance/:captainId error:');
    res.status(500).json({ error: 'Failed to fetch captain report card' });
  }
});

// ── Route: Item-wise Ingredient Cost / Profitability ───────────────────
// Scoped to Food items. Uses historical DailyCogsEntry.unitCostAtConsumption
// to estimate ingredient cost for the selected period.
router.get('/itemwise-sales/ingredients', optionalAuth, async (req: any, res) => {
  try {
    const { menuItemId, startDate, endDate } = req.query;
    const mid = String(menuItemId || '');
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!mid || !start || !end) {
      return res.status(400).json({ error: 'menuItemId, startDate, and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const menuItem = await basePrisma.menuItem.findFirst({
      where: { id: mid, restaurantId: { in: tenantIds }, isDeleted: false },
      select: { id: true, name: true, menuType: true, categoryId: true },
    });
    if (!menuItem) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    if (menuItem.menuType === 'LIQUOR') {
      return res.status(400).json({ error: 'Ingredient cost drill-down is only supported for Food items' });
    }

    const recipe = await basePrisma.menuItemRecipe.findMany({
      where: { menuItemId: mid, restaurantId: { in: tenantIds } },
      include: {
        ingredient: { select: { id: true, name: true, unit: true } },
      },
    });

    // Sum sold quantity and revenue from completed transactions in the date range.
    const transactions = await basePrisma.transaction.findMany({
      where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
      select: { items: true, grandTotal: true, amount: true },
    });

    const normalizedMenuName = menuItem.name.trim().toLowerCase();
    let totalRevenue = 0;
    let totalQuantity = 0;
    for (const t of transactions) {
      let parsed: any[] = [];
      try {
        parsed = Array.isArray(t.items) ? t.items : (typeof t.items === 'string' ? JSON.parse(t.items) : []);
      } catch {
        parsed = [];
      }
      const matching = parsed.filter((it: any) => {
        if (!it) return false;
        const itemId = String(it?.menuItemId || it?.id || '');
        const itemName = String(it?.name || it?.n || '').trim().toLowerCase();
        return itemId === mid || itemName === normalizedMenuName;
      });
      for (const it of matching) {
        const qty = Math.max(0, Number(it?.quantity || it?.q || 1));
        const price = Math.max(0, Number(it?.price || it?.p || 0));
        totalQuantity += qty;
        totalRevenue += qty * price;
      }
    }

    let totalIngredientCost = 0;
    let missingCostCount = 0;
    let fallbackUsedCount = 0;
    const ingredientBreakdown: {
      id: string;
      name: string;
      unit: string;
      recipeQty: number;
      avgUnitCost: number;
      totalCost: number;
      source: 'cogs' | 'inventory' | 'missing';
    }[] = [];

    for (const r of recipe) {
      const recipeQty = Math.max(0, Number(r.quantity));
      if (recipeQty <= 0) continue;

      // 1. Try historical consumption cost in the selected period
      const cogsEntries = await basePrisma.dailyCogsEntry.findMany({
        where: {
          kitchenInventoryItemId: r.ingredientId,
          restaurantId: { in: tenantIds },
          date: { gte: start, lte: end },
        },
        select: { consumedQty: true, unitCostAtConsumption: true },
      });

      let weightedCost = 0;
      let consumedTotal = 0;
      for (const e of cogsEntries) {
        const qty = Number(e.consumedQty || 0);
        const cost = Number(e.unitCostAtConsumption || 0);
        if (qty > 0) {
          weightedCost += qty * cost;
          consumedTotal += qty;
        }
      }
      let avgUnitCost = consumedTotal > 0 ? weightedCost / consumedTotal : 0;
      let source: 'cogs' | 'inventory' | 'missing' = avgUnitCost > 0 ? 'cogs' : 'missing';

      // 2. Fallback to the inventory master price if no COGS data exists
      if (avgUnitCost <= 0) {
        const invItem = await basePrisma.kitchenInventoryItem.findFirst({
          where: { id: r.ingredientId, restaurantId: { in: tenantIds } },
          select: { price: true },
        });
        const invPrice = Number(invItem?.price || 0);
        if (invPrice > 0) {
          avgUnitCost = invPrice;
          source = 'inventory';
          fallbackUsedCount += 1;
        } else {
          missingCostCount += 1;
        }
      }

      const totalCost = avgUnitCost * recipeQty * totalQuantity;
      totalIngredientCost += totalCost;
      ingredientBreakdown.push({
        id: r.ingredientId,
        name: r.ingredient.name,
        unit: r.ingredient.unit,
        recipeQty,
        avgUnitCost: round2(avgUnitCost),
        totalCost: round2(totalCost),
        source,
      });
    }

    const profit = totalRevenue - totalIngredientCost;
    const marginPercent = totalRevenue > 0 ? round2((profit / totalRevenue) * 100) : 0;

    let costConfidence: 'full' | 'partial' | 'none' = 'none';
    if (recipe.length > 0) {
      if (missingCostCount === 0 && fallbackUsedCount === 0) costConfidence = 'full';
      else if (missingCostCount === 0 && fallbackUsedCount > 0) costConfidence = 'full';
      else costConfidence = 'partial';
    }

    res.json({
      menuItemId: menuItem.id,
      name: menuItem.name,
      menuType: menuItem.menuType,
      totalQuantity,
      totalRevenue: round2(totalRevenue),
      totalIngredientCost: round2(totalIngredientCost),
      profit: round2(profit),
      marginPercent,
      hasRecipe: recipe.length > 0,
      missingCostCount,
      fallbackUsedCount,
      costConfidence,
      ingredients: ingredientBreakdown,
      period: { startDate: start, endDate: end },
      fallbackMessage: recipe.length === 0 ? 'No recipe found for this item.' : undefined,
    });
  } catch (err) {
    logger.error({ err }, '[Reports] itemwise-sales/ingredients error:');
    res.status(500).json({ error: 'Failed to fetch ingredient profitability' });
  }
});

// ── Route: Venue-wise Revenue ──────────────────────────────────────────────
// Revenue, orders, and average order value grouped by outlet/venue.
router.get('/venue-revenue', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const outlets = await basePrisma.outlet.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true },
    });

    const agg = await basePrisma.transaction.groupBy({
      by: ['restaurantId'],
      where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
      _sum: { grandTotal: true, amount: true },
      _count: { id: true },
    });

    const aggByRestaurant = new Map(agg.map((a) => [a.restaurantId, a]));

    const venues = outlets.map((o) => {
      const row = aggByRestaurant.get(o.id);
      const revenue = round2(num(row?._sum?.grandTotal) || num(row?._sum?.amount));
      const orders = row?._count?.id || 0;
      return {
        id: o.id,
        name: o.name,
        revenue,
        orders,
        averageOrderValue: orders > 0 ? round2(revenue / orders) : 0,
      };
    });

    const totalRevenue = venues.reduce((s, v) => s + v.revenue, 0);
    const totalOrders = venues.reduce((s, v) => s + v.orders, 0);

    res.json({
      venues: venues.sort((a, b) => b.revenue - a.revenue),
      summary: { totalRevenue: round2(totalRevenue), totalOrders, averageOrderValue: totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0 },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] venue-revenue error:');
    res.status(500).json({ error: 'Failed to fetch venue revenue report' });
  }
});

// ── Route: Monthly P&L ───────────────────────────────────────────────────────
// Simplified profit & loss: revenue minus cost of goods sold.
router.get('/monthly-pl', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const txAgg = await basePrisma.transaction.aggregate({
      where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
      _sum: { grandTotal: true, amount: true, discountAmount: true },
      _count: { id: true },
    });

    const totalRevenue = round2(num(txAgg._sum?.grandTotal) || num(txAgg._sum?.amount));
    const totalDiscounts = round2(num(txAgg._sum?.discountAmount));

    const cogsAgg = await basePrisma.dailyCogsEntry.aggregate({
      where: {
        restaurantId: { in: tenantIds },
        date: { gte: start, lte: end },
      },
      _sum: { cogsAmount: true },
    });
    const totalCogs = round2(num(cogsAgg._sum?.cogsAmount));

    const expAgg = await basePrisma.expenditure.aggregate({
      where: {
        restaurantId: { in: tenantIds },
        expenditureDate: { gte: start, lte: end },
        status: { not: 'CANCELLED' },
      },
      _sum: { amount: true },
    });
    const totalExpenditures = round2(num(expAgg._sum?.amount));

    const advanceAgg = await basePrisma.expenditure.aggregate({
      where: {
        restaurantId: { in: tenantIds },
        expenditureDate: { gte: start, lte: end },
        status: { not: 'CANCELLED' },
        OR: [
          { entryType: 'ADVANCE' },
          { category: { contains: 'advance', mode: 'insensitive' } },
          { narration: { contains: 'advance', mode: 'insensitive' } },
        ],
      },
      _sum: { amount: true },
    });
    const totalAdvances = round2(num(advanceAgg._sum?.amount));

    const poAgg = await basePrisma.purchaseOrder.aggregate({
      where: {
        restaurantId: { in: tenantIds },
        orderDate: { gte: start, lte: end },
        status: { not: 'CANCELLED' },
      },
      _sum: { totalAmount: true },
    });
    const totalPurchases = round2(num(poAgg._sum?.totalAmount));

    const totalOutflows = totalCogs + totalExpenditures + totalDiscounts + totalPurchases + totalAdvances;
    const grossProfit = round2(totalRevenue - totalOutflows);
    const marginPercent = totalRevenue > 0 ? round2((grossProfit / totalRevenue) * 100) : 0;

    res.json({
      summary: {
        totalRevenue,
        totalSales: totalRevenue,
        totalCogs,
        totalExpenditures,
        totalDiscounts,
        totalPurchases,
        totalAdvances,
        totalOutflows,
        grossProfit,
        marginPercent,
        totalTransactions: txAgg._count?.id || 0,
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] monthly-pl error:');
    res.status(500).json({ error: 'Failed to fetch monthly P&L report' });
  }
});

// ── Route: Cancelled / Edited Items ─────────────────────────────────────────
router.get('/cancelled-items', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const cancelledOrders = await basePrisma.order.findMany({
      where: {
        restaurantId: { in: tenantIds },
        status: 'CANCELLED',
        createdAt: { gte: startIST, lte: endIST },
      },
      select: { id: true, tableId: true, totalAmount: true, createdAt: true, table: { select: { number: true } } },
    });

    const editedItems = await basePrisma.orderItem.findMany({
      where: {
        order: { restaurantId: { in: tenantIds }, createdAt: { gte: startIST, lte: endIST } },
        OR: [
          { cancelledQuantity: { gt: 0 } },
          { editedQuantity: { gt: 0 } },
          { removedFromBill: true },
        ],
      },
      select: {
        id: true,
        name: true,
        quantity: true,
        cancelledQuantity: true,
        editedQuantity: true,
        removedFromBill: true,
        price: true,
        order: { select: { id: true, createdAt: true, table: { select: { number: true } } } },
      },
    });

    const items = editedItems.map((it) => ({
      id: it.id,
      name: it.name,
      quantity: it.quantity,
      cancelledQuantity: it.cancelledQuantity,
      editedQuantity: it.editedQuantity,
      removedFromBill: it.removedFromBill,
      price: num(it.price),
      orderId: it.order.id,
      tableNumber: it.order.table?.number,
      createdAt: it.order.createdAt,
      type: it.removedFromBill ? 'removed' : it.cancelledQuantity > 0 ? 'cancelled' : 'edited',
    }));

    res.json({
      cancelledOrders: cancelledOrders.map((o) => ({
        id: o.id,
        tableNumber: o.table?.number,
        totalAmount: num(o.totalAmount),
        createdAt: o.createdAt,
      })),
      items,
      summary: {
        cancelledOrderCount: cancelledOrders.length,
        editedItemCount: items.filter((i) => i.type === 'edited').length,
        cancelledItemCount: items.filter((i) => i.type === 'cancelled').length,
        removedItemCount: items.filter((i) => i.type === 'removed').length,
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] cancelled-items error:');
    res.status(500).json({ error: 'Failed to fetch cancelled items report' });
  }
});

// ── Route: Table Utilization ───────────────────────────────────────────────
router.get('/table-utilization', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tables = await basePrisma.table.findMany({
      where: { restaurantId: { in: tenantIds } },
      select: { id: true, number: true, capacity: true },
    });

    const orders = await basePrisma.order.findMany({
      where: {
        restaurantId: { in: tenantIds },
        status: 'PAID',
        paidAt: { gte: startIST, lte: endIST },
        isDeleted: false,
      },
      select: { tableId: true, totalAmount: true, id: true },
    });

    const tableMap = new Map<string, { orders: number; revenue: number }>();
    for (const t of tables) {
      tableMap.set(t.id, { orders: 0, revenue: 0 });
    }
    for (const o of orders) {
      const rec = tableMap.get(o.tableId);
      if (!rec) continue;
      rec.orders += 1;
      rec.revenue += num(o.totalAmount);
    }

    const rows = tables.map((t) => {
      const rec = tableMap.get(t.id)!;
      return {
        id: t.id,
        number: t.number,
        capacity: t.capacity,
        orders: rec.orders,
        revenue: round2(rec.revenue),
        revenuePerOrder: rec.orders > 0 ? round2(rec.revenue / rec.orders) : 0,
      };
    });

    res.json({
      tables: rows.sort((a, b) => b.revenue - a.revenue),
      summary: {
        totalTables: tables.length,
        activeTables: rows.filter((r) => r.orders > 0).length,
        totalRevenue: round2(rows.reduce((s, r) => s + r.revenue, 0)),
        totalOrders: rows.reduce((s, r) => s + r.orders, 0),
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] table-utilization error:');
    res.status(500).json({ error: 'Failed to fetch table utilization report' });
  }
});

// ── Route: Hourly Analysis ───────────────────────────────────────────────────
router.get('/hourly-analysis', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const transactions = await basePrisma.transaction.findMany({
      where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
      select: { paidAt: true, grandTotal: true, amount: true },
    });

    const hours = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      label: `${String(i).padStart(2, '0')}:00`,
      revenue: 0,
      orders: 0,
    }));

    for (const t of transactions) {
      const d = t.paidAt ? new Date(t.paidAt) : null;
      if (!d) continue;
      const h = d.getHours();
      hours[h].revenue += num(t.grandTotal) || num(t.amount);
      hours[h].orders += 1;
    }

    res.json({
      hours: hours.map((h) => ({ ...h, revenue: round2(h.revenue) })),
      summary: {
        peakHour: hours.reduce((max, h) => (h.revenue > max.revenue ? h : max), hours[0])?.label,
        totalRevenue: round2(transactions.reduce((s, t) => s + (num(t.grandTotal) || num(t.amount)), 0)),
        totalOrders: transactions.length,
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] hourly-analysis error:');
    res.status(500).json({ error: 'Failed to fetch hourly analysis report' });
  }
});

// ── Route: KOT Count Report ──────────────────────────────────────────────────
router.get('/kot-count', optionalAuth, async (req: any, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = String(startDate || '');
    const end = String(endDate || '');
    if (!start || !end) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startIST, endIST } = toISTRange(start, end);
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const kots = await basePrisma.kot.findMany({
      where: {
        restaurantId: { in: tenantIds },
        createdAt: { gte: startIST, lte: endIST },
      },
      select: { createdAt: true },
    });

    const dayMap = new Map<string, number>();
    for (const k of kots) {
      const d = k.createdAt ? new Date(k.createdAt).toISOString().slice(0, 10) : '';
      if (!d) continue;
      dayMap.set(d, (dayMap.get(d) || 0) + 1);
    }
    const aggByDay = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));

    const totalKots = kots.length;

    const byStatus = await basePrisma.kotItem.groupBy({
      by: ['status'],
      where: {
        kot: { restaurantId: { in: tenantIds }, createdAt: { gte: startIST, lte: endIST } },
      },
      _count: { id: true },
    });

    res.json({
      summary: {
        totalKots,
        averagePerDay: aggByDay.length > 0 ? round2(totalKots / aggByDay.length) : 0,
      },
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.id })),
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Reports] kot-count error:');
    res.status(500).json({ error: 'Failed to fetch KOT count report' });
  }
});

export default router;
