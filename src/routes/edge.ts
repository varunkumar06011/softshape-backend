// ─────────────────────────────────────────────────────────────────────────────
// edge.ts — Cloud backend routes for edge server integration
// ─────────────────────────────────────────────────────────────────────────────
// These routes are called by the edge server (running on the restaurant's
// billing PC) to sync data bidirectionally:
//
//   POST /api/edge/sync      — Edge pushes locally created orders/KOTs/tables
//   GET  /api/edge/changes   — Edge pulls incremental config changes
//   GET  /api/edge/config    — Edge pulls full config (initial download)
//   POST /api/edge/register  — Edge registers with cloud (setup token)
//
// Authentication: Bearer JWT (same as captain/cashier app)
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { Router, type Response } from "express";
import logger from "../lib/logger";
import prisma from "../lib/prisma";
import { verifyToken } from "../lib/auth";
import { verifyAgentToken, signAgentToken, AGENT_JWT_SECRET } from "../lib/agentToken";
import jwt from "jsonwebtoken";
import { authenticateEdge } from "../middleware/auth";
import { getIo } from "../socket";
import { getKolkataDateString } from "../utils/date";
import { deductInventoryForOrder } from "../services/inventoryService";
import { cacheClear } from "../lib/cache";
import { emitConfigChange } from "../lib/edgeEmit";
import { getNextTxnNumber } from "../lib/transactionHelpers";
import { normalizeSettlementAllocations } from "../services/paymentSummaryService";
import { resolveTenantContext } from "../lib/tenantContext";
import { getGstBreakdownWithRate, getEffectiveGstRate } from "../utils/gst";

const router = Router();

// ─── Helper: Get restaurant ID from authenticated request ────────────────────

function getReqRestaurantId(req: any): string | null {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId ?? null;
}

// ─── Helper: Invalidate all caches after edge sync ───────────────────────────
// Mirrors the 7-prefix set used by invalidateCache middleware on the direct
// settle path (orders.ts). Resolves organizationId via TenantContext so
// cache version bumps are org-scoped — matching what cacheMiddleware reads.

async function invalidateEdgeSyncCaches(restaurantId: string): Promise<void> {
  try {
    const ctx = await resolveTenantContext(restaurantId);
    const orgId = ctx.organizationId;
    const prefixes = [
      "tables:*", "sections:list:*", "transactions:*",
      "analytics:*", "reports:*", "stats:today:*", "venue:sections:*",
    ];
    for (const p of prefixes) {
      await cacheClear(p, orgId);
    }
  } catch (err: any) {
    logger.warn(`[EdgeSync] Cache invalidation failed for restaurant ${restaurantId}: ${err.message}`);
  }
}

// ─── POST /api/edge/sync — Receive batch of records from edge server ─────────
//
// Body: { restaurantId, batch: [{ queueId, tableName, recordId, operation, data }] }
// Returns: { accepted: [queueId, ...], rejected: [{ queueId, error, outcome }] }
//
// The edge server enqueues locally created orders, KOTs, and table updates
// in its sync_queue. This endpoint receives them in batches and upserts
// into PostgreSQL. After successful upsert, the cloud emits socket events
// so dashboards and other clients see the changes in real-time.
//
// Outcomes:
//   - "applied":   The record was created or updated in the cloud.
//   - "duplicate": The record was already synced (idempotent skip). Safe to dequeue.
//   - "rejected":  Legacy business rejection. Safe to dequeue and audit.
//   - "permanent": Validated non-retryable data/business failure. Safe to dequeue and audit.
//   - "conflict":  A conflict was detected and logged. Safe to dequeue but needs review.
//   - "error":     Processing failed. The edge should retry.

type SyncItemOutcome = "applied" | "duplicate" | "rejected" | "permanent" | "conflict" | "error" | "waiting_dependency";

interface SyncItemResult {
  outcome: SyncItemOutcome;
  message?: string;
}

router.post("/sync", authenticateEdge, async (req: any, res: Response) => {
  try {
    const authRestaurantId = getReqRestaurantId(req);
    if (!authRestaurantId) {
      return res.status(401).json({ error: "No restaurant ID in session" });
    }

    const { restaurantId, batch } = req.body as {
      restaurantId?: string;
      batch?: Array<{
        queueId: number;
        tableName: string;
        recordId: string;
        operation: string;
        data: any;
      }>;
    };

    if (restaurantId !== authRestaurantId) {
      return res.status(403).json({ error: "Restaurant ID mismatch" });
    }

    if (!batch || !Array.isArray(batch) || batch.length === 0) {
      return res.json({ accepted: [], rejected: [] });
    }

    const accepted: number[] = [];
    const rejected: Array<{ queueId: number; error: string; outcome: string }> = [];

    const deviceId = req.body.deviceId || null;

    for (const item of batch) {
      try {
        const result = await processSyncItem(authRestaurantId, item, deviceId);
        // Only "applied" goes into accepted (safe to dequeue, cloud has the data).
        // "duplicate" is safe to dequeue but the cloud already had it.
        // "rejected" is safe to dequeue — cloud refused it (business rule).
        // "conflict" is safe to dequeue — cloud logged a conflict for review.
        // "error" should be retried by the edge.
        if (result.outcome === "applied") {
          accepted.push(item.queueId);
        } else {
          rejected.push({
            queueId: item.queueId,
            error: result.message || result.outcome,
            outcome: result.outcome,
          });
          if (result.outcome !== "error") {
            logger.info(`[EdgeSync] ${item.tableName}/${item.recordId}: ${result.outcome} — ${result.message || ""}`);
          }
        }
      } catch (err: any) {
        // Foreign key / dependency errors → waiting_dependency (not a permanent error)
        if (err.message?.startsWith("WAITING_DEPENDENCY:")) {
          rejected.push({ queueId: item.queueId, error: err.message, outcome: "waiting_dependency" });
          logger.info(`[EdgeSync] ${item.tableName}/${item.recordId}: waiting_dependency — ${err.message}`);
        } else {
          logger.error(`[EdgeSync] Failed to process ${item.tableName}/${item.recordId}: ${err.message}`);
          rejected.push({ queueId: item.queueId, error: err.message || "Unknown error", outcome: "error" });
        }
      }
    }

    // Every submitted queue item must receive an explicit outcome. Never
    // silently drop an item, because the edge cannot safely acknowledge it.
    const respondedIds = new Set([
      ...accepted,
      ...rejected.map((item) => item.queueId),
    ]);
    for (const item of batch) {
      if (!respondedIds.has(item.queueId)) {
        rejected.push({
          queueId: item.queueId,
          error: "Sync item produced no cloud outcome",
          outcome: "error",
        });
      }
    }

    logger.info(`[EdgeSync] Batch processed: ${accepted.length} accepted, ${rejected.length} rejected (${rejected.filter(r => r.outcome === "error").length} errors, ${rejected.filter(r => r.outcome !== "error").length} permanent)`);

    res.json({ accepted, rejected });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Sync endpoint error");
    res.status(500).json({ error: "Sync processing failed" });
  }
});

// ─── Process a single sync item ──────────────────────────────────────────────

async function processSyncItem(restaurantId: string, item: any, deviceId: string | null = null): Promise<SyncItemResult> {
  const { tableName, recordId, data } = item;

  switch (tableName) {
    case "order":
      return await upsertOrder(restaurantId, recordId, data, deviceId);

    case "order_item":
      return await upsertOrderItem(restaurantId, recordId, data);

    case "kot":
      return await upsertKot(restaurantId, recordId, data, deviceId);

    case "kot_item":
      return await upsertKotItem(restaurantId, recordId, data);

    case "table":
      return await upsertTable(restaurantId, recordId, data, item.operation);

    case "outlet":
      return await upsertOutlet(restaurantId, recordId, data);

    case "venue":
      return await upsertVenue(restaurantId, recordId, data);

    case "floor":
      return await upsertFloor(restaurantId, recordId, data);

    case "section":
      return await upsertSection(restaurantId, recordId, data);

    case "category":
      return await upsertCategory(restaurantId, recordId, data);

    case "menu_item":
      return await upsertMenuItem(restaurantId, recordId, data);

    case "menu_item_variant":
      return await upsertMenuItemVariant(restaurantId, recordId, data);

    case "users":
      return await upsertUser(restaurantId, recordId, data);

    case "transaction":
      return await upsertTransaction(restaurantId, recordId, data);

    case "walkin_transaction":
      return await upsertWalkinTransaction(restaurantId, recordId, data);

    case "expenditure":
      return await upsertExpenditure(restaurantId, recordId, data);

    case "employee":
      return await upsertEmployee(restaurantId, recordId, data);

    case "ledger_category":
      return await upsertLedgerCategory(restaurantId, recordId, data);

    default:
      logger.warn(`[EdgeSync] Unknown table: ${tableName}`);
      throw new Error(`Unknown table: ${tableName}`);
  }
}

// ─── Upsert order with nested items ──────────────────────────────────────────

