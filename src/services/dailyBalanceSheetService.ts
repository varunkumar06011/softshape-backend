// ─────────────────────────────────────────────────────────────────────────────
// Daily Balance Sheet Service — Per-outlet daily balance sheet with venue sales
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors xReportService.ts structure: round2 helper, compute-then-persist pattern.
// Once a sheet is saved, viewing it returns frozen numbers (no live recompute).
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { basePrisma, runWithExplicitTenantScope } from "../lib/prisma";
import logger from "../lib/logger";
import { computeExpenditureAmountFromExpenditures } from "./xReportService";
import { computePaymentSummary, type PaymentSummary } from "./paymentSummaryService";
import { createAuditLog } from "../lib/auditLog";
import { completedTxnWhere } from "../lib/transactionHelpers";
import { EXPENDITURE_STATUS, ENTRY_TYPE, CASH_METHOD, BALANCE_SHEET_STATUS } from "../utils/constants";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getAggregateBalanceSheetStorageId(organizationId: string): string {
  return `organization:${organizationId}`;
}

// ── Venue type → bucket mapping ──────────────────────────────────────────────
// Maps Venue.venueType to the four sales buckets used by the balance sheet.
const VENUE_TYPE_MAP: Record<string, string> = {
  AC_BAR: "acBar",
  NON_AC_BAR: "nonAcBar",
  FAMILY_WING: "familyWing",
  FAMILY_RESTAURANT: "familyWing",
  "FAMILY RESTAURANT": "familyWing",
  "FAMILY RESTARUNT": "familyWing", // tolerate common spelling typo
  PARCEL: "parcel",
  // Fallbacks for common naming variants
  AC: "acBar",
  NON_AC: "nonAcBar",
  FAMILY: "familyWing",
  TAKEAWAY: "parcel",
  TAKE_AWAY: "parcel",
  DINE_IN: "acBar", // default dine-in → AC Bar bucket
};

export interface VenueSales {
  acBar: number;
  nonAcBar: number;
  familyWing: number;
  parcel: number;
}

// ── computeVenueSales ────────────────────────────────────────────────────────
// Aggregate Transaction.grandTotal (fallback amount) for the business day (txnDate),
// grouped by joining Transaction.sectionId → Section.venueId → Venue.venueType.
// Bucketing is purely by venue type (with name-based fallbacks for generic types).
// Unrecognized venue types are bucketed with a warning, never thrown.
export async function computeVenueSales(restaurantId: string | string[], reportDate: string): Promise<VenueSales> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];

  // Use runWithExplicitTenantScope so the restaurantId filter is always injected,
  // even for multi-outlet queries. This prevents accidental cross-tenant data access.
  const db = runWithExplicitTenantScope(ids);

  const transactions = await db.transaction.findMany({
    where: completedTxnWhere(ids, { txnDate: reportDate }),
    select: {
      grandTotal: true,
      amount: true,
      sectionId: true,
      restaurantId: true,
      platform: true,
    },
  });

  // Partition: aggregator-platform transactions (Swiggy/Zomato) are handled
  // exclusively by computeAggregatorSales — they must NOT be bucketed into
  // venue sales, otherwise they'd be double-counted in Gross Sales.
  const AGGREGATOR_PLATFORMS = new Set(['SWIGGY', 'ZOMATO']);
  const venueTxns = transactions.filter((t: any) => {
    const platform = (t.platform || '').toUpperCase();
    return !AGGREGATOR_PLATFORMS.has(platform);
  });

  // Collect all sectionIds to batch-resolve venue types
  const sectionIds = [...new Set(venueTxns.map((t: any) => t.sectionId).filter(Boolean))] as string[];

  // Resolve sectionId → venueId
  const sections = await db.section.findMany({
    where: { id: { in: sectionIds } },
    select: { id: true, venueId: true },
  });

  const sectionVenueMap = new Map<string, string | null>();
  for (const s of sections) {
    sectionVenueMap.set(s.id, s.venueId);
  }

  // Resolve venueId → venueType
  const venueIds = [...new Set([...sectionVenueMap.values()].filter(Boolean))] as string[];
  const venues = await db.venue.findMany({
    where: { id: { in: venueIds } },
    select: { id: true, venueType: true, name: true },
  });

  const venueTypeMap = new Map<string, string>();
  const venueNameMap = new Map<string, string>();
  for (const v of venues) {
    venueTypeMap.set(v.id, v.venueType);
    if (v.name) venueNameMap.set(v.id, v.name);
  }

  // Load outlet names so we can detect family/restaurant outlets by name even when
  // the venue names are generic (e.g. "Main Dining" under "Vgrand Family Restaurant").
  const outletNameMap = new Map<string, string>();
  if (ids.length > 0) {
    const outlets = await basePrisma.outlet.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    for (const o of outlets) {
      if (o.name) outletNameMap.set(o.id, o.name);
    }
  }

  const buckets: VenueSales = { acBar: 0, nonAcBar: 0, familyWing: 0, parcel: 0 };

  for (const txn of venueTxns) {
    const sectionId = txn.sectionId;

    // Transactions without a sectionId have no venue mapping, but they still
    // represent real sales. Bucket them into acBar (the default bucket,
    // consistent with the unrecognized-venueType fallback below) so their
    // grandTotal is not silently lost from the venue sales total.
    if (!sectionId) {
      buckets.acBar += Number(txn.grandTotal ?? txn.amount ?? 0);
      continue;
    }

    const venueId = sectionVenueMap.get(sectionId);
    const venueType = venueId ? venueTypeMap.get(venueId) : null;
    const venueName = venueId ? venueNameMap.get(venueId) : undefined;

    let bucketKey = venueType ? VENUE_TYPE_MAP[venueType.toUpperCase()] : null;

    // For generic or missing venue types, infer the bucket from the venue name so
    // Family/Restaurant/Parcel/Bar venues that were backfilled as DINE_IN still map correctly.
    const isGenericType = !venueType || ['DINE_IN', 'DINING', 'UNKNOWN', 'DEFAULT'].includes(venueType.toUpperCase());
    if (venueName && (!bucketKey || isGenericType)) {
      const nameUpper = venueName.toUpperCase();
      if (nameUpper.includes('PARCEL') || nameUpper.includes('TAKEAWAY')) {
        bucketKey = 'parcel';
      } else if (nameUpper.includes('FAMILY') || nameUpper.includes('RESTAURANT')) {
        bucketKey = 'familyWing';
      } else if (nameUpper.includes('BAR') || nameUpper.includes('LOUNGE')) {
        bucketKey = 'acBar';
      }
    }

    // If the venue name is also generic, infer from the outlet name.
    const outletName = txn.restaurantId ? outletNameMap.get(txn.restaurantId) : undefined;
    if (outletName && !bucketKey) {
      const outletNameUpper = outletName.toUpperCase();
      if (outletNameUpper.includes('FAMILY') || outletNameUpper.includes('RESTAURANT')) {
        bucketKey = 'familyWing';
      } else if (outletNameUpper.includes('BAR') || outletNameUpper.includes('LOUNGE')) {
        bucketKey = 'acBar';
      } else if (outletNameUpper.includes('PARCEL') || outletNameUpper.includes('TAKEAWAY')) {
        bucketKey = 'parcel';
      }
    }

    if (!bucketKey) {
      if (venueType) {
        logger.warn(
          { restaurantId, reportDate, venueType, venueName, outletName, sectionId },
          "[DailyBalanceSheet] Unrecognized venueType — bucketing into acBar"
        );
      }
      buckets.acBar += Number(txn.grandTotal ?? txn.amount ?? 0);
      continue;
    }

    buckets[bucketKey as keyof VenueSales] += Number(txn.grandTotal ?? txn.amount ?? 0);
  }

  return {
    acBar: round2(buckets.acBar),
    nonAcBar: round2(buckets.nonAcBar),
    familyWing: round2(buckets.familyWing),
    parcel: round2(buckets.parcel),
  };
}

