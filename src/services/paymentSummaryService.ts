// ─────────────────────────────────────────────────────────────────────────────
// Payment Summary Service — Canonical accounting contract for a business day.
//
// Produces one stable PaymentSummary consumed by the X-report, Daily Balance
// Sheet, admin reports, print renderers, and edge parity tests. Enforces three
// named accounting invariants on every recovered completed transaction:
//
//   1. Bill Allocation Invariant:    cashBill + cardBill + upiBill + otherBill = grandTotal
//   2. Tip Allocation Invariant:     cashTip + cardTip + upiTip + otherTip    = tipAmount
//   3. Collection Conservation:      sum(bill allocations) + sum(tip allocations)
//                                     = grandTotal + tipAmount
//
// Legacy single-method rows are inferred from `method` + `grandTotal` + `tipAmount`.
// Legacy MIXED rows use stored cash/card bill portions and assign the bill
// remainder to Other; the historical tip tender is exposed as
// `unallocatedLegacyTips` rather than silently placed in Card/UPI.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import prisma from "../lib/prisma";
import { basePrisma, runWithExplicitTenantScope } from "../lib/prisma";
import { completedTxnWhere } from "../lib/transactionHelpers";
import { computeExpenditureAmountFromExpenditures } from "./xReportService";
import {
  computeExpenditureTotal,
  computeNonCashExpenditureTotal,
} from "./dailyBalanceSheetService";
import { ENTRY_TYPE, EXPENDITURE_STATUS, CASH_METHOD } from "../utils/constants";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function num(v: any): number {
  return Number(v ?? 0);
}

// ── Public contract ──────────────────────────────────────────────────────────

export interface PaymentMethodAllocations {
  cash: number;
  card: number;
  upi: number;
  other: number;
}

export interface PaymentInvariants {
  billAllocationValid: boolean;
  tipAllocationValid: boolean;
  collectionConservationValid: boolean;
}

export interface PaymentSummary {
  restaurantIds: string[];
  reportDate: string;
  sales: {
    total: number;            // sum(grandTotal) — restaurant revenue, excludes tips
    byMethod: PaymentMethodAllocations; // bill allocations by payment method
  };
  tips: {
    total: number;            // sum(tipAmount)
    byMethod: PaymentMethodAllocations; // tip allocations by payment method
    unallocatedLegacyTips: number; // historical MIXED tip tender that cannot be reconstructed
  };
  collections: PaymentMethodAllocations; // actual money received by method (bill + tip)
  expenditures: {
    total: number;            // EXPENSE + GROCERY + LIABILITY_PAYMENT (matches Daily Balance Sheet)
    xReportTotal: number;     // EXPENSE + GROCERY only (matches X-report)
    nonCash: number;          // expenditures with non-cash payment method
    cash: number;             // total - nonCash (only cash expenditures reduce physical cash)
  };
  tipsPaid: number;           // mandatory same-day cash payout = tips.total
  netCashMovement: number;    // cashCollected - cashExpenditures - tipsPaid
  expectedCash: number;       // alias for netCashMovement (used by X-report expected cash)
  sourceFingerprint: string;  // hash of the source set; detects late accounting changes
  invariants: PaymentInvariants;
  transactionCount: number;
}

// ── Per-transaction normalized allocation ────────────────────────────────────

export interface TransactionAllocations {
  transactionId: string;
  method: string;
  grandTotal: number;
  tipAmount: number;
  bill: PaymentMethodAllocations;
  tip: PaymentMethodAllocations;
  isLegacy: boolean;
  hasUnallocatedLegacyTip: boolean;
}

/**
 * Derive bill and tip allocations for a single completed transaction.
 *
 * Rules:
 * - New normalized rows: use explicit cashAmount/cardAmount/upiAmount/otherAmount
 *   and cashTipAmount/cardTipAmount/upiTipAmount/otherTipAmount. Validate the
 *   Bill Allocation Invariant; if it fails, fall back to method-based inference
 *   and flag the row.
 * - Legacy single-method rows (CASH/CARD/UPI/OTHER): assign the full grandTotal
 *   to that method's bill bucket and the full tipAmount to that method's tip
 *   bucket.
 * - Legacy MIXED rows: use stored cashAmount/cardAmount for bill portions,
 *   assign the bill remainder to Other. Tip tender cannot be reconstructed, so
 *   the full tipAmount is exposed as `hasUnallocatedLegacyTip` and assigned to
 *   the cash tip bucket only if cashTipAmount is explicitly stored; otherwise it
 *   is left out of the byMethod tip split and surfaced in `unallocatedLegacyTips`.
 */
