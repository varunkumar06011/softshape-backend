// ─────────────────────────────────────────────────────────────────────────────
// X Report Service — Daily cashier X report with denomination tracking
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { basePrisma, runWithExplicitTenantScope } from "../lib/prisma";
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

  const total = Number(result._sum?.grandTotal ?? 0) || Number(result._sum?.amount ?? 0);
  return round2(total);
}

// Auto-fill cash/card/upi/other amounts from Transaction rows for the given business date, grouped by method.
// Two-pass design (see task spec):
//   Pass 1 — base split: compute cashSales/cardSales/upiSales/otherSales from each transaction's own
//     amount fields (grandTotal for single-method, cashAmount/cardAmount/upiAmount for MIXED, routing
//     to otherSales when zero of cash/card/upi are populated). No tip math here.
//   Pass 2 — global tip reallocation: iterate all transactions, apply the eligibility rule to decide
//     whether each row's cardTipAmount/upiTipAmount contributes to totalCardTip/totalUpiTip, then apply
//     one flat adjustment: cardSales += totalCardTip; upiSales += totalUpiTip; cashSales -= (totalCardTip + totalUpiTip).
//
// Eligibility rule:
//   - Direct transaction (CASH/CARD/UPI): eligible iff method is CARD or UPI (CASH excluded — waiter keeps cash tips).
//   - MIXED transaction: a method is "selected" if its amount field is > 0 (legacy null upiAmount = not selected).
//     eligible = no CASH selected AND (CARD or UPI selected). This makes CASH+CARD, CASH+UPI, CASH+CARD+UPI
//     all ineligible (cash-sourced tip stays invisible to bucket math), CARD+UPI eligible, and 1-method
//     MIXED rows behave like direct transactions of that method. Zero-method MIXED/OTHER = ineligible.
//
// Invariant: cashSales + cardSales + upiSales + otherSales == sum(grandTotal) == totalSales
// (tips are only moved between buckets, never added on top).
export async function computePaymentBreakdownFromTransactions(restaurantId: string, reportDate: string): Promise<{ cashSales: number; cardSales: number; upiSales: number; otherSales: number }> {
  // ── Pass 1: base split (no tip math) ────────────────────────────────────────
  const rows = await prisma.transaction.groupBy({
    by: ["method"],
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    _sum: { grandTotal: true, amount: true },
  });

  let cashSales = 0;
  let cardSales = 0;
  let upiSales = 0;
  let otherSales = 0;
  for (const row of rows) {
    const grandTotal = Number(row._sum?.grandTotal ?? 0) || Number(row._sum?.amount ?? 0);
    // grandTotal never includes tips (tips are stored separately), so the base
    // allocation is just grandTotal per method. Tips are reallocated in Pass 2.
    if (row.method === "CASH") {
      cashSales += grandTotal;
    } else if (row.method === "CARD") {
      cardSales += grandTotal;
    } else if (row.method === "UPI") {
      upiSales += grandTotal;
    } else if (row.method === "MIXED") {
      // MIXED transactions are split: cashAmount → cashSales, cardAmount → cardSales,
      // upiAmount → upiSales, remainder → otherSales. Fetch individual transactions
      // to get per-txn splits (groupBy can't expose per-row amount fields).
      otherSales += grandTotal; // placeholder, corrected below
    } else {
      otherSales += grandTotal;
    }
  }

  // For MIXED transactions, fetch individual rows to split cash/card/upi/other.
  // upiAmount is included so UPI can be a third splittable component. Legacy rows
  // with null upiAmount are treated as "UPI not selected" (Number(null ?? 0) === 0),
  // so old cash+card-only rows compute exactly as before.
  const mixedTxns = await prisma.transaction.findMany({
    where: completedTxnWhere(restaurantId, { txnDate: reportDate, method: "MIXED" }),
    select: { grandTotal: true, amount: true, cashAmount: true, cardAmount: true, upiAmount: true },
  });

  if (mixedTxns.length > 0) {
    let mixedOtherTotal = 0;
    for (const txn of mixedTxns) {
      const gt = Number(txn.grandTotal ?? 0) || Number(txn.amount ?? 0);
      const cash = Number(txn.cashAmount ?? 0);
      const card = Number(txn.cardAmount ?? 0);
      const upi = Number(txn.upiAmount ?? 0);
      cashSales += cash;
      cardSales += card;
      upiSales += upi;
      mixedOtherTotal += Math.max(0, gt - cash - card - upi);
    }
    otherSales += mixedOtherTotal;
    // Subtract the full grandTotal placeholder we added in the groupBy loop.
    const mixedGrandTotalSum = mixedTxns.reduce((sum, t) => sum + (Number(t.grandTotal ?? 0) || Number(t.amount ?? 0)), 0);
    otherSales -= mixedGrandTotalSum;
    // Now otherSales has: (original otherSales without MIXED) + mixedOtherTotal
  }

  // ── Pass 2: global tip reallocation (eligibility-aware) ─────────────────────
  // Iterate all transactions for the period and, for each eligible row, accumulate
  // its cardTipAmount/upiTipAmount into totalCardTip/totalUpiTip. Then apply one
  // flat adjustment. This is mathematically equivalent to per-row adjustment (a flat
  // additive adjustment is linear) but never touches the Pass 1 base-split code.
  const allTxns = await prisma.transaction.findMany({
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    select: { method: true, cashAmount: true, cardAmount: true, upiAmount: true, cardTipAmount: true, upiTipAmount: true },
  });

  let totalCardTip = 0;
  let totalUpiTip = 0;
  for (const txn of allTxns) {
    const method = String(txn.method ?? "").toUpperCase();
    const cardTip = Number(txn.cardTipAmount ?? 0);
    const upiTip = Number(txn.upiTipAmount ?? 0);
    if (cardTip === 0 && upiTip === 0) continue;

    let eligible = false;
    if (method === "CARD" || method === "UPI") {
      // Direct transaction: eligible iff method is CARD or UPI.
      eligible = true;
    } else if (method === "MIXED") {
      // MIXED: eligible iff CASH not selected AND (CARD or UPI selected).
      // A method is "selected" if its amount field is > 0. Legacy null upiAmount
      // is treated as "UPI not selected" so old cash+card rows stay ineligible
      // only when cash is present — matching prior behavior exactly.
      const hasCash = Number(txn.cashAmount ?? 0) > 0;
      const hasCard = Number(txn.cardAmount ?? 0) > 0;
      const hasUpi = Number(txn.upiAmount ?? 0) > 0;
      eligible = !hasCash && (hasCard || hasUpi);
    }
    // CASH, OTHER, and zero-method MIXED rows are ineligible.

    if (eligible) {
      totalCardTip += cardTip;
      totalUpiTip += upiTip;
    }
  }

  // Reallocate eligible card/UPI tips from the cash bucket (drawer payout to waiter)
  // into their settlement buckets. Cash tips are NOT touched — the waiter keeps them
  // directly and they never pass through the drawer. This keeps the invariant
  // cash + card + upi + other == sum(grandTotal) intact because tips are only
  // moved between buckets, never added on top.
  cardSales += totalCardTip;
  upiSales += totalUpiTip;
  cashSales -= (totalCardTip + totalUpiTip);

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
export async function computeExpenditureAmountFromExpenditures(restaurantId: string | string[], reportDate: string): Promise<number> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];
  // Use runWithExplicitTenantScope so the restaurantId filter is always injected,
  // even for multi-outlet queries. This prevents accidental cross-tenant data access.
  const db = runWithExplicitTenantScope(ids);
  const result = await db.expenditure.aggregate({
    where: {
      expenditureDate: reportDate,
      status: { not: "VOIDED" },
      entryType: { in: ["EXPENSE", "GROCERY", "LIABILITY_PAYMENT"] },
    },
    _sum: { amount: true },
  });

  return round2(Number(result._sum.amount || 0));
}

