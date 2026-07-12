// Data fetchers for the Spire AI agent.
// Wraps the Phase 0 extracted report functions and adds direct queries
// for Attendance and DailyInventorySnapshot.

import { withOrgScope } from '../../lib/prisma';
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
};
