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
import { verifyToken, signToken } from "../lib/auth";
import { verifyAgentToken } from "../lib/agentToken";
import { authenticateEdge } from "../middleware/auth";
import { getIo } from "../socket";
import { getKolkataDateString } from "../utils/date";
import { deductInventoryForOrder } from "../services/inventoryService";
import { cacheClear } from "../lib/cache";
import { getNextTxnNumber } from "../lib/transactionHelpers";
import { resolveTenantContext } from "../lib/tenantContext";
import { getGstBreakdownWithRate, getEffectiveGstRate } from "../utils/gst";

const router = Router();

// ─── Helper: Get restaurant ID from authenticated request ────────────────────

function getReqRestaurantId(req: any): string | null {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId ?? null;
}

// ─── POST /api/edge/sync — Receive batch of records from edge server ─────────
//
// Body: { restaurantId, batch: [{ queueId, tableName, recordId, operation, data }] }
// Returns: { accepted: [queueId, ...], rejected: [{ queueId, error }] }
//
// The edge server enqueues locally created orders, KOTs, and table updates
// in its sync_queue. This endpoint receives them in batches and upserts
// into PostgreSQL. After successful upsert, the cloud emits socket events
// so dashboards and other clients see the changes in real-time.

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
    const rejected: Array<{ queueId: number; error: string }> = [];

    const deviceId = req.body.deviceId || null;

    for (const item of batch) {
      try {
        await processSyncItem(authRestaurantId, item, deviceId);
        accepted.push(item.queueId);
      } catch (err: any) {
        logger.error(`[EdgeSync] Failed to process ${item.tableName}/${item.recordId}: ${err.message}`);
        rejected.push({ queueId: item.queueId, error: err.message || "Unknown error" });
      }
    }

    logger.info(`[EdgeSync] Batch processed: ${accepted.length} accepted, ${rejected.length} rejected`);

    res.json({ accepted, rejected });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Sync endpoint error");
    res.status(500).json({ error: "Sync processing failed" });
  }
});

// ─── Process a single sync item ──────────────────────────────────────────────

async function processSyncItem(restaurantId: string, item: any, deviceId: string | null = null): Promise<void> {
  const { tableName, recordId, data } = item;

  switch (tableName) {
    case "order":
      await upsertOrder(restaurantId, recordId, data, deviceId);
      break;

    case "order_item":
      await upsertOrderItem(restaurantId, recordId, data);
      break;

    case "kot":
      await upsertKot(restaurantId, recordId, data);
      break;

    case "kot_item":
      await upsertKotItem(restaurantId, recordId, data);
      break;

    case "table":
      await upsertTable(restaurantId, recordId, data);
      break;

    case "outlet":
      await upsertOutlet(restaurantId, recordId, data);
      break;

    case "venue":
      await upsertVenue(restaurantId, recordId, data);
      break;

    case "floor":
      await upsertFloor(restaurantId, recordId, data);
      break;

    case "section":
      await upsertSection(restaurantId, recordId, data);
      break;

    case "category":
      await upsertCategory(restaurantId, recordId, data);
      break;

    case "menu_item":
      await upsertMenuItem(restaurantId, recordId, data);
      break;

    case "menu_item_variant":
      await upsertMenuItemVariant(restaurantId, recordId, data);
      break;

    case "users":
      await upsertUser(restaurantId, recordId, data);
      break;

    case "transaction":
      await upsertTransaction(restaurantId, recordId, data);
      break;

    default:
      logger.warn(`[EdgeSync] Unknown table: ${tableName}`);
      throw new Error(`Unknown table: ${tableName}`);
  }
}

// ─── Upsert order with nested items ──────────────────────────────────────────

