import { PrismaClient, Prisma, OrderStatus, TableStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { getIo } from "../socket";

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.BILLING_REQUESTED,
];

export const tableInclude: Prisma.TableInclude = {
  section: {
    select: {
      id: true,
      name: true,
      restaurantId: true,
      venueId: true,
      venue: { select: { id: true, name: true, venueType: true, kotEnabled: true } },
    },
  },
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: { updatedAt: Prisma.SortOrder.desc },
    take: 1,
    include: {
      items: {
        where: { removedFromBill: false },
        orderBy: { id: Prisma.SortOrder.asc },
      },
    },
  },
};

export async function calculateOrderTotalAmount(
  tx: PrismaClient,
  orderId: string,
): Promise<number> {
  const items = await tx.orderItem.findMany({
    where: { orderId, removedFromBill: false },
  });
  return items.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
}

export function emitTableUpdated(restaurantId: string, table: unknown): void {
  getIo().to(restaurantId).emit("table:updated", { restaurantId, table });
}

export interface TransferOrderItemsInput {
  sourceTableId: string;
  targetTableId: string;
  itemIds: string[];
  transferredBy: string;
  requestId?: string;
  restaurantId: string;
}

export interface TransferOrderItemsResult {
  success: boolean;
  sourceTable: any;
  targetTable: any;
}

/**
 * Core transfer-items logic, extracted from POST /api/tables/:id/transfer-items.
 * Reused by the offline-sync bulk endpoint to avoid self-HTTP loopback.
 */
export async function transferOrderItemsService(input: TransferOrderItemsInput): Promise<TransferOrderItemsResult> {
  const { sourceTableId: id, targetTableId, itemIds, transferredBy, requestId, restaurantId } = input;

  if (!restaurantId) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  }

  // ── IDEMPOTENCY CHECK ──────────────────────────────────────────────
  if (requestId) {
    const existingPr = await prisma.processedRequest.findUnique({
      where: {
        requestId_actionType_restaurantId: {
          requestId,
          actionType: 'transfer-items',
          restaurantId,
        },
      },
    });
    if (existingPr) {
      return { success: true, ...(existingPr.result as any) };
    }
  }

  const normalizedItemIds = Array.isArray(itemIds)
    ? itemIds.map((itemId) => String(itemId).trim()).filter(Boolean)
    : [];

  if (!targetTableId?.trim() || !transferredBy?.trim() || normalizedItemIds.length === 0) {
    throw Object.assign(new Error("targetTableId, itemIds, and transferredBy are required"), { statusCode: 400 });
  }

  if (id === targetTableId) {
    throw Object.assign(new Error("Source and destination tables must be different"), { statusCode: 400 });
  }

  const [sourceTable, targetTable] = await Promise.all([
    prisma.table.findUnique({ where: { id }, include: tableInclude }) as any,
    prisma.table.findUnique({ where: { id: targetTableId }, include: tableInclude }) as any,
  ]);

  if (!sourceTable) {
    throw Object.assign(new Error("Source table not found"), { statusCode: 404 });
  }
  if (!targetTable) {
    throw Object.assign(new Error("Target table not found"), { statusCode: 404 });
  }

  if (sourceTable.status === TableStatus.AVAILABLE) {
    throw Object.assign(new Error("Source table has no active session"), { statusCode: 409, serverUpdatedAt: sourceTable.updatedAt });
  }

  const sourceOrder = sourceTable.orders.find((order: any) => (ACTIVE_ORDER_STATUSES as any).includes(order.status));
  if (!sourceOrder) {
    throw Object.assign(new Error("Source table has no active order"), { statusCode: 400 });
  }

  const transferableItemIds = new Set(
    sourceOrder.items
      .filter((item: any) => !item.removedFromBill)
      .map((item: any) => item.id),
  );

  if (!normalizedItemIds.every((itemId) => transferableItemIds.has(itemId))) {
    throw Object.assign(new Error("One or more selected items are not transferable from the source table"), { statusCode: 400 });
  }

  const existingTargetOrder = targetTable.orders.find((order: any) => (ACTIVE_ORDER_STATUSES as any).includes(order.status));
  if (!existingTargetOrder && targetTable.status !== TableStatus.AVAILABLE) {
    throw Object.assign(new Error("Target table does not have an active order to receive items"), { statusCode: 409 });
  }

  await prisma.$transaction(async (tx) => {
    const destinationOrder = existingTargetOrder ?? await tx.order.create({
      data: {
        status: OrderStatus.CONFIRMED,
        restaurantId,
        tableId: targetTableId,
      },
    });

    await tx.orderItem.updateMany({
      where: { id: { in: normalizedItemIds } },
      data: { orderId: destinationOrder.id },
    });

    const sourceTotalAmount = await calculateOrderTotalAmount(tx as unknown as PrismaClient, sourceOrder.id);
    const destinationTotalAmount = await calculateOrderTotalAmount(tx as unknown as PrismaClient, destinationOrder.id);

    await tx.order.update({
      where: { id: sourceOrder.id },
      data: { totalAmount: sourceTotalAmount },
    });

    await tx.order.update({
      where: { id: destinationOrder.id },
      data: { totalAmount: destinationTotalAmount },
    });

    await tx.table.update({
      where: { id },
      data: {
        currentBill: sourceTotalAmount,
        ...(sourceTotalAmount === 0
          ? {
              status: TableStatus.AVAILABLE,
              workflowStatus: "Free",
              captainId: null,
              guests: 0,
              sessionStartedAt: null,
              currentBill: 0,
              kotHistory: [],
            }
          : {}),
      },
    });

    await tx.table.update({
      where: { id: targetTableId },
      data: {
        currentBill: destinationTotalAmount,
        status: TableStatus.OCCUPIED,
        workflowStatus: targetTable.status === TableStatus.AVAILABLE
          ? "Occupied"
          : (targetTable.workflowStatus ?? "Occupied"),
        ...(targetTable.status === TableStatus.AVAILABLE
          ? { sessionStartedAt: new Date() }
          : {}),
      },
    });

    if (sourceTotalAmount === 0) {
      await tx.order.update({
        where: { id: sourceOrder.id },
        data: { status: OrderStatus.CANCELLED },
      });
    }
  }, { timeout: 15000, maxWait: 10000 });

  const [updatedSourceTable, updatedTargetTable] = await Promise.all([
    prisma.table.findUnique({ where: { id }, include: tableInclude }),
    prisma.table.findUnique({ where: { id: targetTableId }, include: tableInclude }),
  ]);

  emitTableUpdated(restaurantId, updatedSourceTable);
  emitTableUpdated(restaurantId, updatedTargetTable);

  getIo().to(restaurantId).emit("table:items-transferred", {
    restaurantId,
    sourceTableId: id,
    targetTableId,
    itemIds: normalizedItemIds,
    transferredBy,
    sourceTable: updatedSourceTable,
    targetTable: updatedTargetTable,
  });

  // ── IDEMPOTENCY RECORD ──────────────────────────────────────────────
  if (requestId) {
    await prisma.processedRequest.create({
      data: {
        requestId,
        actionType: 'transfer-items',
        restaurantId,
        deviceId: null,
        result: { success: true, sourceTable: updatedSourceTable, targetTable: updatedTargetTable } as any,
      },
    }).catch(() => {});
  }

  return {
    success: true,
    sourceTable: updatedSourceTable,
    targetTable: updatedTargetTable,
  };
}
