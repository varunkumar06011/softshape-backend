// Data fetchers for the Spire AI agent.
// Wraps the Phase 0 extracted report functions and adds direct queries
// for Attendance and DailyInventorySnapshot.

import { withOrgScope } from '../../lib/prisma';
import { basePrisma } from '../../lib/prisma';
import { completedTxnWhere } from '../../lib/transactionHelpers';
import {
  getDailySalesData,
  getItemwiseSalesData,
  getDiscountReportData,
} from '../../routes/reports';

export { getDailySalesData, getItemwiseSalesData, getDiscountReportData };

export interface AttendanceSummary {
  totalEmployees: number;
  present: number;
  absent: number;
  halfDay: number;
  leave: number;
  notMarked: number;
  records: { name: string; role: string | null; status: string }[];
}

export async function getAttendanceSummary(
  tenantIds: string[],
  startDate: string,
  endDate: string,
): Promise<AttendanceSummary> {
  const orgPrisma = withOrgScope(undefined, tenantIds);
  const employees = await orgPrisma.employee.findMany({
    where: { restaurantId: { in: tenantIds }, isActive: true },
    select: { id: true, name: true, role: true },
  });

  const attendance = await orgPrisma.attendance.findMany({
    where: {
      restaurantId: { in: tenantIds },
      date: { gte: startDate, lte: endDate },
    },
    include: { employee: { select: { id: true, name: true, role: true } } },
  });

  const attendanceMap = new Map(attendance.map(a => [a.employeeId, a.status]));

  const present = attendance.filter(a => a.status === 'PRESENT').length;
  const absent = attendance.filter(a => a.status === 'ABSENT').length;
  const halfDay = attendance.filter(a => a.status === 'HALF_DAY').length;
  const leave = attendance.filter(a => a.status === 'LEAVE').length;
  const notMarked = employees.length - attendance.length;

  const records = employees.map(e => ({
    name: e.name,
    role: e.role,
    status: attendanceMap.get(e.id) || 'NOT_MARKED',
  }));

  return {
    totalEmployees: employees.length,
    present,
    absent,
    halfDay,
    leave,
    notMarked,
    records,
  };
}

export interface PurchaseSummary {
  items: { itemName: string; purchased: number; sold: number; wastage: number; closingStock: number }[];
  totalPurchased: number;
  totalSold: number;
  totalWastage: number;
}

