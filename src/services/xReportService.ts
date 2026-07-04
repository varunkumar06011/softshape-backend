// ─────────────────────────────────────────────────────────────────────────────
// X Report Service — Daily cashier X report with denomination tracking
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import logger from "../lib/logger";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Auto-fill totalSales from paid Transaction rows for the given date
async function computeTotalSalesFromTransactions(restaurantId: string, reportDate: string): Promise<number> {
  const startOfDay = new Date(`${reportDate}T00:00:00+05:30`);
  const endOfDay = new Date(`${reportDate}T23:59:59+05:30`);

  const result = await prisma.transaction.aggregate({
    where: {
      restaurantId,
      paidAt: { gte: startOfDay, lte: endOfDay },
    },
    _sum: { grandTotal: true, amount: true },
  });

  const total = Number(result._sum.grandTotal ?? result._sum.amount ?? 0);
  return round2(total);
}

// Auto-fill voucherAmount from non-voided Voucher rows for the given date
async function computeVoucherAmountFromVouchers(restaurantId: string, reportDate: string): Promise<number> {
  const result = await prisma.voucher.aggregate({
    where: {
      restaurantId,
      voucherDate: reportDate,
      status: { not: "VOIDED" },
    },
    _sum: { amount: true },
  });

  return round2(Number(result._sum.amount || 0));
}

// Upsert (create or update) the X report for a given date
export async function upsertXReport(
  restaurantId: string,
  reportDate: string,
  data: {
    totalSales: number;
    voucherAmount?: number;
    cardAmount?: number;
    cashAmount?: number;
    notes500?: number;
    notes200?: number;
    notes100?: number;
    notes50?: number;
    notes20?: number;
    notes10?: number;
  },
  createdBy?: string
) {
  const voucherAmount = round2(data.voucherAmount ?? 0);
  const cardAmount = round2(data.cardAmount ?? 0);
  const cashAmount = round2(data.cashAmount ?? 0);
  const totalAmount = round2(data.totalSales - voucherAmount);

  const notes500 = data.notes500 ?? 0;
  const notes200 = data.notes200 ?? 0;
  const notes100 = data.notes100 ?? 0;
  const notes50 = data.notes50 ?? 0;
  const notes20 = data.notes20 ?? 0;
  const notes10 = data.notes10 ?? 0;
  const cashFromNotes = round2(
    notes500 * 500 + notes200 * 200 + notes100 * 100 + notes50 * 50 + notes20 * 20 + notes10 * 10
  );

  const report = await prisma.xReport.upsert({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
    update: {
      totalSales: new Prisma.Decimal(round2(data.totalSales)),
      voucherAmount: new Prisma.Decimal(voucherAmount),
      cardAmount: new Prisma.Decimal(cardAmount),
      cashAmount: new Prisma.Decimal(cashAmount),
      totalAmount: new Prisma.Decimal(totalAmount),
      notes500,
      notes200,
      notes100,
      notes50,
      notes20,
      notes10,
      cashFromNotes: new Prisma.Decimal(cashFromNotes),
      createdBy: createdBy ?? null,
    },
    create: {
      restaurantId,
      reportDate,
      totalSales: new Prisma.Decimal(round2(data.totalSales)),
      voucherAmount: new Prisma.Decimal(voucherAmount),
      cardAmount: new Prisma.Decimal(cardAmount),
      cashAmount: new Prisma.Decimal(cashAmount),
      totalAmount: new Prisma.Decimal(totalAmount),
      notes500,
      notes200,
      notes100,
      notes50,
      notes20,
      notes10,
      cashFromNotes: new Prisma.Decimal(cashFromNotes),
      createdBy: createdBy ?? null,
    },
  });

  logger.info({ restaurantId, reportDate, reportId: report.id }, "[XReport] Upserted successfully");
  return report;
}

// List X reports for a date range
export async function listXReports(restaurantId: string, startDate: string, endDate: string) {
  return prisma.xReport.findMany({
    where: {
      restaurantId,
      reportDate: { gte: startDate, lte: endDate },
    },
    orderBy: { reportDate: "desc" },
  });
}

// Get a single X report by date, auto-seeding totalSales if it doesn't exist yet
export async function getXReport(restaurantId: string, reportDate: string) {
  const existing = await prisma.xReport.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
  });

  if (existing) return existing;

  // Auto-seed: compute totalSales and voucherAmount from transactions/vouchers but don't persist yet
  const [totalSales, voucherAmount] = await Promise.all([
    computeTotalSalesFromTransactions(restaurantId, reportDate),
    computeVoucherAmountFromVouchers(restaurantId, reportDate),
  ]);
  return {
    id: null,
    restaurantId,
    reportDate,
    totalSales: new Prisma.Decimal(totalSales),
    voucherAmount: new Prisma.Decimal(voucherAmount),
    cardAmount: new Prisma.Decimal(0),
    cashAmount: new Prisma.Decimal(0),
    totalAmount: new Prisma.Decimal(totalSales - voucherAmount),
    notes500: 0,
    notes200: 0,
    notes100: 0,
    notes50: 0,
    notes20: 0,
    notes10: 0,
    cashFromNotes: new Prisma.Decimal(0),
    createdBy: null,
    printed: false,
    printedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Mark the report as printed
export async function markXReportPrinted(restaurantId: string, reportDate: string) {
  return prisma.xReport.updateMany({
    where: { restaurantId, reportDate },
    data: { printed: true, printedAt: new Date() },
  });
}