async function upsertOrder(restaurantId: string, orderId: string, data: any, deviceId: string | null = null): Promise<void> {
  const createdAt = data.created_at || data.createdAt
    ? new Date(Number(data.created_at || data.createdAt))
    : undefined;

  // Map edge-specific statuses to cloud OrderStatus enum values.
  // The edge uses "SETTLED" for settled orders, but the cloud enum has "PAID".
  const rawStatus = data.status || "PREPARING";
  const cloudStatus = rawStatus === "SETTLED" ? "PAID" : rawStatus;

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
  };
  if (createdAt) orderData.createdAt = createdAt;

  // Idempotency: check by orderId first
  const existing = await prisma.order.findUnique({ where: { id: orderId } });

  // Also check by lastRequestId (edge server may generate new UUID on retry)
  if (!existing && orderData.lastRequestId) {
    const byRequestId = await prisma.order.findFirst({
      where: { restaurantId, lastRequestId: orderData.lastRequestId },
    });
    if (byRequestId) {
      // Already synced under a different ID — skip creation
      return;
    }
  }

  if (existing) {
    // ── Day-closed guard ──────────────────────────────────────────────────────
    // If this order has been locked by a "Close Day" action, reject the sync
    // upsert to prevent stale edge data from overwriting final numbers.
    if (existing.dayClosedAt) {
      logger.warn(`[EdgeSync] Order ${orderId} is day-closed (${existing.dayClosedAt}) — rejecting sync upsert from device ${deviceId}`);
      return;
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
    const updateData: any = {
      status: orderData.status,
      totalAmount: orderData.totalAmount,
      captainId: orderData.captainId,
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
  } else {
    // Create new order
    await prisma.order.create({ data: orderData }).catch((err: any) => {
      // P2002 = unique constraint violation (race condition or duplicate)
      if (err.code !== "P2002") throw err;
    });
  }

  // Upsert order items if present
  if (data.items && Array.isArray(data.items)) {
    for (const item of data.items) {
      await upsertOrderItem(restaurantId, item.id || item.order_item_id, { ...item, order_id: orderId });
    }
  }

  // Emit socket event for real-time dashboard updates
  try {
    const io = getIo();
    io.to(restaurantId).emit("order:updated", { orderId, restaurantId, status: orderData.status });
  } catch {
    // Socket not initialized — skip
  }
}

// ─── Upsert order item ───────────────────────────────────────────────────────

async function upsertOrderItem(restaurantId: string, itemId: string, data: any): Promise<void> {
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
      // P2002 = unique constraint violation (already exists)
      if (err.code !== "P2002") throw err;
    });
  }
}

// ─── Upsert KOT with nested items ────────────────────────────────────────────