async function upsertOrder(restaurantId: string, orderId: string, data: any, deviceId: string | null = null): Promise<SyncItemResult> {
  const createdAt = data.created_at || data.createdAt
    ? new Date(Number(data.created_at || data.createdAt))
    : undefined;

  // Map edge-specific statuses to cloud OrderStatus enum values.
  // The edge uses "SETTLED" for settled orders, but the cloud enum has "PAID".
  const rawStatus = data.status || "PREPARING";
  const cloudStatus = rawStatus === "SETTLED" ? "PAID" : rawStatus;

  // Compute liquor presence from edge payload items (if present) to set
  // barInventoryDeducted correctly at creation, mirroring createOrderService.
  // When data.items is absent (status-only sync), default to false — safe because
  // deductInventoryForOrder() is idempotent and will no-op on food-only orders.
  const hasLiquorItems = Array.isArray(data.items) && data.items.some((item: any) => {
    const mt = item.menu_type || item.menuType;
    return mt === 'LIQUOR' || mt === 'BAR';
  });

  const orderData: any = {
    id: data.id || orderId,
    tableId: data.table_id || data.tableId,
    restaurantId,
    status: cloudStatus,
    totalAmount: Number(data.total_amount || data.totalAmount || 0),
    captainId: data.captain_id || data.captainId || null,
    platform: data.platform || "DINE_IN",
    createdByUserId: data.created_by_user_id || data.createdByUserId || null,
    lastRequestId: data.last_request_id || data.lastRequestId || null,
    isExtraTable: !!(data.is_extra_table ?? data.isExtraTable),
    billNumber: data.bill_number || data.billNumber || null,
    barInventoryDeducted: !hasLiquorItems,
  };
  if (createdAt) orderData.createdAt = createdAt;

  // Idempotency: check by orderId first
  const existing = await prisma.order.findUnique({ where: { id: orderId } });

  // Also check by lastRequestId (edge server may generate new UUID on retry)
  if (!existing && orderData.lastRequestId) {
    const byRequestId = await prisma.order.findFirst({
      where: { restaurantId, lastRequestId: orderData.lastRequestId },
      include: { items: { select: { id: true } } },
    });
    if (byRequestId) {
      // Already synced under a different ID. Only upsert items if the cloud
      // order has NO items — the frontend's offline-sync may have created the
      // order shell but failed to sync items. If items already exist, upserting
      // edge items (which have different IDs) would create duplicates.
      if (data.items && Array.isArray(data.items) && byRequestId.items.length === 0) {
        for (const item of data.items) {
          await upsertOrderItem(restaurantId, item.id || item.order_item_id, { ...item, order_id: byRequestId.id });
        }
      }
      return { outcome: "duplicate", message: `Order already synced under ID ${byRequestId.id}` };
    }
    // Also check ProcessedRequest table — the browser's sync engine may have
    // already pushed this order via /api/orders with the same requestId.
    const processedByRequestId = await prisma.processedRequest.findUnique({
      where: {
        requestId_actionType_restaurantId: {
          requestId: orderData.lastRequestId,
          actionType: 'create-order',
          restaurantId,
        },
      },
    });
    if (processedByRequestId) {
      logger.info(`[EdgeSync] Order ${orderId} already processed via requestId=${orderData.lastRequestId} — skipping edge sync upsert`);
      // Only upsert items if the cloud order has none (same rationale as above).
      const cloudOrderId = (processedByRequestId.result as any)?.order?.id;
      if (cloudOrderId && data.items && Array.isArray(data.items)) {
        const existingItems = await prisma.orderItem.findMany({
          where: { orderId: cloudOrderId },
          select: { id: true },
        });
        if (existingItems.length === 0) {
          for (const item of data.items) {
            await upsertOrderItem(restaurantId, item.id || item.order_item_id, { ...item, order_id: cloudOrderId });
          }
        }
      }
      return { outcome: "duplicate", message: `Order already processed via requestId=${orderData.lastRequestId}` };
    }
  }

  if (existing) {
    // ── Day-closed guard ──────────────────────────────────────────────────────
    // If this order has been locked by a "Close Day" action, reject the sync
    // upsert to prevent stale edge data from overwriting final numbers.
    if (existing.dayClosedAt) {
      logger.warn(`[EdgeSync] Order ${orderId} is day-closed (${existing.dayClosedAt}) — rejecting sync upsert from device ${deviceId}`);
      return { outcome: "permanent", message: `Order ${orderId} is day-closed; cloud already contains the locked order` };
    }

    // ── Conflict detection ────────────────────────────────────────────────────
    // If the cloud's updatedAt is newer than the edge's updatedAt, someone else
    // modified this order while the edge was offline. Flag it for manual review.
    const edgeUpdatedAt = data.updated_at || data.updatedAt
      ? new Date(Number(data.updated_at || data.updatedAt))
      : null;

    if (edgeUpdatedAt && existing.updatedAt > edgeUpdatedAt && existing.status !== orderData.status) {
      // Conflict: cloud has a newer version with a different status
      logger.warn(`[EdgeSync] Order ${orderId} conflict — cloud updatedAt (${existing.updatedAt}) > edge updatedAt (${edgeUpdatedAt})`);

      await prisma.orderConflict.create({
        data: {
          orderId,
          restaurantId,
          deviceId: deviceId || null,
          cloudUpdatedAt: existing.updatedAt,
          edgeUpdatedAt,
          cloudStatus: existing.status,
          edgeStatus: orderData.status,
          cloudTotal: existing.totalAmount,
          edgeTotal: orderData.totalAmount,
        },
      }).catch((err: any) => {
        // Don't fail the sync if conflict logging fails
        logger.error(`[EdgeSync] Failed to create conflict record: ${err.message}`);
      });
    }

    // Update existing order (last-write-wins, but conflict is flagged above)
    const conflictDetected = edgeUpdatedAt && existing.updatedAt > edgeUpdatedAt && existing.status !== orderData.status;

    // ── Settlement-rollback guard ──────────────────────────────────────────
    // A settled (PAID) order must never be regressed to a pre-settlement
    // status by a stale edge sync record. The edge may legitimately re-send
    // an older row (queued before settlement, or a retry) — drop the status
    // field in that case but still allow harmless fields to refresh.
    if (existing.status === "PAID" && cloudStatus !== "PAID") {
      logger.warn(
        `[EdgeSync] Order ${orderId} is PAID in cloud but edge sent ${cloudStatus} — dropping status rollback (edgeUpdatedAt=${edgeUpdatedAt?.toISOString() ?? 'n/a'})`
      );
      const safeUpdate: any = {
        totalAmount: orderData.totalAmount,
        captainId: orderData.captainId,
        billNumber: orderData.billNumber,
        ...(hasLiquorItems ? { barInventoryDeducted: false } : {}),
      };
      if (edgeUpdatedAt) safeUpdate.updatedAt = edgeUpdatedAt;
      await prisma.order.update({ where: { id: orderId }, data: safeUpdate });
      return { outcome: "conflict", message: `Order ${orderId} already PAID — rejected stale status ${cloudStatus}` };
    }

    const updateData: any = {
      status: orderData.status,
      totalAmount: orderData.totalAmount,
      captainId: orderData.captainId,
      billNumber: orderData.billNumber,
      ...(hasLiquorItems ? { barInventoryDeducted: false } : {}),
    };
    // Set paidAt when edge marks order as settled (mapped to PAID)
    if (cloudStatus === "PAID" && existing.status !== "PAID") {
      updateData.paidAt = edgeUpdatedAt || new Date();
      updateData.billingRequested = false;
    }
    // Use edge's updated_at if provided (keep timestamps consistent)
    if (edgeUpdatedAt) updateData.updatedAt = edgeUpdatedAt;
    await prisma.order.update({
      where: { id: orderId },
      data: updateData,
    });
    if (conflictDetected) {
      return { outcome: "conflict", message: `Order ${orderId} conflict — cloud updatedAt newer than edge` };
    }
  } else {
    // Create new order
    // If tableId references a table that doesn't exist in cloud yet, return
    // waiting_dependency instead of creating an orphan order with no table link.
    // The edge sync worker will retry after the table syncs. This prevents
    // orders from appearing in the admin panel with no table assignment.
    if (orderData.tableId) {
      const tableExists = await prisma.table.findUnique({
        where: { id: orderData.tableId },
        select: { id: true },
      });
      if (!tableExists) {
        logger.warn(`[EdgeSync] Order ${orderId} references table ${orderData.tableId} not in cloud — waiting for table sync`);
        return { outcome: "waiting_dependency", message: `Table ${orderData.tableId} not found for order sync; waiting for table sync` };
      }
    }
    await prisma.order.create({ data: orderData }).catch((err: any) => {
      // P2002 = unique constraint violation (race condition or duplicate)
      if (err.code === "P2002") return;
      // P2003 = foreign key (captain not synced yet — table already handled above)
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent user not found");
      }
      throw err;
    });
  }

  // Upsert order items if present
  if (data.items && Array.isArray(data.items)) {
    for (const item of data.items) {
      await upsertOrderItem(restaurantId, item.id || item.order_item_id, { ...item, order_id: orderId });
    }

    // ── Defense-in-depth: ensure barInventoryDeducted=false when liquor items exist ──
    // The flag is now set correctly at order creation/update above, but this
    // re-asserts it after item upserts as a belt-and-suspenders guard against
    // any race condition or stale resync that might have overwritten it.
    if (hasLiquorItems) {
      await prisma.order.update({
        where: { id: orderId },
        data: { barInventoryDeducted: false },
      }).catch(() => {
        // Order may not exist (race with duplicate detection above) — safe to skip
      });
      logger.info(`[EdgeSync] Order ${orderId} has liquor items — set barInventoryDeducted=false for deduction processing`);
    }
  }

  // Emit socket event for real-time dashboard updates
  try {
    const io = getIo();
    io.to(restaurantId).emit("order:updated", { orderId, restaurantId, status: orderData.status });
  } catch {
    // Socket not initialized — skip
  }
  return { outcome: "applied" };
}

// ─── Upsert order item ───────────────────────────────────────────────────────

async function upsertOrderItem(restaurantId: string, itemId: string, data: any): Promise<SyncItemResult> {
  const itemData = {
    id: data.id || itemId,
    orderId: data.order_id || data.orderId,
    menuItemId: data.menu_item_id || data.menuItemId,
    name: data.name,
    price: Number(data.price || 0),
    quantity: Number(data.quantity || 1),
    notes: data.notes || null,
    menuType: data.menu_type || data.menuType || "FOOD",
    cancelledQuantity: Number(data.cancelled_quantity || data.cancelledQuantity || 0),
    removedFromBill: !!(data.removed_from_bill || data.removedFromBill),
  };

  const existing = await prisma.orderItem.findUnique({ where: { id: itemId } });

  if (existing) {
    await prisma.orderItem.update({
      where: { id: itemId },
      data: {
        quantity: itemData.quantity,
        cancelledQuantity: itemData.cancelledQuantity,
        removedFromBill: itemData.removedFromBill,
        notes: itemData.notes,
      },
    });
  } else {
    await prisma.orderItem.create({ data: itemData }).catch((err: any) => {
      // P2002 = unique constraint (already exists, fine)
      if (err.code === "P2002") return;
      // P2003 = foreign key (parent order or menuItem not synced yet)
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent order or menuItem not found");
      }
      throw err;
    });
  }
  return { outcome: "applied" };
}

// ─── Upsert KOT with nested items ────────────────────────────────────────────

async function upsertKot(restaurantId: string, kotId: string, data: any, deviceId: string | null = null): Promise<SyncItemResult> {
  const kotCreatedAt = data.created_at || data.createdAt
    ? new Date(Number(data.created_at || data.createdAt))
    : undefined;

  const edgeKotNumber = Number(data.kot_number || data.kotNumber || 0);
  // counterDate must reflect the IST business day the KOT was created on,
  // not the sync-processing time. Sync can be delayed past midnight IST;
  // using today's date would land the KOT on the wrong counter date and
  // break daily-reset semantics. Prefer the edge-provided counter_date
  // (authoritative), fall back to deriving from createdAt.
  const edgeCounterDate = data.counter_date || data.counterDate
    || (kotCreatedAt ? getKolkataDateString(kotCreatedAt) : getKolkataDateString());

  const kotData: any = {
    id: data.id || kotId,
    restaurantId,
    deviceId: deviceId || null,
    tableId: data.table_id || data.tableId,
    orderId: data.order_id || data.orderId,
    kotNumber: edgeKotNumber,
    counterDate: edgeCounterDate,
    captainId: data.captain_id || data.captainId || null,
  };
  if (kotCreatedAt) kotData.createdAt = kotCreatedAt;

  // If tableId references a table not in cloud, null it out (same as orders)
  if (kotData.tableId) {
    const tableExists = await prisma.table.findUnique({
      where: { id: kotData.tableId },
      select: { id: true },
    });
    if (!tableExists) {
      logger.warn(`[EdgeSync] KOT ${kotId} references table ${kotData.tableId} not in cloud — creating without table link`);
      kotData.tableId = null;
    }
  }

  const existing = await prisma.kot.findUnique({ where: { id: kotId } });

  if (existing) {
    // Already synced — skip
    return { outcome: "duplicate", message: `KOT ${kotId} already synced` };
  }

  let kotCreated = false;
  try {
    await (prisma as any).kot.create({ data: kotData });
    kotCreated = true;
  } catch (err: any) {
    if (err.code === "P2003") {
      // P2003 = foreign key (parent order or table not synced yet)
      throw new Error("WAITING_DEPENDENCY: parent order or table not found");
    }
    if (err.code !== "P2002") throw err;
    // P2002 on (restaurantId, deviceId, kotNumber, counterDate) — the cloud
    // already has a KOT with this exact number+date+device combination. This
    // is a genuine duplicate (e.g. re-sync of the same KOT under a different
    // UUID). The UUID idempotency check above should have caught most cases,
    // but if a retry produced a new UUID, treat it as a duplicate so the edge
    // can safely dequeue the queue item.
    logger.warn(`[EdgeSync] KOT ${kotId} duplicate (device=${deviceId}, #${edgeKotNumber}, date ${edgeCounterDate}) for restaurant ${restaurantId} — treating as duplicate`);
    return { outcome: "duplicate", message: `KOT #${edgeKotNumber} (device ${deviceId}) already exists for ${edgeCounterDate}` };
  }

  if (!kotCreated) return { outcome: "error", message: "KOT creation did not succeed" };

  // Advance the cloud's daily counter past the edge-assigned KOT number so
  // that cloud-generated KOT numbers (getNextKotNumber) never collide with
  // edge-synced ones. Uses GREATEST to avoid lowering the counter if a later
  // batch contains a lower number (out-of-order sync). The counter is
  // advanced for the KOT's original business day (edgeCounterDate), not
  // today — this preserves daily-reset semantics when sync is delayed.
  if (edgeKotNumber > 0) {
    await prisma.$executeRaw`
      INSERT INTO "DailyCounter" ("id", "restaurantId", "counterDate", "kotCount", "createdAt", "updatedAt")
      VALUES (${crypto.randomUUID()}, ${restaurantId}, ${edgeCounterDate}, ${edgeKotNumber}, NOW(), NOW())
      ON CONFLICT ("restaurantId", "counterDate")
      DO UPDATE SET "kotCount" = GREATEST("DailyCounter"."kotCount", ${edgeKotNumber}), "updatedAt" = NOW()
    `;
  }

  // Upsert KOT items if present
  if (data.items && Array.isArray(data.items)) {
    for (const item of data.items) {
      await upsertKotItem(restaurantId, item.id || item.kot_item_id, { ...item, kot_id: kotId });
    }
  }
  return { outcome: "applied" };
}

// ─── Upsert KOT item ─────────────────────────────────────────────────────────

async function upsertKotItem(restaurantId: string, itemId: string, data: any): Promise<SyncItemResult> {
  const orderItemId = data.order_item_id || data.orderItemId;
  const menuItemId = data.menu_item_id || data.menuItemId;

  if (!orderItemId || !menuItemId) {
    throw new Error(`KotItem ${itemId} missing required field: orderItemId or menuItemId`);
  }

  const itemCreatedAt = data.created_at || data.createdAt
    ? new Date(Number(data.created_at || data.createdAt))
    : undefined;

  const itemData: any = {
    id: data.id || itemId,
    kotId: data.kot_id || data.kotId,
    orderItemId,
    menuItemId,
    name: data.name,
    quantity: Number(data.quantity || 1),
    price: Number(data.price || 0),
    notes: data.notes || null,
    status: data.status || "SENT",
  };
  if (itemCreatedAt) itemData.createdAt = itemCreatedAt;

  const existing = await prisma.kotItem.findUnique({ where: { id: itemId } });

  if (existing) {
    await prisma.kotItem.update({
      where: { id: itemId },
      data: { status: itemData.status, quantity: itemData.quantity },
    });
  } else {
    await prisma.kotItem.create({ data: itemData }).catch((err: any) => {
      // P2002 = unique constraint (already exists, fine)
      if (err.code === "P2002") return;
      // P2003 = foreign key constraint (parent KOT or order_item not synced yet)
      // Return waiting_dependency so the edge retries after the parent syncs
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent KOT or order_item not found");
      }
      throw err;
    });
  }
  return { outcome: "applied" };
}

// ─── Upsert table status ─────────────────────────────────────────────────────