export function deriveTransactionAllocations(txn: {
  id: string;
  method: string;
  grandTotal: any;
  amount?: any;
  tipAmount?: any;
  cashAmount?: any;
  cardAmount?: any;
  upiAmount?: any;
  otherAmount?: any;
  cashTipAmount?: any;
  cardTipAmount?: any;
  upiTipAmount?: any;
  otherTipAmount?: any;
}): TransactionAllocations {
  const method = String(txn.method || "").toUpperCase();
  const grandTotal = round2(num(txn.grandTotal) || num(txn.amount));
  const tipAmount = round2(num(txn.tipAmount));

  const cashBill = round2(num(txn.cashAmount));
  const cardBill = round2(num(txn.cardAmount));
  const upiBill = round2(num(txn.upiAmount));
  const otherBill = round2(num(txn.otherAmount));

  const cashTip = round2(num(txn.cashTipAmount));
  const cardTip = round2(num(txn.cardTipAmount));
  const upiTip = round2(num(txn.upiTipAmount));
  const otherTip = round2(num(txn.otherTipAmount));

  const hasExplicitBill = cashBill > 0 || cardBill > 0 || upiBill > 0 || otherBill > 0;
  const hasExplicitTip =
    cashTip > 0 || cardTip > 0 || upiTip > 0 || otherTip > 0;

  // New normalized rows: explicit bill allocations exist and satisfy the invariant.
  const billSum = round2(cashBill + cardBill + upiBill + otherBill);
  const billInvariantOk = hasExplicitBill && billSum === grandTotal;

  let bill: PaymentMethodAllocations;
  let tip: PaymentMethodAllocations;
  let isLegacy = false;
  let hasUnallocatedLegacyTip = false;

  if (billInvariantOk) {
    bill = { cash: cashBill, card: cardBill, upi: upiBill, other: otherBill };
  } else if (method === "MIXED") {
    // Legacy MIXED: cash/card bill portions are stored, remainder → Other.
    isLegacy = true;
    const remainder = round2(grandTotal - cashBill - cardBill);
    bill = {
      cash: cashBill,
      card: cardBill,
      upi: 0,
      other: Math.max(0, remainder),
    };
  } else if (method === "CASH" || method === "CARD" || method === "UPI" || method === "OTHER") {
    // Legacy single-method: full grandTotal to that method.
    isLegacy = true;
    bill = {
      cash: method === "CASH" ? grandTotal : 0,
      card: method === "CARD" ? grandTotal : 0,
      upi: method === "UPI" ? grandTotal : 0,
      other: method === "OTHER" ? grandTotal : 0,
    };
  } else if (hasExplicitBill) {
    // Unknown method but explicit allocations exist — trust them.
    bill = { cash: cashBill, card: cardBill, upi: upiBill, other: otherBill };
  } else {
    // Unknown method, no allocations — bucket as Other.
    isLegacy = true;
    bill = { cash: 0, card: 0, upi: 0, other: grandTotal };
  }

  // Tip allocation.
  const tipSum = round2(cashTip + cardTip + upiTip + otherTip);
  if (hasExplicitTip && tipSum === tipAmount) {
    tip = { cash: cashTip, card: cardTip, upi: upiTip, other: otherTip };
  } else if (method === "MIXED") {
    // Legacy MIXED tip tender cannot be reconstructed. If a cash tip portion was
    // explicitly stored, honor it; the remainder is unallocated legacy tip.
    isLegacy = true;
    if (tipAmount > 0) {
      hasUnallocatedLegacyTip = true;
    }
    tip = { cash: cashTip, card: 0, upi: 0, other: 0 };
  } else if (method === "CASH" || method === "CARD" || method === "UPI" || method === "OTHER") {
    isLegacy = true;
    tip = {
      cash: method === "CASH" ? tipAmount : 0,
      card: method === "CARD" ? tipAmount : 0,
      upi: method === "UPI" ? tipAmount : 0,
      other: method === "OTHER" ? tipAmount : 0,
    };
  } else if (hasExplicitTip) {
    tip = { cash: cashTip, card: cardTip, upi: upiTip, other: otherTip };
  } else {
    isLegacy = true;
    tip = { cash: 0, card: 0, upi: 0, other: 0 };
    if (tipAmount > 0) hasUnallocatedLegacyTip = true;
  }

  return {
    transactionId: txn.id,
    method,
    grandTotal,
    tipAmount,
    bill,
    tip,
    isLegacy,
    hasUnallocatedLegacyTip,
  };
}

