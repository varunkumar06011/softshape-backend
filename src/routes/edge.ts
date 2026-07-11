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

import { Router, type Response } from "express";
import logger from "../lib/logger";
import prisma from "../lib/prisma";
import { verifyToken } from "../lib/auth";
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

    for (const item of batch) {
      try {
        await processSyncItem(authRestaurantId, item);
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

async function processSyncItem(restaurantId: string, item: any): Promise<void> {
  const { tableName, recordId, data } = item;

  switch (tableName) {
    case "order":
      await upsertOrder(restaurantId, recordId, data);
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

    default:
      logger.warn(`[EdgeSync] Unknown table: ${tableName}`);
      throw new Error(`Unknown table: ${tableName}`);
  }
}

// ─── Upsert order with nested items ──────────────────────────────────────────

async function upsertOrder(restaurantId: string, orderId: string, data: any): Promise<void> {
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
    // Update existing order
    const updateData: any = {
      status: orderData.status,
      totalAmount: orderData.totalAmount,
      captainId: orderData.captainId,
    };
    // Use edge's updated_at if provided (keep timestamps consistent)
    const edgeUpdatedAt = data.updated_at || data.updatedAt;
    if (edgeUpdatedAt) updateData.updatedAt = new Date(Number(edgeUpdatedAt));
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
      logger.warn(`[EdgeSync] Table ${tableId} references missing section — skipping create`);
      return;
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
    ]);

    res.json({
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
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Config endpoint error");
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// ─── POST /api/edge/register — Edge server registration ──────────────────────
//
// Called by the edge server on first startup with a setup token.
// Returns the session token + restaurant ID that the edge server stores locally.

router.post("/register", async (req: any, res: Response) => {
  try {
    const { setupToken } = req.body;

    if (!setupToken) {
      return res.status(400).json({ error: "setupToken is required" });
    }

    // Verify the setup token — it's a JWT with restaurantId
    let decoded: any;
    try {
      decoded = verifyToken(setupToken);
    } catch {
      return res.status(401).json({ error: "Invalid or expired setup token" });
    }

    const restaurantId = decoded.activeRestaurantId || decoded.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: "No restaurant ID in token" });
    }

    // Verify the outlet exists
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { id: true, name: true },
    });

    if (!outlet) {
      return res.status(404).json({ error: "Outlet not found" });
    }

    // Return session info for the edge server
    res.json({
      success: true,
      restaurantId,
      restaurantName: outlet.name,
      sessionToken: setupToken, // Reuse the setup token as session token
      backendUrl: `${req.protocol}://${req.get("host")}`,
    });
  } catch (err: any) {
    logger.error({ err }, "[EdgeSync] Register endpoint error");
    res.status(500).json({ error: "Registration failed" });
  }
});

export default router;
