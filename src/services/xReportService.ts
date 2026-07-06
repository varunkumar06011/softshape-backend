// ─────────────────────────────────────────────────────────────────────────────
// X Report Service — Daily cashier X report with denomination tracking
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { basePrisma } from "../lib/prisma";
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

// Auto-fill cashAmount/cardAmount from Transaction rows for the given date, grouped by method.
// CASH -> cashSales, CARD + UPI -> cardSales.
async function computeCashCardFromTransactions(restaurantId: string, reportDate: string): Promise<{ cashSales: number; cardSales: number }> {
  const startOfDay = new Date(`${reportDate}T00:00:00+05:30`);
  const endOfDay = new Date(`${reportDate}T23:59:59+05:30`);

  const rows = await prisma.transaction.groupBy({
    by: ["method"],
    where: {
      restaurantId,
      paidAt: { gte: startOfDay, lte: endOfDay },
    },
    _sum: { grandTotal: true, amount: true },
  });

  let cashSales = 0;
  let cardSales = 0;
  for (const row of rows) {
    const value = Number(row._sum.grandTotal ?? row._sum.amount ?? 0);
    if (row.method === "CASH") {
      cashSales += value;
    } else if (row.method === "CARD" || row.method === "UPI") {
      cardSales += value;
    }
  }

  return { cashSales: round2(cashSales), cardSales: round2(cardSales) };
}

// Auto-fill expenditureAmount from non-voided Expenditure rows for the given date
export async function computeExpenditureAmountFromExpenditures(restaurantId: string | string[], reportDate: string): Promise<number> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];
  // Use basePrisma for multi-outlet aggregation; default prisma client enforces the
  // active outlet via tenant context, which would overwrite the restaurantId filter.
  const db = ids.length > 1 ? basePrisma : prisma;
  const result = await db.expenditure.aggregate({
    where: {
      restaurantId: { in: ids },
      expenditureDate: reportDate,
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
    expenditureAmount?: number;
    parcelCounterSale?: number;
    cardAmount?: number;
    cashAmount?: number;
    tipsAmount?: number;
    notes500?: number;
    notes200?: number;
    notes100?: number;
    notes50?: number;
    notes20?: number;
    notes10?: number;
  },
  createdBy?: string
) {
  const expenditureAmount = round2(data.expenditureAmount ?? 0);
  const parcelCounterSale = round2(data.parcelCounterSale ?? 0);
  const cardAmount = round2(data.cardAmount ?? 0);
  const cashAmount = round2(data.cashAmount ?? 0);
  const tipsAmount = round2(data.tipsAmount ?? 0);
  // Balance = Total Sale - Total Expenditure (parcelCounterSale is already part of
  // totalSales via Total Sale, so it no longer participates in this formula).
  const totalAmount = round2(data.totalSales - expenditureAmount);

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
      expenditureAmount: new Prisma.Decimal(expenditureAmount),
      parcelCounterSale: new Prisma.Decimal(parcelCounterSale),
      cardAmount: new Prisma.Decimal(cardAmount),
      cashAmount: new Prisma.Decimal(cashAmount),
      tipsAmount: new Prisma.Decimal(tipsAmount),
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
      expenditureAmount: new Prisma.Decimal(expenditureAmount),
      parcelCounterSale: new Prisma.Decimal(parcelCounterSale),
      cardAmount: new Prisma.Decimal(cardAmount),
      cashAmount: new Prisma.Decimal(cashAmount),
      tipsAmount: new Prisma.Decimal(tipsAmount),
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

  // Auto-seed: compute totalSales, expenditureAmount, and cash/card breakdown from
  // transactions/expenditures but don't persist yet
  const [totalSales, expenditureAmount, { cashSales, cardSales }] = await Promise.all([
    computeTotalSalesFromTransactions(restaurantId, reportDate),
    computeExpenditureAmountFromExpenditures(restaurantId, reportDate),
    computeCashCardFromTransactions(restaurantId, reportDate),
  ]);
  return {
    id: null,
    restaurantId,
    reportDate,
    totalSales: new Prisma.Decimal(totalSales),
    expenditureAmount: new Prisma.Decimal(expenditureAmount),
    parcelCounterSale: new Prisma.Decimal(0),
    cardAmount: new Prisma.Decimal(cardSales),
    cashAmount: new Prisma.Decimal(cashSales),
    tipsAmount: new Prisma.Decimal(0),
    totalAmount: new Prisma.Decimal(round2(totalSales - expenditureAmount)),
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

// Update only the expenditure side of an existing X report when an expenditure is
// created/verified/voided. Leaves manually-entered fields (totalSales, tips, notes)
// untouched so the cashier's counts are preserved.
export async function updateXReportExpenditureAmount(restaurantId: string, reportDate: string) {
  try {
    const existing = await prisma.xReport.findUnique({
      where: { restaurantId_reportDate: { restaurantId, reportDate } },
    });
    if (!existing) return;

    const expenditureAmount = await computeExpenditureAmountFromExpenditures(restaurantId, reportDate);
    const totalAmount = round2(Number(existing.totalSales) - expenditureAmount);

    await prisma.xReport.update({
      where: { id: existing.id },
      data: {
        expenditureAmount: new Prisma.Decimal(expenditureAmount),
        totalAmount: new Prisma.Decimal(totalAmount),
      },
    });
  } catch (err) {
    logger.warn({ err, restaurantId, reportDate }, "[XReport] Failed to sync expenditure amount");
  }
}

// Mark the report as printed
export async function markXReportPrinted(restaurantId: string, reportDate: string) {
  return prisma.xReport.updateMany({
    where: { restaurantId, reportDate },
    data: { printed: true, printedAt: new Date() },
  });
}