async function upsertTable(restaurantId: string, tableId: string, data: any, operation?: string): Promise<SyncItemResult> {
  // Table status is LAN-only (broadcast via lanBroadcast). However, if the table
  // doesn't exist in the cloud yet (e.g. it was created locally but never synced
  // as an "insert"), we must create it — otherwise orders referencing it will
  // fail with foreign key errors. Use upsert to handle both cases.
  if (operation === "update") {
    // Check if table exists in cloud; if yes, skip (LAN-only status update)
    const existing = await prisma.table.findUnique({ where: { id: tableId }, select: { id: true } });
    if (existing) {
      return { outcome: "duplicate", message: "Table status updates are not synced to cloud" };
    }
    // Table doesn't exist — fall through to upsert (create it)
    logger.info(`[EdgeSync] Table ${tableId} not found in cloud — creating from update operation`);
  }

  const updateData: any = {
    status: data.status,
    workflowStatus: data.workflowStatus || data.workflow_status,
    currentBill: Number(data.currentBill || data.current_bill || 0),
    captainId: data.captainId || data.captain_id || null,
    guests: Number(data.guests || 0),
  };

  if (data.kotHistory || data.kot_history) {
    const kotHist = data.kotHistory || data.kot_history;
    updateData.kotHistory = typeof kotHist === "string" ? JSON.parse(kotHist) : kotHist;
  }

  if (data.discount !== undefined) {
    updateData.discount = data.discount ? Number(data.discount) : null;
  }

  if (data.sessionStartedAt || data.session_started_at) {
    const ssa = data.sessionStartedAt || data.session_started_at;
    updateData.sessionStartedAt = typeof ssa === "number" ? new Date(ssa) : new Date(ssa);
  }

  // Use upsert to handle case where table doesn't exist in cloud yet
  await prisma.table.upsert({
    where: { id: tableId },
    update: updateData,
    create: {
      id: tableId,
      number: data.number || 0,
      capacity: data.capacity || 4,
      sectionId: data.sectionId || data.section_id,
      restaurantId,
      ...updateData,
    },
  }).catch((err: any) => {
    // P2003 = FK constraint (section doesn't exist yet)
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent section not found");
    }
    if (err.code === "P2002") return; // unique constraint (race condition)
    throw err;
  });

  // Emit socket event for real-time table status updates
  try {
    const io = getIo();
    io.to(restaurantId).emit("table:updated", {
      tableId,
      restaurantId,
      status: updateData.status,
      workflowStatus: updateData.workflowStatus,
      currentBill: updateData.currentBill,
    });
  } catch {
    // Socket not initialized — skip
  }
  await invalidateEdgeSyncCaches(restaurantId);
  return { outcome: "applied" };
}

// ─── Upsert outlet (restaurant settings) ────────────────────────────────────

async function upsertOutlet(restaurantId: string, _recordId: string, data: any): Promise<SyncItemResult> {
  // Outlet requires an Organization — create one if it doesn't exist
  const existing = await prisma.outlet.findUnique({ where: { id: restaurantId } });

  if (existing) {
    await prisma.outlet.update({
      where: { id: restaurantId },
      data: {
        name: data.name,
        slug: data.slug,
        restaurantCode: data.restaurantCode,
        restaurantType: data.restaurantType,
        address: data.address,
        phone: data.phone,
        email: data.email,
        gstin: data.gstin,
        logoUrl: data.logoUrl,
        receiptHeader: data.receiptHeader,
        receiptSubHeader: data.receiptSubHeader,
        themePrimary: data.themePrimary,
        themeSecondary: data.themeSecondary,
        barUnitMl: data.barUnitMl,
        fullBottleMl: data.fullBottleMl,
        halfBottleMl: data.halfBottleMl,
        fssai: data.fssai,
        pricesIncludeGst: data.pricesIncludeGst,
        gstCategory: data.gstCategory,
        gstRate: data.gstRate,
        gstRegistered: data.gstRegistered,
        serviceChargePercent: data.serviceChargePercent,
      },
    }).catch((err: any) => { if (err.code !== "P2002") throw err; });
    return { outcome: "applied" };
  }

  // Create organization first, then outlet.
  // Reuse the edge-provided organizationId when available so the cloud and edge
  // share the same org ID — preventing duplicate organizations on subsequent syncs.
  const orgId = data.organizationId || crypto.randomUUID();
  await prisma.organization.create({
    data: { id: orgId, name: data.name },
  }).catch((err: any) => { if (err.code !== "P2002") throw err; });

  await prisma.outlet.create({
    data: {
      id: restaurantId,
      name: data.name,
      slug: data.slug,
      restaurantCode: data.restaurantCode,
      restaurantType: data.restaurantType,
      address: data.address,
      phone: data.phone,
      email: data.email,
      gstin: data.gstin,
      logoUrl: data.logoUrl,
      receiptHeader: data.receiptHeader,
      receiptSubHeader: data.receiptSubHeader,
      themePrimary: data.themePrimary,
      themeSecondary: data.themeSecondary,
      barUnitMl: data.barUnitMl,
      fullBottleMl: data.fullBottleMl,
      halfBottleMl: data.halfBottleMl,
      fssai: data.fssai,
      pricesIncludeGst: data.pricesIncludeGst,
      gstCategory: data.gstCategory,
      gstRate: data.gstRate,
      gstRegistered: data.gstRegistered,
      serviceChargePercent: data.serviceChargePercent,
      organizationId: orgId,
    },
  }).catch((err: any) => {
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent organization not found");
    }
    if (err.code === "P2002") return;
    throw err;
  });
  return { outcome: "applied" };
}

// ─── Upsert venue ────────────────────────────────────────────────────────────

async function upsertVenue(restaurantId: string, venueId: string, data: any): Promise<SyncItemResult> {
  await prisma.venue.upsert({
    where: { id: venueId },
    update: {
      name: data.name,
      venueType: data.venueType,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    },
    create: {
      id: venueId,
      restaurantId,
      name: data.name,
      venueType: data.venueType,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    },
  }).catch((err: any) => {
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent restaurant not found");
    }
    if (err.code === "P2002") return;
    throw err;
  });
  return { outcome: "applied" };
}

// ─── Upsert floor ────────────────────────────────────────────────────────────

async function upsertFloor(restaurantId: string, floorId: string, data: any): Promise<SyncItemResult> {
  await prisma.floor.upsert({
    where: { id: floorId },
    update: { name: data.name, sortOrder: data.sortOrder },
    create: {
      id: floorId,
      venueId: data.venueId,
      restaurantId,
      name: data.name,
      sortOrder: data.sortOrder,
    },
  }).catch((err: any) => {
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent venue not found");
    }
    if (err.code === "P2002") return;
    throw err;
  });
  return { outcome: "applied" };
}

// ─── Upsert section ──────────────────────────────────────────────────────────

async function upsertSection(restaurantId: string, sectionId: string, data: any): Promise<SyncItemResult> {
  await prisma.section.upsert({
    where: { id: sectionId },
    update: { name: data.name, sortOrder: data.sortOrder },
    create: {
      id: sectionId,
      name: data.name,
      restaurantId,
      floorId: data.floorId,
      sortOrder: data.sortOrder,
      isDefault: !!data.isDefault,
    },
  }).catch((err: any) => {
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent floor not found");
    }
    if (err.code === "P2002") return;
    throw err;
  });
  return { outcome: "applied" };
}

// ─── Upsert category ─────────────────────────────────────────────────────────

async function upsertCategory(restaurantId: string, categoryId: string, data: any): Promise<SyncItemResult> {
  await prisma.category.upsert({
    where: { id: categoryId },
    update: { name: data.name, sortOrder: data.sortOrder, isActive: data.isActive, printerTarget: data.printerTarget },
    create: {
      id: categoryId,
      name: data.name,
      restaurantId,
      sortOrder: data.sortOrder,
      isActive: data.isActive,
      printerTarget: data.printerTarget,
    },
  }).catch((err: any) => {
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent restaurant not found");
    }
    if (err.code === "P2002") return;
    throw err;
  });
  return { outcome: "applied" };
}

// ─── Upsert menu item with nested variants ───────────────────────────────────

async function upsertMenuItem(restaurantId: string, itemId: string, data: any): Promise<SyncItemResult> {
  const existing = await prisma.menuItem.findUnique({ where: { id: itemId } });

  // ── Conflict check: if the cloud row was updated more recently than the edge
  // edit, refuse the overwrite so the edge keeps it queued for review. This
  // prevents a cashier's offline edit from silently clobbering an admin's
  // newer cloud edit (last-write-wins would lose the admin change).
  if (existing && data.updatedAt && existing.updatedAt) {
    const edgeUpdatedAt = Number(data.updatedAt);
    const cloudUpdatedAt = new Date(existing.updatedAt).getTime();
    if (!Number.isNaN(edgeUpdatedAt) && !Number.isNaN(cloudUpdatedAt) && edgeUpdatedAt < cloudUpdatedAt) {
      logger.warn(`[EdgeSync] MenuItem ${itemId} conflict — edge updatedAt (${edgeUpdatedAt}) older than cloud (${cloudUpdatedAt})`);
      return { outcome: "conflict", message: "Cloud has a newer version of this item — manual review required" };
    }
  }

  const itemData: any = {
    id: itemId,
    name: data.name,
    description: data.description,
    imageUrl: data.imageUrl,
    isVeg: data.isVeg,
    isAvailable: data.isAvailable,
    sortOrder: data.sortOrder,
    categoryId: data.categoryId,
    restaurantId,
    basePrice: Number(data.basePrice || 0),
    unit: data.unit,
    isDeleted: data.isDeleted,
    printerTarget: data.printerTarget,
    printerName: data.printerName,
    menuType: data.menuType || "FOOD",
    gstEnabled: (data.menuType || "FOOD") === "LIQUOR" ? false : data.gstEnabled,
    isSpecial: data.isSpecial,
    specialChannel: data.specialChannel,
    specialActive: data.specialActive,
    specialExpiresAt: data.specialExpiresAt ? new Date(Number(data.specialExpiresAt)) : null,
  };

  if (existing) {
    await prisma.menuItem.update({ where: { id: itemId }, data: itemData }).catch((err: any) => {
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent category not found");
      }
      throw err;
    });
  } else {
    await prisma.menuItem.create({ data: itemData }).catch((err: any) => {
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent category not found");
      }
      if (err.code === "P2002") return;
      throw err;
    });
  }

  // Upsert nested variants
  if (data.variants && Array.isArray(data.variants)) {
    for (const variant of data.variants) {
      await upsertMenuItemVariant(restaurantId, variant.id, { ...variant, menuItemId: itemId });
    }
  }

  // ── Upsert venue prices (cashier edge edits may change per-venue pricing) ────
  if (data.venuePrices && Array.isArray(data.venuePrices)) {
    for (const vp of data.venuePrices) {
      if (!vp.venueId) continue;
      await prisma.venuePrice.upsert({
        where: { venueId_menuItemId: { venueId: vp.venueId, menuItemId: itemId } },
        create: {
          id: `vp-${vp.venueId}-${itemId}`,
          venueId: vp.venueId,
          menuItemId: itemId,
          restaurantId,
          price: Number(vp.price || 0),
          isActive: vp.isActive !== false,
        },
        update: {
          price: Number(vp.price || 0),
          isActive: vp.isActive !== false,
        },
      }).catch((err: any) => {
        // P2002 = unique constraint (harmless race, already applied).
        // P2003 = missing venue FK — return waiting_dependency so the sync retries
        if (err.code === "P2003") {
          throw new Error("WAITING_DEPENDENCY: parent venue not found");
        }
        if (err.code !== "P2002") logger.warn(`[EdgeSync] VenuePrice upsert failed for ${itemId}/${vp.venueId}: ${err.message}`);
      });
    }
  }

  // ── Upsert per-venue availability ───────────────────────────────────────────
  if (data.venueAvailabilities && Array.isArray(data.venueAvailabilities)) {
    for (const va of data.venueAvailabilities) {
      if (!va.venueId) continue;
      await prisma.venueMenuItemAvailability.upsert({
        where: { venueId_menuItemId: { venueId: va.venueId, menuItemId: itemId } },
        create: {
          id: `vmaa-${va.venueId}-${itemId}`,
          venueId: va.venueId,
          menuItemId: itemId,
          restaurantId,
          isAvailable: va.isAvailable !== false,
        },
        update: {
          isAvailable: va.isAvailable !== false,
        },
      }).catch((err: any) => {
        // P2003 = missing venue FK — return waiting_dependency so the sync retries
        if (err.code === "P2003") {
          throw new Error("WAITING_DEPENDENCY: parent venue not found");
        }
        if (err.code !== "P2002") logger.warn(`[EdgeSync] VenueAvailability upsert failed for ${itemId}/${va.venueId}: ${err.message}`);
      });
    }
  }

  // ── Emit config change to other edge servers + socket event to clients ──────
  // This keeps the admin web, other edge servers, and public menu clients in
  // sync with the cashier's edge edit after it lands in the cloud.
  try {
    const updatedItem = await prisma.menuItem.findUnique({
      where: { id: itemId },
      include: { variants: true },
    });
    if (updatedItem) {
      emitConfigChange(restaurantId, "menu_item", "upsert", updatedItem);
      const io = getIo();
      const payload = { itemId, action: "updated", updatedItem, restaurantId };
      io.to(restaurantId).emit("menu-item-updated", payload);
      io.to(`public:${restaurantId}`).emit("menu-item-updated", payload);
    }
  } catch (e: any) {
    logger.warn({ err: e, restaurantId, itemId }, "[EdgeSync] Failed to emit menu-item-updated after edge sync");
  }

  return { outcome: "applied" };
}

// ─── Upsert menu item variant ────────────────────────────────────────────────

async function upsertMenuItemVariant(restaurantId: string, variantId: string, data: any): Promise<SyncItemResult> {
  const existing = await prisma.menuItemVariant.findUnique({ where: { id: variantId } });

  const variantData: any = {
    id: variantId,
    name: data.name,
    price: Number(data.price || 0),
    isDefault: data.isDefault,
    menuItemId: data.menuItemId,
    isAvailable: data.isAvailable,
    restaurantId,
  };

  if (existing) {
    await prisma.menuItemVariant.update({ where: { id: variantId }, data: variantData }).catch((err: any) => {
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent menu item not found");
      }
      if (err.code !== "P2002") throw err;
    });
  } else {
    await prisma.menuItemVariant.create({ data: variantData }).catch((err: any) => {
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent menu item not found");
      }
      if (err.code === "P2002") return;
      throw err;
    });
  }
  return { outcome: "applied" };
}

// ─── Upsert user (staff account) ─────────────────────────────────────────────