// ── computeExpenditureTotal ──────────────────────────────────────────────────
// Reuses xReportService's computeExpenditureAmountFromExpenditures (EXPENSE + GROCERY),
// then adds standalone LIABILITY_PAYMENT (vendor payments) — excluded from the X-Report
// so cashier is unaffected. Daily-purchase LIABILITY entries are NOT included here
// because they represent accounts payable (vendor outstanding), not actual expenditures.
// Only when a payment is made (LIABILITY_PAYMENT) does the amount become an expenditure.
export async function computeExpenditureTotal(restaurantId: string | string[], reportDate: string): Promise<number> {
  const xReportTotal = await computeExpenditureAmountFromExpenditures(restaurantId, reportDate);
  const vendorPaymentTotal = await computeVendorPaymentExpenditureTotal(restaurantId, reportDate);
  return round2(xReportTotal + vendorPaymentTotal);
}

// ── computeVendorPaymentExpenditureTotal ─────────────────────────────────────
// Sums non-voided LIABILITY_PAYMENT expenditures for the date.
// These include:
// - Standalone vendor payments (linked via linkedVendorId, created by POST /api/vendors/:id/payments)
// - PO payments (linked via linkedPurchaseOrderPaymentId, created by POST /api/purchase-orders/:id/payments)
export async function computeVendorPaymentExpenditureTotal(restaurantId: string | string[], reportDate: string): Promise<number> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];
  const result = await basePrisma.expenditure.aggregate({
    where: {
      restaurantId: { in: ids },
      expenditureDate: reportDate,
      status: { not: EXPENDITURE_STATUS.VOIDED },
      entryType: ENTRY_TYPE.LIABILITY_PAYMENT,
    },
    _sum: { amount: true },
  });
  return round2(Number(result._sum.amount || 0));
}

// ── computeDailyPurchaseExpenditureTotal ─────────────────────────────────────
// Sums non-voided Expenditure rows linked to DailyPurchaseVendorExpenditure for the date.
// These have entryType = "LIABILITY" and are excluded from the X-Report filter.
export async function computeDailyPurchaseExpenditureTotal(restaurantId: string | string[], reportDate: string): Promise<number> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];
  const mappings = await basePrisma.dailyPurchaseVendorExpenditure.findMany({
    where: { date: reportDate, restaurantId: { in: ids } },
    include: { expenditure: { select: { amount: true, status: true } } },
  });
  const total = mappings
    .filter((m: any) => m.expenditure && m.expenditure.status !== "VOIDED")
    .reduce((sum: number, m: any) => sum + Number(m.expenditure.amount), 0);
  return round2(total);
}