// ── Source fingerprint ───────────────────────────────────────────────────────

/**
 * Build a stable hash of the source set (completed transactions + expenditures)
 * so a confirmed/finalized X-report snapshot can detect late accounting changes.
 */
export function buildSourceFingerprint(
  transactions: Array<{
    id: string;
    grandTotal: any;
    tipAmount?: any;
    method: string;
    paidAt?: any;
    cashAmount?: any;
    cardAmount?: any;
    upiAmount?: any;
    otherAmount?: any;
    cashTipAmount?: any;
    cardTipAmount?: any;
    upiTipAmount?: any;
    otherTipAmount?: any;
  }>,
  expenditures: Array<{ id: string; amount: any; status: string; entryType: string; paymentMethod?: string | null }>,
): string {
  // Deterministic sort by id so re-queries with different row order produce
  // the same fingerprint.
  const sortedTx = [...transactions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sortedExp = [...expenditures].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const txHash = createHash("sha256");
  for (const t of sortedTx) {
    // Include all accounting-relevant allocation fields so any change to a
    // bill or tip allocation invalidates the fingerprint.
    txHash.update(
      `${t.id}|${num(t.grandTotal)}|${num(t.tipAmount)}|${t.method}|${t.paidAt ?? ""}|` +
      `${num(t.cashAmount)}|${num(t.cardAmount)}|${num(t.upiAmount)}|${num(t.otherAmount)}|` +
      `${num(t.cashTipAmount)}|${num(t.cardTipAmount)}|${num(t.upiTipAmount)}|${num(t.otherTipAmount)}\n`,
    );
  }
  const expHash = createHash("sha256");
  for (const e of sortedExp) {
    expHash.update(`${e.id}|${num(e.amount)}|${e.status}|${e.entryType}|${e.paymentMethod ?? ""}\n`);
  }
  return createHash("sha256")
    .update(txHash.digest("hex") + "|" + expHash.digest("hex"))
    .digest("hex");
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Compute the canonical PaymentSummary for one or more outlets on a business
 * date. All consumers (X-report, Daily Balance Sheet, admin reports, print
 * renderers, edge parity tests) must call this function.
 */
export async function computePaymentSummary(
  restaurantId: string | string[],
  reportDate: string,
): Promise<PaymentSummary> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];
  const db = runWithExplicitTenantScope(ids);

  const [transactions, expenditures] = await Promise.all([
    db.transaction.findMany({
      where: completedTxnWhere(ids, { txnDate: reportDate }),
      select: {
        id: true,
        method: true,
        grandTotal: true,
        amount: true,
        tipAmount: true,
        cashAmount: true,
        cardAmount: true,
        upiAmount: true,
        otherAmount: true,
        cashTipAmount: true,
        cardTipAmount: true,
        upiTipAmount: true,
        otherTipAmount: true,
        paidAt: true,
      },
    }),
    db.expenditure.findMany({
      where: {
        expenditureDate: reportDate,
        status: { not: EXPENDITURE_STATUS.VOIDED },
        entryType: { in: [ENTRY_TYPE.EXPENSE, "GROCERY", ENTRY_TYPE.LIABILITY_PAYMENT] },
      },
      select: { id: true, amount: true, status: true, entryType: true, paymentMethod: true },
    }),
  ]);

  return buildPaymentSummaryFromRows(ids, reportDate, transactions, expenditures);
}

