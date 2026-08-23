// ─────────────────────────────────────────────────────────────────────────────
// X Report Service — Daily cashier X report with denomination tracking
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { basePrisma, runWithExplicitTenantScope } from "../lib/prisma";
import logger from "../lib/logger";
import { completedTxnWhere } from "../lib/transactionHelpers";
import { computePaymentSummary, type PaymentSummary } from "./paymentSummaryService";

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

  const total = Number(result._sum?.grandTotal ?? 0) || Number(result._sum?.amount ?? 0);
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
    const grandTotal = Number(row._sum?.grandTotal ?? 0) || Number(row._sum?.amount ?? 0);
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
      const gt = Number(txn.grandTotal ?? 0) || Number(txn.amount ?? 0);
      const cash = Number(txn.cashAmount ?? 0);
      const card = Number(txn.cardAmount ?? 0);
      cashSales += cash;
      cardSales += card;
      mixedOtherTotal += Math.max(0, gt - cash - card);
    }
    otherSales += mixedOtherTotal;
    // Subtract the full grandTotal placeholder we added in the groupBy loop
    const mixedGrandTotalSum = mixedTxns.reduce((sum, t) => sum + (Number(t.grandTotal ?? 0) || Number(t.amount ?? 0)), 0);
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
    const value = Number(row._sum?.grandTotal ?? 0) || Number(row._sum?.amount ?? 0);
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
// NOTE: LIABILITY_PAYMENT (vendor payments) is excluded here so that admin vendor
// payments do NOT affect the cashier's X-Report. The Daily Balance Sheet includes
// them separately via computeExpenditureTotal in dailyBalanceSheetService.
export async function computeExpenditureAmountFromExpenditures(restaurantId: string | string[], reportDate: string): Promise<number> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];
  // Use runWithExplicitTenantScope so the restaurantId filter is always injected,
  // even for multi-outlet queries. This prevents accidental cross-tenant data access.
  const db = runWithExplicitTenantScope(ids);
  const result = await db.expenditure.aggregate({
    where: {
      expenditureDate: reportDate,
      status: { not: "VOIDED" },
      entryType: { in: ["EXPENSE", "GROCERY"] },
    },
    _sum: { amount: true },
  });

  return round2(Number(result._sum.amount || 0));
}

// Auto-fill tipsAmount from Transaction.tipAmount rows for the given business date
// Also computes cash/card tip split based on payment method and cashTipAmount/cardTipAmount fields
export async function computeTipsFromTransactions(restaurantId: string, reportDate: string): Promise<{ totalTips: number; cashTips: number; cardTips: number }> {
  const rows = await prisma.transaction.findMany({
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    select: { tipAmount: true, cashTipAmount: true, cardTipAmount: true, method: true },
  });

  let totalTips = 0;
  let cashTips = 0;
  let cardTips = 0;
  for (const row of rows) {
    const tip = Number(row.tipAmount ?? 0);
    totalTips += tip;
    const cTip = Number(row.cashTipAmount ?? 0);
    const dTip = Number(row.cardTipAmount ?? 0);
    if (cTip > 0 || dTip > 0) {
      cashTips += cTip;
      cardTips += dTip;
    } else {
      // Fallback for legacy transactions without split tip fields
      if (row.method === 'CASH') cashTips += tip;
      else if (row.method === 'CARD') cardTips += tip;
    }
  }

  return {
    totalTips: round2(totalTips),
    cashTips: round2(cashTips),
    cardTips: round2(cardTips),
  };
}