// ── computeNonCashExpenditureTotal ────────────────────────────────────────────
// Sums non-voided LIABILITY_PAYMENT expenditures (vendor payments) with non-cash
// payment methods. These are actual payments but not in cash, so they don't reduce
// the closing cash balance. Daily-purchase LIABILITY entries are NOT included because
// they are accounts payable, not expenditures.
export async function computeNonCashExpenditureTotal(restaurantId: string | string[], reportDate: string): Promise<number> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];

  // Standalone LIABILITY_PAYMENT expenditures (vendor + PO payments) with non-cash methods
  const standalonePayments = await basePrisma.expenditure.findMany({
    where: {
      restaurantId: { in: ids },
      expenditureDate: reportDate,
      entryType: ENTRY_TYPE.LIABILITY_PAYMENT,
      status: { not: EXPENDITURE_STATUS.VOIDED },
      paymentMethod: { not: CASH_METHOD },
    },
    select: { amount: true },
  });
  const standaloneTotal = standalonePayments.reduce(
    (sum: number, e: any) => sum + Number(e.amount),
    0
  );

  return round2(standaloneTotal);
}

// ── computeAggregatorSales ────────────────────────────────────────────────────
// Compute Swiggy and Zomato sales from transactions based on platform field.
export async function computeAggregatorSales(restaurantId: string | string[], reportDate: string): Promise<{ swiggy: number; zomato: number }> {
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];
  const db: any = Array.isArray(restaurantId) ? basePrisma : prisma;

  const transactions = await db.transaction.findMany({
    where: completedTxnWhere(ids, { txnDate: reportDate }),
    select: {
      grandTotal: true,
      amount: true,
      platform: true,
    },
  });

  let swiggy = 0;
  let zomato = 0;

  for (const txn of transactions) {
    const amount = Number(txn.grandTotal ?? txn.amount ?? 0);
    const platform = (txn.platform || '').toUpperCase();
    
    if (platform === 'SWIGGY') {
      swiggy += amount;
    } else if (platform === 'ZOMATO') {
      zomato += amount;
    }
  }

  return {
    swiggy: round2(swiggy),
    zomato: round2(zomato),
  };
}

// ── calculateRunningBalance (pure function) ──────────────────────────────────
// No DB access — independently testable. Returns closing balance + intermediate steps.
export interface AdjustmentInput {
  label: string;
  amount: number;
  sign: "PLUS" | "MINUS";
  narration?: string | null;
  sortOrder: number;
}

export interface BalanceSteps {
  openingBalance: number;
  afterSales: number;
  afterExpenditures: number;
  afterAdjustments: number;
  closingBalance: number;
  steps: { label: string; value: number }[];
}

