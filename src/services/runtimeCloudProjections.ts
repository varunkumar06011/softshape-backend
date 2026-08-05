// ─────────────────────────────────────────────────────────────────────────────
// runtimeCloudProjections.ts — Cloud projection handlers for Milestone 2
// ─────────────────────────────────────────────────────────────────────────────
// Registers cloud projection handlers for order, KOT, and bill events.
// When the Runtime uploads events to the cloud, these handlers update the
// cloud's Prisma models (Order, OrderItem, Kot, KotItem) inside the same
// transaction that inserts the event into runtime_event.
//
// Status mapping is imported from the frozen Order protocol — never duplicated.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import type { RuntimeEventEnvelope } from "./runtimeEventService";
import { RUNTIME_EVENT_TYPES } from "./runtimeEventService";
import {
  registerCloudProjection,
  resetCloudProjectionRegistry,
  discoverCloudProjections,
} from "./runtimeCloudProjectionService";

// ── Status mapping (single source of truth) ──────────────────────────────────
// This mirrors the frozen mapping in the Runtime's contract/orderProtocol.ts.
// Both sides must agree. If this mapping changes, the Runtime side must change
// in the same commit.

const V2_TO_CLOUD_STATUS = {
  OPEN: "PENDING",
  BILLED: "BILLING_REQUESTED",
  VOIDED: "CANCELLED",
} as const;

// ── ORDER_CREATED ────────────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.ORDER_CREATED, async (tx, event) => {
  const payload = event.payload as {
    tableId: string;
    captainId?: string | null;
    platform?: string;
  };

  // Idempotent: skip if order already exists (duplicate event)
  const existing = await tx.order.findUnique({ where: { id: event.aggregateId } });
  if (existing) return;

  await tx.order.create({
    data: {
      id: event.aggregateId,
      tableId: payload.tableId,
      restaurantId: event.restaurantId,
      status: V2_TO_CLOUD_STATUS.OPEN,
      totalAmount: 0,
      captainId: payload.captainId ?? null,
      platform: payload.platform ?? "DINE_IN",
      lastRequestId: event.requestId,
    },
  });
});

// ── ORDER_ITEMS_ADDED ────────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.ORDER_ITEMS_ADDED, async (tx, event) => {
  const payload = event.payload as {
    items: Array<{
      id: string;
      menuItemId: string;
      name: string;
      price: number;
      quantity: number;
      notes?: string | null;
    }>;
  };

  for (const item of payload.items) {
    // Idempotent: skip if item already exists
    const existing = await tx.orderItem.findUnique({ where: { id: item.id } });
    if (existing) continue;

    await tx.orderItem.create({
      data: {
        id: item.id,
        orderId: event.aggregateId,
        menuItemId: item.menuItemId,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        notes: item.notes ?? null,
      },
    });
  }

  // Recalculate order total from active items
  const items = await tx.orderItem.findMany({
    where: { orderId: event.aggregateId, removedFromBill: false },
  });
  const total = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  await tx.order.update({
    where: { id: event.aggregateId },
    data: { totalAmount: total, lastRequestId: event.requestId ?? undefined },
  });
});

// ── ORDER_ITEM_CANCELLED ─────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.ORDER_ITEM_CANCELLED, async (tx, event) => {
  const payload = event.payload as { orderItemId: string };

  const item = await tx.orderItem.findUnique({ where: { id: payload.orderItemId } });
  if (!item || item.removedFromBill) return;

  await tx.orderItem.update({
    where: { id: payload.orderItemId },
    data: {
      removedFromBill: true,
      removedAt: new Date(event.occurredAt),
    },
  });

  // Recalculate order total
  const items = await tx.orderItem.findMany({
    where: { orderId: event.aggregateId, removedFromBill: false },
  });
  const total = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  await tx.order.update({
    where: { id: event.aggregateId },
    data: { totalAmount: total, lastRequestId: event.requestId ?? undefined },
  });
});