/**
 * Pure builder: takes already-loaded transaction and expenditure rows and
 * returns a PaymentSummary. Exposed so edge parity tests can compare cloud and
 * edge outputs from identical inputs without hitting the database.
 */
export function buildPaymentSummaryFromRows(
  restaurantIds: string[],
  reportDate: string,
  transactions: Array<any>,
  expenditures: Array<any>,
): PaymentSummary {
  let totalSales = 0;
  let totalTips = 0;
  let unallocatedLegacyTips = 0;

  const billByMethod: PaymentMethodAllocations = { cash: 0, card: 0, upi: 0, other: 0 };
  const tipByMethod: PaymentMethodAllocations = { cash: 0, card: 0, upi: 0, other: 0 };

  let billInvariantValid = true;
  let tipInvariantValid = true;
  let collectionConservationValid = true;

  for (const txn of transactions) {
    const alloc = deriveTransactionAllocations(txn);
    const grandTotal = alloc.grandTotal;
    const tipAmount = alloc.tipAmount;

    totalSales = round2(totalSales + grandTotal);
    totalTips = round2(totalTips + tipAmount);

    billByMethod.cash = round2(billByMethod.cash + alloc.bill.cash);
    billByMethod.card = round2(billByMethod.card + alloc.bill.card);
    billByMethod.upi = round2(billByMethod.upi + alloc.bill.upi);
    billByMethod.other = round2(billByMethod.other + alloc.bill.other);

    tipByMethod.cash = round2(tipByMethod.cash + alloc.tip.cash);
    tipByMethod.card = round2(tipByMethod.card + alloc.tip.card);
    tipByMethod.upi = round2(tipByMethod.upi + alloc.tip.upi);
    tipByMethod.other = round2(tipByMethod.other + alloc.tip.other);

    if (alloc.hasUnallocatedLegacyTip) {
      unallocatedLegacyTips = round2(unallocatedLegacyTips + tipAmount);
    }

    // Validate per-transaction invariants.
    const billSum = round2(alloc.bill.cash + alloc.bill.card + alloc.bill.upi + alloc.bill.other);
    const tipSum = round2(alloc.tip.cash + alloc.tip.card + alloc.tip.upi + alloc.tip.other);
    // Reject NaN/Infinity/negative in stored allocation fields.
    const allAllocValues = [alloc.bill.cash, alloc.bill.card, alloc.bill.upi, alloc.bill.other,
      alloc.tip.cash, alloc.tip.card, alloc.tip.upi, alloc.tip.other];
    if (allAllocValues.some(v => !Number.isFinite(v) || v < 0)) {
      billInvariantValid = false;
      collectionConservationValid = false;
    }
    if (billSum !== grandTotal) billInvariantValid = false;
    if (tipSum !== (alloc.hasUnallocatedLegacyTip ? 0 : tipAmount)) {
      // Legacy MIXED unallocated tips are expected; only flag non-legacy mismatches.
      if (!alloc.hasUnallocatedLegacyTip) tipInvariantValid = false;
    }
    if (round2(billSum + tipSum) !== round2(grandTotal + tipAmount)) {
      collectionConservationValid = false;
    }
  }

  // Collections = bill + tip by method (actual money received).
  const collections: PaymentMethodAllocations = {
    cash: round2(billByMethod.cash + tipByMethod.cash),
    card: round2(billByMethod.card + tipByMethod.card),
    upi: round2(billByMethod.upi + tipByMethod.upi),
    other: round2(billByMethod.other + tipByMethod.other),
  };

  // Expenditures.
  const xReportTotal = round2(
    expenditures
      .filter((e) => e.entryType === ENTRY_TYPE.EXPENSE || e.entryType === "GROCERY")
      .reduce((s, e) => s + num(e.amount), 0),
  );
  const total = round2(expenditures.reduce((s, e) => s + num(e.amount), 0));
  const nonCash = round2(
    expenditures
      .filter(
        (e) =>
          e.paymentMethod &&
          String(e.paymentMethod).toUpperCase() !== CASH_METHOD &&
          (e.paymentMethod || null) !== null,
      )
      .reduce((s, e) => s + num(e.amount), 0),
  );
  // Legacy expenditure rows with no payment method are treated as Cash.
  const cashExpenditures = round2(total - nonCash);

  // Mandatory same-day cash tip payout.
  const tipsPaid = totalTips;
  const netCashMovement = round2(collections.cash - cashExpenditures - tipsPaid);

  const sourceFingerprint = buildSourceFingerprint(
    transactions.map((t) => ({
      id: t.id,
      grandTotal: t.grandTotal,
      tipAmount: t.tipAmount,
      method: t.method,
      paidAt: t.paidAt,
      cashAmount: t.cashAmount,
      cardAmount: t.cardAmount,
      upiAmount: t.upiAmount,
      otherAmount: t.otherAmount,
      cashTipAmount: t.cashTipAmount,
      cardTipAmount: t.cardTipAmount,
      upiTipAmount: t.upiTipAmount,
      otherTipAmount: t.otherTipAmount,
    })),
    expenditures.map((e) => ({
      id: e.id,
      amount: e.amount,
      status: e.status,
      entryType: e.entryType,
      paymentMethod: e.paymentMethod,
    })),
  );

  return {
    restaurantIds,
    reportDate,
    sales: {
      total: round2(totalSales),
      byMethod: {
        cash: round2(billByMethod.cash),
        card: round2(billByMethod.card),
        upi: round2(billByMethod.upi),
        other: round2(billByMethod.other),
      },
    },
    tips: {
      total: round2(totalTips),
      byMethod: {
        cash: round2(tipByMethod.cash),
        card: round2(tipByMethod.card),
        upi: round2(tipByMethod.upi),
        other: round2(tipByMethod.other),
      },
      unallocatedLegacyTips: round2(unallocatedLegacyTips),
    },
    collections: {
      cash: round2(collections.cash),
      card: round2(collections.card),
      upi: round2(collections.upi),
      other: round2(collections.other),
    },
    expenditures: {
      total,
      xReportTotal,
      nonCash,
      cash: cashExpenditures,
    },
    tipsPaid,
    netCashMovement,
    expectedCash: netCashMovement,
    sourceFingerprint,
    invariants: {
      billAllocationValid: billInvariantValid,
      tipAllocationValid: tipInvariantValid,
      collectionConservationValid,
    },
    transactionCount: transactions.length,
  };
}