export async function getPurchaseSummary(
  tenantIds: string[],
  startDate: string,
  endDate: string,
  itemName?: string,
): Promise<PurchaseSummary> {
  const orgPrisma = withOrgScope(undefined, tenantIds);
  const snapshots = await orgPrisma.dailyInventorySnapshot.findMany({
    where: {
      restaurantId: { in: tenantIds },
      snapshotDate: { gte: startDate, lte: endDate },
      ...(itemName ? { itemName: { contains: itemName, mode: 'insensitive' } } : {}),
    },
  });

  const itemMap = new Map<string, { purchased: number; sold: number; wastage: number; closingStock: number }>();

  for (const s of snapshots) {
    const key = s.itemName;
    const existing = itemMap.get(key) || { purchased: 0, sold: 0, wastage: 0, closingStock: 0 };
    existing.purchased += Number(s.purchased);
    existing.sold += Number(s.sold);
    existing.wastage += Number(s.wastage);
    existing.closingStock = Number(s.closingStock); // last value wins
    itemMap.set(key, existing);
  }

  const items = Array.from(itemMap.entries()).map(([itemName, totals]) => ({
    itemName,
    purchased: round2(totals.purchased),
    sold: round2(totals.sold),
    wastage: round2(totals.wastage),
    closingStock: round2(totals.closingStock),
  }));

  return {
    items,
    totalPurchased: round2(items.reduce((s, i) => s + i.purchased, 0)),
    totalSold: round2(items.reduce((s, i) => s + i.sold, 0)),
    totalWastage: round2(items.reduce((s, i) => s + i.wastage, 0)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(val: any): number {
  if (val == null) return 0;
  return typeof val === 'number' ? val : Number(val);
}

export async function getTopSellingItems(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
  limit: number = 5,
  itemName?: string,
) {
  const data = await getItemwiseSalesData(tenantIds, startIST, endIST, { itemName });
  return {
    items: data.items.slice(0, limit),
    summary: data.summary,
  };
}

export interface FloorStatus {
  total: number;
  available: number;
  occupied: number;
  reserved: number;
  cleaning: number;
  billingRequested: number;
  totalCurrentBill: number;
  totalGuests: number;
}

export async function getFloorStatus(tenantIds: string[]): Promise<FloorStatus> {
  const orgPrisma = withOrgScope(undefined, tenantIds);
  const tables = await orgPrisma.table.findMany({
    where: { restaurantId: { in: tenantIds } },
    select: { status: true, currentBill: true, guests: true },
  });

  const total = tables.length;
  const available = tables.filter(t => t.status === 'AVAILABLE').length;
  const occupied = tables.filter(t => t.status === 'OCCUPIED').length;
  const reserved = tables.filter(t => t.status === 'RESERVED').length;
  const cleaning = tables.filter(t => t.status === 'CLEANING').length;
  const billingRequested = tables.filter(t => t.status === 'BILLING_REQUESTED').length;
  const totalCurrentBill = tables.reduce((sum, t) => sum + Number(t.currentBill), 0);
  const totalGuests = tables.reduce((sum, t) => sum + t.guests, 0);

  return { total, available, occupied, reserved, cleaning, billingRequested, totalCurrentBill: round2(totalCurrentBill), totalGuests };
}

export interface PaymentBreakdown {
  methods: { method: string; count: number; totalAmount: number }[];
  totalAmount: number;
  totalTransactions: number;
}

export async function getPaymentBreakdown(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
): Promise<PaymentBreakdown> {
  const orgPrisma = withOrgScope(undefined, tenantIds);
  const transactions = await orgPrisma.transaction.findMany({
    where: {
      restaurantId: { in: tenantIds },
      paidAt: { gte: startIST, lte: endIST },
    },
    select: { method: true, amount: true },
  });

  const methodMap = new Map<string, { count: number; totalAmount: number }>();
  for (const t of transactions) {
    const key = t.method || 'UNKNOWN';
    const existing = methodMap.get(key) || { count: 0, totalAmount: 0 };
    existing.count += 1;
    existing.totalAmount += Number(t.amount);
    methodMap.set(key, existing);
  }

  const methods = Array.from(methodMap.entries())
    .map(([method, v]) => ({ method, count: v.count, totalAmount: round2(v.totalAmount) }))
    .sort((a, b) => b.totalAmount - a.totalAmount);

  return {
    methods,
    totalAmount: round2(methods.reduce((s, m) => s + m.totalAmount, 0)),
    totalTransactions: transactions.length,
  };
}

export interface WastageSummary {
  items: { itemName: string; wastage: number; unit?: string }[];
  totalWastage: number;
}

export async function getWastageSummary(
  tenantIds: string[],
  startDate: string,
  endDate: string,
): Promise<WastageSummary> {
  const orgPrisma = withOrgScope(undefined, tenantIds);
  const snapshots = await orgPrisma.dailyInventorySnapshot.findMany({
    where: {
      restaurantId: { in: tenantIds },
      snapshotDate: { gte: startDate, lte: endDate },
      wastage: { gt: 0 },
    },
    select: { itemName: true, wastage: true },
  });

  const itemMap = new Map<string, number>();
  for (const s of snapshots) {
    itemMap.set(s.itemName, (itemMap.get(s.itemName) || 0) + Number(s.wastage));
  }

  const items = Array.from(itemMap.entries())
    .map(([itemName, wastage]) => ({ itemName, wastage: round2(wastage) }))
    .sort((a, b) => b.wastage - a.wastage);

  return {
    items,
    totalWastage: round2(items.reduce((s, i) => s + i.wastage, 0)),
  };
}

export interface LowStockAlert {
  items: { name: string; currentStock: number; reorderLevel: number; unit: string; shortfall: number }[];
  totalAlerts: number;
}

export async function getLowStockAlerts(tenantIds: string[]): Promise<LowStockAlert> {
  const orgPrisma = withOrgScope(undefined, tenantIds);
  const items = await orgPrisma.kitchenInventoryItem.findMany({
    where: {
      restaurantId: { in: tenantIds },
      currentStock: { lte: orgPrisma.kitchenInventoryItem.fields.reorderLevel },
    },
    select: { name: true, currentStock: true, reorderLevel: true, unit: true },
  });

  const alerts = items
    .map(i => ({
      name: i.name,
      currentStock: round2(Number(i.currentStock)),
      reorderLevel: round2(Number(i.reorderLevel)),
      unit: i.unit,
      shortfall: round2(Number(i.reorderLevel) - Number(i.currentStock)),
    }))
    .sort((a, b) => b.shortfall - a.shortfall);

  return { items: alerts, totalAlerts: alerts.length };
}

export interface PeriodComparison {
  current: { totalRevenue: number; totalTransactions: number; averageBillValue: number };
  previous: { totalRevenue: number; totalTransactions: number; averageBillValue: number };
  revenueDelta: number;
  revenueDeltaPercent: number;
  transactionDelta: number;
}

export async function getPeriodComparison(
  tenantIds: string[],
  currentStart: Date,
  currentEnd: Date,
  previousStart: Date,
  previousEnd: Date,
): Promise<PeriodComparison> {
  const [currentData, previousData] = await Promise.all([
    getDailySalesData(tenantIds, currentStart, currentEnd),
    getDailySalesData(tenantIds, previousStart, previousEnd),
  ]);

  const c = currentData.summary;
  const p = previousData.summary;
  const revenueDelta = round2(c.totalRevenue - p.totalRevenue);
  const revenueDeltaPercent = p.totalRevenue > 0 ? round2((revenueDelta / p.totalRevenue) * 100) : 0;
  const transactionDelta = c.totalTransactions - p.totalTransactions;

  return {
    current: { totalRevenue: round2(c.totalRevenue), totalTransactions: c.totalTransactions, averageBillValue: round2(c.averageBillValue) },
    previous: { totalRevenue: round2(p.totalRevenue), totalTransactions: p.totalTransactions, averageBillValue: round2(p.averageBillValue) },
    revenueDelta,
    revenueDeltaPercent,
    transactionDelta,
  };
}

// ── AOV (Average Order Value) ───────────────────────────────────────────────
// Reuses the existing getDailySalesData summary so the AOV is computed with the
// system's single source of truth (grandTotal / completed transaction count).

export interface AovData {
  aov: number;
  totalRevenue: number;
  totalTransactions: number;
  totalDiscount: number;
}

export async function getAovData(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
): Promise<AovData> {
  const data = await getDailySalesData(tenantIds, startIST, endIST);
  const s = data.summary;
  return {
    aov: round2(s.averageBillValue),
    totalRevenue: round2(s.totalRevenue),
    totalTransactions: s.totalTransactions,
    totalDiscount: round2(s.totalDiscount),
  };
}

// AOV comparison between two ranges (e.g. this month vs last month).
export interface AovComparison {
  current: { aov: number; totalRevenue: number; totalTransactions: number };
  previous: { aov: number; totalRevenue: number; totalTransactions: number };
  aovDelta: number;
  aovDeltaPercent: number;
  revenueDelta: number;
  revenueDeltaPercent: number;
  transactionDelta: number;
}

export async function getAovComparison(
  tenantIds: string[],
  currentStart: Date,
  currentEnd: Date,
  previousStart: Date,
  previousEnd: Date,
): Promise<AovComparison> {
  const [cur, prev] = await Promise.all([
    getAovData(tenantIds, currentStart, currentEnd),
    getAovData(tenantIds, previousStart, previousEnd),
  ]);

  const aovDelta = round2(cur.aov - prev.aov);
  const aovDeltaPercent = prev.aov > 0 ? round2((aovDelta / prev.aov) * 100) : 0;
  const revenueDelta = round2(cur.totalRevenue - prev.totalRevenue);
  const revenueDeltaPercent = prev.totalRevenue > 0 ? round2((revenueDelta / prev.totalRevenue) * 100) : 0;
  const transactionDelta = cur.totalTransactions - prev.totalTransactions;

  return {
    current: { aov: cur.aov, totalRevenue: cur.totalRevenue, totalTransactions: cur.totalTransactions },
    previous: { aov: prev.aov, totalRevenue: prev.totalRevenue, totalTransactions: prev.totalTransactions },
    aovDelta,
    aovDeltaPercent,
    revenueDelta,
    revenueDeltaPercent,
    transactionDelta,
  };
}

// ── Orders / Bills count ─────────────────────────────────────────────────────
export interface OrdersCount {
  totalTransactions: number;
  totalRevenue: number;
  averageBillValue: number;
}

export async function getOrdersCount(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
): Promise<OrdersCount> {
  const data = await getDailySalesData(tenantIds, startIST, endIST);
  const s = data.summary;
  return {
    totalTransactions: s.totalTransactions,
    totalRevenue: round2(s.totalRevenue),
    averageBillValue: round2(s.averageBillValue),
  };
}

// ── Revenue (focused) ────────────────────────────────────────────────────────
export interface RevenueData {
  totalRevenue: number;
  netSales: number;
  totalTransactions: number;
  totalDiscount: number;
  averageBillValue: number;
}

export async function getRevenueData(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
): Promise<RevenueData> {
  const data = await getDailySalesData(tenantIds, startIST, endIST);
  const s = data.summary;
  return {
    totalRevenue: round2(s.totalRevenue),
    netSales: round2(s.netSales),
    totalTransactions: s.totalTransactions,
    totalDiscount: round2(s.totalDiscount),
    averageBillValue: round2(s.averageBillValue),
  };
}

// ── Category sales (desserts, beverages, etc.) ───────────────────────────────
// Filters itemwise sales by category name (case-insensitive contains match).
export interface CategorySalesData {
  categoryName: string;
  items: { name: string; quantitySold: number; totalRevenue: number }[];
  totalQuantity: number;
  totalRevenue: number;
  totalTransactions: number;
}

export async function getCategorySales(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
  categoryName: string,
): Promise<CategorySalesData> {
  const data = await getItemwiseSalesData(tenantIds, startIST, endIST);
  const lowerCat = categoryName.toLowerCase();
  const matched = data.items.filter((it: any) => {
    const cat = String(it.category || '').toLowerCase();
    const reportCat = String(it.reportCategory || '').toLowerCase();
    return cat.includes(lowerCat) || reportCat.includes(lowerCat);
  });
  const totalQuantity = matched.reduce((s, it: any) => s + it.quantitySold, 0);
  const totalRevenue = round2(matched.reduce((s, it: any) => s + it.totalRevenue, 0));
  return {
    categoryName,
    items: matched.map((it: any) => ({
      name: it.name,
      quantitySold: it.quantitySold,
      totalRevenue: round2(it.totalRevenue),
    })),
    totalQuantity,
    totalRevenue,
    totalTransactions: matched.reduce((s, it: any) => s + (it.orderCount || 0), 0),
  };
}

// ── Outlet-wise performance ──────────────────────────────────────────────────
export interface OutletWisePerformance {
  outlets: {
    outletId: string;
    outletName: string;
    totalRevenue: number;
    totalTransactions: number;
    averageBillValue: number;
  }[];
  totalRevenue: number;
  totalTransactions: number;
  averageBillValue: number;
}

export async function getOutletWisePerformance(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
): Promise<OutletWisePerformance> {
  const orgPrisma = withOrgScope(undefined, tenantIds);
  const txnWhere = completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } });

  const [byOutletRows, outlets] = await Promise.all([
    orgPrisma.transaction.groupBy({
      by: ['restaurantId'],
      where: txnWhere,
      _sum: { grandTotal: true, amount: true },
      _count: { id: true },
    }),
    basePrisma.outlet.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true },
    }),
  ]);

  const nameMap = new Map(outlets.map(o => [o.id, o.name]));

  const outletRows = byOutletRows.map(r => {
    const revenue = round2(num(r._sum.grandTotal) || num(r._sum.amount));
    const count = r._count.id;
    return {
      outletId: r.restaurantId,
      outletName: nameMap.get(r.restaurantId) || 'Outlet',
      totalRevenue: revenue,
      totalTransactions: count,
      averageBillValue: count > 0 ? round2(revenue / count) : 0,
    };
  }).sort((a, b) => b.totalRevenue - a.totalRevenue);

  const totalRevenue = round2(outletRows.reduce((s, o) => s + o.totalRevenue, 0));
  const totalTransactions = outletRows.reduce((s, o) => s + o.totalTransactions, 0);
  const averageBillValue = totalTransactions > 0 ? round2(totalRevenue / totalTransactions) : 0;

  return { outlets: outletRows, totalRevenue, totalTransactions, averageBillValue };
}

