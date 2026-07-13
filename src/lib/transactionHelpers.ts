import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { getKolkataDateString } from "../utils/date";

/**
 * Generate the next daily-sequential transaction number for a restaurant.
 * Must be called inside a Prisma transaction (tx) so the increment is atomic.
 */
export async function getNextTxnNumber(
  restaurantId: string,
  tx: any
): Promise<number> {
  const counterDate = getKolkataDateString();

  return await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { txnCount: { increment: 1 } },
    create: { restaurantId, counterDate, txnCount: 1 },
    select: { txnCount: true },
  }).then((c: { txnCount: number }) => c.txnCount);
}

/**
 * Generate the next daily-sequential bill number for a restaurant.
 * Must be called inside a Prisma transaction (tx) so the increment is atomic.
 */
export async function getNextBillNumber(
  restaurantId: string,
  tx: any
): Promise<number> {
  const counterDate = getKolkataDateString();

  const rows = await tx.$queryRaw<{ billCount: number }[]>`
    INSERT INTO "DailyCounter" ("id", "restaurantId", "counterDate", "billCount", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${restaurantId}, ${counterDate}, 1, NOW(), NOW())
    ON CONFLICT ("restaurantId", "counterDate")
    DO UPDATE SET "billCount" = "DailyCounter"."billCount" + 1, "updatedAt" = NOW()
    RETURNING "billCount";
  `;

  return rows[0].billCount;
}

/**
 * Format a bill number as a plain daily-sequential number.
 */
export function formatBillNumber(_date: Date, billNumber: number): string {
  return String(billNumber);
}

/**
 * Standard where-clause fragment for aggregations that should only include
 * completed transactions. This centralizes the filter so every report, X-report,
 * and analytics endpoint behaves consistently.
 */
export function completedTxnWhere(restaurantId: string | string[], extra: any = {}) {
  const idFilter = Array.isArray(restaurantId) ? { in: restaurantId } : restaurantId;
  return {
    restaurantId: idFilter,
    status: 'COMPLETED',
    ...extra,
  };
}

/**
 * Build a JSON-ready item array for Transaction.items from order items.
 * Preserves the same shape used by settleOrderService and printBillService.
 */
export function buildTxnItemsFromOrderItems(
  items: Array<{ id?: string; name: string; quantity: number; price: number; menuItem?: any; menuItemId?: string; menuType?: string; notes?: string | null }>
): Array<{ id?: string; name: string; quantity: number; price: number; menuType: string; menuItemId?: string; notes?: string | null; gstEnabled?: boolean }> {
  return items.map(item => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    price: Number(item.price),
    menuType: item.menuItem?.menuType || item.menuType || 'FOOD',
    menuItemId: item.menuItemId || item.menuItem?.id || undefined,
    notes: item.notes || null,
    gstEnabled: item.menuItem?.gstEnabled ?? true,
  }));
}

/**
 * Upsert a PENDING transaction at print-bill time, or update an existing one.
 * Idempotent: reuses existing txnNumber/billNumber if the transaction already exists.
 */
