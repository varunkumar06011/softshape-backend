// Data fetchers for the Spire AI agent.
// Wraps the Phase 0 extracted report functions and adds direct queries
// for Attendance and DailyInventorySnapshot.

import prisma from '../../lib/prisma';
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
  const employees = await prisma.employee.findMany({
    where: { restaurantId: { in: tenantIds }, isActive: true },
    select: { id: true, name: true, role: true },
  });

  const attendance = await prisma.attendance.findMany({
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
  const snapshots = await prisma.dailyInventorySnapshot.findMany({
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

export default {
  getDailySalesData,
  getItemwiseSalesData,
  getDiscountReportData,
  getAttendanceSummary,
  getPurchaseSummary,
  getTopSellingItems,
};
