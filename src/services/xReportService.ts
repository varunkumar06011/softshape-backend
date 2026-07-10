// ─────────────────────────────────────────────────────────────────────────────
// X Report Service — Daily cashier X report with denomination tracking
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { basePrisma } from "../lib/prisma";
import logger from "../lib/logger";
import { completedTxnWhere } from "../lib/transactionHelpers";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Auto-fill totalSales from paid Transaction rows for the given business date
// Total Sales should NOT include tips - tips are separate from sales revenue
export async function computeTotalSalesFromTransactions(restaurantId: string, reportDate: string): Promise<number> {
  const result = await prisma.transaction.aggregate({
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    _sum: { grandTotal: true, amount: true },
  });

  const total = Number(result._sum?.grandTotal ?? result._sum?.amount ?? 0);
  return round2(total);
}

// Auto-fill cash/card/upi/other amounts from Transaction rows for the given business date, grouped by method.
// Tips are excluded from the breakdown to match total sales calculation (Grand Total - Tips).
// For MIXED transactions, cashAmount and cardAmount are split into their respective buckets,
// and the remainder (grandTotal - cashAmount - cardAmount) goes to otherSales.
export async function computePaymentBreakdownFromTransactions(restaurantId: string, reportDate: string): Promise<{ cashSales: number; cardSales: number; upiSales: number; otherSales: number }> {
  const rows = await prisma.transaction.groupBy({
    by: ["method"],
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    _sum: { grandTotal: true, amount: true, tipAmount: true },
  });

  let cashSales = 0;
  let cardSales = 0;
  let upiSales = 0;
  let otherSales = 0;
  for (const row of rows) {
    const grandTotal = Number(row._sum?.grandTotal ?? row._sum?.amount ?? 0);
    // grandTotal never includes tips (tips are stored separately as tipAmount),
    // so no tip subtraction is needed here.
    const value = grandTotal;
    if (row.method === "CASH") {
      cashSales += value;
    } else if (row.method === "CARD") {
      cardSales += value;
    } else if (row.method === "UPI") {
      upiSales += value;
    } else if (row.method === "MIXED") {
      // MIXED transactions are split: cashAmount → cashSales, cardAmount → cardSales,
      // remainder → otherSales. Fetch individual transactions to get per-txn splits.
      otherSales += value; // placeholder, will be corrected below
    } else {
      otherSales += value;
    }
  }

  // For MIXED transactions, fetch individual rows to split cash/card/other
  const mixedTxns = await prisma.transaction.findMany({
    where: completedTxnWhere(restaurantId, { txnDate: reportDate, method: "MIXED" }),
    select: { grandTotal: true, amount: true, cashAmount: true, cardAmount: true },
  });

  if (mixedTxns.length > 0) {
    // Remove the placeholder we added above
    let mixedOtherTotal = 0;
    for (const txn of mixedTxns) {
      const gt = Number(txn.grandTotal ?? txn.amount ?? 0);
      const cash = Number(txn.cashAmount ?? 0);
      const card = Number(txn.cardAmount ?? 0);
      cashSales += cash;
      cardSales += card;
      mixedOtherTotal += Math.max(0, gt - cash - card);
    }
    otherSales += mixedOtherTotal;
    // Subtract the full grandTotal placeholder we added in the groupBy loop
    const mixedGrandTotalSum = mixedTxns.reduce((sum, t) => sum + Number(t.grandTotal ?? t.amount ?? 0), 0);
    otherSales -= mixedGrandTotalSum;
    // Now otherSales has: (original otherSales without MIXED) + mixedOtherTotal
  }

  return { cashSales: round2(cashSales), cardSales: round2(cardSales), upiSales: round2(upiSales), otherSales: round2(otherSales) };
}

// Compute venue-wise sales breakdown from transactions by sectionTag
export async function computeVenueSalesFromTransactions(restaurantId: string, reportDate: string): Promise<{
  acBar: number;
  nonAcBar: number;
  familyWing: number;
  parcel: number;
  swiggy: number;
  zomato: number;
}> {
  const rows = await prisma.transaction.groupBy({
    by: ["platform", "sectionTag"],
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    _sum: { grandTotal: true, amount: true },
  });

  let acBar = 0;
  let nonAcBar = 0;
  let familyWing = 0;
  let parcel = 0;
  let swiggy = 0;
  let zomato = 0;

  for (const row of rows) {
    const value = Number(row._sum?.grandTotal ?? row._sum?.amount ?? 0);
    const platform = row.platform?.toUpperCase() || 'DIRECT';
    const sectionTag = row.sectionTag?.toLowerCase() || '';

    // Platform-based (Swiggy, Zomato)
    if (platform === 'SWIGGY') {
      swiggy += value;
    } else if (platform === 'ZOMATO') {
      zomato += value;
    } else {
      // SectionTag-based for direct orders
      if (sectionTag.includes('bar') || sectionTag.includes('pdr') || sectionTag.includes('conference') || sectionTag.includes('rooms')) {
        // AC Bar venues
        acBar += value;
      } else if (sectionTag.includes('gobox') || sectionTag.includes('bar-parcel')) {
        // Non-AC Bar parcel
        nonAcBar += value;
      } else if (sectionTag.includes('family') || sectionTag.includes('restaurant')) {
        // Family wing
        familyWing += value;
      } else if (sectionTag.includes('parcel')) {
        // Parcel counter
        parcel += value;
      } else {
        // Default to family/restaurant for unknown sections
        familyWing += value;
      }
    }
  }

  return {
    acBar: round2(acBar),
    nonAcBar: round2(nonAcBar),
    familyWing: round2(familyWing),
    parcel: round2(parcel),
    swiggy: round2(swiggy),
    zomato: round2(zomato),
  };
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
      entryType: { in: ["EXPENSE", "GROCERY", "LIABILITY_PAYMENT"] },
    },
    _sum: { amount: true },
  });

  return round2(Number(result._sum.amount || 0));
}