async function upsertUser(restaurantId: string, userId: string, data: any): Promise<SyncItemResult> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });

  if (existing) {
    // On update, only set fields that are explicitly provided.
    // Never default role to 'CAPTAIN' — that would silently overwrite
    // cashiers/managers and cause them to appear in the captain login list.
    const updateData: any = {
      name: data.name,
      outletId: data.outletId || restaurantId,
      isActive: data.isActive,
    };
    if (data.pin !== undefined) updateData.pin = data.pin;
    if (data.role) updateData.role = data.role;
    await prisma.user.update({ where: { id: userId }, data: updateData }).catch((err: any) => {
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent outlet not found");
      }
      if (err.code === "P2002") return;
      throw err;
    });
  } else {
    const userData: any = {
      id: userId,
      name: data.name,
      pin: data.pin, // bcrypt hash — stored as-is
      role: data.role || 'CAPTAIN', // schema requires a role on create
      outletId: data.outletId || restaurantId, // User.outletId maps to Outlet.id
      isActive: data.isActive,
    };
    await prisma.user.create({ data: userData }).catch((err: any) => {
      if (err.code === "P2003") {
        throw new Error("WAITING_DEPENDENCY: parent outlet not found");
      }
      if (err.code === "P2002") return;
      throw err;
    });
  }
  return { outcome: "applied" };
}

// ─── Upsert transaction from edge settlement ─────────────────────────────────
//
// When the edge server settles an order locally, it stores payment details in
// edge_config and enqueues a "transaction" sync record. This handler receives
// that payment data, creates/updates the cloud Transaction record, and triggers
// inventory deduction (which only runs on the cloud).

async function upsertTransaction(restaurantId: string, txnId: string, data: any): Promise<SyncItemResult> {
  const {
    orderId,
    paymentMethod = "CASH",
    cashAmount,
    cardAmount,
    upiAmount,
    otherAmount,
    tipAmount,
    cashTipAmount,
    cardTipAmount,
    upiTipAmount,
    otherTipAmount,
    discountPercent,
    localTxnId,
    requestId,
    settledAt,
    isExtraTable = false,
    captainId: edgeCaptainId,
    // Edge-provided totals — used as fallback when cloud order items haven't synced yet
    subtotal: edgeSubtotal,
    discountAmount: edgeDiscountAmount,
    cgst: edgeCgst,
    sgst: edgeSgst,
    grandTotal: edgeGrandTotal,
    roundOff: edgeRoundOff,
    items: edgeItems,
  } = data;

  if (!orderId) {
    logger.warn(`[EdgeSync] Transaction ${txnId} has no orderId — skipping`);
    return { outcome: "permanent", message: `Transaction ${txnId} has no orderId` };
  }

  // Idempotency: check ProcessedRequest table — the browser's sync engine may have
  // already settled this order via /api/orders/:id/settle with the same requestId.
  if (requestId) {
    const existingSettle = await prisma.processedRequest.findUnique({
      where: {
        requestId_actionType_restaurantId: {
          requestId,
          actionType: 'settle',
          restaurantId,
        },
      },
    });
    if (existingSettle) {
      // A ProcessedRequest is only an idempotency marker. Verify the financial
      // record exists before acknowledging the edge queue item; older partial
      // failures could leave the marker without a Transaction row.
      const existingTransaction = await prisma.transaction.findFirst({
        where: { orderId, restaurantId },
        select: { id: true },
      });
      if (existingTransaction) {
        logger.info(`[EdgeSync] Transaction ${txnId} already exists as ${existingTransaction.id} for requestId=${requestId}`);
        return { outcome: "duplicate", message: `Transaction ${existingTransaction.id} already exists` };
      }
      logger.warn(`[EdgeSync] ProcessedRequest exists without Transaction for requestId=${requestId}; repairing settlement`);
    }
  }

  // Verify the order exists and belongs to this restaurant.
  // Optimization: when the edge provides totals (edgeSubtotal > 0), we can skip
  // loading order items + menuItem (the heaviest part of the query) since we'll
  // use edge totals anyway. We still need table info for section/venue/taxProfile.
  const edgeHasTotals = edgeSubtotal != null && Number(edgeSubtotal) > 0;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      // Only load items when we need to recalculate totals from cloud data
      ...(edgeHasTotals ? {} : {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: true },
        },
      }),
      table: { include: { section: { include: { venue: { include: { taxProfile: true } } } } } },
    },
  });

  // A transaction must not be accepted while its order is absent. Creating an
  // orderId=null orphan makes the edge dequeue the transaction, so it can never
  // be retried and linked after the order arrives. Keep the queue item pending;
  // the order sync will be retried independently and this transaction will then
  // be processed with its real order relation.
  const orderMissing = !order;
  if (orderMissing) {
    logger.warn(`[EdgeSync] Transaction ${txnId} references missing order ${orderId} — waiting for order sync`);
    return { outcome: "waiting_dependency", message: `Order ${orderId} not found for transaction sync; waiting for order sync` };
  }

  if (order && order.restaurantId !== restaurantId) {
    logger.warn(`[EdgeSync] Transaction ${txnId} order ${orderId} belongs to different restaurant`);
    return { outcome: "permanent", message: `Order ${orderId} belongs to different restaurant` };
  }

  // Process transaction if the order is settled (SETTLED/PAID) or in a
  // pre-settlement state (BILLING_REQUESTED/PREPARING). The edge may have
  // settled the order locally but the order sync might not have arrived yet.
  // upsertTransaction will mark the order PAID regardless.
  const orderStatus = orderMissing ? "PAID" : String(order!.status) as string;
  if (order && orderStatus === "CANCELLED") {
    logger.warn(`[EdgeSync] Transaction ${txnId} order ${orderId} is CANCELLED — skipping transaction creation`);
    return { outcome: "permanent", message: `Order ${orderId} is CANCELLED; no transaction should be created` };
  }

  // Calculate totals from order items (same logic as settleOrderService)
  // Optimization: skip tenant context resolution when edge provides all totals
  // (resolveTenantContext does 2 DB queries that aren't needed in that case)
  const ctx = edgeHasTotals ? null : await resolveTenantContext(restaurantId);

  // When order is missing, skip cloud-side recalculation and use edge totals directly
  let subtotal = 0;
  let discountAmount = 0;
  let cgst = 0;
  let sgst = 0;
  let serviceChargeAmount = 0;
  let grandTotal = 0;
  let roundOff = 0;
  let useEdgeTotals = true;

  if (order) {
    const venueTaxProfile = order.table?.section?.venue?.taxProfile;
    const taxSource = venueTaxProfile
      ? { gstRate: venueTaxProfile.gstRate, gstCategory: venueTaxProfile.gstCategory, gstRegistered: venueTaxProfile.gstRegistered, pricesIncludeGst: ctx?.pricesIncludeGst }
      : (ctx || { gstRate: null, gstCategory: undefined, gstRegistered: true, pricesIncludeGst: false, serviceChargePercent: 0 });

    // When edge provides totals, skip cloud-side recalculation entirely
    const orderItems = order.items || [];
    const foodItems = orderItems.filter((item: any) => item.menuItem?.menuType === "FOOD");
    const liquorItems = orderItems.filter((item: any) => {
      const mt = item.menuItem?.menuType as string;
      return mt === "LIQUOR" || mt === "BAR";
    });

    const foodSubtotal = foodItems.reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0);
    const liquorSubtotal = liquorItems.reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0);
    subtotal = foodSubtotal + liquorSubtotal;

    // GST-exempt items: any item (food or liquor) with gstEnabled=false is exempt.
    // Liquor defaults to gstEnabled=false (no GST) but admin can enable it per item.
    const gstExemptFood = foodItems
      .filter((item: any) => item.menuItem?.gstEnabled === false)
      .reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0);
    const gstExemptLiquor = liquorItems
      .filter((item: any) => item.menuItem?.gstEnabled === false)
      .reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0);
    const gstExemptTotal = gstExemptFood + gstExemptLiquor;

    const effectiveDiscountPercent = discountPercent != null ? Number(discountPercent) : 0;
    discountAmount = effectiveDiscountPercent > 0
      ? Math.round(subtotal * (effectiveDiscountPercent / 100) * 100) / 100
      : 0;

    const discountedSubtotal = Math.max(0, subtotal - discountAmount);
    const gstExemptAfterDiscount = Math.max(0, gstExemptTotal - (discountAmount > 0 && subtotal > 0 ? discountAmount * (gstExemptTotal / subtotal) : 0));
    const taxableAmount = Math.max(0, discountedSubtotal - gstExemptAfterDiscount);
    const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
    const gstResult = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!taxSource.pricesIncludeGst);
    cgst = gstResult.cgst;
    sgst = gstResult.sgst;
    const tax = gstResult.tax;
    const scPercent = Number(ctx?.serviceChargePercent || 0);
    serviceChargeAmount = scPercent > 0
      ? (discountedSubtotal + tax) * (scPercent / 100)
      : 0;
    const rawGrandTotal = Math.max(0, discountedSubtotal + tax + serviceChargeAmount);
    grandTotal = Math.round(rawGrandTotal);
    roundOff = Math.round((grandTotal - rawGrandTotal) * 100) / 100;

    // Fallback: if cloud order has no items or fewer items than edge (sync race
    // condition), use edge-provided totals. The edge already calculated these
    // from local SQLite — they're authoritative for the settlement moment.
    // Two conditions trigger the fallback:
    //   1. Cloud subtotal is 0 but edge has a non-zero subtotal (items not synced)
    //   2. Cloud grandTotal differs from edge grandTotal by more than ₹1
    //      (partial sync — some items arrived but not all)
    const edgeGtNum = edgeGrandTotal != null ? Number(edgeGrandTotal) : 0;
    useEdgeTotals = edgeSubtotal != null && Number(edgeSubtotal) > 0 && (
      subtotal === 0 ||
      (edgeGtNum > 0 && Math.abs(grandTotal - edgeGtNum) > 1)
    );
  }

  let finalSubtotal = subtotal;
  let finalDiscountAmount = discountAmount;
  let finalCgst = cgst;
  let finalSgst = sgst;
  let finalGrandTotal = grandTotal;
  let finalRoundOff = roundOff;

  if (useEdgeTotals) {
    logger.warn(`[EdgeSync] EDGE_FALLBACK: Order ${orderId} has no items in cloud — using edge totals (grandTotal=${edgeGrandTotal})`);
    finalSubtotal = Number(edgeSubtotal);
    finalDiscountAmount = Number(edgeDiscountAmount || 0);
    finalCgst = Number(edgeCgst || 0);
    finalSgst = Number(edgeSgst || 0);
    finalGrandTotal = Number(edgeGrandTotal || 0);
    finalRoundOff = Number(edgeRoundOff || 0);
  }

  const paidAt = settledAt ? new Date(Number(settledAt)) : new Date();
  // txnDate must reflect the actual settlement business day (IST), not the
  // sync-processing time. Sync can be delayed past midnight by network
  // outages, backoff, or cloud downtime — using `new Date()` here would
  // land the transaction on the wrong day and hide it from the admin
  // panel's "today" filter. Derive from paidAt (edge settledAt timestamp).
  const txnDate = getKolkataDateString(paidAt);

  // Check for existing transaction by orderId.
  // When order is missing, also check for a previously-created orphan transaction
  // (orderId=null, recoverySource='edge_no_order') so we can update it instead of
  // creating a duplicate.
  // When order IS found, also check for an orphan that was created while the
  // order was missing — if found, we link it by updating orderId.
  let existingTxn = !orderMissing
    ? await prisma.transaction.findUnique({
        where: { orderId },
        select: { id: true, txnNumber: true, status: true, grandTotal: true, orderId: true },
      })
    : await prisma.transaction.findFirst({
        where: { orderId: null, recoverySource: 'edge_no_order', restaurantId, grandTotal: Number(edgeGrandTotal) },
        select: { id: true, txnNumber: true, status: true, grandTotal: true, orderId: true },
      });

  let linkingOrphan = false;
  if (!existingTxn && !orderMissing && edgeGrandTotal != null) {
    // Order found but no transaction by orderId — check for an orphan created
    // during a prior sync when the order was missing.
    const orphan = await prisma.transaction.findFirst({
      where: { orderId: null, recoverySource: 'edge_no_order', restaurantId, grandTotal: Number(edgeGrandTotal) },
      select: { id: true, txnNumber: true, status: true, grandTotal: true, orderId: true },
    });
    if (orphan) {
      logger.info(`[EdgeSync] Found orphan transaction ${orphan.id} for order ${orderId} — linking via orderId update`);
      existingTxn = orphan;
      linkingOrphan = true;
    }
  }

  // Build transaction items from order items, falling back to edge-provided items
  // when cloud order items haven't synced yet (same race condition as totals)
  const txnItems = ((order && order.items && order.items.length > 0)
    ? order.items
    : (edgeItems || [])
  ).map((item: any) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    price: Number(item.price),
    menuType: item.menuType || (item.menuItem?.menuType) || "FOOD",
    menuItemId: item.menuItemId || undefined,
    gstEnabled: item.gstEnabled ?? item.menuItem?.gstEnabled ?? true,
  }));

  const txnData: any = {
    restaurantId,
    ...(orderMissing ? {} : { order: { connect: { id: orderId } } }),
    tableNumber: order ? (order.table?.number ?? null) : null,
    tableLabel: null,
    sectionTag: order ? ((order.table as any)?.sectionTag || null) : null,
    ...(order?.table?.sectionId ? { section: { connect: { id: order.table.sectionId } } } : {}),
    platform: order ? (order.platform || null) : null,
    captainId: order ? (order.captainId || (order.table as any)?.captainId || edgeCaptainId || null) : (edgeCaptainId || null),
    amount: new Prisma.Decimal(finalGrandTotal),
    method: String(paymentMethod).toUpperCase(),
    status: "COMPLETED",
    itemCount: txnItems.length,
    items: txnItems as any,
    subtotal: new Prisma.Decimal(finalSubtotal),
    discountPercent: new Prisma.Decimal(discountPercent != null ? Number(discountPercent) : 0),
    discountAmount: new Prisma.Decimal(finalDiscountAmount),
    cgst: new Prisma.Decimal(finalCgst),
    sgst: new Prisma.Decimal(finalSgst),
    grandTotal: new Prisma.Decimal(finalGrandTotal),
    roundOff: new Prisma.Decimal(finalRoundOff),
    ...(() => {
      const alloc = normalizeSettlementAllocations({
        paymentMethod: String(paymentMethod).toUpperCase(),
        grandTotal: Number(finalGrandTotal),
        tipAmount: Number(tipAmount || 0),
        cashAmount: Number(cashAmount || 0),
        cardAmount: Number(cardAmount || 0),
        upiAmount: Number(upiAmount || 0),
        otherAmount: Number(otherAmount || 0),
        cashTipAmount: Number(cashTipAmount || 0),
        cardTipAmount: Number(cardTipAmount || 0),
        upiTipAmount: Number(upiTipAmount || 0),
        otherTipAmount: Number(otherTipAmount || 0),
      });
      return {
        tipAmount: new Prisma.Decimal(Number(tipAmount || 0)),
        cashTipAmount: new Prisma.Decimal(alloc.cashTipAmount),
        cardTipAmount: new Prisma.Decimal(alloc.cardTipAmount),
        upiTipAmount: new Prisma.Decimal(alloc.upiTipAmount),
        otherTipAmount: new Prisma.Decimal(alloc.otherTipAmount),
        cashAmount: new Prisma.Decimal(alloc.cashAmount),
        cardAmount: new Prisma.Decimal(alloc.cardAmount),
        upiAmount: new Prisma.Decimal(alloc.upiAmount),
        otherAmount: new Prisma.Decimal(alloc.otherAmount),
      };
    })(),
    txnDate,
    billNumber: order ? (order.billNumber || null) : null,
    paidAt,
    confirmedAt: paidAt,
    recoverySource: orderMissing ? 'edge_no_order' : undefined,
  };

  let settledTxn: any = null;
  if (existingTxn) {
    if (linkingOrphan) {
      // Link orphan transaction: update orderId and clear recoverySource,
      // plus refresh any order-dependent fields that were null before.
      logger.info(`[EdgeSync] Linking orphan transaction ${existingTxn.id} to order ${orderId}`);
      settledTxn = await prisma.transaction.update({
        where: { id: existingTxn.id },
        data: { ...txnData, recoverySource: null },
      });
    } else if (existingTxn.status === "COMPLETED" && Number(existingTxn.grandTotal) > 0) {
      // Already has correct non-zero totals — skip update, proceed to inventory deduction
      logger.info(`[EdgeSync] Transaction for order ${orderId} already COMPLETED with total ${existingTxn.grandTotal} — skipping update`);
      settledTxn = await prisma.transaction.findUnique({ where: { id: existingTxn.id } });
    } else if (existingTxn.status === "COMPLETED" && Number(existingTxn.grandTotal) === 0 && finalGrandTotal > 0) {
      // Fix: a 0-total transaction was created by the sync race condition.
      // Now that we have correct totals (from edge fallback or cloud items), update it.
      logger.warn(`[EdgeSync] CORRECTING 0-total COMPLETED transaction ${existingTxn.id} → grandTotal=${finalGrandTotal} (source: ${useEdgeTotals ? "edge_fallback" : "cloud_recalc"})`);
      settledTxn = await prisma.transaction.update({
        where: { id: existingTxn.id },
        data: txnData,
      });
      // Audit trail for post-hoc financial correction
      await prisma.auditLog.create({
        data: {
          restaurantId,
          action: "TRANSACTION_TOTAL_CORRECTED",
          entityType: "Transaction",
          entityId: existingTxn.id,
          metadata: {
            previousGrandTotal: 0,
            correctedGrandTotal: finalGrandTotal,
            source: useEdgeTotals ? "edge_fallback" : "cloud_recalc",
            orderId,
            localTxnId,
          },
        },
      }).catch(() => {});
    } else {
      settledTxn = await prisma.transaction.update({
        where: { id: existingTxn.id },
        data: txnData,
      });
      logger.info(`[EdgeSync] Updated transaction ${existingTxn.id} for order ${orderId} from edge settlement`);
    }
  } else {
    // Get next txn number using the shared helper.
    // Pass txnDate (the settlement business day) so a delayed sync that
    // crosses midnight IST allocates from the correct day's counter, not
    // today's. Without this, a transaction settled yesterday that syncs
    // today would get a txnNumber from today's sequence.
    // Allocate the number and create the transaction atomically. If Prisma
    // validation or creation fails, the counter increment rolls back with the
    // transaction instead of consuming a number for a transaction that was
    // never stored.
    try {
      settledTxn = await prisma.$transaction(async (tx) => {
        txnData.txnNumber = await getNextTxnNumber(restaurantId, tx, txnDate);
        return await tx.transaction.create({ data: txnData });
      });
    } catch (err: any) {
      if (err.code !== "P2002") throw err;
      // P2002 on orderId — another sync beat us to it, that's fine
      logger.info(`[EdgeSync] Transaction for order ${orderId} already exists (P2002) — skipping`);
      settledTxn = null;
    }

    if (settledTxn) {
      logger.info(`[EdgeSync] Created transaction for order ${orderId} from edge settlement`);
    }
  }

  // ── Trigger inventory deduction ──────────────────────────────────────────────
  // Skip when order is missing — no order to deduct from or mark PAID.
  // Inventory deduction will run when the order eventually syncs and a
  // subsequent transaction sync links to it.
  // Also skip for old transactions (settled > 10 minutes ago) — the inventory
  // was already consumed at settlement time, and deducting now is both
  // meaningless and very slow (loads all inventory items). This dramatically
  // speeds up catch-up sync without affecting real-time settlements.
  const syncAgeMs = Date.now() - (settledAt ? Number(settledAt) : Date.now());
  const isCatchupSync = syncAgeMs > 10 * 60 * 1000; // 10 minutes
  if (order && !isCatchupSync) {
    try {
      const deductionResult = await prisma.$transaction(async (tx) => {
        // Lock the order row
        const lockedRows = await tx.$queryRaw<Array<{
          id: string; inventoryDeducted: boolean; barInventoryDeducted: boolean; settledAt: Date | null;
        }>>`
          SELECT "id", "inventoryDeducted", "barInventoryDeducted", "settledAt"
          FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
        `;
        const lockedRow = lockedRows[0];
        if (!lockedRow) {
          logger.warn(`[EdgeSync] Order ${orderId} not found for inventory deduction`);
          return null;
        }

        // Also ensure the order is marked PAID with paidAt and settledAt
        if (orderStatus !== "PAID") {
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: "PAID",
              paidAt: paidAt,
              settledAt: paidAt,
              billingRequested: false,
            },
          });
        } else if (!lockedRow.settledAt) {
          // Order was already PAID but settledAt was never set (older order)
          await tx.order.update({
            where: { id: orderId },
            data: { settledAt: paidAt },
          });
        }

        return await deductInventoryForOrder(orderId, restaurantId, tx, null);
      }, { timeout: 15000, maxWait: 20000 });

      // KOT cleanup for non-walk-in orders (mirrors settleOrderService behavior)
      if (!isExtraTable && order.table?.id) {
        try {
          await prisma.kot.deleteMany({
            where: { tableId: order.table.id, restaurantId },
          });
        } catch (kotErr: any) {
          logger.error(`[EdgeSync] KOT cleanup failed for table ${order.table.id}: ${kotErr.message}`);
        }
      }

      if (deductionResult) {
        logger.info(`[EdgeSync] Inventory deduction for order ${orderId}: bar errors=${deductionResult.barDeductionErrors.length}, kitchen errors=${deductionResult.kitchenDeductionErrors.length}`);

        // Emit inventory updates via socket
        try {
          const io = getIo();
          for (const update of deductionResult.inventoryUpdates) {
            io.to(restaurantId).emit("inventory:updated", {
              restaurantId,
              item: {
                id: update.id,
                name: update.name,
                currentStock: update.currentStock,
                reorderLevel: update.reorderLevel,
                unitOfMeasure: update.unitOfMeasure,
              },
            });
            if (update.isLowStock) {
              io.to(restaurantId).emit("inventory:low_stock", {
                restaurantId,
                item: {
                  id: update.id,
                  name: update.name,
                  currentStock: update.currentStock,
                  reorderLevel: update.reorderLevel,
                  unitOfMeasure: update.unitOfMeasure,
                },
              });
            }
          }
          io.to(restaurantId).emit("order:paid", {
            orderId,
            tableId: order.table?.id || null,
            paymentMethod: String(paymentMethod).toUpperCase(),
            isExtraTable,
            transaction: settledTxn,
          });

          // Emit table:terminated for non-walk-in orders (matches settleOrderService payload shape)
          if (!isExtraTable && order.table?.id) {
            io.to(restaurantId).emit("table:terminated", {
              restaurantId,
              tableId: order.table.id,
              terminatedAt: new Date().toISOString(),
              terminatedBy: null,
            });
          }
        } catch {
          // Socket not initialized — skip
        }
      }
    } catch (deductErr: any) {
      logger.error(`[EdgeSync] Inventory deduction failed for order ${orderId}: ${deductErr.message}`);
      // Don't fail the sync — the transaction was created, deduction can be retried
    }
  } else if (order && isCatchupSync) {
    // Catch-up sync: mark order as PAID and emit socket events, but skip
    // the heavy inventory deduction (stock was already consumed at settlement time)
    try {
      if (orderStatus !== "PAID") {
        await prisma.order.update({
          where: { id: orderId },
          data: {
            status: "PAID",
            paidAt: paidAt,
            billingRequested: false,
          },
        });
      }
      // KOT cleanup for non-walk-in orders
      if (!isExtraTable && order.table?.id) {
        try {
          await prisma.kot.deleteMany({
            where: { tableId: order.table.id, restaurantId },
          });
        } catch (kotErr: any) {
          logger.error(`[EdgeSync] KOT cleanup failed for table ${order.table.id}: ${kotErr.message}`);
        }
      }
      // Emit socket events so admin panel updates in real-time
      try {
        const io = getIo();
        io.to(restaurantId).emit("order:paid", {
          orderId,
          tableId: order.table?.id || null,
          paymentMethod: String(paymentMethod).toUpperCase(),
          isExtraTable,
          transaction: settledTxn,
        });
        if (!isExtraTable && order.table?.id) {
          io.to(restaurantId).emit("table:terminated", {
            restaurantId,
            tableId: order.table.id,
            terminatedAt: new Date().toISOString(),
            terminatedBy: null,
          });
        }
      } catch {
        // Socket not initialized — skip
      }
      logger.info(`[EdgeSync] Catch-up sync: marked order ${orderId} as PAID, skipped inventory deduction (settled ${Math.round(syncAgeMs / 1000)}s ago)`);
    } catch (markErr: any) {
      logger.error(`[EdgeSync] Failed to mark order ${orderId} as PAID during catch-up: ${markErr.message}`);
    }
  }

  // Clear all caches (org-scoped, matching direct settle path)
  // Skip during catch-up sync — cache invalidation is only needed for real-time
  if (!isCatchupSync) {
    await invalidateEdgeSyncCaches(restaurantId);
  }
  return { outcome: "applied" };
}