// ── Today's Specials ─────────────────────────────────────────────────────────
// Returns per-special quantity/revenue, total specials revenue, total outlet
// revenue, specials' contribution %, and an outlet-wise breakdown.
export interface SpecialsSummary {
  specials: { name: string; quantitySold: number; revenue: number }[];
  totalSpecialsRevenue: number;
  totalOutletRevenue: number;
  specialsContributionPercent: number;
  byOutlet: {
    outletId: string;
    outletName: string;
    specialsRevenue: number;
    totalRevenue: number;
  }[];
}

export async function getSpecialsSummary(
  tenantIds: string[],
  startIST: Date,
  endIST: Date,
): Promise<SpecialsSummary> {
  const orgPrisma = withOrgScope(undefined, tenantIds);

  // 1. Specials order items (menuItem.isSpecial = true) for paid transactions.
  const specialItems = await orgPrisma.orderItem.findMany({
    where: {
      removedFromBill: false,
      quantity: { gt: 0 },
      menuItem: { isSpecial: true, isDeleted: false },
      order: {
        status: 'PAID',
        isDeleted: false,
        restaurantId: { in: tenantIds },
        transactions: {
          status: 'COMPLETED',
          paidAt: { gte: startIST, lte: endIST },
        },
      },
    },
    select: {
      quantity: true,
      price: true,
      menuItem: { select: { id: true, name: true, basePrice: true } },
      order: { select: { restaurantId: true } },
    },
  });

  // 2. Total outlet revenue (all completed transactions) for contribution %.
  const txnWhere = completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } });
  const [totalAgg, byOutletTxnRows, outlets] = await Promise.all([
    orgPrisma.transaction.aggregate({
      where: txnWhere,
      _sum: { grandTotal: true, amount: true },
    }),
    orgPrisma.transaction.groupBy({
      by: ['restaurantId'],
      where: txnWhere,
      _sum: { grandTotal: true, amount: true },
    }),
    basePrisma.outlet.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true },
    }),
  ]);

  const totalOutletRevenue = round2(num(totalAgg._sum.grandTotal) || num(totalAgg._sum.amount));
  const nameMap = new Map(outlets.map(o => [o.id, o.name]));

  // 3. Aggregate specials by item name.
  const specialMap = new Map<string, { quantitySold: number; revenue: number }>();
  // Per-outlet specials revenue
  const outletSpecials = new Map<string, number>();

  for (const it of specialItems) {
    const name = it.menuItem?.name || 'Unknown Special';
    const qty = Number(it.quantity || 0);
    const price = Number(it.price ?? it.menuItem?.basePrice ?? 0);
    const revenue = round2(qty * price);
    const existing = specialMap.get(name) || { quantitySold: 0, revenue: 0 };
    existing.quantitySold += qty;
    existing.revenue = round2(existing.revenue + revenue);
    specialMap.set(name, existing);

    const rid = it.order?.restaurantId;
    if (rid) {
      outletSpecials.set(rid, round2((outletSpecials.get(rid) || 0) + revenue));
    }
  }

  const specials = Array.from(specialMap.entries())
    .map(([name, v]) => ({ name, quantitySold: v.quantitySold, revenue: round2(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);

  const totalSpecialsRevenue = round2(specials.reduce((s, sp) => s + sp.revenue, 0));
  const specialsContributionPercent = totalOutletRevenue > 0
    ? round2((totalSpecialsRevenue / totalOutletRevenue) * 100)
    : 0;

  // 4. Outlet-wise breakdown (only outlets that the admin is authorized to see).
  const byOutlet = byOutletTxnRows.map(r => {
    const rid = r.restaurantId;
    const totalRevenue = round2(num(r._sum.grandTotal) || num(r._sum.amount));
    return {
      outletId: rid,
      outletName: nameMap.get(rid) || 'Outlet',
      specialsRevenue: round2(outletSpecials.get(rid) || 0),
      totalRevenue,
    };
  }).sort((a, b) => b.totalRevenue - a.totalRevenue);

  return {
    specials,
    totalSpecialsRevenue,
    totalOutletRevenue,
    specialsContributionPercent,
    byOutlet,
  };
}

export default {
  getDailySalesData,
  getItemwiseSalesData,
  getDiscountReportData,
  getAttendanceSummary,
  getPurchaseSummary,
  getTopSellingItems,
  getFloorStatus,
  getPaymentBreakdown,
  getWastageSummary,
  getLowStockAlerts,
  getPeriodComparison,
  getAovData,
  getAovComparison,
  getOrdersCount,
  getRevenueData,
  getCategorySales,
  getOutletWisePerformance,
  getSpecialsSummary,
};
