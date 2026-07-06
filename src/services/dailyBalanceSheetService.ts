// ─────────────────────────────────────────────────────────────────────────────
// Daily Balance Sheet Service — Per-outlet daily balance sheet with venue sales
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors xReportService.ts structure: round2 helper, compute-then-persist pattern.
// Once a sheet is saved, viewing it returns frozen numbers (no live recompute).
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { basePrisma } from "../lib/prisma";
import logger from "../lib/logger";
import { computeVoucherAmountFromVouchers } from "./xReportService";
import { createAuditLog } from "../lib/auditLog";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
// Aggregate Transaction.grandTotal (fallback amount) for the day, grouped by
// joining Transaction.sectionId → Section.venueId → Venue.venueType.
// Unrecognized venue types are bucketed with a warning, never thrown.
export async function computeVenueSales(restaurantId: string | string[], reportDate: string): Promise<VenueSales> {
  const startOfDay = new Date(`${reportDate}T00:00:00+05:30`);
  const endOfDay = new Date(`${reportDate}T23:59:59+05:30`);
  const ids = Array.isArray(restaurantId) ? restaurantId : [restaurantId];

  // Use basePrisma for multi-outlet queries; the default prisma client would overwrite
  // restaurantId with the active outlet from tenant context.
  const db = ids.length > 1 ? basePrisma : prisma;

  const transactions = await db.transaction.findMany({
    where: {
      restaurantId: { in: ids },
      paidAt: { gte: startOfDay, lte: endOfDay },
    },
    select: {
      grandTotal: true,
      amount: true,
      sectionId: true,
    },
  });

  // Collect all sectionIds to batch-resolve venue types
  const sectionIds = [...new Set(transactions.map((t) => t.sectionId).filter(Boolean))] as string[];

  if (sectionIds.length === 0) {
    return { acBar: 0, nonAcBar: 0, familyWing: 0, parcel: 0 };
  }

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

  const buckets: VenueSales = { acBar: 0, nonAcBar: 0, familyWing: 0, parcel: 0 };

  for (const txn of transactions) {
    const sectionId = txn.sectionId;
    if (!sectionId) continue;

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

    if (!bucketKey) {
      if (venueType) {
        logger.warn(
          { restaurantId, reportDate, venueType, venueName, sectionId },
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

// ── computeVoucherTotal ──────────────────────────────────────────────────────
// Reuses xReportService's computeVoucherAmountFromVouchers via import.
export async function computeVoucherTotal(restaurantId: string | string[], reportDate: string): Promise<number> {
  return computeVoucherAmountFromVouchers(restaurantId, reportDate);
}

// ── calculateRunningBalance (pure function) ──────────────────────────────────
// No DB access — independently testable. Returns closing balance + intermediate steps.
export interface AdjustmentInput {
  label: string;
  amount: number;
  sign: "PLUS" | "MINUS";
  sortOrder: number;
}

export interface BalanceSteps {
  openingBalance: number;
  afterSales: number;
  afterVouchers: number;
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
  totalVouchers: number,
  adjustments: AdjustmentInput[]
): BalanceSteps {
  const ob = round2(openingBalance);
  const totalSales =
    round2(sales.acBar) +
    round2(sales.nonAcBar) +
    round2(sales.familyWing) +
    round2(sales.parcel) +
    round2(sales.swiggy) +
    round2(sales.zomato);

  const afterSales = round2(ob + totalSales);
  const afterVouchers = round2(afterSales - totalVouchers);

  // Sort adjustments by sortOrder, apply sequentially
  const sorted = [...adjustments].sort((a, b) => a.sortOrder - b.sortOrder);

  const steps: { label: string; value: number }[] = [
    { label: "Opening Balance", value: ob },
    { label: "+ Total Sales", value: afterSales },
    { label: "- Vouchers", value: afterVouchers },
  ];

  let running = afterVouchers;
  for (const adj of sorted) {
    const amt = round2(adj.amount);
    if (adj.sign === "PLUS") {
      running = round2(running + amt);
    } else {
      running = round2(running - amt);
    }
    steps.push({ label: `${adj.sign === "PLUS" ? "+" : "−"} ${adj.label}`, value: running });
  }

  return {
    openingBalance: ob,
    afterSales,
    afterVouchers,
    afterAdjustments: running,
    closingBalance: running,
    steps,
  };
}

// ── getOrSeedBalanceSheet ────────────────────────────────────────────────────
// If a saved row exists, return it exactly as saved (frozen numbers).
// If not, compute fresh and return an unsaved shape (id: null).
export async function getOrSeedBalanceSheet(restaurantId: string, reportDate: string) {
  const existing = await prisma.dailyBalanceSheet.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (existing) return existing;

  // Auto-seed: compute venue sales + voucher total, pull openingBalance from
  // the most recent prior saved sheet — don't persist yet.
  const [venueSales, totalVouchers, priorSheet] = await Promise.all([
    computeVenueSales(restaurantId, reportDate),
    computeVoucherTotal(restaurantId, reportDate),
    prisma.dailyBalanceSheet.findFirst({
      where: {
        restaurantId,
        reportDate: { lt: reportDate },
        closingBalance: { not: null },
      },
      orderBy: { reportDate: "desc" },
      select: { reportDate: true, closingBalance: true },
    }),
  ]);

  const openingBalance = priorSheet ? Number(priorSheet.closingBalance) : 0;
  logger.info(
    { restaurantId, reportDate, priorDate: priorSheet?.reportDate, priorClosing: priorSheet?.closingBalance, openingBalance },
    "[DailyBalanceSheet] Seeded opening balance from prior sheet"
  );

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
    swiggySale: null,
    zomatoSale: null,
    totalVouchers: new Prisma.Decimal(totalVouchers),
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

// ── getOrSeedAggregateBalanceSheet ───────────────────────────────────────────
// Returns a synthetic balance sheet for the "All Outlets" admin view.
// Sums saved sheets when available; otherwise computes fresh across all outlets.
export async function getOrSeedAggregateBalanceSheet(tenantIds: string[], reportDate: string) {
  const savedSheets = await basePrisma.dailyBalanceSheet.findMany({
    where: { restaurantId: { in: tenantIds }, reportDate },
    include: { adjustments: true },
  });

  const sum = (arr: any[]) => arr.reduce((s, x) => s + Number(x || 0), 0);

  if (savedSheets.length > 0) {
    return {
      id: null,
      restaurantId: "all",
      reportDate,
      openingBalance: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.openingBalance)))),
      acBarSaleComputed: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.acBarSaleComputed)))),
      acBarSaleOverride: null,
      nonAcBarSaleComputed: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.nonAcBarSaleComputed)))),
      nonAcBarSaleOverride: null,
      familyWingSaleComputed: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.familyWingSaleComputed)))),
      familyWingSaleOverride: null,
      parcelSaleComputed: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.parcelSaleComputed)))),
      parcelSaleOverride: null,
      swiggySale: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.swiggySale)))),
      zomatoSale: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.zomatoSale)))),
      totalVouchers: new Prisma.Decimal(round2(sum(savedSheets.map((s) => s.totalVouchers)))),
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

  const [venueSales, totalVouchers] = await Promise.all([
    computeVenueSales(tenantIds, reportDate),
    computeVoucherTotal(tenantIds, reportDate),
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
    swiggySale: new Prisma.Decimal(0),
    zomatoSale: new Prisma.Decimal(0),
    totalVouchers: new Prisma.Decimal(totalVouchers),
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
// pure function, snapshots totalVouchers and closingBalance, upserts.
// Rejects with 409-style error if status === "LOCKED" and not explicitly unlocking.
export async function upsertBalanceSheet(
  restaurantId: string,
  reportDate: string,
  data: {
    openingBalance?: number;
    acBarSaleOverride?: number | null;
    nonAcBarSaleOverride?: number | null;
    familyWingSaleOverride?: number | null;
    parcelSaleOverride?: number | null;
    swiggySale?: number | null;
    zomatoSale?: number | null;
    adjustments?: { label: string; amount: number; sign: string; sortOrder: number }[];
  },
  userId?: string
) {
  // Check if locked
  const existing = await prisma.dailyBalanceSheet.findUnique({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
  });

  if (existing && existing.status === "LOCKED") {
    const err: any = new Error("Balance sheet is LOCKED. Unlock first to edit.");
    err.statusCode = 409;
    throw err;
  }

  // Compute venue sales fresh (for computed values)
  const venueSales = await computeVenueSales(restaurantId, reportDate);
  const totalVouchers = await computeVoucherTotal(restaurantId, reportDate);

  const openingBalance = data.openingBalance ?? (existing ? Number(existing.openingBalance) : 0);

  // Use override if provided, otherwise computed value
  const acBar = data.acBarSaleOverride != null ? data.acBarSaleOverride : venueSales.acBar;
  const nonAcBar = data.nonAcBarSaleOverride != null ? data.nonAcBarSaleOverride : venueSales.nonAcBar;
  const familyWing = data.familyWingSaleOverride != null ? data.familyWingSaleOverride : venueSales.familyWing;
  const parcel = data.parcelSaleOverride != null ? data.parcelSaleOverride : venueSales.parcel;
  const swiggy = data.swiggySale ?? (existing ? Number(existing.swiggySale ?? 0) : 0);
  const zomato = data.zomatoSale ?? (existing ? Number(existing.zomatoSale ?? 0) : 0);

  const adjustments = (data.adjustments || []).map((a, i) => ({
    label: a.label,
    amount: a.amount,
    sign: (a.sign === "PLUS" ? "PLUS" : "MINUS") as "PLUS" | "MINUS",
    sortOrder: a.sortOrder ?? i,
  }));

  const balanceSteps = calculateRunningBalance(
    openingBalance,
    { acBar, nonAcBar, familyWing, parcel, swiggy, zomato },
    totalVouchers,
    adjustments
  );

  const upsertData = {
    openingBalance: new Prisma.Decimal(round2(openingBalance)),
    acBarSaleComputed: new Prisma.Decimal(venueSales.acBar),
    acBarSaleOverride: data.acBarSaleOverride != null ? new Prisma.Decimal(data.acBarSaleOverride) : null,
    nonAcBarSaleComputed: new Prisma.Decimal(venueSales.nonAcBar),
    nonAcBarSaleOverride: data.nonAcBarSaleOverride != null ? new Prisma.Decimal(data.nonAcBarSaleOverride) : null,
    familyWingSaleComputed: new Prisma.Decimal(venueSales.familyWing),
    familyWingSaleOverride: data.familyWingSaleOverride != null ? new Prisma.Decimal(data.familyWingSaleOverride) : null,
    parcelSaleComputed: new Prisma.Decimal(venueSales.parcel),
    parcelSaleOverride: data.parcelSaleOverride != null ? new Prisma.Decimal(data.parcelSaleOverride) : null,
    swiggySale: data.swiggySale != null ? new Prisma.Decimal(data.swiggySale) : (existing ? existing.swiggySale : null),
    zomatoSale: data.zomatoSale != null ? new Prisma.Decimal(data.zomatoSale) : (existing ? existing.zomatoSale : null),
    totalVouchers: new Prisma.Decimal(totalVouchers),
    closingBalance: new Prisma.Decimal(balanceSteps.closingBalance),
    createdBy: userId ?? existing?.createdBy ?? null,
  };

  const result = await prisma.dailyBalanceSheet.upsert({
    where: {
      restaurantId_reportDate: { restaurantId, reportDate },
    },
    update: {
      ...upsertData,
      // Replace adjustments: delete all existing, create new
      adjustments: {
        deleteMany: {},
        create: adjustments.map((a) => ({
          label: a.label,
          amount: new Prisma.Decimal(a.amount),
          sign: a.sign,
          sortOrder: a.sortOrder,
        })),
      },
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
          sortOrder: a.sortOrder,
        })),
      },
    },
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
    },
  });

  logger.info({ restaurantId, reportDate, sheetId: result.id }, "[DailyBalanceSheet] Upserted successfully");
  return result;
}