// ─── Upsert Walk-in Transaction (no order, no table) ─────────────────────────
// Creates a cloud Transaction record from edge walk-in transaction data.

async function upsertWalkinTransaction(restaurantId: string, txnId: string, data: any): Promise<SyncItemResult> {
  const {
    orderId = null,
    tableNumber = null,
    captainId = null,
    amount = 0,
    method = "CASH",
    itemCount = 0,
    items = [],
    subtotal = 0,
    discountPercent = 0,
    discountAmount = 0,
    cgst = 0,
    sgst = 0,
    grandTotal = 0,
    roundOff = 0,
    tipAmount = 0,
    sectionId = null,
    sectionTag = null,
    billNumber = null,
    platform = "CASHIER",
    txnDate,
    createdAt,
  } = data;

  // Deduplicate items
  let resolvedItems: any[] = [];
  if (Array.isArray(items) && items.length > 0) {
    const itemMap = new Map<string, any>();
    for (const item of items) {
      const qty = Number(item.quantity || item.q || 0);
      if (qty <= 0) continue;
      const name = (item.name || item.n || '').trim();
      const price = Number(item.price || item.p || 0);
      const key = `${name.toLowerCase()}::${price}`;
      const existing = itemMap.get(key);
      if (existing) {
        existing.quantity += qty;
      } else {
        itemMap.set(key, {
          name,
          quantity: qty,
          price,
          menuType: item.menuType || item.type || 'FOOD',
          menuItemId: item.menuItemId || item.id || undefined,
          gstEnabled: item.gstEnabled ?? true,
        });
      }
    }
    resolvedItems = Array.from(itemMap.values());
  }

  const paidAt = createdAt ? new Date(Number(createdAt)) : new Date();
  // txnDate fallback must use the actual transaction time (paidAt), not the
  // sync-processing time. Same rationale as upsertTransaction: sync can be
  // delayed past midnight IST, and using new Date() would land the walk-in
  // transaction on the wrong day, hiding it from the admin panel's date filter.
  const dateStr = txnDate || getKolkataDateString(paidAt);

  // Check for existing transaction by localId to prevent duplicates
  const existingTxn = await prisma.transaction.findFirst({
    where: {
      restaurantId,
      OR: [
        { orderId: txnId },
        { id: txnId },
      ],
    },
    select: { id: true, status: true },
  });

  if (existingTxn) {
    logger.info(`[EdgeSync] Walk-in transaction ${txnId} already exists — skipping`);
    return { outcome: "duplicate", message: `Walk-in transaction ${txnId} already exists` };
  }

  // Pass dateStr (the settlement business day derived from paidAt) so a
  // delayed sync that crosses midnight IST allocates from the correct day's
  // counter, not today's.
  const txnNumber = await prisma.$transaction(async (tx) => {
    return await getNextTxnNumber(String(restaurantId), tx, dateStr);
  });

  await prisma.transaction.create({
    data: {
      id: txnId,
      txnNumber,
      restaurantId,
      ...(orderId ? { order: { connect: { id: orderId } } } : {}),
      tableNumber: tableNumber ? Number(tableNumber) : null,
      captainId: captainId || null,
      amount: new Prisma.Decimal(grandTotal != null ? grandTotal : amount),
      method: String(method).toUpperCase(),
      itemCount: resolvedItems.length || Number(itemCount) || 0,
      items: resolvedItems.length > 0 ? resolvedItems : (items || []),
      subtotal: subtotal != null ? new Prisma.Decimal(subtotal) : null,
      discountPercent: discountPercent != null ? new Prisma.Decimal(discountPercent) : new Prisma.Decimal(0),
      discountAmount: discountAmount != null ? new Prisma.Decimal(discountAmount) : new Prisma.Decimal(0),
      cgst: cgst != null ? new Prisma.Decimal(cgst) : null,
      sgst: sgst != null ? new Prisma.Decimal(sgst) : null,
      grandTotal: grandTotal != null ? new Prisma.Decimal(grandTotal) : null,
      roundOff: roundOff != null ? new Prisma.Decimal(roundOff) : null,
      tipAmount: tipAmount != null ? new Prisma.Decimal(tipAmount) : new Prisma.Decimal(0),
      sectionTag: sectionTag || null,
      ...(sectionId ? { section: { connect: { id: sectionId } } } : {}),
      platform: platform || "CASHIER",
      billNumber: billNumber || null,
      status: "COMPLETED",
      paidAt,
      txnDate: dateStr,
    },
  }).catch((err: any) => {
    if (err.code === "P2002") return; // unique constraint (already exists)
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent order or section not found");
    }
    throw err;
  });

  await invalidateEdgeSyncCaches(restaurantId);
  logger.info(`[EdgeSync] Walk-in transaction ${txnId} created for restaurant ${restaurantId}`);
  return { outcome: "applied" };
}