// ── Normalization helper for settlement writes ───────────────────────────────

export interface NormalizedAllocationsInput {
  paymentMethod: string;
  grandTotal: number;
  tipAmount?: number;
  // Optional explicit bill allocations (for MIXED / split payments).
  cashAmount?: number;
  cardAmount?: number;
  upiAmount?: number;
  otherAmount?: number;
  // Optional explicit tip allocations (cash tip on a card bill, etc.).
  cashTipAmount?: number;
  cardTipAmount?: number;
  upiTipAmount?: number;
  otherTipAmount?: number;
}

export interface NormalizedAllocations {
  method: string;
  cashAmount: number;
  cardAmount: number;
  upiAmount: number;
  otherAmount: number;
  cashTipAmount: number;
  cardTipAmount: number;
  upiTipAmount: number;
  otherTipAmount: number;
  billInvariantValid: boolean;
  tipInvariantValid: boolean;
}

/**
 * Normalize raw settlement input into explicit bill + tip allocations that
 * satisfy the named invariants. Used by every settlement write path so the
 * database always stores a consistent normalized shape.
 *
 * - Single-method payments: assign the full bill and tip to that method.
 * - MIXED payments: use provided cash/card/upi/other bill portions; if the
 *   remainder doesn't reconcile to grandTotal, assign the difference to Other.
 * - Tip allocations: use explicit per-method tip portions when provided;
 *   otherwise default the full tip to the primary payment method, unless the
 *   caller explicitly splits it.
 */
