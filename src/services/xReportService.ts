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

// Auto-fill cash/card splits from paid Transaction rows for the given date
async function computeCashCardFromTransactions(restaurantId: string, reportDate: string) {
  const startOfDay = new Date(`${reportDate}T00:00:00+05:30`);
  const endOfDay = new Date(`${reportDate}T23:59:59+05:30`);

  const groups = await prisma.transaction.groupBy({
    by: ["method"],
    where: {
      restaurantId,
      paidAt: { gte: startOfDay, lte: endOfDay },
    },
    _sum: { amount: true, grandTotal: true },
  });

  let cashSales = 0;
  let cardSales = 0;

  for (const group of groups) {
    const sum = Number(group._sum.grandTotal ?? group._sum.amount ?? 0);
    const method = (group.method || "").toUpperCase();
    if (method === "CASH") {
      cashSales += sum;
    } else if (method === "CARD" || method === "UPI") {
      cardSales += sum;
    }
  }

  return {
    cashSales: round2(cashSales),
    cardSales: round2(cardSales),
  };
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

// Auto-fill expenditure amount from non-voided Expenditure rows for the given date
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
  const totalSales = round2(data.totalSales);
  const expenditureAmount = round2(data.expenditureAmount ?? 0);
  const parcelCounterSale = round2(data.parcelCounterSale ?? 0);
  const tipsAmount = round2(data.tipsAmount ?? 0);
  const balanceAmount = round2(totalSales - expenditureAmount);

  const { cashSales, cardSales } = await computeCashCardFromTransactions(restaurantId, reportDate);
  const cashAmount = round2(cashSales);
  const cardAmount = round2(cardSales);

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
      totalSales: new Prisma.Decimal(totalSales),
      expenditureAmount: new Prisma.Decimal(expenditureAmount),
      parcelCounterSale: new Prisma.Decimal(parcelCounterSale),
      tipsAmount: new Prisma.Decimal(tipsAmount),
      cardAmount: new Prisma.Decimal(cardAmount),
      cashAmount: new Prisma.Decimal(cashAmount),
      totalAmount: new Prisma.Decimal(balanceAmount),
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
      totalSales: new Prisma.Decimal(totalSales),
      expenditureAmount: new Prisma.Decimal(expenditureAmount),
      parcelCounterSale: new Prisma.Decimal(parcelCounterSale),
      tipsAmount: new Prisma.Decimal(tipsAmount),
      cardAmount: new Prisma.Decimal(cardAmount),
      cashAmount: new Prisma.Decimal(cashAmount),
      totalAmount: new Prisma.Decimal(balanceAmount),
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

  // Auto-seed: compute totalSales and expenditureAmount from transactions/expenditures but don't persist yet
  const [totalSales, expenditureAmount, paymentSplit] = await Promise.all([
    computeTotalSalesFromTransactions(restaurantId, reportDate),
    computeExpenditureAmountFromExpenditures(restaurantId, reportDate),
    computeCashCardFromTransactions(restaurantId, reportDate),
  ]);
  const { cashSales, cardSales } = paymentSplit;
  return {
    id: null,
    restaurantId,
    reportDate,
    totalSales: new Prisma.Decimal(totalSales),
    expenditureAmount: new Prisma.Decimal(expenditureAmount),
    parcelCounterSale: new Prisma.Decimal(0),
    tipsAmount: new Prisma.Decimal(0),
    cardAmount: new Prisma.Decimal(cardSales),
    cashAmount: new Prisma.Decimal(cashSales),
    totalAmount: new Prisma.Decimal(totalSales - expenditureAmount),
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