// ─── Upsert Expenditure (edge-created cash payment) ─────────────────────────
// Idempotent: checks for existing expenditure by edge-generated stable ID before creating.

async function upsertExpenditure(restaurantId: string, expenditureId: string, data: any): Promise<SyncItemResult> {
  const {
    amount = 0,
    paidToType = "STAFF",
    paidToName = "Unknown",
    category = null,
    narration = null,
    approver = null,
    createdBy = null,
    expenditureNo = null,
    date = null,
    voided = false,
    employeeId = null,
    ledgerCategoryId = null,
    entryType = "EXPENSE",
  } = data;

  // Idempotency: check if expenditure already exists by edge-generated ID
  const existing = await prisma.expenditure.findUnique({
    where: { id: expenditureId },
    select: { id: true },
  });

  if (existing) {
    logger.info(`[EdgeSync] Expenditure ${expenditureId} already exists — skipping`);
    return { outcome: "duplicate", message: `Expenditure ${expenditureId} already exists` };
  }

  // Resolve createdById — required by Prisma schema (FK to User).
  // The edge sync sends names (not user IDs) in createdBy/approver fields,
  // so we can't use them directly as createdById. Always look up a valid user.
  let createdById: string | null = null;

  // Try to find the approver by name first
  if (approver) {
    const approverUser = await prisma.user.findFirst({
      where: { outletId: restaurantId, name: approver },
      select: { id: true },
    });
    if (approverUser) createdById = approverUser.id;
  }

  // Fallback: find the first admin/owner user for this restaurant
  if (!createdById) {
    const fallbackUser = await prisma.user.findFirst({
      where: { outletId: restaurantId, role: { in: ["OWNER", "ADMIN"] } },
      select: { id: true },
    });
    createdById = fallbackUser?.id || null;
  }

  // Fallback: find any user for this restaurant (cashier, captain, etc.)
  if (!createdById) {
    const anyUser = await prisma.user.findFirst({
      where: { outletId: restaurantId },
      select: { id: true },
    });
    createdById = anyUser?.id || null;
  }

  // Fallback: find any OWNER/ADMIN in the same organization
  if (!createdById) {
    try {
      const ctx = await resolveTenantContext(restaurantId);
      if (ctx.organizationId) {
        const orgUser = await prisma.user.findFirst({
          where: { role: { in: ["OWNER", "ADMIN"] } },
          select: { id: true, outletId: true },
        });
        // Verify the found user belongs to the same organization
        if (orgUser) {
          const userOutlet = await prisma.outlet.findUnique({
            where: { id: orgUser.outletId || "" },
            select: { organizationId: true },
          });
          if (userOutlet?.organizationId === ctx.organizationId) {
            createdById = orgUser.id;
          }
        }
      }
    } catch { /* ignore — fall through to error below */ }
  }

  // Last resort: if no user found at all, skip this expenditure with an error
  if (!createdById) {
    logger.warn(`[EdgeSync] No valid user found for expenditure ${expenditureId} — cannot create without createdById`);
    return { outcome: "error", message: "No valid user found for createdById; waiting for user sync" };
  }

  // Resolve employeeId for STAFF expenditures.
  // The edge sends the edge-generated employee ID. Verify it exists in cloud
  // (it may have been synced in the same batch). If not found by ID, fall back
  // to name-based lookup — this handles older edge payloads without employeeId.
  let resolvedEmployeeId: string | null = null;
  if (paidToType === "STAFF" && employeeId) {
    const emp = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (emp) {
      resolvedEmployeeId = emp.id;
    }
  }
  if (paidToType === "STAFF" && !resolvedEmployeeId && paidToName) {
    const empByName = await prisma.employee.findFirst({
      where: { restaurantId, name: { equals: paidToName, mode: "insensitive" } },
      select: { id: true },
    });
    if (empByName) resolvedEmployeeId = empByName.id;
  }

  // Resolve ledgerCategoryId for OTHER expenditures.
  // The edge sends the edge-generated category ID. Verify it exists in cloud.
  // If not found by ID, fall back to name-based lookup using the `category`
  // field (which holds the category name for OTHER expenditures).
  let resolvedLedgerCategoryId: string | null = null;
  const VALID_ENTRY_TYPES = ["ASSET", "LIABILITY", "GROCERY", "EXPENSE", "LIABILITY_PAYMENT"];
  const validEntryType = VALID_ENTRY_TYPES.includes(entryType) ? entryType : "EXPENSE";

  if (paidToType === "OTHER" && ledgerCategoryId) {
    const lc = await prisma.ledgerCategory.findUnique({
      where: { id: ledgerCategoryId },
      select: { id: true },
    });
    if (lc) {
      resolvedLedgerCategoryId = lc.id;
    }
  }
  if (paidToType === "OTHER" && !resolvedLedgerCategoryId && category) {
    const lcByName = await prisma.ledgerCategory.findFirst({
      where: {
        restaurantId,
        entryType: validEntryType,
        name: { equals: category, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (lcByName) resolvedLedgerCategoryId = lcByName.id;
  }

  await prisma.expenditure.create({
    data: {
      id: expenditureId,
      restaurantId,
      amount: new Prisma.Decimal(amount),
      paidToType: paidToType || "STAFF",
      paidToName: paidToName || "Unknown",
      category,
      narration,
      approvedByName: approver || null,
      createdById,
      employeeId: resolvedEmployeeId,
      ledgerCategoryId: resolvedLedgerCategoryId,
      entryType: validEntryType,
      expenditureNo: expenditureNo ? Number(expenditureNo) : Math.floor(Math.random() * 100000),
      expenditureDate: date || getKolkataDateString(),
      status: voided ? "VOIDED" : "ACTIVE",
    },
  }).catch((err: any) => {
    if (err.code === "P2002") return; // unique constraint (already exists)
    if (err.code === "P2003") {
      throw new Error("WAITING_DEPENDENCY: parent user/employee/ledger not found");
    }
    throw err;
  });

  logger.info(`[EdgeSync] Expenditure ${expenditureId} created for restaurant ${restaurantId} (employeeId=${resolvedEmployeeId || "none"}, ledgerCategoryId=${resolvedLedgerCategoryId || "none"}, entryType=${validEntryType})`);
  return { outcome: "applied" };
}

// ─── Upsert Employee (edge-created staff from expenditure) ──────────────────
// Idempotent: checks for existing employee by edge-generated ID before creating.
// Mirrors the cloud createEmployeeIfMissing logic in expenditures.ts — creates
// an Employee record with baseSalary 0, no role (admin assigns later).

async function upsertEmployee(restaurantId: string, employeeId: string, data: any): Promise<SyncItemResult> {
  const { name = "Unknown" } = data;

  // Idempotency: check if employee already exists by edge-generated ID
  const existing = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true },
  });

  if (existing) {
    logger.info(`[EdgeSync] Employee ${employeeId} already exists — skipping`);
    return { outcome: "duplicate", message: `Employee ${employeeId} already exists` };
  }

  // De-duplicate by name (case-insensitive) — if an employee with the same
  // name already exists for this restaurant, skip creation to avoid duplicates.
  const existingByName = await prisma.employee.findFirst({
    where: { restaurantId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });

  if (existingByName) {
    logger.info(`[EdgeSync] Employee with name "${name}" already exists for restaurant ${restaurantId} — skipping`);
    return { outcome: "duplicate", message: `Employee with name "${name}" already exists` };
  }

  await prisma.employee.create({
    data: {
      id: employeeId,
      restaurantId,
      name: name.trim(),
      baseSalary: new Prisma.Decimal(0),
      isActive: true,
      createdVia: "CASHIER",
    },
  }).catch((err: any) => {
    if (err.code === "P2002") return; // unique constraint (already exists)
    throw err;
  });

  logger.info(`[EdgeSync] Employee ${employeeId} ("${name}") created for restaurant ${restaurantId}`);
  return { outcome: "applied" };
}

// ─── Upsert Ledger Category (edge-created expense category) ─────────────────
// Idempotent: checks for existing category by edge-generated ID before creating.
// Mirrors the cloud ledgerCategories.ts create logic.

async function upsertLedgerCategory(restaurantId: string, categoryId: string, data: any): Promise<SyncItemResult> {
  const { name = "Unknown", entryType = "EXPENSE" } = data;

  const VALID_ENTRY_TYPES = ["ASSET", "LIABILITY", "GROCERY", "EXPENSE", "LIABILITY_PAYMENT"];
  const validEntryType = VALID_ENTRY_TYPES.includes(entryType) ? entryType : "EXPENSE";
  const normalizedName = name.trim().replace(/\s+/g, " ");

  // Idempotency: check if category already exists by edge-generated ID
  const existing = await prisma.ledgerCategory.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });

  if (existing) {
    logger.info(`[EdgeSync] LedgerCategory ${categoryId} already exists — skipping`);
    return { outcome: "duplicate", message: `LedgerCategory ${categoryId} already exists` };
  }

  // De-duplicate by name + entryType (case-insensitive) — matches the unique
  // constraint @@unique([restaurantId, entryType, name]) on LedgerCategory.
  const existingByName = await prisma.ledgerCategory.findFirst({
    where: {
      restaurantId,
      entryType: validEntryType,
      name: { equals: normalizedName, mode: "insensitive" },
    },
    select: { id: true, isActive: true },
  });

  if (existingByName) {
    // If deactivated, reactivate it
    if (!existingByName.isActive) {
      await prisma.ledgerCategory.update({
        where: { id: existingByName.id },
        data: { isActive: true },
      });
      logger.info(`[EdgeSync] LedgerCategory "${normalizedName}" reactivated for restaurant ${restaurantId}`);
      return { outcome: "applied" };
    }
    logger.info(`[EdgeSync] LedgerCategory "${normalizedName}" already exists for restaurant ${restaurantId} — skipping`);
    return { outcome: "duplicate", message: `LedgerCategory "${normalizedName}" already exists` };
  }

  await prisma.ledgerCategory.create({
    data: {
      id: categoryId,
      restaurantId,
      name: normalizedName,
      entryType: validEntryType,
    },
  });

  logger.info(`[EdgeSync] LedgerCategory ${categoryId} ("${normalizedName}") created for restaurant ${restaurantId}`);
  return { outcome: "applied" };
}

// ─── GET /api/edge/changes — Incremental config changes ──────────────────────
//
// Query: ?since=ISO_TIMESTAMP
// Returns: { timestamp, changes: [{ table, operation, row }] }
//
// Queries all config tables for rows updated since the given timestamp.
// The edge server polls this every 60 seconds as a backup to the socket
// real-time push.