// Upsert (create or update) the X report for a given date.
//
// New behavior (normalized payment model):
// - Derived totals (sales, payment breakdown, tips, cash expenditures, expected
//   cash, source fingerprint) are always recomputed from PaymentSummary.
// - The client may only submit denomination counts and explicit state-transition
//   actions. Manual Cash/Card/UPI/Other/sales/tip totals are no longer accepted.
// - tipsPaidAmount is always set to tipsAmount (mandatory same-day cash payout).
// - Net cash movement = cashCollected - cashExpenditures - tipsPaidAmount.
// - A DRAFT report may be updated freely. PAYOUT_CONFIRMED / FINALIZED reports
//   reject derived-total updates via the state transition functions below.
export async function upsertXReport(
  restaurantId: string,
  reportDate: string,
  data: {
    notes500?: number;
    notes200?: number;
    notes100?: number;
    notes50?: number;
    notes20?: number;
    notes10?: number;
  },
  createdBy?: string
) {
  const summary = await computePaymentSummary(restaurantId, reportDate);

  const notes500 = data.notes500 ?? 0;
  const notes200 = data.notes200 ?? 0;
  const notes100 = data.notes100 ?? 0;
  const notes50 = data.notes50 ?? 0;
  const notes20 = data.notes20 ?? 0;
  const notes10 = data.notes10 ?? 0;
  const cashFromNotes = round2(
    notes500 * 500 + notes200 * 200 + notes100 * 100 + notes50 * 50 + notes20 * 20 + notes10 * 10
  );

  // Only allow updates to a DRAFT report. PAYOUT_CONFIRMED / FINALIZED reports
  // are immutable snapshots that require explicit state-transition actions.
  const existing = await prisma.xReport.findUnique({
    where: { restaurantId_reportDate: { restaurantId, reportDate } },
  });
  if (existing && existing.reportStatus !== "DRAFT") {
    const err: any = new Error(
      `X Report is ${existing.reportStatus}. Use the confirm-payout or finalize endpoint to transition state.`
    );
    err.statusCode = 409;
    throw err;
  }

  const derivedFields = buildXReportDerivedFields(summary);

  const report = await prisma.xReport.upsert({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
    update: {
      ...derivedFields,
      tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
      cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
      expectedCash: new Prisma.Decimal(summary.expectedCash),
      sourceFingerprint: summary.sourceFingerprint,
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
      ...derivedFields,
      tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
      cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
      expectedCash: new Prisma.Decimal(summary.expectedCash),
      sourceFingerprint: summary.sourceFingerprint,
      reportStatus: "DRAFT",
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

// Build the derived X-report fields from a PaymentSummary.
function buildXReportDerivedFields(summary: PaymentSummary) {
  return {
    totalSales: new Prisma.Decimal(summary.sales.total),
    expenditureAmount: new Prisma.Decimal(summary.expenditures.xReportTotal),
    parcelCounterSale: new Prisma.Decimal(0),
    cardAmount: new Prisma.Decimal(summary.collections.card),
    cashAmount: new Prisma.Decimal(summary.collections.cash),
    upiAmount: new Prisma.Decimal(summary.collections.upi),
    otherAmount: new Prisma.Decimal(summary.collections.other),
    tipsAmount: new Prisma.Decimal(summary.tips.total),
    cashTipsAmount: new Prisma.Decimal(summary.tips.byMethod.cash),
    cardTipsAmount: new Prisma.Decimal(summary.tips.byMethod.card),
    upiTipsAmount: new Prisma.Decimal(summary.tips.byMethod.upi),
    otherTipsAmount: new Prisma.Decimal(summary.tips.byMethod.other),
    totalAmount: new Prisma.Decimal(summary.netCashMovement),
  };
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

// Get a single X report by date.
//
// For DRAFT reports: recompute derived totals from PaymentSummary so the
// cashier always sees live data. Denomination counts are preserved.
// For PAYOUT_CONFIRMED / FINALIZED reports: return the frozen snapshot as-is.
// If no report exists, return an unsaved DRAFT shape computed from PaymentSummary.
export async function getXReport(restaurantId: string, reportDate: string) {
  const existing = await prisma.xReport.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
  });

  if (existing) {
    // Frozen snapshots: PAYOUT_CONFIRMED and FINALIZED reports are immutable.
    if (existing.reportStatus !== "DRAFT") {
      return existing;
    }

    // DRAFT: recompute derived totals from PaymentSummary, preserve denominations.
    try {
      const summary = await computePaymentSummary(restaurantId, reportDate);
      const derivedFields = buildXReportDerivedFields(summary);
      const updated = await prisma.xReport.update({
        where: { id: existing.id },
        data: {
          ...derivedFields,
          tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
          cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
          expectedCash: new Prisma.Decimal(summary.expectedCash),
          sourceFingerprint: summary.sourceFingerprint,
        },
      });
      return updated;
    } catch (err) {
      logger.warn({ err, restaurantId, reportDate }, "[XReport] Failed to recompute DRAFT report");
      return existing;
    }
  }

  // Auto-seed: compute from PaymentSummary but don't persist yet.
  const summary = await computePaymentSummary(restaurantId, reportDate);
  const derivedFields = buildXReportDerivedFields(summary);
  return {
    id: null,
    restaurantId,
    reportDate,
    ...derivedFields,
    tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
    cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
    expectedCash: new Prisma.Decimal(summary.expectedCash),
    sourceFingerprint: summary.sourceFingerprint,
    reportStatus: "DRAFT",
    tipsPaidConfirmedAt: null,
    tipsPaidConfirmedBy: null,
    parcelCounterSale: new Prisma.Decimal(0),
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

// Update an existing DRAFT X report when an expenditure is created/verified/voided.
// Recomputes derived totals from PaymentSummary. PAYOUT_CONFIRMED / FINALIZED
// reports are immutable snapshots and are not touched.
export async function updateXReportExpenditureAmount(restaurantId: string, reportDate: string) {
  try {
    const existing = await prisma.xReport.findUnique({
      where: { restaurantId_reportDate: { restaurantId, reportDate } },
    });
    if (!existing) {
      // Auto-create the X report with computed values so expenditures are reflected
      // even before the cashier opens the report for the day.
      const summary = await computePaymentSummary(restaurantId, reportDate);
      const derivedFields = buildXReportDerivedFields(summary);
      await prisma.xReport.create({
        data: {
          restaurantId,
          reportDate,
          ...derivedFields,
          tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
          cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
          expectedCash: new Prisma.Decimal(summary.expectedCash),
          sourceFingerprint: summary.sourceFingerprint,
          reportStatus: "DRAFT",
          cashFromNotes: new Prisma.Decimal(0),
        },
      });
      return;
    }

    if (existing.reportStatus !== "DRAFT") {
      // Frozen snapshot — do not modify.
      return;
    }

    const summary = await computePaymentSummary(restaurantId, reportDate);
    const derivedFields = buildXReportDerivedFields(summary);
    await prisma.xReport.update({
      where: { id: existing.id },
      data: {
        ...derivedFields,
        tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
        cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
        expectedCash: new Prisma.Decimal(summary.expectedCash),
        sourceFingerprint: summary.sourceFingerprint,
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

// ── X-report finalization state machine ──────────────────────────────────────
// Legal transitions:
//   DRAFT → PAYOUT_CONFIRMED       (requires tips > 0 and cashier acknowledgement)
//   DRAFT → FINALIZED              (only when tips = 0)
//   PAYOUT_CONFIRMED → FINALIZED   (recompute/compare fingerprint + invariants)
// All transitions are persisted atomically with the snapshot fields.

function conflictError(message: string, statusCode = 409): Error & { statusCode: number } {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Transition a DRAFT X-report to PAYOUT_CONFIRMED.
 * Requires: tips > 0, valid PaymentSummary, cashier acknowledgement.
 * Persists the snapshot, source fingerprint, confirmation user/time, and status
 * atomically in one database transaction.
 */
export async function confirmXReportPayout(
  restaurantId: string,
  reportDate: string,
  userId?: string,
  denominationCounts?: {
    notes500?: number; notes200?: number; notes100?: number;
    notes50?: number; notes20?: number; notes10?: number;
  },
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.xReport.findUnique({
      where: { restaurantId_reportDate: { restaurantId, reportDate } },
    });
    if (!existing) {
      throw conflictError("X Report not found for this date", 404);
    }
    if (existing.reportStatus !== "DRAFT") {
      throw conflictError(`X Report is ${existing.reportStatus}, cannot confirm payout`);
    }

    const summary = await computePaymentSummary(restaurantId, reportDate);
    if (!summary.invariants.billAllocationValid || !summary.invariants.collectionConservationValid) {
      throw conflictError("Payment invariants violated — cannot confirm payout");
    }
    if (summary.tips.total <= 0) {
      throw conflictError("Tips are zero — use finalize directly");
    }
    // tipsPaidAmount must equal total tips (mandatory same-day payout).
    if (round2(summary.tipsPaid) !== round2(summary.tips.total)) {
      throw conflictError("Tips paid amount does not match total tips");
    }

    const derivedFields = buildXReportDerivedFields(summary);
    const notes = denominationCounts ?? {};
    const notes500 = notes.notes500 ?? existing.notes500 ?? 0;
    const notes200 = notes.notes200 ?? existing.notes200 ?? 0;
    const notes100 = notes.notes100 ?? existing.notes100 ?? 0;
    const notes50 = notes.notes50 ?? existing.notes50 ?? 0;
    const notes20 = notes.notes20 ?? existing.notes20 ?? 0;
    const notes10 = notes.notes10 ?? existing.notes10 ?? 0;
    const cashFromNotes = round2(
      notes500 * 500 + notes200 * 200 + notes100 * 100 + notes50 * 50 + notes20 * 20 + notes10 * 10
    );

    return tx.xReport.update({
      where: { id: existing.id },
      data: {
        ...derivedFields,
        tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
        cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
        expectedCash: new Prisma.Decimal(summary.expectedCash),
        sourceFingerprint: summary.sourceFingerprint,
        tipsPaidConfirmedAt: new Date(),
        tipsPaidConfirmedBy: userId ?? null,
        notes500, notes200, notes100, notes50, notes20, notes10,
        cashFromNotes: new Prisma.Decimal(cashFromNotes),
        reportStatus: "PAYOUT_CONFIRMED",
        reportVersion: { increment: 1 },
      },
    });
  }, { timeout: 15000, maxWait: 20000 });
}

/**
 * Transition a DRAFT or PAYOUT_CONFIRMED X-report to FINALIZED.
 * - DRAFT → FINALIZED: only when tips = 0.
 * - PAYOUT_CONFIRMED → FINALIZED: recompute fingerprint + invariants; reject if
 *   the source changed or payout data is missing/mismatched.
 * Persists the final snapshot atomically. After FINALIZED, the report is immutable.
 */
export async function finalizeXReport(
  restaurantId: string,
  reportDate: string,
  userId?: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.xReport.findUnique({
      where: { restaurantId_reportDate: { restaurantId, reportDate } },
    });
    if (!existing) {
      throw conflictError("X Report not found for this date", 404);
    }
    if (existing.reportStatus === "FINALIZED") {
      throw conflictError("X Report is already FINALIZED");
    }
    if (existing.reportStatus !== "DRAFT" && existing.reportStatus !== "PAYOUT_CONFIRMED") {
      throw conflictError(`X Report is ${existing.reportStatus}, cannot finalize`);
    }

    const summary = await computePaymentSummary(restaurantId, reportDate);

    if (!summary.invariants.billAllocationValid || !summary.invariants.collectionConservationValid) {
      throw conflictError("Payment invariants violated — cannot finalize");
    }

    if (existing.reportStatus === "DRAFT") {
      // DRAFT → FINALIZED only when tips = 0.
      if (summary.tips.total > 0) {
        throw conflictError("Tips are greater than zero — confirm payout before finalizing");
      }
    } else {
      // PAYOUT_CONFIRMED → FINALIZED: verify the source fingerprint hasn't changed.
      if (existing.sourceFingerprint && existing.sourceFingerprint !== summary.sourceFingerprint) {
        throw conflictError(
          "Source data changed after payout confirmation — reconfirm payout before finalizing"
        );
      }
      // Verify payout was confirmed.
      if (!existing.tipsPaidConfirmedAt) {
        throw conflictError("Payout was not confirmed — confirm payout before finalizing");
      }
      if (round2(Number(existing.tipsPaidAmount)) !== round2(summary.tips.total)) {
        throw conflictError("Tips paid amount does not match total tips");
      }
    }

    const derivedFields = buildXReportDerivedFields(summary);
    return tx.xReport.update({
      where: { id: existing.id },
      data: {
        ...derivedFields,
        tipsPaidAmount: new Prisma.Decimal(summary.tipsPaid),
        cashExpenditures: new Prisma.Decimal(summary.expenditures.cash),
        expectedCash: new Prisma.Decimal(summary.expectedCash),
        sourceFingerprint: summary.sourceFingerprint,
        reportStatus: "FINALIZED",
        reportVersion: { increment: 1 },
      },
    });
  }, { timeout: 15000, maxWait: 20000 });
}

/**
 * Reopen a FINALIZED X-report back to DRAFT. Requires explicit authorization.
 * Used when a late transaction must be corrected after finalization.
 */
export async function reopenXReport(
  restaurantId: string,
  reportDate: string,
  userId?: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.xReport.findUnique({
      where: { restaurantId_reportDate: { restaurantId, reportDate } },
    });
    if (!existing) {
      throw conflictError("X Report not found for this date", 404);
    }
    if (existing.reportStatus !== "FINALIZED") {
      throw conflictError("Only FINALIZED reports can be reopened");
    }
    return tx.xReport.update({
      where: { id: existing.id },
      data: {
        reportStatus: "DRAFT",
        reportVersion: { increment: 1 },
        tipsPaidConfirmedAt: null,
        tipsPaidConfirmedBy: null,
      },
    });
  }, { timeout: 15000, maxWait: 20000 });
}