export function calculateRunningBalance(
  openingBalance: number,
  sales: {
    acBar: number;
    nonAcBar: number;
    familyWing: number;
    parcel: number;
    swiggy: number;
    zomato: number;
  },
  totalExpenditures: number,
  adjustments: AdjustmentInput[],
  totalSalesOverride?: number | null,
  totalExpendituresOverride?: number | null,
  nonCashExpenditures?: number,
  paymentSummary?: {
    cashCollected: number;
    cardCollected: number;
    upiCollected: number;
    otherCollected: number;
    totalTips: number;
    tipsPaid: number;
    cashExpenditures: number;
  } | null,
): BalanceSteps {
  const ob = round2(openingBalance);

  // Cash sales (in-hand cash)
  const cashSales =
    round2(sales.acBar) +
    round2(sales.nonAcBar) +
    round2(sales.familyWing) +
    round2(sales.parcel);

  // Aggregator sales (settled later, not cash-in-hand)
  const swiggy = round2(sales.swiggy);
  const zomato = round2(sales.zomato);
  const aggregatorSales = round2(swiggy + zomato);

  // Total sales for display (includes aggregators) — override if provided
  const totalSales = totalSalesOverride != null
    ? round2(totalSalesOverride)
    : round2(cashSales + aggregatorSales);

  // Effective expenditures — override if provided
  const effectiveExpenditures = totalExpendituresOverride != null
    ? round2(totalExpendituresOverride)
    : round2(totalExpenditures);

  // Non-cash expenditures are only carved out when no manual override is set.
  // When an override is active, the admin is responsible for the full number.
  const nonCash = (totalExpendituresOverride == null && nonCashExpenditures != null)
    ? round2(nonCashExpenditures)
    : 0;
  const cashExpenditures = round2(effectiveExpenditures - nonCash);

  // When a PaymentSummary is available, the closing balance is computed from
  // actual cash collected (bill + tip) minus cash expenditures minus mandatory
  // same-day tip payout. This replaces the legacy model that treated all venue
  // sales as cash-in-hand.
  if (paymentSummary) {
    const cashCollected = round2(paymentSummary.cashCollected);
    const tipsPaid = round2(paymentSummary.tipsPaid);
    const cashExpendituresFromSummary = round2(paymentSummary.cashExpenditures);

    // Step-by-step calculation:
    // 1. Opening Balance + Cash Collected (actual money in drawer)
    const afterCashCollected = round2(ob + cashCollected);
    // 2. Minus Cash Expenditures
    const afterExpendituresStep = round2(afterCashCollected - cashExpendituresFromSummary);
    // 3. Minus Tips Paid (mandatory same-day cash payout)
    const afterTipsPaid = round2(afterExpendituresStep - tipsPaid);

    const steps: { label: string; value: number }[] = [
      { label: "Opening Balance", value: ob },
      { label: `+ Cash Collected (₹${cashCollected})`, value: afterCashCollected },
      { label: `- Cash Expenditures (₹${cashExpendituresFromSummary})`, value: afterExpendituresStep },
      { label: `- Tips Paid (₹${tipsPaid})`, value: afterTipsPaid },
    ];

    // Sort adjustments by sortOrder, apply sequentially
    const sorted = [...adjustments].sort((a, b) => a.sortOrder - b.sortOrder);
    let running = afterTipsPaid;
    for (const adj of sorted) {
      const amt = round2(adj.amount);
      if (adj.sign === "PLUS") {
        running = round2(running + amt);
      } else {
        running = round2(running - amt);
      }
      steps.push({ label: `${adj.sign === "PLUS" ? "+" : "−"} ${adj.label} (₹${amt})`, value: running });
    }

    return {
      openingBalance: ob,
      afterSales: afterTipsPaid,
      afterExpenditures: afterExpendituresStep,
      afterAdjustments: running,
      closingBalance: running,
      steps,
    };
  }

  // Legacy fallback (no PaymentSummary): preserve the original calculation so
  // historical sheets remain readable under their old semantics.
  // Step-by-step calculation:
  // 1. Opening Balance + Total Sales
  const afterTotalSales = round2(ob + totalSales);
  // 2. Minus Aggregator Sales (Swiggy + Zomato)
  const afterAggregatorDeduction = round2(afterTotalSales - aggregatorSales);
  // 3. Minus Cash Expenditures (total minus non-cash carve-out)
  const afterExpenditures = round2(afterAggregatorDeduction - cashExpenditures);

  // Sort adjustments by sortOrder, apply sequentially
  const sorted = [...adjustments].sort((a, b) => a.sortOrder - b.sortOrder);

  const steps: { label: string; value: number }[] = [
    { label: "Opening Balance", value: ob },
    { label: `+ Total Sales (₹${totalSales})`, value: afterTotalSales },
    { label: `- Swiggy + Zomato (₹${aggregatorSales})`, value: afterAggregatorDeduction },
    { label: `- Expenditure (₹${effectiveExpenditures}${nonCash > 0 ? `, cash ₹${cashExpenditures}` : ''})`, value: afterExpenditures },
  ];

  let running = afterExpenditures;
  for (const adj of sorted) {
    const amt = round2(adj.amount);
    if (adj.sign === "PLUS") {
      running = round2(running + amt);
    } else {
      running = round2(running - amt);
    }
    steps.push({ label: `${adj.sign === "PLUS" ? "+" : "−"} ${adj.label} (₹${amt})`, value: running });
  }

  return {
    openingBalance: ob,
    afterSales: afterAggregatorDeduction,
    afterExpenditures,
    afterAdjustments: running,
    closingBalance: running,
    steps,
  };
}

// ── getOrSeedBalanceSheet ────────────────────────────────────────────────────
// If a saved row exists, return it exactly as saved (frozen numbers).
// If not, compute fresh and return an unsaved shape (id: null).
export async function getOrSeedBalanceSheet(restaurantId: string, reportDate: string) {
  const existing = await basePrisma.dailyBalanceSheet.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
      bankCollections: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (existing) return existing;

  // Auto-seed: compute venue sales + expenditure total + aggregator sales, pull openingBalance from
  // the most recent prior saved sheet — don't persist yet.
  // Also carry forward bank names from the most recent prior sheet (amounts start at 0).
  const [venueSales, totalExpenditures, aggregatorSales, priorSheet, priorBanks] = await Promise.all([
    computeVenueSales(restaurantId, reportDate),
    computeExpenditureTotal(restaurantId, reportDate),
    computeAggregatorSales(restaurantId, reportDate),
    basePrisma.dailyBalanceSheet.findFirst({
      where: {
        restaurantId,
        reportDate: { lt: reportDate },
        closingBalance: { not: null },
      },
      orderBy: { reportDate: "desc" },
      select: { reportDate: true, closingBalance: true },
    }),
    basePrisma.bankCollection.findMany({
      where: {
        dailyBalanceSheet: {
          restaurantId,
          reportDate: { lt: reportDate },
        },
      },
      distinct: ["bankName"],
      orderBy: { bankName: "asc" },
      select: { bankName: true },
    }),
  ]);

  const openingBalance = priorSheet ? Number(priorSheet.closingBalance) : 0;
  logger.info(
    { restaurantId, reportDate, priorDate: priorSheet?.reportDate, priorClosing: priorSheet?.closingBalance, openingBalance, carriedBankNames: priorBanks.map(b => b.bankName) },
    "[DailyBalanceSheet] Seeded opening balance and bank names from prior sheet"
  );

  // Seed bank collections: carry forward names only, amounts start at 0
  const seededBankCollections = priorBanks.map((b, i) => ({
    id: null,
    bankName: b.bankName,
    amount: new Prisma.Decimal(0),
    sortOrder: i,
  }));

  return {
    id: null,
    restaurantId,
    reportDate,
    openingBalance: new Prisma.Decimal(openingBalance),
    acBarSaleComputed: new Prisma.Decimal(venueSales.acBar),
    acBarSaleOverride: null,
    nonAcBarSaleComputed: new Prisma.Decimal(venueSales.nonAcBar),
    nonAcBarSaleOverride: null,
    familyWingSaleComputed: new Prisma.Decimal(venueSales.familyWing),
    familyWingSaleOverride: null,
    parcelSaleComputed: new Prisma.Decimal(venueSales.parcel),
    parcelSaleOverride: null,
    totalSalesOverride: null,
    swiggySale: new Prisma.Decimal(aggregatorSales.swiggy),
    zomatoSale: new Prisma.Decimal(aggregatorSales.zomato),
    totalExpenditures: new Prisma.Decimal(totalExpenditures),
    totalExpendituresOverride: null,
    closingBalance: null,
    status: "DRAFT",
    createdBy: null,
    submittedBy: null,
    submittedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    adjustments: [],
    bankCollections: seededBankCollections,
  };
}