// Auto-fill tipsAmount from Transaction.tipAmount rows for the given business date
export async function computeTipsFromTransactions(restaurantId: string, reportDate: string): Promise<number> {
  const result = await prisma.transaction.aggregate({
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    _sum: { tipAmount: true },
  });

  return round2(Number(result._sum?.tipAmount || 0));
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
    upiAmount?: number;
    otherAmount?: number;
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

  // Use manual override if provided, otherwise auto-compute from transactions
  const allManual = data.cashAmount != null && data.cardAmount != null && data.upiAmount != null && data.otherAmount != null;
  const someManual = data.cashAmount != null || data.cardAmount != null || data.upiAmount != null || data.otherAmount != null;
  let cashAmount: number;
  let cardAmount: number;
  let upiAmount: number;
  let otherAmount: number;
  if (allManual) {
    cashAmount = round2(data.cashAmount!);
    cardAmount = round2(data.cardAmount!);
    upiAmount = round2(data.upiAmount!);
    otherAmount = round2(data.otherAmount!);
  } else {
    const breakdown = await computePaymentBreakdownFromTransactions(restaurantId, reportDate);
    cashAmount = data.cashAmount != null ? round2(data.cashAmount) : breakdown.cashSales;
    cardAmount = data.cardAmount != null ? round2(data.cardAmount) : breakdown.cardSales;
    upiAmount = data.upiAmount != null ? round2(data.upiAmount) : breakdown.upiSales;
    otherAmount = data.otherAmount != null ? round2(data.otherAmount) : breakdown.otherSales;
  }

  // Use provided tips if explicitly sent, otherwise auto-compute from transaction tips
  const tipsAmount = data.tipsAmount != null
    ? round2(data.tipsAmount)
    : await computeTipsFromTransactions(restaurantId, reportDate);

  // totalAmount = totalSales - expenditure - card - upi - other
  // This represents expected cash-in-hand (cash sales minus expenditures, minus non-cash payments)
  const totalAmount = round2(data.totalSales - expenditureAmount - cardAmount - upiAmount - otherAmount);

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
      upiAmount: new Prisma.Decimal(upiAmount),
      otherAmount: new Prisma.Decimal(otherAmount),
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
      upiAmount: new Prisma.Decimal(upiAmount),
      otherAmount: new Prisma.Decimal(otherAmount),
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

// Get a single X report by date, auto-seeding totalSales if it doesn't exist yet.
// For existing reports, only totalSales and expenditureAmount are self-healed.
// Payment fields (cash/card/upi/other/tips) are NOT overwritten — they may have been
// manually entered by the cashier. The frontend's "Refresh" button handles updating
// payment fields from transactions while respecting manual edits.
export async function getXReport(restaurantId: string, reportDate: string) {
  const existing = await prisma.xReport.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
  });

  if (existing) {
    // Self-heal only totalSales and expenditureAmount — these are auto-computed and
    // not manually editable. Payment fields (cash/card/upi/other/tips) are preserved
    // so cashier manual overrides are not lost on reload.
    try {
      const [freshTotalSales, freshExpenditureAmount] = await Promise.all([
        computeTotalSalesFromTransactions(restaurantId, reportDate),
        computeExpenditureAmountFromExpenditures(restaurantId, reportDate),
      ]);
      const storedTotalSales = round2(Number(existing.totalSales));
      const storedExpenditureAmount = round2(Number(existing.expenditureAmount));

      const totalSalesStale = storedTotalSales !== freshTotalSales;
      const expenditureStale = storedExpenditureAmount !== freshExpenditureAmount;

      if (totalSalesStale || expenditureStale) {
        logger.info(
          { restaurantId, reportDate, storedTotalSales, freshTotalSales, storedExpenditureAmount, freshExpenditureAmount },
          "[XReport] Self-healing stale totalSales and/or expenditure"
        );
        const updateData: any = {};
        if (totalSalesStale) {
          updateData.totalSales = new Prisma.Decimal(freshTotalSales);
        }
        if (expenditureStale) {
          updateData.expenditureAmount = new Prisma.Decimal(freshExpenditureAmount);
        }
        // Recalculate totalAmount = totalSales - expenditure - card - upi - other
        const effectiveTotalSales = totalSalesStale ? freshTotalSales : storedTotalSales;
        const effectiveExpenditure = expenditureStale ? freshExpenditureAmount : storedExpenditureAmount;
        const storedCard = round2(Number(existing.cardAmount));
        const storedUpi = round2(Number(existing.upiAmount));
        const storedOther = round2(Number(existing.otherAmount));
        const freshTotalAmount = round2(effectiveTotalSales - effectiveExpenditure - storedCard - storedUpi - storedOther);
        const storedTotalAmount = round2(Number(existing.totalAmount));
        if (freshTotalAmount !== storedTotalAmount) {
          updateData.totalAmount = new Prisma.Decimal(freshTotalAmount);
        }
        await prisma.xReport.update({
          where: { id: existing.id },
          data: updateData,
        });
        return {
          ...existing,
          ...(totalSalesStale ? { totalSales: new Prisma.Decimal(freshTotalSales) } : {}),
          ...(expenditureStale ? { expenditureAmount: new Prisma.Decimal(freshExpenditureAmount) } : {}),
          ...(freshTotalAmount !== storedTotalAmount ? { totalAmount: new Prisma.Decimal(freshTotalAmount) } : {}),
        };
      }
    } catch (err) {
      logger.warn({ err, restaurantId, reportDate }, "[XReport] Failed to self-heal");
    }
    return existing;
  }

  // Auto-seed: compute totalSales, expenditureAmount, cash/card breakdown, and tips from
  // transactions/expenditures but don't persist yet
  const [totalSales, expenditureAmount, breakdown, tipsSales] = await Promise.all([
    computeTotalSalesFromTransactions(restaurantId, reportDate),
    computeExpenditureAmountFromExpenditures(restaurantId, reportDate),
    computePaymentBreakdownFromTransactions(restaurantId, reportDate),
    computeTipsFromTransactions(restaurantId, reportDate),
  ]);
  return {
    id: null,
    restaurantId,
    reportDate,
    totalSales: new Prisma.Decimal(totalSales),
    expenditureAmount: new Prisma.Decimal(expenditureAmount),
    parcelCounterSale: new Prisma.Decimal(0),
    cardAmount: new Prisma.Decimal(breakdown.cardSales),
    cashAmount: new Prisma.Decimal(breakdown.cashSales),
    upiAmount: new Prisma.Decimal(breakdown.upiSales),
    otherAmount: new Prisma.Decimal(breakdown.otherSales),
    tipsAmount: new Prisma.Decimal(tipsSales),
    totalAmount: new Prisma.Decimal(round2(totalSales - expenditureAmount - breakdown.cardSales - breakdown.upiSales - breakdown.otherSales)),
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
    const expenditureAmount = await computeExpenditureAmountFromExpenditures(restaurantId, reportDate);

    const existing = await prisma.xReport.findUnique({
      where: { restaurantId_reportDate: { restaurantId, reportDate } },
    });
    if (!existing) {
      // Auto-create the X report with computed values so expenditures are reflected
      // even before the cashier opens the report for the day.
      const [totalSales, breakdown, tipsSales] = await Promise.all([
        computeTotalSalesFromTransactions(restaurantId, reportDate),
        computePaymentBreakdownFromTransactions(restaurantId, reportDate),
        computeTipsFromTransactions(restaurantId, reportDate),
      ]);
      const totalAmount = round2(totalSales - expenditureAmount - breakdown.cardSales - breakdown.upiSales - breakdown.otherSales);
      await prisma.xReport.create({
        data: {
          restaurantId,
          reportDate,
          totalSales: new Prisma.Decimal(totalSales),
          expenditureAmount: new Prisma.Decimal(expenditureAmount),
          cardAmount: new Prisma.Decimal(breakdown.cardSales),
          cashAmount: new Prisma.Decimal(breakdown.cashSales),
          upiAmount: new Prisma.Decimal(breakdown.upiSales),
          otherAmount: new Prisma.Decimal(breakdown.otherSales),
          tipsAmount: new Prisma.Decimal(tipsSales),
          totalAmount: new Prisma.Decimal(totalAmount),
          cashFromNotes: new Prisma.Decimal(0),
        },
      });
      return;
    }

    const totalAmount = round2(Number(existing.totalSales) - expenditureAmount - Number(existing.cardAmount) - Number(existing.upiAmount) - Number(existing.otherAmount));

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