export async function upsertPendingTransaction(
  tx: any,
  {
    restaurantId,
    orderId,
    tableNumber,
    tableLabel,
    captainId,
    sectionTag,
    sectionId,
    platform,
    createdByUserId,
    billNumber,
    items,
    subtotal,
    discountPercent,
    discountAmount,
    cgst,
    sgst,
    serviceChargeAmount,
    grandTotal,
    roundOff,
    tipAmount,
    itemCount,
  }: {
    restaurantId: string;
    orderId: string;
    tableNumber?: number | null;
    tableLabel?: string | null;
    captainId?: string | null;
    sectionTag?: string | null;
    sectionId?: string | null;
    platform?: string | null;
    createdByUserId?: string | null;
    billNumber?: string | null;
    items: any[];
    subtotal: number;
    discountPercent: number;
    discountAmount: number;
    cgst: number;
    sgst: number;
    serviceChargeAmount?: number;
    grandTotal: number;
    roundOff: number;
    tipAmount?: number;
    itemCount?: number;
  }
) {
  const txnDate = getKolkataDateString();

  const existing = await tx.transaction.findUnique({
    where: { orderId },
    select: { id: true, txnNumber: true, billNumber: true },
  });

  const txnNumber = existing?.txnNumber ?? (await getNextTxnNumber(restaurantId, tx));
  const resolvedBillNumber = existing?.billNumber ?? billNumber ?? null;

  const data = {
    restaurantId,
    orderId,
    tableNumber: tableNumber ?? null,
    tableLabel: tableLabel ?? null,
    captainId: captainId ?? null,
    sectionTag: sectionTag ?? null,
    sectionId: sectionId ?? null,
    platform: platform ?? null,
    createdByUserId: createdByUserId ?? null,
    amount: new Prisma.Decimal(grandTotal),
    method: 'PENDING',
    status: 'PENDING',
    itemCount: itemCount ?? items.length,
    items: items as any,
    subtotal: new Prisma.Decimal(subtotal),
    discountPercent: new Prisma.Decimal(discountPercent),
    discountAmount: new Prisma.Decimal(discountAmount),
    cgst: new Prisma.Decimal(cgst),
    sgst: new Prisma.Decimal(sgst),
    serviceChargeAmount: new Prisma.Decimal(serviceChargeAmount ?? 0),
    grandTotal: new Prisma.Decimal(grandTotal),
    roundOff: new Prisma.Decimal(roundOff),
    tipAmount: new Prisma.Decimal(tipAmount ?? 0),
    txnNumber,
    txnDate,
    billNumber: resolvedBillNumber,
  };

  if (existing) {
    return await tx.transaction.update({
      where: { id: existing.id },
      data: {
        ...data,
        // Preserve the original createdAt and do not stamp paidAt for PENDING rows.
        paidAt: undefined,
      },
    });
  }

  return await tx.transaction.create({ data });
}

/**
 * Upsert a CANCELLED transaction at terminate-table/cancel time.
 * Idempotent: reuses existing txnNumber if the transaction already exists.
 */
export async function upsertCancelledTransaction(
  tx: any,
  {
    restaurantId,
    orderId,
    tableNumber,
    tableLabel,
    captainId,
    sectionTag,
    sectionId,
    platform,
    createdByUserId,
    billNumber,
    items,
    subtotal,
    discountPercent,
    discountAmount,
    cgst,
    sgst,
    serviceChargeAmount,
    grandTotal,
    roundOff,
    tipAmount,
    itemCount,
  }: {
    restaurantId: string;
    orderId: string;
    tableNumber?: number | null;
    tableLabel?: string | null;
    captainId?: string | null;
    sectionTag?: string | null;
    sectionId?: string | null;
    platform?: string | null;
    createdByUserId?: string | null;
    billNumber?: string | null;
    items: any[];
    subtotal: number;
    discountPercent: number;
    discountAmount: number;
    cgst: number;
    sgst: number;
    serviceChargeAmount?: number;
    grandTotal: number;
    roundOff: number;
    tipAmount?: number;
    itemCount?: number;
  }
) {
  const txnDate = getKolkataDateString();

  const existing = await tx.transaction.findUnique({
    where: { orderId },
    select: { id: true, txnNumber: true, billNumber: true },
  });

  const txnNumber = existing?.txnNumber ?? (await getNextTxnNumber(restaurantId, tx));
  const resolvedBillNumber = existing?.billNumber ?? billNumber ?? null;

  const data = {
    restaurantId,
    orderId,
    tableNumber: tableNumber ?? null,
    tableLabel: tableLabel ?? null,
    captainId: captainId ?? null,
    sectionTag: sectionTag ?? null,
    sectionId: sectionId ?? null,
    platform: platform ?? null,
    createdByUserId: createdByUserId ?? null,
    amount: new Prisma.Decimal(grandTotal),
    method: 'PENDING',
    status: 'CANCELLED',
    itemCount: itemCount ?? items.length,
    items: items as any,
    subtotal: new Prisma.Decimal(subtotal),
    discountPercent: new Prisma.Decimal(discountPercent),
    discountAmount: new Prisma.Decimal(discountAmount),
    cgst: new Prisma.Decimal(cgst),
    sgst: new Prisma.Decimal(sgst),
    serviceChargeAmount: new Prisma.Decimal(serviceChargeAmount ?? 0),
    grandTotal: new Prisma.Decimal(grandTotal),
    roundOff: new Prisma.Decimal(roundOff),
    tipAmount: new Prisma.Decimal(tipAmount ?? 0),
    txnNumber,
    txnDate,
    billNumber: resolvedBillNumber,
    cancelledAt: new Date(),
  };

  if (existing) {
    return await tx.transaction.update({
      where: { id: existing.id },
      data: {
        ...data,
        paidAt: undefined,
      },
    });
  }

  return await tx.transaction.create({ data });
}