router.get("/changes", authenticateEdge, async (req: any, res: Response) => {
  try {
    const restaurantId = getReqRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: "No restaurant ID in session" });
    }

    const sinceParam = (req.query.since as string) || new Date(0).toISOString();
    const since = new Date(sinceParam);

    const changes: Array<{ table: string; operation: string; row: any }> = [];

    // Get the outlet to determine organization scope
    const outlet = await prisma.outlet.findUnique({ where: { id: restaurantId } });
    if (!outlet) {
      return res.status(404).json({ error: "Outlet not found" });
    }

    // Each cashier PC downloads ONLY its own outlet's incremental changes.
    // Multi-outlet orgs have separate cashier PCs per outlet, each
    // linked with its own setup token. Downloading all outlets' data
    // caused verification mismatches and re-polluted the local DB.
    // Same fix as /api/edge/config (commit f0543b2).
    const restaurantIds: string[] = [restaurantId];

    // Query each config table for rows updated since `since`
    // Using Prisma queries with updatedAt filter

    // ── Outlet ──────────────────────────────────────────────────────────────
    // Outlet is a single row — always include it in changes
    if (outlet) {
      changes.push({ table: "outlet", operation: "upsert", row: outlet });
    }

    // ── Tax Profiles ────────────────────────────────────────────────────────
    const taxProfiles = await prisma.taxProfile.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const tp of taxProfiles) {
      changes.push({ table: "tax_profile", operation: "upsert", row: tp });
    }

    // ── Price Profiles ──────────────────────────────────────────────────────
    const priceProfiles = await prisma.priceProfile.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const pp of priceProfiles) {
      changes.push({ table: "price_profile", operation: "upsert", row: pp });
    }

    // ── Price Profile Items ─────────────────────────────────────────────────
    const priceProfileItems = await prisma.priceProfileItem.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const ppi of priceProfileItems) {
      changes.push({ table: "price_profile_item", operation: "upsert", row: ppi });
    }

    // ── Categories ──────────────────────────────────────────────────────────
    const categories = await prisma.category.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const c of categories) {
      changes.push({ table: "category", operation: "upsert", row: c });
    }

    // ── Menu Items ──────────────────────────────────────────────────────────
    const menuItems = await prisma.menuItem.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const m of menuItems) {
      changes.push({ table: "menu_item", operation: "upsert", row: m });
    }

    // ── Menu Item Variants ──────────────────────────────────────────────────
    // MenuItemVariant has no updatedAt — query via related menu items that changed
    const changedMenuItemIds = menuItems.map((m) => m.id);
    const variants = await prisma.menuItemVariant.findMany({
      where: { restaurantId: { in: restaurantIds }, menuItemId: { in: changedMenuItemIds } },
    });
    for (const v of variants) {
      changes.push({ table: "menu_item_variant", operation: "upsert", row: v });
    }

    // ── Menu Item Addons ────────────────────────────────────────────────────
    // MenuItemAddon has no updatedAt — query via related menu items that changed
    const addons = await prisma.menuItemAddon.findMany({
      where: { restaurantId: { in: restaurantIds }, menuItemId: { in: changedMenuItemIds } },
    });
    for (const a of addons) {
      changes.push({ table: "menu_item_addon", operation: "upsert", row: a });
    }

    // ── Combo Components ────────────────────────────────────────────────────
    // ComboComponent has no updatedAt — query via combo menu items that changed.
    // A combo's components are replaced on every PATCH /combos/:id, so any combo
    // menu item in the changed set will pull its current components here.
    const changedComboMenuItemIds = menuItems.filter((m: any) => m.isCombo).map((m) => m.id);
    if (changedComboMenuItemIds.length > 0) {
      const comboComponents = await prisma.comboComponent.findMany({
        where: { restaurantId: { in: restaurantIds }, comboMenuItemId: { in: changedComboMenuItemIds } },
      });
      for (const cc of comboComponents) {
        changes.push({ table: "combo_component", operation: "upsert", row: cc });
      }
    }

    // ── Venues ──────────────────────────────────────────────────────────────
    const venues = await prisma.venue.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const v of venues) {
      changes.push({ table: "venue", operation: "upsert", row: v });
    }

    // ── Floors ──────────────────────────────────────────────────────────────
    const floors = await prisma.floor.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const f of floors) {
      changes.push({ table: "floor", operation: "upsert", row: f });
    }

    // ── Sections ────────────────────────────────────────────────────────────
    const sections = await prisma.section.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const s of sections) {
      changes.push({ table: "section", operation: "upsert", row: s });
    }

    // ── Tables ──────────────────────────────────────────────────────────────
    const tables = await prisma.table.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const t of tables) {
      changes.push({ table: "table", operation: "upsert", row: t });
    }

    // ── Venue Prices ────────────────────────────────────────────────────────
    const venuePrices = await prisma.venuePrice.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const vp of venuePrices) {
      changes.push({ table: "venue_price", operation: "upsert", row: vp });
    }

    // ── Venue Menu Item Availability ────────────────────────────────────────
    const availability = await prisma.venueMenuItemAvailability.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
    });
    for (const va of availability) {
      changes.push({ table: "venue_menu_item_availability", operation: "upsert", row: va });
    }

    // ── Users (staff accounts) ──────────────────────────────────────────────
    const users = await prisma.user.findMany({
      where: { outletId: { in: restaurantIds }, updatedAt: { gte: since } },
      select: { id: true, name: true, pin: true, role: true, isActive: true, outletId: true, permissions: true },
    });
    for (const u of users) {
      changes.push({ table: "user", operation: "upsert", row: u });
    }

    // ── Ledger Categories (expense/asset/liability categories) ──────────────
    const ledgerCategories = await prisma.ledgerCategory.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
      select: { id: true, restaurantId: true, name: true, entryType: true, isActive: true },
    });
    for (const lc of ledgerCategories) {
      changes.push({ table: "ledger_category", operation: "upsert", row: lc });
    }

    // ── Employees (staff without login accounts) ────────────────────────────
    const employees = await prisma.employee.findMany({
      where: { restaurantId: { in: restaurantIds }, updatedAt: { gte: since } },
      select: { id: true, restaurantId: true, name: true, role: true, isActive: true },
    });
    for (const e of employees) {
      changes.push({ table: "employee", operation: "upsert", row: e });
    }

    // ── Transaction deletions (from AuditLog) ───────────────────────────────
    // Transactions are hard-deleted, so we can't query them by updatedAt.
    // Instead, query AuditLog for TRANSACTION_DELETE actions since the given
    // timestamp. The audit metadata contains orderId which the edge needs
    // to remove the local settle record.
    const txnDeleteAudits = await prisma.auditLog.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        action: "TRANSACTION_DELETE",
        createdAt: { gte: since },
      },
      select: { entityId: true, metadata: true },
    });
    for (const audit of txnDeleteAudits) {
      const meta = audit.metadata as any;
      changes.push({
        table: "transaction",
        operation: "delete",
        row: { id: audit.entityId, orderId: meta?.orderId || null },
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      changes,
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Changes endpoint error");
    res.status(500).json({ error: "Failed to fetch changes" });
  }
});

// ─── GET /api/edge/config — Full config download ─────────────────────────────
//
// Returns all config data for the restaurant in one response.
// Used by the edge server on initial registration or full resync.

router.get("/config", authenticateEdge, async (req: any, res: Response) => {
  try {
    const restaurantId = getReqRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: "No restaurant ID in session" });
    }

    // Get the outlet to determine organization scope
    const outlet = await prisma.outlet.findUnique({ where: { id: restaurantId } });
    if (!outlet) {
      return res.status(404).json({ error: "Outlet not found" });
    }

    const organizationId = outlet.organizationId;
    // Each cashier PC downloads ONLY its own outlet's data.
    // Multi-outlet orgs have separate cashier PCs per outlet, each
    // linked with its own setup token. Downloading all outlets' data
    // caused verification mismatches, oversized payloads, and timeouts.
    const allRestaurantIds: string[] = [restaurantId];

    const [
      taxProfiles,
      priceProfiles,
      priceProfileItems,
      venues,
      floors,
      sections,
      tables,
      categories,
      menuItems,
      menuVariants,
      menuAddons,
      comboComponents,
      venuePrices,
      venueAvailability,
      users,
      ledgerCategories,
      employees,
    ] = await Promise.all([
      prisma.taxProfile.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.priceProfile.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.priceProfileItem.findMany({
        where: { priceProfile: { restaurantId: { in: allRestaurantIds } } },
      }),
      prisma.venue.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.floor.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.section.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.table.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.category.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.menuItem.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.menuItemVariant.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.menuItemAddon.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.comboComponent.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.venuePrice.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.venueMenuItemAvailability.findMany({ where: { restaurantId: { in: allRestaurantIds } } }),
      prisma.user.findMany({
        where: { outletId: { in: allRestaurantIds } },
        select: { id: true, name: true, pin: true, role: true, isActive: true, outletId: true, permissions: true },
      }),
      prisma.ledgerCategory.findMany({
        where: { restaurantId: { in: allRestaurantIds } },
        select: { id: true, restaurantId: true, name: true, entryType: true, isActive: true },
      }),
      prisma.employee.findMany({
        where: { restaurantId: { in: allRestaurantIds }, isActive: true },
        select: { id: true, restaurantId: true, name: true, role: true, isActive: true },
      }),
    ]);

    res.json({
      outlet: {
        ...outlet,
        edgeApiKey: outlet?.edgeApiKey,
      },
      organizationId,
      taxProfiles,
      priceProfiles,
      priceProfileItems,
      venues,
      floors,
      sections,
      tables,
      categories,
      menuItems,
      menuVariants,
      menuAddons,
      comboComponents,
      venuePrices,
      venueAvailability,
      users,
      ledgerCategories,
      employees,
      counts: {
        taxProfiles: taxProfiles.length,
        priceProfiles: priceProfiles.length,
        priceProfileItems: priceProfileItems.length,
        venues: venues.length,
        floors: floors.length,
        sections: sections.length,
        tables: tables.length,
        categories: categories.length,
        menuItems: menuItems.length,
        menuVariants: menuVariants.length,
        menuAddons: menuAddons.length,
        comboComponents: comboComponents.length,
        venuePrices: venuePrices.length,
        venueAvailability: venueAvailability.length,
        users: users.length,
        ledgerCategories: ledgerCategories.length,
        employees: employees.length,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Config endpoint error");
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// ─── GET /api/edge/key — Fetch the LAN edge API key ──────────────────────────
//
// Authenticated frontend apps call this once (after login) and cache the key
// for all subsequent edgeFetch() calls via the X-Edge-Key header.

router.get("/key", authenticateEdge, async (req: any, res: Response) => {
  try {
    const restaurantId = getReqRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: "No restaurant ID in session" });
    }

    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { edgeApiKey: true },
    });

    if (!outlet?.edgeApiKey) {
      const edgeApiKey = crypto.randomBytes(32).toString("hex");
      await prisma.outlet.update({
        where: { id: restaurantId },
        data: { edgeApiKey },
      });
      return res.json({ edgeApiKey });
    }

    return res.json({ edgeApiKey: outlet.edgeApiKey });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Key endpoint error");
    res.status(500).json({ error: "Failed to fetch edge API key" });
  }
});

// ─── POST /api/edge/register — Edge server registration ──────────────────────
//
// Called by the edge server on first startup with a setup token.
// Returns the session token + restaurant ID that the edge server stores locally.
//
// The setup token may be a regular staff JWT or the short-lived agent-setup token
// generated from Admin → Printers (also used by the Windows Print Agent). Both are
// accepted. A fresh staff JWT is issued as the edge session token so authenticated
// endpoints such as /api/edge/config continue to work.
//
// Multi-agent: no hub guard — multiple edge servers can register for the same
// outlet. Each device gets its own entry in printerConfig.agents[deviceId].

interface SetupTokenPayload {
  restaurantId: string;
  userId?: string;
  role?: string;
}

function verifySetupToken(setupToken: string): SetupTokenPayload | null {
  try {
    const decoded = verifyToken(setupToken);
    const restaurantId = decoded.activeRestaurantId || decoded.restaurantId;
    if (!restaurantId) return null;
    return { restaurantId, userId: decoded.userId, role: decoded.role };
  } catch {
    try {
      const decoded = verifyAgentToken(setupToken);
      if (decoded.purpose !== "agent-setup") return null;
      if (!decoded.restaurantId) return null;
      return { restaurantId: decoded.restaurantId };
    } catch {
      return null;
    }
  }
}