async function upsertKot(restaurantId: string, kotId: string, data: any): Promise<void> {
  const kotCreatedAt = data.created_at || data.createdAt
    ? new Date(Number(data.created_at || data.createdAt))
    : undefined;

  const edgeKotNumber = Number(data.kot_number || data.kotNumber || 0);

  const kotData: any = {
    id: data.id || kotId,
    restaurantId,
    tableId: data.table_id || data.tableId,
    orderId: data.order_id || data.orderId,
    kotNumber: edgeKotNumber,
  };
  if (kotCreatedAt) kotData.createdAt = kotCreatedAt;

  const existing = await prisma.kot.findUnique({ where: { id: kotId } });

  if (existing) {
    // Already synced — skip
    return;
  }

  await prisma.kot.create({ data: kotData }).catch((err: any) => {
    if (err.code !== "P2002") throw err;
    // P2002 on (restaurantId, kotNumber) — the cloud already has a KOT with
    // this number (either cloud-generated or from another edge device). Log
    // it so operators are aware of the collision; the edge KOT is not in the
    // cloud DB but still exists locally on the edge server.
    logger.warn(`[EdgeSync] KOT ${kotId} from edge collides with existing KOT #${edgeKotNumber} for restaurant ${restaurantId} — edge KOT not persisted to cloud`);
  });

  // Advance the cloud's daily counter past the edge-assigned KOT number so
  // that cloud-generated KOT numbers (getNextKotNumber) never collide with
  // edge-synced ones. Uses GREATEST to avoid lowering the counter if a later
  // batch contains a lower number (out-of-order sync).
  if (edgeKotNumber > 0) {
    const counterDate = getKolkataDateString();
    await prisma.$executeRaw`
      INSERT INTO "DailyCounter" ("id", "restaurantId", "counterDate", "kotCount", "createdAt", "updatedAt")
      VALUES (${crypto.randomUUID()}, ${restaurantId}, ${counterDate}, ${edgeKotNumber}, NOW(), NOW())
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
}

// ─── Upsert KOT item ─────────────────────────────────────────────────────────

async function upsertKotItem(restaurantId: string, itemId: string, data: any): Promise<void> {
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
      if (err.code !== "P2002") throw err;
    });
  }
}

// ─── Upsert table status ─────────────────────────────────────────────────────

async function upsertTable(restaurantId: string, tableId: string, data: any): Promise<void> {
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
    // P2002 = unique constraint (race condition), P2003 = FK constraint (section doesn't exist)
    if (err.code === "P2003") {
      logger.warn(`[EdgeSync] Table ${tableId} references missing section — will retry`);
      throw err;
    }
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
}

// ─── Upsert outlet (restaurant settings) ────────────────────────────────────

async function upsertOutlet(restaurantId: string, _recordId: string, data: any): Promise<void> {
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
    return;
  }

  // Create organization first, then outlet
  const orgId = crypto.randomUUID();
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
    if (err.code === "P2003") { logger.warn(`[EdgeSync] Outlet ${restaurantId} references missing organization — will retry`); throw err; }
    if (err.code !== "P2002") throw err;
  });
}

// ─── Upsert venue ────────────────────────────────────────────────────────────

async function upsertVenue(restaurantId: string, venueId: string, data: any): Promise<void> {
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
    if (err.code === "P2003") { logger.warn(`[EdgeSync] Venue ${venueId} references missing restaurant — will retry`); throw err; }
    if (err.code !== "P2002") throw err;
  });
}

// ─── Upsert floor ────────────────────────────────────────────────────────────

async function upsertFloor(restaurantId: string, floorId: string, data: any): Promise<void> {
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
    if (err.code === "P2003") { logger.warn(`[EdgeSync] Floor ${floorId} references missing venue — will retry`); throw err; }
    if (err.code !== "P2002") throw err;
  });
}

// ─── Upsert section ──────────────────────────────────────────────────────────

async function upsertSection(restaurantId: string, sectionId: string, data: any): Promise<void> {
  await prisma.section.upsert({
    where: { id: sectionId },
    update: { name: data.name, sortOrder: data.sortOrder },
    create: {
      id: sectionId,
      name: data.name,
      restaurantId,
      floorId: data.floorId,
      sortOrder: data.sortOrder,
    },
  }).catch((err: any) => {
    if (err.code === "P2003") { logger.warn(`[EdgeSync] Section ${sectionId} references missing floor — will retry`); throw err; }
    if (err.code !== "P2002") throw err;
  });
}

// ─── Upsert category ─────────────────────────────────────────────────────────

async function upsertCategory(restaurantId: string, categoryId: string, data: any): Promise<void> {
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
    if (err.code === "P2003") { logger.warn(`[EdgeSync] Category ${categoryId} references missing restaurant — will retry`); throw err; }
    if (err.code !== "P2002") throw err;
  });
}

// ─── Upsert menu item with nested variants ───────────────────────────────────

async function upsertMenuItem(restaurantId: string, itemId: string, data: any): Promise<void> {
  const existing = await prisma.menuItem.findUnique({ where: { id: itemId } });

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
    gstEnabled: data.gstEnabled,
    isSpecial: data.isSpecial,
    specialChannel: data.specialChannel,
    specialActive: data.specialActive,
  };

  if (existing) {
    await prisma.menuItem.update({ where: { id: itemId }, data: itemData }).catch((err: any) => {
      if (err.code === "P2003") { logger.warn(`[EdgeSync] MenuItem ${itemId} references missing category — will retry`); throw err; }
      throw err;
    });
  } else {
    await prisma.menuItem.create({ data: itemData }).catch((err: any) => {
      if (err.code === "P2003") { logger.warn(`[EdgeSync] MenuItem ${itemId} references missing category — will retry`); throw err; }
      if (err.code !== "P2002") throw err;
    });
  }

  // Upsert nested variants
  if (data.variants && Array.isArray(data.variants)) {
    for (const variant of data.variants) {
      await upsertMenuItemVariant(restaurantId, variant.id, { ...variant, menuItemId: itemId });
    }
  }
}

// ─── Upsert menu item variant ────────────────────────────────────────────────

async function upsertMenuItemVariant(restaurantId: string, variantId: string, data: any): Promise<void> {
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
      if (err.code !== "P2002") throw err;
    });
  } else {
    await prisma.menuItemVariant.create({ data: variantData }).catch((err: any) => {
      if (err.code === "P2003") { logger.warn(`[EdgeSync] Variant ${variantId} references missing menu item — will retry`); throw err; }
      if (err.code !== "P2002") throw err;
    });
  }
}

// ─── Upsert user (staff account) ─────────────────────────────────────────────

async function upsertUser(restaurantId: string, userId: string, data: any): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });

  const userData: any = {
    id: userId,
    name: data.name,
    pin: data.pin, // bcrypt hash — stored as-is
    role: data.role || 'CAPTAIN',
    outletId: data.outletId || restaurantId, // User.outletId maps to Outlet.id
    isActive: data.isActive,
  };

  if (existing) {
    await prisma.user.update({ where: { id: userId }, data: userData }).catch((err: any) => {
      if (err.code !== "P2002") throw err;
    });
  } else {
    await prisma.user.create({ data: userData }).catch((err: any) => {
      if (err.code === "P2003") { logger.warn(`[EdgeSync] User ${userId} references missing restaurant — will retry`); throw err; }
      if (err.code !== "P2002") throw err;
    });
  }
}

// ─── Upsert transaction from edge settlement ─────────────────────────────────
//
// When the edge server settles an order locally, it stores payment details in
// edge_config and enqueues a "transaction" sync record. This handler receives
// that payment data, creates/updates the cloud Transaction record, and triggers
// inventory deduction (which only runs on the cloud).

async function upsertTransaction(restaurantId: string, txnId: string, data: any): Promise<void> {
  const {
    orderId,
    paymentMethod = "CASH",
    cashAmount,
    cardAmount,
    tipAmount,
    cashTipAmount,
    cardTipAmount,
    discountPercent,
    localTxnId,
    requestId,
    settledAt,
  } = data;

  if (!orderId) {
    logger.warn(`[EdgeSync] Transaction ${txnId} has no orderId — skipping`);
    return;
  }

  // Verify the order exists and belongs to this restaurant
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: true },
      },
      table: { include: { section: { include: { venue: { include: { taxProfile: true } } } } } },
    },
  });

  if (!order) {
    logger.warn(`[EdgeSync] Transaction ${txnId} references missing order ${orderId} — will retry`);
    throw new Error(`Order ${orderId} not found for transaction sync`);
  }

  if (order.restaurantId !== restaurantId) {
    logger.warn(`[EdgeSync] Transaction ${txnId} order ${orderId} belongs to different restaurant`);
    return;
  }

  // Process transaction if the order is settled (SETTLED/PAID) or in a
  // pre-settlement state (BILLING_REQUESTED/PREPARING). The edge may have
  // settled the order locally but the order sync might not have arrived yet.
  // upsertTransaction will mark the order PAID regardless.
  const orderStatus = String(order.status) as string;
  if (orderStatus === "CANCELLED") {
    logger.warn(`[EdgeSync] Transaction ${txnId} order ${orderId} is CANCELLED — skipping transaction creation`);
    return;
  }

  // Calculate totals from order items (same logic as settleOrderService)
  const ctx = await resolveTenantContext(restaurantId);
  const venueTaxProfile = order.table?.section?.venue?.taxProfile;
  const taxSource = venueTaxProfile
    ? { gstRate: venueTaxProfile.gstRate, gstCategory: venueTaxProfile.gstCategory, gstRegistered: venueTaxProfile.gstRegistered, pricesIncludeGst: ctx.pricesIncludeGst }
    : ctx;

  const foodItems = order.items.filter((item: any) => item.menuItem.menuType === "FOOD");
  const liquorItems = order.items.filter((item: any) => {
    const mt = item.menuItem.menuType as string;
    return mt === "LIQUOR" || mt === "BAR";
  });

  const subtotal = foodItems.reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0)
    + liquorItems.reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0);

  // Food: GST-exempt only when gstEnabled=false. Liquor/bar: always GST-exempt.
  const gstExemptFood = foodItems
    .filter((item: any) => item.menuItem.gstEnabled === false)
    .reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0);
  const gstExemptLiquor = liquorItems
    .reduce((sum: number, item: any) => sum + Number(item.price) * item.quantity, 0);
  const gstExemptTotal = gstExemptFood + gstExemptLiquor;

  const effectiveDiscountPercent = discountPercent != null ? Number(discountPercent) : 0;
  const discountAmount = effectiveDiscountPercent > 0
    ? Math.round(subtotal * (effectiveDiscountPercent / 100) * 100) / 100
    : 0;

  const discountedSubtotal = Math.max(0, subtotal - discountAmount);
  const gstExemptAfterDiscount = Math.max(0, gstExemptTotal - (discountAmount > 0 && subtotal > 0 ? discountAmount * (gstExemptTotal / subtotal) : 0));
  const taxableAmount = Math.max(0, discountedSubtotal - gstExemptAfterDiscount);
  const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
  const { cgst, sgst, tax } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!taxSource.pricesIncludeGst);
  const scPercent = Number(ctx.serviceChargePercent || 0);
  const serviceChargeAmount = scPercent > 0
    ? (discountedSubtotal + tax) * (scPercent / 100)
    : 0;
  const rawGrandTotal = Math.max(0, discountedSubtotal + tax + serviceChargeAmount);
  const grandTotal = Math.round(rawGrandTotal);
  const roundOff = Math.round((grandTotal - rawGrandTotal) * 100) / 100;

  const txnDate = getKolkataDateString();
  const paidAt = settledAt ? new Date(Number(settledAt)) : new Date();

  // Check for existing transaction by orderId
  const existingTxn = await prisma.transaction.findUnique({
    where: { orderId },
    select: { id: true, txnNumber: true, status: true },
  });

  // Build transaction items from order items
  const txnItems = order.items.map((item: any) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    price: Number(item.price),
    menuType: item.menuItem?.menuType || "FOOD",
    menuItemId: item.menuItemId || undefined,
    gstEnabled: item.menuItem?.gstEnabled ?? true,
  }));

  const txnData: any = {
    restaurantId,
    orderId,
    tableNumber: order.table?.number ?? null,
    tableLabel: null,
    sectionTag: (order.table as any)?.sectionTag || null,
    sectionId: order.table?.sectionId || null,
    platform: order.platform || null,
    captainId: order.captainId || (order.table as any)?.captainId || null,
    amount: new Prisma.Decimal(grandTotal),
    method: String(paymentMethod).toUpperCase(),
    status: "COMPLETED",
    itemCount: txnItems.length,
    items: txnItems as any,
    subtotal: new Prisma.Decimal(subtotal),
    discountPercent: new Prisma.Decimal(effectiveDiscountPercent),
    discountAmount: new Prisma.Decimal(discountAmount),
    cgst: new Prisma.Decimal(cgst),
    sgst: new Prisma.Decimal(sgst),
    grandTotal: new Prisma.Decimal(grandTotal),
    roundOff: new Prisma.Decimal(roundOff),
    tipAmount: new Prisma.Decimal(tipAmount || 0),
    cashTipAmount: new Prisma.Decimal(cashTipAmount ?? (String(paymentMethod).toUpperCase() === "CASH" ? (tipAmount || 0) : 0)),
    cardTipAmount: new Prisma.Decimal(cardTipAmount ?? (String(paymentMethod).toUpperCase() === "CARD" ? (tipAmount || 0) : 0)),
    cashAmount: new Prisma.Decimal(cashAmount || 0),
    cardAmount: new Prisma.Decimal(cardAmount || 0),
    txnDate,
    billNumber: order.billNumber || null,
    paidAt,
    confirmedAt: paidAt,
  };

  if (existingTxn) {
    // Update existing transaction if it's not already COMPLETED
    if (existingTxn.status === "COMPLETED") {
      logger.info(`[EdgeSync] Transaction for order ${orderId} already COMPLETED — skipping update`);
    } else {
      await prisma.transaction.update({
        where: { id: existingTxn.id },
        data: txnData,
      });
      logger.info(`[EdgeSync] Updated transaction ${existingTxn.id} for order ${orderId} from edge settlement`);
    }
  } else {
    // Get next txn number using the shared helper
    const txnNumber = await prisma.$transaction(async (tx) => {
      return await getNextTxnNumber(restaurantId, tx);
    });

    txnData.txnNumber = txnNumber;

    await prisma.transaction.create({
      data: txnData,
    }).catch((err: any) => {
      if (err.code !== "P2002") throw err;
      // P2002 on orderId — another sync beat us to it, that's fine
      logger.info(`[EdgeSync] Transaction for order ${orderId} already exists (P2002) — skipping`);
    });

    logger.info(`[EdgeSync] Created transaction for order ${orderId} from edge settlement`);
  }

  // ── Trigger inventory deduction ──────────────────────────────────────────────
  // The edge server cannot deduct inventory (bar/kitchen stock lives in the cloud
  // DB). When a settled order arrives via sync, we run the same deduction logic
  // used by settleOrderService. This is idempotent — it checks the
  // barInventoryDeducted / inventoryDeducted flags on the order.
  try {
    const deductionResult = await prisma.$transaction(async (tx) => {
      // Lock the order row
      const lockedRows = await tx.$queryRaw<Array<{
        id: string; inventoryDeducted: boolean; barInventoryDeducted: boolean;
      }>>`
        SELECT "id", "inventoryDeducted", "barInventoryDeducted"
        FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
      `;
      const lockedRow = lockedRows[0];
      if (!lockedRow) {
        logger.warn(`[EdgeSync] Order ${orderId} not found for inventory deduction`);
        return null;
      }

      // Also ensure the order is marked PAID with paidAt
      if (orderStatus !== "PAID") {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: "PAID",
            paidAt: paidAt,
            billingRequested: false,
          },
        });
      }

      return await deductInventoryForOrder(orderId, restaurantId, tx, null);
    }, { timeout: 15000, maxWait: 20000 });

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
          paymentMethod: String(paymentMethod).toUpperCase(),
          isExtraTable: false,
        });
      } catch {
        // Socket not initialized — skip
      }
    }
  } catch (deductErr: any) {
    logger.error(`[EdgeSync] Inventory deduction failed for order ${orderId}: ${deductErr.message}`);
    // Don't fail the sync — the transaction was created, deduction can be retried
  }

  // Clear transaction cache
  cacheClear("transactions:");
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

    // Query each config table for rows updated since `since`
    // Using Prisma queries with updatedAt filter

    // ── Outlet ──────────────────────────────────────────────────────────────
    // Outlet is a single row — always include it in changes
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
    }).catch(() => null);
    if (outlet) {
      changes.push({ table: "outlet", operation: "upsert", row: outlet });
    }

    // ── Tax Profiles ────────────────────────────────────────────────────────
    const taxProfiles = await prisma.taxProfile.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const tp of taxProfiles) {
      changes.push({ table: "tax_profile", operation: "upsert", row: tp });
    }

    // ── Price Profiles ──────────────────────────────────────────────────────
    const priceProfiles = await prisma.priceProfile.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const pp of priceProfiles) {
      changes.push({ table: "price_profile", operation: "upsert", row: pp });
    }

    // ── Price Profile Items ─────────────────────────────────────────────────
    const priceProfileItems = await prisma.priceProfileItem.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const ppi of priceProfileItems) {
      changes.push({ table: "price_profile_item", operation: "upsert", row: ppi });
    }

    // ── Categories ──────────────────────────────────────────────────────────
    const categories = await prisma.category.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const c of categories) {
      changes.push({ table: "category", operation: "upsert", row: c });
    }

    // ── Menu Items ──────────────────────────────────────────────────────────
    const menuItems = await prisma.menuItem.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const m of menuItems) {
      changes.push({ table: "menu_item", operation: "upsert", row: m });
    }

    // ── Menu Item Variants ──────────────────────────────────────────────────
    // MenuItemVariant has no updatedAt — query via related menu items that changed
    const changedMenuItemIds = menuItems.map((m) => m.id);
    const variants = await prisma.menuItemVariant.findMany({
      where: { restaurantId, menuItemId: { in: changedMenuItemIds } },
    });
    for (const v of variants) {
      changes.push({ table: "menu_item_variant", operation: "upsert", row: v });
    }

    // ── Menu Item Addons ────────────────────────────────────────────────────
    // MenuItemAddon has no updatedAt — query via related menu items that changed
    const addons = await prisma.menuItemAddon.findMany({
      where: { restaurantId, menuItemId: { in: changedMenuItemIds } },
    });
    for (const a of addons) {
      changes.push({ table: "menu_item_addon", operation: "upsert", row: a });
    }

    // ── Venues ──────────────────────────────────────────────────────────────
    const venues = await prisma.venue.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const v of venues) {
      changes.push({ table: "venue", operation: "upsert", row: v });
    }

    // ── Floors ──────────────────────────────────────────────────────────────
    const floors = await prisma.floor.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const f of floors) {
      changes.push({ table: "floor", operation: "upsert", row: f });
    }

    // ── Sections ────────────────────────────────────────────────────────────
    const sections = await prisma.section.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const s of sections) {
      changes.push({ table: "section", operation: "upsert", row: s });
    }

    // ── Tables ──────────────────────────────────────────────────────────────
    const tables = await prisma.table.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const t of tables) {
      changes.push({ table: "table", operation: "upsert", row: t });
    }

    // ── Venue Prices ────────────────────────────────────────────────────────
    const venuePrices = await prisma.venuePrice.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const vp of venuePrices) {
      changes.push({ table: "venue_price", operation: "upsert", row: vp });
    }

    // ── Venue Menu Item Availability ────────────────────────────────────────
    const availability = await prisma.venueMenuItemAvailability.findMany({
      where: { restaurantId, updatedAt: { gte: since } },
    });
    for (const va of availability) {
      changes.push({ table: "venue_menu_item_availability", operation: "upsert", row: va });
    }

    // ── Users (staff accounts) ──────────────────────────────────────────────
    const users = await prisma.user.findMany({
      where: { outletId: restaurantId, updatedAt: { gte: since } },
      select: { id: true, name: true, pin: true, role: true, isActive: true, outletId: true, permissions: true },
    });
    for (const u of users) {
      changes.push({ table: "user", operation: "upsert", row: u });
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

    const [
      outlet,
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
      venuePrices,
      venueAvailability,
      users,
    ] = await Promise.all([
      prisma.outlet.findUnique({ where: { id: restaurantId } }),
      prisma.taxProfile.findMany({ where: { restaurantId } }),
      prisma.priceProfile.findMany({ where: { restaurantId } }),
      prisma.priceProfileItem.findMany({
        where: { priceProfile: { restaurantId } },
      }),
      prisma.venue.findMany({ where: { restaurantId } }),
      prisma.floor.findMany({ where: { restaurantId } }),
      prisma.section.findMany({ where: { restaurantId } }),
      prisma.table.findMany({ where: { restaurantId } }),
      prisma.category.findMany({ where: { restaurantId } }),
      prisma.menuItem.findMany({ where: { restaurantId } }),
      prisma.menuItemVariant.findMany({ where: { restaurantId } }),
      prisma.menuItemAddon.findMany({ where: { restaurantId } }),
      prisma.venuePrice.findMany({ where: { restaurantId } }),
      prisma.venueMenuItemAvailability.findMany({ where: { restaurantId } }),
      prisma.user.findMany({
        where: { outletId: restaurantId },
        select: { id: true, name: true, pin: true, role: true, isActive: true, outletId: true, permissions: true },
      }),
    ]);

    res.json({
      outlet: {
        ...outlet,
        edgeApiKey: outlet?.edgeApiKey,
      },
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
      venuePrices,
      venueAvailability,
      users,
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
// Hub guard: checks printerConfig for an existing active hub. If another device
// is already registered as hub for this outlet and has heartbeated within the
// last 24 hours, rejects with 409. If the existing hub is stale (>24h no
// heartbeat), allows re-registration. If the same deviceId re-registers, allows.

const HUB_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

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

    // ── Hub guard: check for an existing active hub ──────────────────────────
    let existingConfig: Record<string, any> = {};
    try {
      existingConfig = (outlet.printerConfig as Record<string, any>) || {};
      if (typeof existingConfig !== "object" || Array.isArray(existingConfig) || existingConfig === null) {
        existingConfig = {};
      }
    } catch {
      existingConfig = {};
    }

    const existingAgentId = existingConfig.lastAgentId || existingConfig.agentId || null;
    const agentLastSeen = existingConfig.agentLastSeen || existingConfig.lastAgentSeen || null;

    if (existingAgentId && agentLastSeen) {
      const lastSeenDate = new Date(agentLastSeen);
      const elapsedMs = Date.now() - lastSeenDate.getTime();
      const isStale = elapsedMs > HUB_STALE_THRESHOLD_MS;

      if (!isStale && existingAgentId !== deviceId) {
        logger.warn(
          { restaurantId, existingAgentId, newDeviceId: deviceId, lastSeen: agentLastSeen },
          "[EdgeSync] Hub registration rejected — another hub is active for this outlet",
        );
        return res.status(409).json({
          error: "Another hub device is already active for this outlet",
          existingHub: { agentId: existingAgentId, lastSeen: agentLastSeen },
          hint: "If the previous hub is no longer in use, wait 24 hours for it to go stale, or use the admin app to deactivate it.",
        });
      }

      if (isStale) {
        logger.info(
          { restaurantId, existingAgentId, elapsedMs },
          "[EdgeSync] Previous hub is stale — allowing re-registration",
        );
      }
    }

    // Update printerConfig with the new hub's identity
    const newConfig = {
      ...existingConfig,
      lastAgentId: deviceId || `edge-${Date.now()}`,
      lastAgentSeen: new Date().toISOString(),
      agentOnline: true,
      agentLastSeen: new Date().toISOString(),
    };

    await prisma.outlet.update({
      where: { id: restaurantId },
      data: { printerConfig: newConfig },
    });

    // Issue a real staff JWT as the edge session token. The setup token (especially
    // an agent-setup token) is not valid for authenticated endpoints like /api/edge/config.
    const sessionToken = signToken({
      userId: sessionUser?.id || `edge-${deviceId || "unknown"}`,
      role: sessionUser?.role || "OWNER",
      restaurantId,
      activeRestaurantId: restaurantId,
      organizationId: outlet.organizationId,
      restaurantCode: outlet.restaurantCode,
      slug: outlet.slug || "",
    });

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

// ─── POST /api/edge/register-offline — Register after offline onboarding ─────
//
// Called by the edge server after offline onboarding when connectivity returns.
// Creates the outlet, organization, and owner user directly in Postgres from
// the onboarding payload — this breaks the circular dependency where sync
// can't push because there's no JWT, and register-offline can't issue a JWT
// because the outlet doesn't exist yet.
//
// After this call succeeds, the edge server has a real JWT and the sync worker
// can push the remaining records (venue, floor, section, tables, menu, etc.)
// via the normal sync path. Those upserts will be idempotent (P2002 catches).
//
// Body: { restaurantId, deviceId, restaurantName, restaurantType, restaurantCode, slug, owner: { name, pin, phone } }
// Returns: { success, sessionToken, restaurantId, restaurantName, restaurantCode }

router.post("/register-offline", async (req: any, res: Response) => {
  try {
    const { restaurantId, deviceId, restaurantName, restaurantType, restaurantCode, slug, owner } = req.body;

    if (!restaurantId || !restaurantName || !owner?.name || !owner?.pin) {
      return res.status(400).json({ error: "restaurantId, restaurantName, owner.name, and owner.pin are required" });
    }

    // Check if outlet already exists (e.g. from a previous successful sync)
    const existing = await prisma.outlet.findUnique({ where: { id: restaurantId } });

    let organizationId: string;

    if (existing) {
      // Outlet already exists — use its organization
      organizationId = existing.organizationId;
      logger.info(`[EdgeSync] Register-offline: outlet ${restaurantId} already exists`);
    } else {
      // Create organization + outlet + owner user directly in Postgres
      const orgId = crypto.randomUUID();
      await prisma.organization.create({
        data: { id: orgId, name: restaurantName },
      }).catch((err: any) => { if (err.code !== "P2002") throw err; });
      organizationId = orgId;

      await prisma.outlet.create({
        data: {
          id: restaurantId,
          name: restaurantName,
          slug: slug || restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          restaurantCode: restaurantCode || slug?.slice(0, 8).toUpperCase() || restaurantId.slice(0, 8).toUpperCase(),
          restaurantType: restaurantType || "DINE_IN_VEG",
          gstCategory: "NON_AC",
          gstRate: 5.0,
          gstRegistered: true,
          pricesIncludeGst: false,
          organizationId,
        },
      }).catch((err: any) => {
        if (err.code === "P2002") { logger.warn(`[EdgeSync] Outlet ${restaurantId} already exists (P2002)`); return; }
        throw err;
      });

      // Create owner user
      const userId = crypto.randomUUID();
      await prisma.user.create({
        data: {
          id: userId,
          name: owner.name,
          pin: owner.pin, // bcrypt hash from edge server
          role: "OWNER",
          outletId: restaurantId,
          isActive: true,
        },
      }).catch((err: any) => {
        if (err.code === "P2003") { logger.warn(`[EdgeSync] Owner user references missing outlet — will retry`); throw err; }
        if (err.code !== "P2002") throw err;
      });

      logger.info(`[EdgeSync] Register-offline: created outlet ${restaurantName} (${restaurantId}) + owner ${owner.name}`);
    }

    // Find the owner user for this outlet (to get userId for JWT)
    const ownerUser = await prisma.user.findFirst({
      where: { outletId: restaurantId, role: "OWNER" },
      select: { id: true, role: true },
    });

    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, restaurantCode: true, slug: true, edgeApiKey: true },
    });

    let edgeApiKey = outlet?.edgeApiKey;
    if (!edgeApiKey) {
      edgeApiKey = crypto.randomBytes(32).toString("hex");
      await prisma.outlet.update({
        where: { id: restaurantId },
        data: { edgeApiKey },
      });
    }

    // Issue a real JWT for the edge server
    const sessionToken = signToken({
      userId: ownerUser?.id || `edge-${deviceId || 'unknown'}`,
      role: ownerUser?.role || "OWNER",
      restaurantId,
      activeRestaurantId: restaurantId,
      organizationId,
      restaurantCode: outlet?.restaurantCode,
      slug: outlet?.slug || '',
    });

    logger.info(`[EdgeSync] Offline registration successful for ${outlet?.name} (${restaurantId})`);

    res.json({
      success: true,
      sessionToken,
      restaurantId,
      restaurantName: outlet?.name || restaurantName,
      restaurantCode: outlet?.restaurantCode || restaurantCode,
      backendUrl: `${req.protocol}://${req.get("host")}`,
      edgeApiKey,
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Register-offline endpoint error");
    res.status(500).json({ error: "Offline registration failed" });
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

export default router;