export function normalizeSettlementAllocations(
  input: NormalizedAllocationsInput,
): NormalizedAllocations {
  const method = String(input.paymentMethod || "").toUpperCase();
  const grandTotal = round2(num(input.grandTotal));
  const tipAmount = round2(num(input.tipAmount));

  // Reject invalid numeric inputs before any allocation logic runs.
  if (!Number.isFinite(grandTotal) || grandTotal < 0) {
    throw new Error(`Invalid grandTotal: ${input.grandTotal}`);
  }
  if (!Number.isFinite(tipAmount) || tipAmount < 0) {
    throw new Error(`Invalid tipAmount: ${input.tipAmount}`);
  }
  for (const [field, value] of Object.entries({
    cashAmount: input.cashAmount,
    cardAmount: input.cardAmount,
    upiAmount: input.upiAmount,
    otherAmount: input.otherAmount,
    cashTipAmount: input.cashTipAmount,
    cardTipAmount: input.cardTipAmount,
    upiTipAmount: input.upiTipAmount,
    otherTipAmount: input.otherTipAmount,
  })) {
    if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      throw new Error(`Invalid ${field}: ${value}`);
    }
  }

  let cashBill: number;
  let cardBill: number;
  let upiBill: number;
  let otherBill: number;

  if (method === "CASH") {
    cashBill = grandTotal;
    cardBill = 0;
    upiBill = 0;
    otherBill = 0;
  } else if (method === "CARD") {
    cashBill = 0;
    cardBill = grandTotal;
    upiBill = 0;
    otherBill = 0;
  } else if (method === "UPI") {
    cashBill = 0;
    cardBill = 0;
    upiBill = grandTotal;
    otherBill = 0;
  } else if (method === "OTHER") {
    cashBill = 0;
    cardBill = 0;
    upiBill = 0;
    otherBill = grandTotal;
  } else if (method === "MIXED") {
    cashBill = round2(num(input.cashAmount));
    cardBill = round2(num(input.cardAmount));
    upiBill = round2(num(input.upiAmount));
    // Reconcile remainder to Other so the Bill Allocation Invariant holds.
    const explicitSum = round2(cashBill + cardBill + upiBill);
    otherBill = round2(Math.max(0, grandTotal - explicitSum));
  } else {
    // Unknown method — bucket as Other.
    cashBill = 0;
    cardBill = 0;
    upiBill = 0;
    otherBill = grandTotal;
  }

  // Tip allocations.
  const hasExplicitTipSplit =
    num(input.cashTipAmount) > 0 ||
    num(input.cardTipAmount) > 0 ||
    num(input.upiTipAmount) > 0 ||
    num(input.otherTipAmount) > 0;

  let cashTip: number;
  let cardTip: number;
  let upiTip: number;
  let otherTip: number;

  if (hasExplicitTipSplit) {
    cashTip = round2(num(input.cashTipAmount));
    cardTip = round2(num(input.cardTipAmount));
    upiTip = round2(num(input.upiTipAmount));
    const explicitTipSum = round2(cashTip + cardTip + upiTip);
    otherTip = round2(Math.max(0, tipAmount - explicitTipSum));
  } else if (tipAmount > 0) {
    // Default the full tip to the primary payment method.
    cashTip = method === "CASH" ? tipAmount : 0;
    cardTip = method === "CARD" ? tipAmount : 0;
    upiTip = method === "UPI" ? tipAmount : 0;
    otherTip = method === "OTHER" || method === "MIXED" ? tipAmount : 0;
    // For MIXED with no explicit tip split, default the tip to cash (most common
    // case: customer leaves a cash tip on a mixed bill).
    if (method === "MIXED") {
      cashTip = tipAmount;
      cardTip = 0;
      upiTip = 0;
      otherTip = 0;
    }
  } else {
    cashTip = 0;
    cardTip = 0;
    upiTip = 0;
    otherTip = 0;
  }

  const billSum = round2(cashBill + cardBill + upiBill + otherBill);
  const tipSum = round2(cashTip + cardTip + upiTip + otherTip);

  return {
    method,
    cashAmount: cashBill,
    cardAmount: cardBill,
    upiAmount: upiBill,
    otherAmount: otherBill,
    cashTipAmount: cashTip,
    cardTipAmount: cardTip,
    upiTipAmount: upiTip,
    otherTipAmount: otherTip,
    billInvariantValid: billSum === grandTotal,
    tipInvariantValid: tipSum === tipAmount,
  };
}