router.post("/register", async (req: any, res: Response) => {
  try {
    const { setupToken, deviceId } = req.body;

    if (!setupToken) {
      return res.status(400).json({ error: "setupToken is required" });
    }

    // Verify the setup token — accept staff JWT or agent-setup token from Admin → Printers
    const tokenPayload = verifySetupToken(setupToken);
    if (!tokenPayload) {
      return res.status(401).json({ error: "Invalid or expired setup token" });
    }

    const { restaurantId, userId: tokenUserId, role: tokenRole } = tokenPayload;

    // Verify the outlet exists
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { id: true, name: true, restaurantCode: true, slug: true, organizationId: true, printerConfig: true },
    });

    if (!outlet) {
      return res.status(404).json({ error: "Outlet not found" });
    }

    // ── Resolve the user to bind the edge session token to ───────────────────
    // Prefer the user encoded in a staff JWT, otherwise fall back to an active owner/admin.
    let sessionUser: { id: string; role: string } | null = null;
    if (tokenUserId && tokenRole) {
      const user = await prisma.user.findUnique({
        where: { id: tokenUserId },
        select: { id: true, role: true, isActive: true },
      });
      if (user?.isActive) {
        sessionUser = { id: user.id, role: user.role };
      }
    }
    if (!sessionUser) {
      const ownerLike = await prisma.user.findFirst({
        where: {
          outletId: restaurantId,
          role: { in: ["OWNER", "ADMIN"] },
          isActive: true,
        },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        select: { id: true, role: true },
      });
      if (ownerLike) {
        sessionUser = { id: ownerLike.id, role: ownerLike.role };
      }
    }

    if (!sessionUser) {
      return res.status(400).json({
        error: "No active owner or admin user found for this outlet. Create an owner account before registering this device.",
      });
    }

    // ── Multi-agent: store per-device state, no hub guard ───────────────────
    let existingConfig: Record<string, any> = {};
    try {
      existingConfig = (outlet.printerConfig as Record<string, any>) || {};
      if (typeof existingConfig !== "object" || Array.isArray(existingConfig) || existingConfig === null) {
        existingConfig = {};
      }
    } catch {
      existingConfig = {};
    }

    const effectiveDeviceId = (typeof deviceId === "string" && deviceId) || `edge-${Date.now()}`;
    // Type-check agents — corrupted JSON could make it a non-object
    const existingAgents = (typeof existingConfig.agents === "object" && !Array.isArray(existingConfig.agents) && existingConfig.agents !== null)
      ? (existingConfig.agents as Record<string, any>)
      : {};
    const now = new Date().toISOString();

    // Auto-set primaryAgentId on first registration (same as print/agent-register).
    // Single-desktop outlets get primary automatically; admin can change later.
    const primaryAgentId = (typeof existingConfig.primaryAgentId === "string" && existingConfig.primaryAgentId) || effectiveDeviceId;

    // Update printerConfig with per-device state
    const newConfig = {
      ...existingConfig,
      agents: {
        ...existingAgents,
        [effectiveDeviceId]: {
          ...(existingAgents[effectiveDeviceId] || {}),
          lastSeen: now,
        },
      },
      primaryAgentId,
      lastAgentId: effectiveDeviceId,
      lastAgentSeen: now,
      agentOnline: true,
      agentLastSeen: now,
    };

    await prisma.outlet.update({
      where: { id: restaurantId },
      data: { printerConfig: newConfig },
    });

    // Issue an agent-scoped JWT as the edge session token. The setup token
    // (especially an agent-setup token) is not valid for authenticated endpoints
    // like /api/edge/config. We sign with AGENT role (not OWNER) so a leaked
    // edge session token cannot access staff endpoints (reports, payroll, etc.).
    // Edge routes use authenticateEdge which accepts agent tokens, and none of
    // them call requireRole, so AGENT role is sufficient for all edge operations.
    const sessionToken = signAgentToken(
      {
        restaurantId,
        purpose: "agent-session",
        agentId: deviceId || `edge-${Date.now()}`,
        restaurantCode: outlet.restaurantCode || undefined,
      },
      "30d",
    );

    // Return session info for the edge server
    res.json({
      success: true,
      restaurantId,
      restaurantName: outlet.name,
      sessionToken,
      backendUrl: `${req.protocol}://${req.get("host")}`,
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Register endpoint error");
    res.status(500).json({ error: "Registration failed" });
  }
});

// ─── POST /api/edge/register-offline — DEPRECATED ───────────────────────────
//
// This endpoint is deprecated. Offline onboarding (QuickOnboarding) has been
// retired. All restaurants must register via the 13-step web wizard
// (OnboardingWizard at /onboarding/legacy), then link the desktop app via
// /edge-setup which uses the authenticated /api/edge/register endpoint.
//
// The original implementation is commented out below for reference. It was
// unauthenticated and allowed anyone to create fake outlets in the database.
//
// Body: { restaurantId, deviceId, restaurantName, restaurantType, restaurantCode, slug, owner: { name, pin, phone } }
// Returns: { success, sessionToken, restaurantId, restaurantName, restaurantCode }

router.post("/register-offline", async (req: any, res: Response) => {
  return res.status(410).json({
    error: "Offline registration is deprecated. Please register via the web onboarding wizard, then link the desktop app using the setup token from Admin → Printers.",
  });

  // ── DEPRECATED IMPLEMENTATION (preserved for reference) ──────────────────
  // try {
  //   const { restaurantId, deviceId, restaurantName, restaurantType, restaurantCode, slug, organizationId: edgeOrgId, owner } = req.body;
  //
  //   if (!restaurantId || !restaurantName || !owner?.name || !owner?.pin) {
  //     return res.status(400).json({ error: "restaurantId, restaurantName, owner.name, and owner.pin are required" });
  //   }
  //
  //   // Check if outlet already exists (e.g. from a previous successful sync)
  //   const existing = await prisma.outlet.findUnique({ where: { id: restaurantId } });
  //
  //   let organizationId: string;
  //
  //   if (existing) {
  //     // Outlet already exists — use its organization
  //     organizationId = existing.organizationId;
  //     logger.info(`[EdgeSync] Register-offline: outlet ${restaurantId} already exists`);
  //   } else {
  //     // Create organization + outlet + owner user directly in Postgres.
  //     // Reuse the edge-provided org ID so edge and cloud share the same organization.
  //     const orgId = edgeOrgId || crypto.randomUUID();
  //     await prisma.organization.create({
  //       data: { id: orgId, name: restaurantName },
  //     }).catch((err: any) => { if (err.code !== "P2002") throw err; });
  //     organizationId = orgId;
  //
  //     await prisma.outlet.create({
  //       data: {
  //         id: restaurantId,
  //         name: restaurantName,
  //         slug: slug || restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  //         restaurantCode: restaurantCode || slug?.slice(0, 8).toUpperCase() || restaurantId.slice(0, 8).toUpperCase(),
  //         restaurantType: restaurantType || "DINE_IN_VEG",
  //         gstCategory: "NON_AC",
  //         gstRate: 5.0,
  //         gstRegistered: true,
  //         pricesIncludeGst: false,
  //         organizationId,
  //       },
  //     }).catch((err: any) => {
  //       if (err.code === "P2002") { logger.warn(`[EdgeSync] Outlet ${restaurantId} already exists (P2002)`); return; }
  //       throw err;
  //     });
  //
  //     // Create owner user
  //     const userId = crypto.randomUUID();
  //     await prisma.user.create({
  //       data: {
  //         id: userId,
  //         name: owner.name,
  //         pin: owner.pin, // bcrypt hash from edge server
  //         role: "OWNER",
  //         outletId: restaurantId,
  //         isActive: true,
  //       },
  //     }).catch((err: any) => {
  //       if (err.code === "P2003") { logger.warn(`[EdgeSync] Owner user references missing outlet — will retry`); throw err; }
  //       if (err.code !== "P2002") throw err;
  //     });
  //
  //     logger.info(`[EdgeSync] Register-offline: created outlet ${restaurantName} (${restaurantId}) + owner ${owner.name}`);
  //   }
  //
  //   const outlet = await prisma.outlet.findUnique({
  //     where: { id: restaurantId },
  //     select: { name: true, restaurantCode: true, slug: true, edgeApiKey: true },
  //   });
  //
  //   let edgeApiKey = outlet?.edgeApiKey;
  //   if (!edgeApiKey) {
  //     edgeApiKey = crypto.randomBytes(32).toString("hex");
  //     await prisma.outlet.update({
  //       where: { id: restaurantId },
  //       data: { edgeApiKey },
  //     });
  //   }
  //
  //   // Issue an agent-scoped token for the edge server (not a staff JWT).
  //   // This prevents a leaked edge session token from accessing staff endpoints.
  //   const sessionToken = signAgentToken(
  //     {
  //       restaurantId,
  //       purpose: "agent-session",
  //       agentId: deviceId || `edge-${Date.now()}`,
  //       restaurantCode: outlet?.restaurantCode || undefined,
  //     },
  //     "30d",
  //   );
  //
  //   logger.info(`[EdgeSync] Offline registration successful for ${outlet?.name} (${restaurantId})`);
  //
  //   res.json({
  //     success: true,
  //     sessionToken,
  //     restaurantId,
  //     restaurantName: outlet?.name || restaurantName,
  //     restaurantCode: outlet?.restaurantCode || restaurantCode,
  //     backendUrl: `${req.protocol}://${req.get("host")}`,
  //     edgeApiKey,
  //   });
  // } catch (err: any) {
  //   logger.error({ err }, "[EdgeSync] Register-offline endpoint error");
  //   res.status(500).json({ error: "Offline registration failed" });
  // }
});

// ─── POST /api/edge/refresh-session — Refresh an expired agent session token ──
//
// Called by the edge server's sync worker when it detects that its agent
// JWT has expired (or is about to expire). The expired token is sent in the
// Authorization header — we decode it (without verifying expiry) to extract
// the restaurantId, verify the outlet still exists, and issue a fresh token.
//
// This is unauthenticated (no authenticateEdge middleware) because the
// caller's token is expired. We trust the decoded payload's restaurantId
// because the token was signed with AGENT_JWT_SECRET — a valid signature
// proves the token was issued by us, even if it's now expired.
//
// Body: { deviceId?: string }
// Returns: { sessionToken, restaurantId, restaurantName, restaurantCode, backendUrl, expiresAt }

router.post("/refresh-session", async (req: any, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization header required" });
    }

    const expiredToken = authHeader.slice(7);

    // Decode the expired token to extract the payload (restaurantId, agentId).
    // We don't rely on jwt.verify here because the token IS expired — that's
    // the whole point of this endpoint. However, we DO verify the signature
    // (with ignoreExpiration) to prove the token was issued by us and hasn't
    // been tampered with.
    let payload: any;
    try {
      payload = jwt.verify(expiredToken, AGENT_JWT_SECRET, { ignoreExpiration: true }) as any;
    } catch {
      return res.status(401).json({ error: "Invalid token signature — cannot refresh" });
    }

    if (!payload || payload.purpose !== "agent-session") {
      return res.status(401).json({ error: "Not an agent session token" });
    }

    const restaurantId = payload.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: "Token has no restaurantId" });
    }

    // Verify the outlet still exists
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { id: true, name: true, restaurantCode: true, slug: true },
    });

    if (!outlet) {
      logger.warn(`[EdgeSync] Refresh-session: outlet ${restaurantId} not found`);
      return res.status(404).json({ error: "Outlet not found — re-register required" });
    }

    const deviceId = req.body?.deviceId || payload.agentId || `edge-${Date.now()}`;

    // Issue a fresh 30-day agent session token
    const sessionToken = signAgentToken(
      {
        restaurantId,
        purpose: "agent-session",
        agentId: deviceId,
        restaurantCode: outlet.restaurantCode || undefined,
      },
      "30d",
    );

    logger.info(`[EdgeSync] Session refreshed for ${outlet.name} (${restaurantId}), deviceId=${deviceId}`);

    res.json({
      success: true,
      sessionToken,
      restaurantId,
      restaurantName: outlet.name,
      restaurantCode: outlet.restaurantCode || "",
      backendUrl: `${req.protocol}://${req.get("host")}`,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Refresh-session endpoint error");
    res.status(500).json({ error: "Token refresh failed" });
  }
});

// ─── GET /api/edge/conflicts — List unresolved order sync conflicts ───────────
//
// Returns pending OrderConflict records for the admin app to surface
// for manual resolution (Phase 6).

router.get("/conflicts", authenticateEdge, async (req: any, res: Response) => {
  try {
    const restaurantId = getReqRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: "No restaurant ID in session" });
    }

    const conflicts = await prisma.orderConflict.findMany({
      where: { restaurantId, resolution: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({ conflicts });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Conflicts endpoint error");
    res.status(500).json({ error: "Failed to fetch conflicts" });
  }
});

// ─── POST /api/edge/conflicts/:id/resolve — Resolve a conflict ───────────────
//
// Body: { resolution: "RESOLVED_CLOUD" | "RESOLVED_EDGE" | "RESOLVED_MERGE" }

router.post("/conflicts/:id/resolve", authenticateEdge, async (req: any, res: Response) => {
  try {
    const restaurantId = getReqRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: "No restaurant ID in session" });
    }

    const { id } = req.params;
    const { resolution } = req.body;

    if (!["RESOLVED_CLOUD", "RESOLVED_EDGE", "RESOLVED_MERGE"].includes(resolution)) {
      return res.status(400).json({ error: "Invalid resolution value" });
    }

    const conflict = await prisma.orderConflict.findUnique({ where: { id } });
    if (!conflict || conflict.restaurantId !== restaurantId) {
      return res.status(404).json({ error: "Conflict not found" });
    }

    await prisma.orderConflict.update({
      where: { id },
      data: {
        resolution,
        resolvedAt: new Date(),
        resolvedBy: req.user?.userId || null,
      },
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Resolve conflict endpoint error");
    res.status(500).json({ error: "Failed to resolve conflict" });
  }
});

// ─── GET /api/edge/runtime-update-check — Runtime binary update manifest ──────
// Phase 5: The edge-server (Runtime) calls this to check if a new edge-server.exe
// binary is available. The Runtime Host polls the Runtime's /api/edge/update-check
// hourly, which in turn calls this endpoint.
//
// Returns:
//   { updateAvailable: boolean, downloadUrl: string|null, version: string|null }
//
// Driven by env vars so deployments can push updates without code changes:
//   RUNTIME_LATEST_VERSION  — semver string, e.g. "22.9.0"
//   RUNTIME_DOWNLOAD_URL    — public URL to download the new edge-server.exe
//
// The Host handles the actual download, binary swap, health probe, and rollback.

router.get("/runtime-update-check", authenticateEdge, (req: any, res: Response) => {
  try {
    const currentVersion = (req.query.currentVersion as string) || "0.0.0";
    const latestVersion = process.env.RUNTIME_LATEST_VERSION || null;
    const downloadUrl = process.env.RUNTIME_DOWNLOAD_URL || null;

    if (!latestVersion || !downloadUrl) {
      return res.json({
        updateAvailable: false,
        downloadUrl: null,
        version: null,
      });
    }

    const parseVer = (v: string) => v.split(".").map(Number);
    const [curMajor, curMinor, curPatch] = parseVer(currentVersion);
    const [newMajor, newMinor, newPatch] = parseVer(latestVersion);

    const isNewer =
      newMajor > curMajor ||
      (newMajor === curMajor && newMinor > curMinor) ||
      (newMajor === curMajor && newMinor === curMinor && newPatch > curPatch);

    res.json({
      updateAvailable: isNewer,
      downloadUrl: isNewer ? downloadUrl : null,
      version: latestVersion,
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Runtime update check error");
    res.status(500).json({ error: "Failed to check for runtime update" });
  }
});

export default router;