// ── listBalanceSheets ────────────────────────────────────────────────────────
export async function listBalanceSheets(restaurantId: string, startDate: string, endDate: string) {
  return prisma.dailyBalanceSheet.findMany({
    where: {
      restaurantId,
      reportDate: { gte: startDate, lte: endDate },
    },
    orderBy: { reportDate: "desc" },
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
    },
  });
}

// ── setBalanceSheetStatus ────────────────────────────────────────────────────
// For submit/lock/unlock transitions. Logs every unlock via AuditLog.
export async function setBalanceSheetStatus(
  restaurantId: string,
  reportDate: string,
  status: string,
  userId?: string
) {
  const existing = await prisma.dailyBalanceSheet.findUnique({
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

  const result = await prisma.dailyBalanceSheet.update({
    where: { id: existing.id },
    data: updateData,
    include: {
      adjustments: { orderBy: { sortOrder: "asc" } },
    },
  });

  // Log every unlock
  if (status === "DRAFT" && existing.status === "LOCKED") {
    createAuditLog({
      userId: userId ?? undefined,
      restaurantId,
      action: "BALANCE_SHEET_UNLOCK",
      entityType: "DailyBalanceSheet",
      entityId: existing.id,
      metadata: { reportDate, previousStatus: existing.status, newStatus: status },
    });
    logger.info(
      { restaurantId, reportDate, userId, sheetId: existing.id },
      "[DailyBalanceSheet] Unlocked by user"
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
    },
  });
}