// Auto-fill tipsAmount from Transaction.tipAmount rows for the given business date.
// totalTips = sum(cardTipAmount) + sum(upiTipAmount) across all transactions (direct + Other).
// Cash tips are excluded from totalTips (waiter keeps them, drawer never sees them) but are
// still tracked separately in cashTips for record-keeping. Legacy rows without split tip
// fields fall back to method-based classification.
export async function computeTipsFromTransactions(restaurantId: string, reportDate: string): Promise<{ totalTips: number; cashTips: number; cardTips: number; upiTips: number }> {
  const rows = await prisma.transaction.findMany({
    where: completedTxnWhere(restaurantId, { txnDate: reportDate }),
    select: { tipAmount: true, cashTipAmount: true, cardTipAmount: true, upiTipAmount: true, method: true },
  });

  let cashTips = 0;
  let cardTips = 0;
  let upiTips = 0;
  for (const row of rows) {
    const tip = Number(row.tipAmount ?? 0);
    const cTip = Number(row.cashTipAmount ?? 0);
    const dTip = Number(row.cardTipAmount ?? 0);
    const uTip = Number(row.upiTipAmount ?? 0);
    if (cTip > 0 || dTip > 0 || uTip > 0) {
      cashTips += cTip;
      cardTips += dTip;
      upiTips += uTip;
    } else {
      // Fallback for legacy transactions without split tip fields
      if (row.method === 'CASH') cashTips += tip;
      else if (row.method === 'CARD') cardTips += tip;
      else if (row.method === 'UPI') upiTips += tip;
    }
  }

  // totalTips excludes cash tips (they never pass through the drawer). cashTips is
  // kept as a separate record-keeping accumulator and is never subtracted anywhere.
  const totalTips = cardTips + upiTips;

  return {
    totalTips: round2(totalTips),
    cashTips: round2(cashTips),
    cardTips: round2(cardTips),
    upiTips: round2(upiTips),
  };
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
    cashTipsAmount?: number;
    cardTipsAmount?: number;
    upiTipsAmount?: number;
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
  const tipsData = data.tipsAmount != null
    ? { totalTips: round2(data.tipsAmount), cashTips: round2(data.cashTipsAmount ?? 0), cardTips: round2(data.cardTipsAmount ?? 0), upiTips: round2(data.upiTipsAmount ?? 0) }
    : await computeTipsFromTransactions(restaurantId, reportDate);
  const tipsAmount = tipsData.totalTips;
  const cashTipsAmount = tipsData.cashTips;
  const cardTipsAmount = tipsData.cardTips;
  const upiTipsAmount = tipsData.upiTips;

  // totalAmount (cash balance) = totalSales - card - expenditure
  // Matches the cashier UI's "Balance" display: Total Sales - Card - Expenditure.
  const totalAmount = round2(data.totalSales - cardAmount - expenditureAmount);

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
      cashTipsAmount: new Prisma.Decimal(cashTipsAmount),
      cardTipsAmount: new Prisma.Decimal(cardTipsAmount),
      upiTipsAmount: new Prisma.Decimal(upiTipsAmount),
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
      cashTipsAmount: new Prisma.Decimal(cashTipsAmount),
      cardTipsAmount: new Prisma.Decimal(cardTipsAmount),
      upiTipsAmount: new Prisma.Decimal(upiTipsAmount),
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
        // Recalculate totalAmount (cash balance) = totalSales - card - expenditure
        const effectiveTotalSales = totalSalesStale ? freshTotalSales : storedTotalSales;
        const effectiveExpenditure = expenditureStale ? freshExpenditureAmount : storedExpenditureAmount;
        const storedCard = round2(Number(existing.cardAmount));
        const freshTotalAmount = round2(effectiveTotalSales - storedCard - effectiveExpenditure);
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
  const [totalSales, expenditureAmount, breakdown, tipsData] = await Promise.all([
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
    tipsAmount: new Prisma.Decimal(tipsData.totalTips),
    cashTipsAmount: new Prisma.Decimal(tipsData.cashTips),
    cardTipsAmount: new Prisma.Decimal(tipsData.cardTips),
    upiTipsAmount: new Prisma.Decimal(tipsData.upiTips),
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
      const [totalSales, breakdown, tipsData] = await Promise.all([
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
          tipsAmount: new Prisma.Decimal(tipsData.totalTips),
          cashTipsAmount: new Prisma.Decimal(tipsData.cashTips),
          cardTipsAmount: new Prisma.Decimal(tipsData.cardTips),
          upiTipsAmount: new Prisma.Decimal(tipsData.upiTips),
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