// ── getOrSeedAggregateBalanceSheet ───────────────────────────────────────────
// Returns a synthetic balance sheet for the "All Outlets" admin view.
// Sums saved sheets when available; otherwise computes fresh across all outlets.
export async function getOrSeedAggregateBalanceSheet(
  tenantIds: string[],
  reportDate: string,
  organizationId?: string
) {
  if (organizationId) {
    const aggregateSheet = await basePrisma.dailyBalanceSheet.findUnique({
      where: {
        restaurantId_reportDate: {
          restaurantId: getAggregateBalanceSheetStorageId(organizationId),
          reportDate,
        },
      },
      include: { adjustments: { orderBy: { sortOrder: "asc" } }, bankCollections: { orderBy: { sortOrder: "asc" } } },
    });
    if (aggregateSheet) return { ...aggregateSheet, restaurantId: "all" };
  }

  const savedSheets = await basePrisma.dailyBalanceSheet.findMany({
    where: { restaurantId: { in: tenantIds }, reportDate },
    include: { adjustments: true },
  });

  const sum = (arr: any[]) => arr.reduce((s, x) => s + Number(x || 0), 0);

  if (savedSheets.length > 0) {
    // For the aggregate view, recompute venue sales from live transactions so
    // that stale computed values in DRAFT sheets don't block fresh data.
    // Manual overrides (e.g. nonAcBarSaleOverride) are still preserved.
    const savedOutletIds = new Set(savedSheets.map((s) => s.restaurantId));
    const unsavedIds = tenantIds.filter((id) => !savedOutletIds.has(id));

    const [totalExpenditures, unsavedVenueSales, unsavedAggregatorSales] = await Promise.all([
      computeExpenditureTotal(tenantIds, reportDate),
      unsavedIds.length > 0
        ? computeVenueSales(unsavedIds, reportDate)
        : { acBar: 0, nonAcBar: 0, familyWing: 0, parcel: 0 },
      unsavedIds.length > 0
        ? computeAggregatorSales(unsavedIds, reportDate)
        : { swiggy: 0, zomato: 0 },
    ]);
    const unsavedSwiggy = unsavedAggregatorSales.swiggy;
    const unsavedZomato = unsavedAggregatorSales.zomato;

    // Preserve manual overrides from saved sheets; for computed values, use
    // the sheet's saved computed value (for SUBMITTED/LOCKED) or recompute
    // fresh (for DRAFT — they may have stale zeros before all txns settled).
    const effectiveSwiggy = round2(sum(savedSheets.map((s) => Number(s.swiggySale ?? 0))) + unsavedSwiggy);
    const effectiveZomato = round2(sum(savedSheets.map((s) => Number(s.zomatoSale ?? 0))) + unsavedZomato);

    // For DRAFT sheets without an override, recompute from live transactions
    // per-outlet so that saved stale zeros don't suppress real sales in the
    // aggregate. SUBMITTED/LOCKED sheets keep their frozen computed values.
    const draftSheets = savedSheets.filter((s) => s.status === 'DRAFT');
    const draftPerOutlet = new Map<string, VenueSales>();
    for (const ds of draftSheets) {
      if (!draftPerOutlet.has(ds.restaurantId)) {
        draftPerOutlet.set(ds.restaurantId, await computeVenueSales(ds.restaurantId, reportDate));
      }
    }

    const effectiveAcBar = round2(
      sum(savedSheets.map((s) => {
        if (s.acBarSaleOverride != null) return Number(s.acBarSaleOverride);
        if (s.status === 'DRAFT') return draftPerOutlet.get(s.restaurantId)?.acBar ?? 0;
        return Number(s.acBarSaleComputed ?? 0);
      })) + unsavedVenueSales.acBar
    );
    const effectiveNonAcBar = round2(
      sum(savedSheets.map((s) => {
        if (s.nonAcBarSaleOverride != null) return Number(s.nonAcBarSaleOverride);
        if (s.status === 'DRAFT') return draftPerOutlet.get(s.restaurantId)?.nonAcBar ?? 0;
        return Number(s.nonAcBarSaleComputed ?? 0);
      })) + unsavedVenueSales.nonAcBar
    );
    const effectiveFamilyWing = round2(
      sum(savedSheets.map((s) => {
        if (s.familyWingSaleOverride != null) return Number(s.familyWingSaleOverride);
        if (s.status === 'DRAFT') return draftPerOutlet.get(s.restaurantId)?.familyWing ?? 0;
        return Number(s.familyWingSaleComputed ?? 0);
      })) + unsavedVenueSales.familyWing
    );
    const effectiveParcel = round2(
      sum(savedSheets.map((s) => {
        if (s.parcelSaleOverride != null) return Number(s.parcelSaleOverride);
        if (s.status === 'DRAFT') return draftPerOutlet.get(s.restaurantId)?.parcel ?? 0;
        return Number(s.parcelSaleComputed ?? 0);
      })) + unsavedVenueSales.parcel
    );

    return {
      id: null,
      restaurantId: "all",
      reportDate,
      openingBalance: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.openingBalance)))),
      acBarSaleComputed: new Prisma.Decimal(effectiveAcBar),
      acBarSaleOverride: null,
      nonAcBarSaleComputed: new Prisma.Decimal(effectiveNonAcBar),
      nonAcBarSaleOverride: null,
      familyWingSaleComputed: new Prisma.Decimal(effectiveFamilyWing),
      familyWingSaleOverride: null,
      parcelSaleComputed: new Prisma.Decimal(effectiveParcel),
      parcelSaleOverride: null,
      totalSalesOverride: null,
      swiggySale: new Prisma.Decimal(effectiveSwiggy),
      zomatoSale: new Prisma.Decimal(effectiveZomato),
      totalExpenditures: new Prisma.Decimal(round2(totalExpenditures)),
      totalExpendituresOverride: null,
      closingBalance: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.closingBalance)))),
      status: "DRAFT",
      createdBy: null,
      submittedBy: null,
      submittedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      adjustments: savedSheets.flatMap((s) => s.adjustments),
    };
  }

  const [venueSales, totalExpenditures, aggregatorSales] = await Promise.all([
    computeVenueSales(tenantIds, reportDate),
    computeExpenditureTotal(tenantIds, reportDate),
    computeAggregatorSales(tenantIds, reportDate),
  ]);

  return {
    id: null,
    restaurantId: "all",
    reportDate,
    openingBalance: new Prisma.Decimal(0),
    acBarSaleComputed: new Prisma.Decimal(venueSales.acBar),
    acBarSaleOverride: null,
    nonAcBarSaleComputed: new Prisma.Decimal(venueSales.nonAcBar),
    nonAcBarSaleOverride: null,
    familyWingSaleComputed: new Prisma.Decimal(venueSales.familyWing),
    familyWingSaleOverride: null,
    parcelSaleComputed: new Prisma.Decimal(venueSales.parcel),
    parcelSaleOverride: null,
    totalSalesOverride: null,
    swiggySale: new Prisma.Decimal(aggregatorSales.swiggy),
    zomatoSale: new Prisma.Decimal(aggregatorSales.zomato),
    totalExpenditures: new Prisma.Decimal(totalExpenditures),
    totalExpendituresOverride: null,
    closingBalance: null,
    status: "DRAFT",
    createdBy: null,
    submittedBy: null,
    submittedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    adjustments: [],
  };
}