// ── ORDER_VOIDED ─────────────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.ORDER_VOIDED, async (tx, event) => {
  await tx.order.update({
    where: { id: event.aggregateId },
    data: {
      status: V2_TO_CLOUD_STATUS.VOIDED,
      isDeleted: true,
      deletedAt: new Date(event.occurredAt),
      lastRequestId: event.requestId ?? undefined,
    },
  });
});

// ── KOT_SENT ─────────────────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.KOT_SENT, async (tx, event) => {
  const payload = event.payload as {
    kotId: string;
    orderId: string;
    tableId: string;
    kotNumber: number;
    counterDate: string;
    items: Array<{
      id: string;
      orderItemId: string;
      menuItemId: string;
      name: string;
      quantity: number;
      price: number;
      notes?: string | null;
    }>;
  };

  // Idempotent: skip if KOT already exists
  const existing = await tx.kot.findUnique({ where: { id: payload.kotId } });
  if (existing) return;

  await tx.kot.create({
    data: {
      id: payload.kotId,
      restaurantId: event.restaurantId,
      tableId: payload.tableId,
      orderId: payload.orderId,
      kotNumber: payload.kotNumber,
      counterDate: payload.counterDate,
      items: {
        create: payload.items.map((item) => ({
          id: item.id,
          orderItemId: item.orderItemId,
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          notes: item.notes ?? null,
          status: "SENT",
        })),
      },
    },
  });
});

// ── KOT_CANCELLED ────────────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.KOT_CANCELLED, async (tx, event) => {
  const payload = event.payload as { kotId: string };

  const kot = await tx.kot.findUnique({ where: { id: payload.kotId } });
  if (!kot) return;

  await tx.kotItem.updateMany({
    where: { kotId: payload.kotId },
    data: { status: "CANCELLED" },
  });
});

// ── BILL_GENERATED ───────────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.BILL_GENERATED, async (tx, event) => {
  const payload = event.payload as {
    billId: string;
    orderId: string;
    billNumber: number;
    counterDate: string;
    subtotal: number;
    taxAmount: number;
    serviceCharge: number;
    totalAmount: number;
  };

  await tx.order.update({
    where: { id: payload.orderId },
    data: {
      status: V2_TO_CLOUD_STATUS.BILLED,
      billingRequested: true,
      billingRequestedAt: new Date(event.occurredAt),
      billNumber: String(payload.billNumber),
      totalAmount: payload.totalAmount,
      lastRequestId: event.requestId ?? undefined,
    },
  });
});

// ── BILL_EDITED ──────────────────────────────────────────────────────────────

registerCloudProjection(RUNTIME_EVENT_TYPES.BILL_EDITED, async (tx, event) => {
  const payload = event.payload as {
    billId: string;
    orderId: string;
    totalAmount?: number;
  };

  if (typeof payload.totalAmount === "number") {
    await tx.order.update({
      where: { id: payload.orderId },
      data: { totalAmount: payload.totalAmount },
    });
  }
});

// ── Exports ──────────────────────────────────────────────────────────────────

export const MILESTONE_2_CLOUD_EVENT_TYPES = [
  RUNTIME_EVENT_TYPES.ORDER_CREATED,
  RUNTIME_EVENT_TYPES.ORDER_ITEMS_ADDED,
  RUNTIME_EVENT_TYPES.ORDER_ITEM_CANCELLED,
  RUNTIME_EVENT_TYPES.ORDER_VOIDED,
  RUNTIME_EVENT_TYPES.KOT_SENT,
  RUNTIME_EVENT_TYPES.KOT_CANCELLED,
  RUNTIME_EVENT_TYPES.BILL_GENERATED,
  RUNTIME_EVENT_TYPES.BILL_EDITED,
];

export function getMilestone2CloudProjectionDiscovery() {
  return discoverCloudProjections(MILESTONE_2_CLOUD_EVENT_TYPES);
}

export { resetCloudProjectionRegistry };
