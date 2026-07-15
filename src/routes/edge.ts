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
import { Router, type Response } from "express";
import logger from "../lib/logger";
import prisma from "../lib/prisma";
import { verifyToken, signToken } from "../lib/auth";
import { verifyAgentToken } from "../lib/agentToken";
import { authenticate } from "../middleware/auth";
import { getIo } from "../socket";

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

router.post("/sync", authenticate, async (req: any, res: Response) => {
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

  const orderData: any = {
    id: data.id || orderId,
    tableId: data.table_id || data.tableId,
    restaurantId,
    status: data.status || "PREPARING",
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

  const kotData: any = {
    id: data.id || kotId,
    restaurantId,
    tableId: data.table_id || data.tableId,
    orderId: data.order_id || data.orderId,
    kotNumber: Number(data.kot_number || data.kotNumber || 0),
  };
  if (kotCreatedAt) kotData.createdAt = kotCreatedAt;

  const existing = await prisma.kot.findUnique({ where: { id: kotId } });

  if (existing) {
    // Already synced — skip
    return;
  }

  await prisma.kot.create({ data: kotData }).catch((err: any) => {
    if (err.code !== "P2002") throw err;
  });

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

// ─── GET /api/edge/changes — Incremental config changes ──────────────────────
//
// Query: ?since=ISO_TIMESTAMP
// Returns: { timestamp, changes: [{ table, operation, row }] }
//
// Queries all config tables for rows updated since the given timestamp.
// The edge server polls this every 60 seconds as a backup to the socket
// real-time push.

router.get("/changes", authenticate, async (req: any, res: Response) => {
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

router.get("/config", authenticate, async (req: any, res: Response) => {
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

router.get("/key", authenticate, async (req: any, res: Response) => {
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

router.get("/conflicts", authenticate, async (req: any, res: Response) => {
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

router.post("/conflicts/:id/resolve", authenticate, async (req: any, res: Response) => {
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