// ── upsertBalanceSheet ───────────────────────────────────────────────────────
// Takes overrides + openingBalance + full adjustment list, recomputes via the
// pure function, snapshots totalExpenditures and closingBalance, upserts.
// Rejects with 409-style error if status === "LOCKED" and not explicitly unlocking.
// Rejects with 409 if updatedAt mismatch (concurrent edit).
export async function upsertBalanceSheet(
  restaurantId: string,
  reportDate: string,
  data: {
    openingBalance?: number;
    acBarSaleOverride?: number | null;
    nonAcBarSaleOverride?: number | null;
    familyWingSaleOverride?: number | null;
    parcelSaleOverride?: number | null;
    totalSalesOverride?: number | null;
    totalExpendituresOverride?: number | null;
    swiggySale?: number | null;
    zomatoSale?: number | null;
    adjustments?: { label: string; amount: number; sign: string; narration?: string | null; sortOrder: number }[];
    bankCollections?: { bankName: string; amount: number; sortOrder: number }[];
    expectedUpdatedAt?: string; // ISO timestamp for concurrency check
  },
  userId?: string,
  calculationRestaurantIds: string | string[] = restaurantId
) {
  // Check if locked using basePrisma with explicit restaurantId
  const existing = await basePrisma.dailyBalanceSheet.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
  });

  if (existing && existing.status === BALANCE_SHEET_STATUS.LOCKED) {
    const err: any = new Error("Balance sheet is LOCKED. Unlock first to edit.");
    err.statusCode = 409;
    throw err;
  }

  // Compute venue sales fresh (for computed values)
  const venueSales = await computeVenueSales(calculationRestaurantIds, reportDate);
  const totalExpenditures = await computeExpenditureTotal(calculationRestaurantIds, reportDate);
  const nonCashExpenditures = await computeNonCashExpenditureTotal(calculationRestaurantIds, reportDate);
  const aggregatorSales = await computeAggregatorSales(calculationRestaurantIds, reportDate);
  // Compute the canonical PaymentSummary so the closing balance reflects actual
  // cash collected (bill + tip) minus cash expenditures minus mandatory tip payout.
  const paymentSummary = await computePaymentSummary(calculationRestaurantIds, reportDate);

  const openingBalance = data.openingBalance ?? (existing ? Number(existing.openingBalance) : 0);

  // Use override if provided, otherwise computed value
  const acBar = data.acBarSaleOverride != null ? data.acBarSaleOverride : venueSales.acBar;
  const nonAcBar = data.nonAcBarSaleOverride != null ? data.nonAcBarSaleOverride : venueSales.nonAcBar;
  const familyWing = data.familyWingSaleOverride != null ? data.familyWingSaleOverride : venueSales.familyWing;
  const parcel = data.parcelSaleOverride != null ? data.parcelSaleOverride : venueSales.parcel;
  const swiggy = data.swiggySale != null ? data.swiggySale : (existing ? Number(existing.swiggySale ?? 0) : aggregatorSales.swiggy);
  const zomato = data.zomatoSale != null ? data.zomatoSale : (existing ? Number(existing.zomatoSale ?? 0) : aggregatorSales.zomato);

  const preserveExistingAdjustments = data.adjustments === undefined;
  const adjustments = (data.adjustments || []).map((a, i) => ({
    label: a.label,
    amount: a.amount,
    sign: (a.sign === "PLUS" ? "PLUS" : "MINUS") as "PLUS" | "MINUS",
    narration: a.narration ?? null,
    sortOrder: a.sortOrder ?? i,
  }));

  const preserveExistingBankCollections = data.bankCollections === undefined;
  const bankCollections = (data.bankCollections || []).map((b, i) => ({
    bankName: b.bankName.trim(),
    amount: Math.max(0, Number(b.amount) || 0),
    sortOrder: b.sortOrder ?? i,
  }));

  // When preserving, fetch existing adjustments from DB so balance calculation includes them
  let adjustmentsForCalc = adjustments;
  if (preserveExistingAdjustments && existing) {
    const existingAdjustments = await basePrisma.balanceAdjustment.findMany({
      where: { dailyBalanceSheetId: existing.id },
      orderBy: { sortOrder: "asc" },
    });
    adjustmentsForCalc = existingAdjustments.map((a) => ({
      label: a.label,
      amount: Number(a.amount),
      sign: a.sign as "PLUS" | "MINUS",
      narration: a.narration,
      sortOrder: a.sortOrder,
    }));
  }

  const balanceSteps = calculateRunningBalance(
    openingBalance,
    { acBar, nonAcBar, familyWing, parcel, swiggy, zomato },
    totalExpenditures,
    adjustmentsForCalc,
    data.totalSalesOverride,
    data.totalExpendituresOverride,
    nonCashExpenditures,
    {
      cashCollected: paymentSummary.collections.cash,
      cardCollected: paymentSummary.collections.card,
      upiCollected: paymentSummary.collections.upi,
      otherCollected: paymentSummary.collections.other,
      totalTips: paymentSummary.tips.total,
      tipsPaid: paymentSummary.tipsPaid,
      cashExpenditures: paymentSummary.expenditures.cash,
    },
  );

  const upsertData = {
    openingBalance: new Prisma.Decimal(round2(openingBalance)),
    acBarSaleComputed: new Prisma.Decimal(venueSales.acBar),
    acBarSaleOverride: data.acBarSaleOverride != null ? new Prisma.Decimal(data.acBarSaleOverride) : (existing?.acBarSaleOverride ?? null),
    nonAcBarSaleComputed: new Prisma.Decimal(venueSales.nonAcBar),
    nonAcBarSaleOverride: data.nonAcBarSaleOverride != null ? new Prisma.Decimal(data.nonAcBarSaleOverride) : (existing?.nonAcBarSaleOverride ?? null),
    familyWingSaleComputed: new Prisma.Decimal(venueSales.familyWing),
    familyWingSaleOverride: data.familyWingSaleOverride != null ? new Prisma.Decimal(data.familyWingSaleOverride) : (existing?.familyWingSaleOverride ?? null),
    parcelSaleComputed: new Prisma.Decimal(venueSales.parcel),
    parcelSaleOverride: data.parcelSaleOverride != null ? new Prisma.Decimal(data.parcelSaleOverride) : (existing?.parcelSaleOverride ?? null),
    totalSalesOverride: data.totalSalesOverride != null ? new Prisma.Decimal(data.totalSalesOverride) : (existing?.totalSalesOverride ?? null),
    swiggySale: data.swiggySale != null ? new Prisma.Decimal(data.swiggySale) : (existing ? existing.swiggySale : null),
    zomatoSale: data.zomatoSale != null ? new Prisma.Decimal(data.zomatoSale) : (existing ? existing.zomatoSale : null),
    totalExpenditures: new Prisma.Decimal(totalExpenditures),
    totalExpendituresOverride: data.totalExpendituresOverride != null ? new Prisma.Decimal(data.totalExpendituresOverride) : (existing?.totalExpendituresOverride ?? null),
    nonCashExpenditures: new Prisma.Decimal(nonCashExpenditures),
    // Payment summary snapshot — frozen on save so a locked sheet stays auditable.
    cashCollected: new Prisma.Decimal(paymentSummary.collections.cash),
    cardCollected: new Prisma.Decimal(paymentSummary.collections.card),
    upiCollected: new Prisma.Decimal(paymentSummary.collections.upi),
    otherCollected: new Prisma.Decimal(paymentSummary.collections.other),
    totalTips: new Prisma.Decimal(paymentSummary.tips.total),
    tipsPaidAmount: new Prisma.Decimal(paymentSummary.tipsPaid),
    cashExpenditures: new Prisma.Decimal(paymentSummary.expenditures.cash),
    closingBalance: new Prisma.Decimal(balanceSteps.closingBalance),
    createdBy: userId ?? existing?.createdBy ?? null,
  };

  const bankCollectionsUpdate = preserveExistingBankCollections ? {} : {
    bankCollections: {
      deleteMany: {},
      create: bankCollections.map((b) => ({
        bankName: b.bankName,
        amount: new Prisma.Decimal(b.amount),
        sortOrder: b.sortOrder,
      })),
    },
  };

  const result = await basePrisma.dailyBalanceSheet.upsert({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
    update: {
      ...upsertData,
      ...(preserveExistingAdjustments ? {} : {
        adjustments: {
          deleteMany: {},
          create: adjustments.map((a) => ({
            label: a.label,
            amount: new Prisma.Decimal(a.amount),
            sign: a.sign,
            narration: a.narration,
            sortOrder: a.sortOrder,
          })),
        },
      }),
      ...bankCollectionsUpdate,
    },
    create: {
      restaurantId,
      reportDate,
      ...upsertData,
      adjustments: {
        create: adjustments.map((a) => ({
          label: a.label,
          amount: new Prisma.Decimal(a.amount),
          sign: a.sign,
        })),
      },
      bankCollections: {
        create: bankCollections.map((b) => ({
          bankName: b.bankName,
          amount: new Prisma.Decimal(b.amount),
          sortOrder: b.sortOrder,
        })),
      },
    },
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
      bankCollections: { orderBy: { sortOrder: "asc" } },
    },
  });

  logger.info({ restaurantId, reportDate, sheetId: result.id }, "[DailyBalanceSheet] Upserted successfully");
  return result;
}

// ── listBalanceSheets ────────────────────────────────────────────────────────
export async function listBalanceSheets(restaurantId: string, startDate: string, endDate: string) {
  return basePrisma.dailyBalanceSheet.findMany({
    where: {
      restaurantId,
      reportDate: { gte: startDate, lte: endDate },
    },
    orderBy: { reportDate: "desc" },
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
      bankCollections: { orderBy: { sortOrder: "asc" } },
    },
  });
}

// ── setBalanceSheetStatus ────────────────────────────────────────────────────
// For submit/lock/unlock transitions. Logs every status transition via AuditLog.
export async function setBalanceSheetStatus(
  restaurantId: string,
  reportDate: string,
  status: string,
  userId?: string
) {
  const existing = await basePrisma.dailyBalanceSheet.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
  });

  if (!existing) {
    const err: any = new Error("Balance sheet not found for this date");
    err.statusCode = 404;
    throw err;
  }

  const updateData: any = { status };
  if (status === "SUBMITTED") {
    updateData.submittedBy = userId ?? null;
    updateData.submittedAt = new Date();
  }

  const result = await basePrisma.dailyBalanceSheet.update({
    where: { id: existing.id },
    data: updateData,
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
    },
  });

  // Log every status transition for audit trail
  const actionMap: Record<string, string> = {
    DRAFT: existing.status === "LOCKED" ? "BALANCE_SHEET_UNLOCK" : "BALANCE_SHEET_DRAFT",
    SUBMITTED: "BALANCE_SHEET_SUBMIT",
    LOCKED: "BALANCE_SHEET_LOCK",
  };
  const action = actionMap[status];
  if (action) {
    createAuditLog({
      userId: userId ?? undefined,
      restaurantId,
      action,
      entityType: "DailyBalanceSheet",
      entityId: existing.id,
      metadata: { reportDate, previousStatus: existing.status, newStatus: status },
    });
    logger.info(
      { restaurantId, reportDate, userId, sheetId: existing.id, action, previousStatus: existing.status, newStatus: status },
      "[DailyBalanceSheet] Status transition logged"
    );
  }

  return result;
}

// ── Cross-outlet list (for admin "all outlets" view) ─────────────────────────
export async function listBalanceSheetsAcrossOutlets(
  tenantIds: string[],
  startDate: string,
  endDate: string
) {
  return basePrisma.dailyBalanceSheet.findMany({
    where: {
      restaurantId: { in: tenantIds },
      reportDate: { gte: startDate, lte: endDate },
    },
    orderBy: { reportDate: "desc" },
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
      bankCollections: { orderBy: { sortOrder: "asc" } },
    },
  });
}
