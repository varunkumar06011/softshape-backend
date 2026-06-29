// ─────────────────────────────────────────────────────────────────────────────
// Orders Routes — Order lifecycle management (create, update, settle, cancel)
// ─────────────────────────────────────────────────────────────────────────────
// The core business logic route — manages the complete order lifecycle:
//   - Order creation (from captain app, customer QR, or admin panel)
//   - Item additions and modifications (quantity, variants, notes)
//   - Order status transitions (PENDING → CONFIRMED → PREPARING → READY → BILLING → SETTLED)
//   - Bill settlement with GST, discounts, service charge calculation
//   - Print job buffering for KOTs and receipts
//   - Real-time socket updates on order changes
//   - Bar inventory auto-deduction on settlement
//   - Captain assignment and tracking
//   - Table status management (AVAILABLE ↔ OCCUPIED ↔ BILLING)
//   - Order merging and table transfers
//   - GST breakdown calculation (CGST/SGST based on restaurant GST config)
//   - Price resolution per venue (via resolveItemPrice)
//
// Endpoints (partial list — 30+ endpoints):
//   GET    /api/orders                    — list orders (with filters)
//   POST   /api/orders                    — create a new order
//   GET    /api/orders/:id                — get order details
//   PATCH  /api/orders/:id                — update order (status, items)
//   POST   /api/orders/:id/items          — add items to an order
//   PATCH  /api/orders/:id/items/:itemId  — update an order item
//   DELETE /api/orders/:id/items/:itemId  — remove an item from order
//   POST   /api/orders/:id/settle         — settle the bill (create transaction)
//   POST   /api/orders/:id/cancel         — cancel an order
//   POST   /api/orders/:id/transfer       — transfer order to another table
//   POST   /api/orders/:id/merge          — merge orders from multiple tables
//   GET    /api/orders/active             — list all active orders
//   ...and more
// ─────────────────────────────────────────────────────────────────────────────

import { OrderStatus, Prisma, TableStatus, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { randomUUID } from "crypto";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import { getKolkataDateString } from "../utils/date";
import { isBeerItem } from "../utils/itemHelpers";
import prisma from "../lib/prisma";
import { resolveItemPrice } from "../lib/priceResolver";
import { cacheMiddleware, invalidateCache, cacheClear } from "../lib/cache";
import { resolveTenantContext, isBarOutlet, isVenueOutlet, type TenantContext } from "../lib/tenantContext";
import { getGstBreakdown, getEffectiveGstRate, getGstBreakdownWithRate } from "../utils/gst";
import { authenticate, requireRole } from "../middleware/auth";
import { createAuditLog } from "../lib/auditLog";
import { createOrderService, updateOrderItemsService, cancelOrderItemsService, cancelOrderItemService, printBillService, settleOrderService } from "../services/orderService";
import { transferOrderItemsService } from "../services/tableService";

const router = Router();

router.use(authenticate);
const BAR_UNIT_ML = 30;
const BAR_FULL_BOTTLE_MULTIPLIER = 25;

import { acquireLock } from "../lib/redisLock";

const PRINT_LOCK_KEY = (orderId: string) => `print_lock:order:${orderId}`;
const PRINT_LOCK_TTL = 5; // seconds
const BILL_DEDUP_WINDOW_MS = Number(process.env.BILL_DEDUP_WINDOW_MS) || 5000;

const EMIT_LOCK_KEY = (key: string) => `emit_lock:order:${key}`;
const EMIT_LOCK_TTL = 10; // seconds

import { getCaptainName } from "../utils/captainMap";
import {
  buildFoodKOT,
  buildLiquorKOT,
  buildFinalBill,
  buildCancelKOT,
  type BillPrintRestaurant,
} from "../utils/escpos";

// ── Daily-sequential Transaction counter ──────────────────────────────────
// Must be called inside a Prisma transaction (tx) so the increment is atomic.
async function getNextTxnNumber(
  restaurantId: string,
  tx: any
): Promise<number> {
  const counterDate = getKolkataDateString();

  return await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { txnCount: { increment: 1 } },
    create: { restaurantId, counterDate, txnCount: 1 },
    // Add select to ensure atomic read
    select: { txnCount: true }
  }).then((c: { txnCount: number }) => c.txnCount);
}

const warnedPrinterConfigRestaurantIds = new Set<string>();
const warnedNoPrintersRestaurantIds = new Set<string>();
const warnedUnrecognizedTargetRestaurantIds = new Set<string>();

function normalizePrinterConfig(printerConfig: Record<string, any>): {
  printers: Array<{ name?: string; type?: string }>;
  valid: boolean;
} {
  const raw = printerConfig?.printers;
  if (Array.isArray(raw)) return { printers: raw, valid: true };
  if (raw && typeof raw === 'object') return { printers: Object.values(raw), valid: true };
  if (raw !== undefined && raw !== null) {
    console.warn('[PrinterConfig] Unrecognized printers shape:', { sample: String(raw).slice(0, 100) });
  }
  return { printers: [], valid: false };
}

async function loadPrinterConfig(restaurantId: string) {
  const r = await prisma.outlet.findUnique({
    where: { id: restaurantId },
    select: { printerConfig: true }
  });
  const config = (r?.printerConfig as Record<string, any>) || {};
  const { valid } = normalizePrinterConfig(config);
  if (!valid && !warnedPrinterConfigRestaurantIds.has(restaurantId) && r?.printerConfig !== null && r?.printerConfig !== undefined) {
    warnedPrinterConfigRestaurantIds.add(restaurantId);
    console.warn(`[PrinterConfig] Invalid shape for restaurant ${restaurantId}`);
  }
  return config;
}

function resolvePrinterName(
  restaurantId: string,
  itemPrinterName: string | null | undefined,
  itemPrinterTarget: string | null | undefined,
  categoryPrinterTarget: string | null | undefined,
  printerConfig: Record<string, any>
): string | undefined {
  if (itemPrinterName) return itemPrinterName;
  const target = (itemPrinterTarget || categoryPrinterTarget)?.toUpperCase();
  if (!target) return undefined;

  const { printers, valid } = normalizePrinterConfig(printerConfig);
  if (!valid || printers.length === 0) {
    if (!warnedNoPrintersRestaurantIds.has(restaurantId)) {
      warnedNoPrintersRestaurantIds.add(restaurantId);
      console.warn(`[PrinterConfig] No valid printers for target ${target} (restaurant ${restaurantId})`);
    }
    return undefined;
  }

  const normalized = printers.map((p) => ({
    name: p.name,
    type: String(p.type || '').toUpperCase(),
    nameLower: String(p.name || '').toLowerCase(),
  }));

  if (target === 'BAR_PRINTER') {
    return normalized.find((p) => p.type === 'BAR')?.name
      || normalized.find((p) => p.nameLower.includes('bar'))?.name;
  }
  if (target === 'KOT_PRINTER') {
    return normalized.find((p) => p.type === 'KITCHEN')?.name
      || normalized.find((p) => p.nameLower.includes('kitchen'))?.name
      || normalized.find((p) => p.type === 'KOT')?.name;
  }
  if (!warnedUnrecognizedTargetRestaurantIds.has(restaurantId)) {
    warnedUnrecognizedTargetRestaurantIds.add(restaurantId);
    console.warn(`[PrinterConfig] Unrecognized printer target: ${target} (restaurant ${restaurantId})`);
  }
  return undefined;
}

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.BILLING_REQUESTED,
];

const orderInclude = {
  table: {
    include: {
      section: { select: { id: true, name: true, restaurantId: true } },
    },
  },
  items: {
    where: { removedFromBill: false, quantity: { gt: 0 } },
    orderBy: { id: "asc" },
  },
} as const;

// Cancel routes need to broadcast cancelled items so the captain can mark them as struck-through.
// Do NOT use this for billing/pay routes.
const orderIncludeWithCancelled = {
  table: {
    include: {
      section: { select: { id: true, name: true, restaurantId: true } },
    },
  },
  items: {
    orderBy: { id: "asc" },
  },
} as const;

const tableInclude = {
  section: {
    select: {
      id: true,
      name: true,
      restaurantId: true,
      venueId: true,
      venue: { select: { id: true, name: true, venueType: true } },
    },
  },
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: { updatedAt: "desc" },
    take: 1,
    include: {
      items: {
        where: { removedFromBill: false },
        orderBy: { id: "asc" },
      },
    },
  },
} as const;

type IncomingOrderItem = {
  menuItemId?: string;
  name?: string;
  price?: number;
  quantity?: number;
  notes?: string | null;
  menuType?: string;
};

type NormalizedOrderItem = {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  notes: string | null;
  menuType: "FOOD" | "LIQUOR";
};

function normalizeItems(items: unknown): NormalizedOrderItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items must be a non-empty array");
  }

  return items.map((item, index) => {
    const raw = item as IncomingOrderItem;
    const menuItemId = raw.menuItemId?.trim();
    const name = raw.name?.trim();
    const price = Number(raw.price);
    const quantity = Number(raw.quantity);
    const menuType: "FOOD" | "LIQUOR" = raw.menuType === "LIQUOR" ? "LIQUOR" : "FOOD";

    if (!menuItemId || !name || !Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid item at index ${index}`);
    }

    return {
      menuItemId,
      name,
      price,
      quantity: Math.round(quantity),   // cast float (2.0) → integer (2)
      notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null,
      menuType,
    };
  });
}

function totalAmount(items: Array<{ price: number | Prisma.Decimal; quantity: number }>): Prisma.Decimal {
  return items.reduce(
    (sum, item) => sum.add(new Prisma.Decimal(item.price).mul(new Prisma.Decimal(item.quantity))),
    new Prisma.Decimal(0)
  );
}

// ── Daily-sequential KOT counter ──────────────────────────────────────────
// Must be called inside a Prisma transaction (tx) so the increment is atomic.
async function getNextKotNumber(
  restaurantId: string,
  tx: any
): Promise<number> {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const counterDate = nowIST.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const counter = await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { kotCount: { increment: 1 } },
    create: { restaurantId, counterDate, kotCount: 1 },
  });

  return counter.kotCount;
}

async function kotEntryFromItems(
  items: Array<{ name: string; price: number; quantity: number; id?: string; orderItemId?: string } | any>,
  restaurantId: string,
  tx: any
) {
  const kotNumber = await getNextKotNumber(restaurantId, tx);
  const now = new Date();
  return {
    id: String(kotNumber),
    time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
    items: items.map((item) => ({
      id: item.menuItemId || item.id,
      n: item.name,
      p: item.price,
      q: item.quantity,
      s: 'KOT Sent',
      orderItemId: item.id || item.orderItemId,
    })),
  };
}

async function appendKotHistory(
  existing: unknown,
  items: Array<{ name: string; price: number; quantity: number; id?: string; orderItemId?: string } | any>,
  restaurantId: string,
  tx: any
) {
  const history = Array.isArray(existing) ? existing : [];
  return [...history, await kotEntryFromItems(items, restaurantId, tx)];
}

async function emitToRestaurant(restaurantId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
  if (eventName === "print_job") {
    // print_job goes to the DEDICATED print room (print:<restaurantId>).
    // Only PrintStation joins this room via the "join:print" event.
    // Captain / cashier sockets only join the plain restaurant room, so
    // they will never receive print_job — eliminating the double-delivery bug.
    const printRoom = `print:${restaurantId}`;

    // Emit-level lock to prevent duplicate emissions for the same logical job
    const type = (payload as any).type;
    const orderId = (payload as any).orderId || (payload.data as any)?.orderId;
    const kotId = (payload as any).kotId || (payload.data as any)?.kotId;
    const tableNumber = (payload as any).tableNumber || (payload.data as any)?.tableNumber;
    const itemCount = (payload.data as any)?.items?.length || 0;

    // Include requestId and billNumber in lock key to prevent false collision across different requests / orders
    const requestId = (payload as any).requestId || (payload.data as any)?.requestId || '';
    const billNumber = (payload as any).billNumber || (payload.data as any)?.billNumber || '';
    const emitKey = `${restaurantId}-${type}-${orderId || kotId || tableNumber}-${itemCount}-${billNumber}-${requestId}`;
    const eventId = randomUUID();
    const enriched = {
      restaurantId,
      ...payload,
      eventId,  // TOP LEVEL — so bufferPrintJob can read payload.eventId
      data: { ...(payload.data as Record<string, unknown>), eventId },  // also in data for PrintStation client dedup
    };
    // Emit immediately — don't block on Redis/DB
    getIo().to(printRoom).emit(eventName, enriched);
    // Then do Redis lock + buffer async (non-blocking)
    acquireLock(EMIT_LOCK_KEY(emitKey), EMIT_LOCK_TTL).then(acquired => {
      if (!acquired) return;
      bufferPrintJob(restaurantId, enriched).catch(() => {});
    });
  } else {
    getIo().to(restaurantId).emit(eventName, { restaurantId, ...payload });
  }
}

function isBarLikeSection(sectionTag: string | null | undefined, venueType?: string | null): boolean {
  // New-tenant path: use venueType directly
  if (venueType) {
    return ['BAR', 'PDR', 'CONFERENCE', 'BANQUET', 'ROOM_SERVICE'].includes(venueType.toUpperCase());
  }
  // Legacy fallback: sectionTag string matching
  if (!sectionTag) return false;
  return (
    sectionTag === 'venue-bar-conference' ||
    sectionTag === 'venue-bar-pdr' ||
    sectionTag === 'venue-bar-rooms' ||
    sectionTag === 'venue-bar-parcel' ||
    sectionTag === 'venue-bar-gobox' ||
    sectionTag === 'venue-restaurant-parcel'
  );
}


/**
 * Format table number with prefix based on sectionTag and sectionName.
 * For new tenants, section tags won't start with 'venue-'. We use sectionName-based
 * prefix logic as fallback so new tenants get sensible labels automatically.
 */
function formatTableNumber(
  tableNumber: number | string,
  restaurantId: string,
  sectionName?: string,
  sectionTag?: string | null,
  venueType?: string | null,
  ctx?: TenantContext
): string {
  if (tableNumber === 999 || String(tableNumber) === '999') return 'Counter';

  // New-tenant path: derive from venueType when available
  if (venueType) {
    const vt = venueType.toUpperCase();
    if (vt === 'CONFERENCE') return `C${tableNumber}`;
    if (vt === 'PDR')        return `PDR${tableNumber}`;
    if (vt === 'ROOM_SERVICE') return `R${tableNumber}`;
    if (vt === 'BAR')        return `B${tableNumber}`;
    if (vt === 'TAKEAWAY' || vt === 'DELIVERY') return 'P1';
    if (vt === 'BANQUET')    return `B${tableNumber}`;
    if (vt === 'DINE_IN' || vt === 'CAFE') return `T${tableNumber}`;
  }

  if (sectionTag) {
    const tag = sectionTag.toLowerCase();
    if (tag.includes('conference')) return `C${tableNumber}`;
    if (tag.includes('pdr'))        return `PDR${tableNumber}`;
    if (tag.includes('room'))       return `R${tableNumber}`;
    if (tag.includes('gobox'))      return `GB${tableNumber}`;
    if (tag.includes('parcel'))     return 'P1';
    if (tag.includes('family-restaurant') || tag.includes('family_restaurant')) return `F${tableNumber}`;
    if (tag.includes('bar'))        return `B${tableNumber}`;
  }

  if (sectionName) {
    const sec = sectionName.toLowerCase();
    if (sec.includes('conference')) return `C${tableNumber}`;
    if (sec.includes('pdr'))        return `PDR${tableNumber}`;
    if (sec.includes('room'))       return `R${tableNumber}`;
    if (sec.includes('bar') || sec.includes('main hall')) return `B${tableNumber}`;
    if (sec.includes('family restaurant')) return `F${tableNumber}`;
    if (sec.includes('gobox') || sec.includes('go box')) return `GB${tableNumber}`;
    if (sec.includes('parcel')) return 'P1';
  }

  if (ctx) {
    const prefix = restaurantId === ctx.barId ? 'B' : 'T';
    return `${prefix}${tableNumber}`;
  }

  return `T${tableNumber}`;
}

async function assertOrderBelongsToTenant(
  orderId: string,
  requestingRestaurantId: string | undefined,
  existingCtx?: TenantContext,
): Promise<TenantContext> {
  if (!requestingRestaurantId) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
  const ctx = existingCtx ?? await resolveTenantContext(requestingRestaurantId);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { restaurantId: true }
  });
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  if (!ctx.allIds.includes(order.restaurantId)) {
    throw Object.assign(new Error('Cross-tenant access denied'), { statusCode: 403 });
  }
  return ctx;
}

// ── Daily-sequential Bill counter ──────────────────────────────────────────
// Must be called inside a Prisma transaction (tx) so the increment is atomic.
async function getNextBillNumber(
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

function formatBillNumber(_date: Date, billNumber: number): string {
  // Plain incrementing number per day: 1, 2, 3... resets via DailyCounter
  return String(billNumber);
}

router.post("/", invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req: any, res) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Orders] POST / tableId:', req.body?.tableId, 'items:', req.body?.items?.length);
  }

  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { tableId, requestId, captainName, isExtraTable, tableNumber, platform } = req.body;
    const result = await createOrderService({
      restaurantId,
      tableId,
      items: req.body.items,
      requestId,
      captainName,
      isExtraTable,
      tableNumber,
      platform,
      user: req.user ? { userId: req.user.userId, role: req.user.role, name: req.user.name } : undefined,
    });
    res.status(201).json({
      ...result.order,
      kotHistory: result.kotHistory,
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to create order";
    const status = message.startsWith("Invalid") || message.includes("items") ? 400 : 500;
    const response: any = { error: message };
    if ((error as any)?.missing) response.missing = (error as any).missing;
    res.status(status).json(response);
  }
});



router.get("/", cacheMiddleware("orders:list", 10_000), async (req: any, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) ?? "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";

    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (status && !Object.values(OrderStatus).includes(status as OrderStatus)) {
      res.status(400).json({ error: "Invalid status", validStatuses: Object.values(OrderStatus) });
      return;
    }

    const orders = await prisma.order.findMany({
      where: {
        restaurantId,
        status: status ? (status as OrderStatus) : { in: ACTIVE_ORDER_STATUSES },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,  // ← add this line only
      include: orderInclude,
    });

    res.set("Cache-Control", "no-store");
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

router.get("/table/:tableId", async (req, res) => {
  try {
    const tableId = req.params.tableId as string;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const order = await prisma.order.findFirst({
      where: {
        tableId,
        restaurantId,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      orderBy: { updatedAt: "desc" },
      include: orderInclude,
    });

    if (!order) {
      res.status(404).json({ error: "Active order not found" });
      return;
    }

    res.json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch table order" });
  }
});

router.patch("/:id/items", invalidateCache(["tables:*", "sections:list:*", "analytics:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { requestId, captainName, isExtraTable, tableNumber: extraTableNumber, lastUpdatedAt } = req.body;

    const result = await updateOrderItemsService({
      orderId: id,
      restaurantId,
      items: req.body.items,
      requestId,
      captainName,
      isExtraTable,
      tableNumber: extraTableNumber,
      lastUpdatedAt,
    });

    const ctx = await resolveTenantContext(restaurantId);
    const printerConfig = await loadPrinterConfig(restaurantId);
    const mappedItems2 = result.mappedItems;
    const newKotHistory = result.kotHistory;
    const updatedTable = result.table;
    const existingRestaurantId = restaurantId;
    const incomingCaptainName2 = captainName;
    const extraTableNumber2 = extraTableNumber;
    const isExtraTable2 = isExtraTable;
    const updatedOrder = { order: result.order };

    const latestKot2 = newKotHistory[newKotHistory.length - 1] as { id?: string } | undefined;
    const formattedTableNumber2 = extraTableNumber2
      ? (isBarOutlet(existingRestaurantId, ctx) ? `B${extraTableNumber2}` : `T${extraTableNumber2}`)
      : (updatedTable?.number
          ? formatTableNumber(updatedTable.number, existingRestaurantId, updatedTable.section?.name, (updatedTable as any)?.sectionTag, updatedTable?.section?.venue?.venueType, ctx)
          : "UNKNOWN");
    const basePayload = {
      kotId: latestKot2?.id ?? "??",
      tableNumber: formattedTableNumber2,
      restaurantId: existingRestaurantId,
      sectionTag: (updatedTable as any)?.sectionTag || null,
      sectionName: updatedTable?.section?.name || "Main Hall",
      captainName: incomingCaptainName2?.trim() || await getCaptainName(updatedTable?.captainId || undefined) || 'Captain',
      timestamp: new Date().toISOString(),
      requestId: requestId || null,
      printerName: mappedItems2.length === 1 ? mappedItems2[0].printerName : undefined,
    };

    const kotPrintItems2 = mappedItems2.map(i => ({
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      notes: i.notes ?? null,
      type: (i.menuType === 'LIQUOR' ? 'liquor' : 'food') as 'food' | 'liquor',
    }));
    const kotOrderData2 = {
      tableNumber: basePayload.tableNumber,
      orderId: updatedOrder.order.id,
      items: kotPrintItems2,
      kotId: basePayload.kotId,
      sectionName: basePayload.sectionName,
      captainName: basePayload.captainName,
      sectionTag: basePayload.sectionTag || undefined,
    };

    if (isVenueOutlet(existingRestaurantId, ctx)) {
      if (isBarLikeSection(basePayload.sectionTag, updatedTable?.section?.venue?.venueType)) {
        const foodItems = mappedItems2.filter((i) => i.menuType !== "LIQUOR");
        const liquorItems = mappedItems2.filter((i) => i.menuType === "LIQUOR");
        if (foodItems.length > 0) {
          await emitToRestaurant(existingRestaurantId, "print_job", {
            type: "KOT",
            data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData2) }
          });
        }
        if (liquorItems.length > 0) {
          await emitToRestaurant(existingRestaurantId, "print_job", {
            type: "BAR_KOT",
            data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData2) }
          });
        }
      } else {
        const counterItems = mappedItems2.filter((i) => i.printerTarget === 'BAR_PRINTER' || i.menuType === 'LIQUOR');
        const kitchenItems = mappedItems2.filter((i) => i.printerTarget !== 'BAR_PRINTER' && i.menuType !== 'LIQUOR');

        if (kitchenItems.length > 0) {
          const kitchenPrintItems = kitchenItems.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            price: i.price,
            notes: i.notes ?? null,
            type: 'food' as const,
          }));
          await emitToRestaurant(existingRestaurantId, "print_job", {
            type: "KOT",
            data: {
              ...basePayload,
              items: kitchenItems,
              escposData: buildFoodKOT({
                ...kotOrderData2,
                items: kitchenPrintItems,
              }),
            }
          });
        }

        if (counterItems.length > 0) {
          const counterPrintItems = counterItems.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            price: i.price,
            notes: i.notes ?? null,
            type: 'liquor' as const,
          }));
          await emitToRestaurant(existingRestaurantId, "print_job", {
            type: "BAR_KOT",
            data: {
              ...basePayload,
              items: counterItems,
              escposData: buildLiquorKOT({
                ...kotOrderData2,
                items: counterPrintItems,
              }),
            }
          });
        }
      }
    } else {
      const foodItems = mappedItems2.filter((i) => i.menuType !== "LIQUOR");
      const liquorItems = mappedItems2.filter((i) => i.menuType === "LIQUOR");
      if (foodItems.length > 0) {
        await emitToRestaurant(existingRestaurantId, "print_job", {
          type: "KOT",
          data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData2) }
        });
      }
      if (liquorItems.length > 0) {
        await emitToRestaurant(existingRestaurantId, "print_job", {
          type: "BAR_KOT",
          data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData2) }
        });
      }
    }

    res.json({
      order: updatedOrder.order
    });

  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to update order items";
    res.status(message.startsWith("Invalid") || message.includes("items") ? 400 : 500).json({ error: message });
  }
});



router.patch("/:id/status", invalidateCache(["tables:*", "sections:list:*", "transactions:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.activeRestaurantId ?? req.user?.restaurantId);
    const { status } = req.body as { status?: string };

    if (!status || !Object.values(OrderStatus).includes(status as OrderStatus)) {
      res.status(400).json({ error: "Invalid status", validStatuses: Object.values(OrderStatus) });
      return;
    }

    const requestedStatus = status as OrderStatus;

    // Block terminal statuses — these must go through settle/pay/cancel flows
    if (requestedStatus === OrderStatus.PAID || requestedStatus === OrderStatus.CANCELLED) {
      res.status(409).json({
        error: "Use the settlement or cancel flow for this transition",
        requestedStatus,
      });
      return;
    }

    // Fetch current order status for transition validation
    const current = await prisma.order.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    // Allowed status transition map
    const ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
      [OrderStatus.PENDING]:           [OrderStatus.CONFIRMED, OrderStatus.PREPARING],
      [OrderStatus.CONFIRMED]:         [OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.BILLING_REQUESTED],
      [OrderStatus.PREPARING]:         [OrderStatus.CONFIRMED, OrderStatus.READY, OrderStatus.BILLING_REQUESTED],
      [OrderStatus.READY]:             [OrderStatus.CONFIRMED, OrderStatus.PREPARING, OrderStatus.BILLING_REQUESTED],
      [OrderStatus.BILLING_REQUESTED]: [OrderStatus.CONFIRMED, OrderStatus.PREPARING],
    };

    const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(requestedStatus)) {
      res.status(409).json({
        error: "Invalid status transition",
        currentStatus: current.status,
        requestedStatus,
      });
      return;
    }

    // Map order status → table status + workflowStatus
    const TABLE_STATUS_MAP: Partial<Record<OrderStatus, { status: TableStatus; workflowStatus: string }>> = {
      [OrderStatus.CONFIRMED]:         { status: TableStatus.OCCUPIED, workflowStatus: "Confirmed" },
      [OrderStatus.PREPARING]:         { status: TableStatus.OCCUPIED, workflowStatus: "Preparing" },
      [OrderStatus.READY]:             { status: TableStatus.OCCUPIED, workflowStatus: "Ready" },
      [OrderStatus.BILLING_REQUESTED]: { status: TableStatus.BILLING_REQUESTED, workflowStatus: "Waiting Bill" },
    };

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: { status: requestedStatus },
        include: orderInclude,
      });

      let table = null;
      const tableUpdate = TABLE_STATUS_MAP[requestedStatus];
      if (tableUpdate) {
        table = await tx.table.update({
          where: { id: order.tableId },
          data: {
            status: tableUpdate.status,
            workflowStatus: tableUpdate.workflowStatus,
          },
          include: tableInclude,
        });
      }

      return { order, table };
    }, { timeout: 15000, maxWait: 20000 });

    await emitToRestaurant(result.order.restaurantId, "order:updated", { order: result.order });
    if (result.table) {
      await emitToRestaurant(result.order.restaurantId, "table:updated", { table: result.table });
    }
    res.json(result.order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

router.post("/:id/request-billing", invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.activeRestaurantId ?? req.user?.restaurantId);

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { table: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: {
          billingRequested: true,
          billingRequestedAt: new Date(),
          status: OrderStatus.BILLING_REQUESTED,
        },
        include: orderInclude,
      });

      const table = await tx.table.update({
        where: { id: existing.tableId },
        data: {
          status: TableStatus.BILLING_REQUESTED,
          workflowStatus: "Waiting Bill",
        },
        include: tableInclude,
      });

      return { order, table };
    }, { timeout: 15000, maxWait: 20000 });

    await emitToRestaurant(existing.restaurantId, "billing:requested", result);
    await emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });
    res.json(result.order);
  } catch (error) {
    console.error("=== REQUEST BILLING ERROR ===", error);
    const errMessage = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    res.status(500).json({
      error: "Failed to request billing",
      details: errMessage,
      stack: errStack
    });
  }
});

router.patch("/:id/settle", requireRole("OWNER", "ADMIN", "CASHIER"), invalidateCache(["tables:*", "sections:list:*", "transactions:*", "analytics:*", "reports:*", "stats:today:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.activeRestaurantId ?? req.user?.restaurantId);
    const { removedItemIds, removedBy } = req.body as { removedItemIds?: string[], removedBy?: string };

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { items: true, table: true },
    });

    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Mark items as removed
      if (removedItemIds && removedItemIds.length > 0) {
        await tx.orderItem.updateMany({
          where: {
            orderId: id,
            id: { in: removedItemIds },
            removedFromBill: false,
          },
          data: {
            removedFromBill: true,
            removedBy: removedBy || "Cashier",
            removedAt: new Date(),
          },
        });
      }

      // 2. Recalculate totals based on remaining items
      const allItems = await tx.orderItem.findMany({ where: { orderId: id } });
      const validItems = allItems.filter(i => !i.removedFromBill && i.quantity > 0);
      const newTotalAmount = totalAmount(validItems);

      const order = await tx.order.update({
        where: { id },
        data: {
          totalAmount: newTotalAmount,
        },
        include: orderInclude,
      });

      const table = await tx.table.update({
        where: { id: existing.tableId },
        data: {
          currentBill: newTotalAmount,
        },
        include: tableInclude,
      });

      return { order, table };
    }, { timeout: 15000, maxWait: 20000 });

    await emitToRestaurant(existing.restaurantId, "order:updated", { order: result.order });
    await emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });
    res.json(result.order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to settle order items" });
  }
});

router.patch("/:id/bill-edit", requireRole("OWNER", "ADMIN", "CASHIER"), invalidateCache(["tables:*", "sections:list:*", "transactions:*", "analytics:*", "reports:*", "stats:today:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.activeRestaurantId ?? req.user?.restaurantId);
    const {
      removedItemIds,
      editQuantities,
      addedItems,
      editedBy,
      requestId,
    } = req.body as {
      removedItemIds?: string[];
      editQuantities?: Record<string, number>;
      addedItems?: Array<{ menuItemId: string; name: string; price: number; quantity: number; notes?: string | null; menuType?: string }>;
      editedBy?: string;
      requestId?: string;
    };

    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    // ── IDEMPOTENCY CHECK ──────────────────────────────────────────────
    if (requestId) {
      const existingPr = await prisma.processedRequest.findUnique({
        where: {
          requestId_actionType_restaurantId: {
            requestId,
            actionType: 'bill-edit',
            restaurantId,
          },
        },
      });
      if (existingPr) {
        res.json({ message: "Already processed", ...(existingPr.result as any) });
        return;
      }
    }

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { items: true, table: true },
    });

    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
      res.status(409).json({ error: "Cannot edit a settled or paid order", serverUpdatedAt: existing.updatedAt });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Mark removed items
      if (removedItemIds && removedItemIds.length > 0) {
        const itemsToEdit = await tx.orderItem.findMany({
          where: {
            orderId: id,
            id: { in: removedItemIds },
            removedFromBill: false,
          },
        });

        await Promise.all(itemsToEdit.map(async (item) => {
          const requestedQuantity = Math.max(1, Math.round(Number(editQuantities?.[item.id] ?? item.quantity)));
          if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
            throw new Error(`Invalid edit quantity for item ${item.id}`);
          }
          if (requestedQuantity > item.quantity) {
            throw new Error(`edit quantity exceeds remaining quantity for item ${item.id}`);
          }

          const isFullRemoval = requestedQuantity >= item.quantity;
          return tx.orderItem.update({
            where: { id: item.id },
            data: isFullRemoval
              ? {
                  quantity: 0,
                  editedQuantity: { increment: requestedQuantity },
                  originalQuantity: item.originalQuantity ?? item.quantity,
                  removedFromBill: true,
                  removedBy: editedBy || "Cashier",
                  removedAt: new Date(),
                }
              : {
                  quantity: { decrement: requestedQuantity },
                  editedQuantity: { increment: requestedQuantity },
                  originalQuantity: item.originalQuantity ?? item.quantity,
                  removedFromBill: false,
                  removedBy: editedBy || "Cashier",
                  removedAt: new Date(),
                },
          });
        }));
      }

      // 2. Add new cashier-added items (with dedup — merge if same menuItemId+notes exists)
      if (addedItems && addedItems.length > 0) {
        // Fetch existing active items for dedup
        const existingItemsForDedup = await tx.orderItem.findMany({
          where: { orderId: id, removedFromBill: false },
        });
        const dedupMap = new Map<string, typeof existingItemsForDedup[number]>();
        for (const ei of existingItemsForDedup) {
          const key = `${ei.menuItemId}::${ei.notes ?? ''}`;
          dedupMap.set(key, ei);
        }
        const createdInBatch = new Set<string>();

        // Resolve the table's venueId for server-side price resolution
        const tableWithVenue = await tx.table.findUnique({
          where: { id: existing.tableId },
          select: { section: { select: { venue: { select: { id: true } } } } },
        });
        const venueId = tableWithVenue?.section?.venue?.id ?? undefined;

        for (const item of addedItems) {
          const menuItemId = item.menuItemId?.trim();
          const name = item.name?.trim();
          const quantity = Math.round(Number(item.quantity));
          const menuType: "FOOD" | "LIQUOR" = item.menuType === "LIQUOR" ? "LIQUOR" : "FOOD";
          const notes = typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : null;

          if (!menuItemId || !name || quantity <= 0) continue;

          // Server-side price resolution — never trust client-sent price
          const price = await resolveItemPrice(menuItemId, venueId, restaurantId, tx);

          const dedupKey = `${menuItemId}::${notes ?? ''}`;
          const existingMatch = dedupMap.get(dedupKey);

          if (existingMatch) {
            // Merge: increment existing row's quantity
            await tx.orderItem.update({
              where: { id: existingMatch.id },
              data: { quantity: { increment: quantity } },
            });
          } else if (createdInBatch.has(dedupKey)) {
            // Already created in this batch — re-fetch and increment
            const justCreated = await tx.orderItem.findFirst({
              where: { orderId: id, menuItemId, notes, removedFromBill: false },
              orderBy: { id: 'desc' },
            });
            if (justCreated) {
              await tx.orderItem.update({
                where: { id: justCreated.id },
                data: { quantity: { increment: quantity } },
              });
            }
          } else {
            // Create new row
            await tx.orderItem.create({
              data: {
                orderId: id,
                menuItemId,
                name,
                price,
                quantity,
                notes,
                menuType,
                addedByCashier: true,
              },
            });
            createdInBatch.add(dedupKey);
          }
        }
      }

      // 3. Recalculate total from all non-removed items
      const allItems = await tx.orderItem.findMany({ where: { orderId: id } });
      const validItems = allItems.filter(i => !i.removedFromBill && i.quantity > 0);
      const newTotal = totalAmount(validItems);

      const order = await tx.order.update({
        where: { id },
        data: { totalAmount: newTotal },
        include: orderInclude,
      });

      const table = await tx.table.update({
        where: { id: existing.tableId },
        data: { currentBill: newTotal },
        include: tableInclude,
      });

      return { order, table };
    }, { timeout: 15000, maxWait: 20000 });

    await emitToRestaurant(existing.restaurantId, "order:updated", { order: result.order });
    await emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });

    // ── IDEMPOTENCY RECORD ──────────────────────────────────────────────
    if (requestId) {
      await prisma.processedRequest.create({
        data: {
          requestId,
          actionType: 'bill-edit',
          orderId: id,
          restaurantId,
          result: { order: result.order } as any,
        },
      }).catch(() => {}); // non-fatal if duplicate
    }

    createAuditLog({
      userId: req.user?.id,
      restaurantId,
      action: 'BILL_EDIT',
      entityType: 'Order',
      entityId: id,
      metadata: {
        removedItemIds: removedItemIds ?? [],
        editQuantities: editQuantities ?? {},
        addedItemsCount: addedItems?.length ?? 0,
        editedBy: editedBy || 'Cashier',
      },
    });

    res.json(result.order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to edit bill" });
  }
});

// POST /api/orders/:id/print-bill - Print bill without settlement
router.post("/:id/print-bill", async (req, res) => {
  try {
    const orderId = req.params.id as string;
    await assertOrderBelongsToTenant(orderId, req.user?.activeRestaurantId ?? req.user?.restaurantId);
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { tableNumber: tableNumberOverride, discountPercent: discountPercentOverride, kotNumbers: kotNumbersParam, requestId } = req.query as { tableNumber?: string; discountPercent?: string; kotNumbers?: string; requestId?: string };
    const isExtraTable = !!tableNumberOverride;

    // Enforce captain discount limits for extra-table discount override
    if (isExtraTable && discountPercentOverride != null) {
      const requestedDiscount = Number(discountPercentOverride);
      if (requestedDiscount > 0 && req.user?.role === 'CAPTAIN') {
        const assignment = await prisma.captainAssignment.findUnique({
          where: { restaurantId_captainId: { restaurantId, captainId: req.user!.userId! } },
        });
        if (!assignment) {
          return res.status(403).json({ error: 'No discount limit assigned. Contact your manager.' });
        }
        const maxDiscount = Number(assignment.discountLimit);
        if (requestedDiscount > maxDiscount) {
          return res.status(403).json({ error: `Discount exceeds your limit of ${maxDiscount}%` });
        }
      }
    }

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    // Server-side print lock to prevent duplicate prints from the same order
    const acquired = await acquireLock(PRINT_LOCK_KEY(orderId), PRINT_LOCK_TTL);
    if (!acquired) {
      return res.status(429).json({ error: "Duplicate print request — please wait" });
    }

    // 1. VALIDATE OUTSIDE TRANSACTION - Find order with table and items
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          where: { removedFromBill: false },
          include: { menuItem: true }
        },
        table: {
          include: { section: { include: { venue: { include: { taxProfile: true } } } } }
        }
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const ctx = await resolveTenantContext(restaurantId);
    const venueTaxProfile = order.table?.section?.venue?.taxProfile;
    const taxSource = venueTaxProfile
      ? { gstRate: venueTaxProfile.gstRate, gstCategory: venueTaxProfile.gstCategory, gstRegistered: venueTaxProfile.gstRegistered, pricesIncludeGst: ctx.pricesIncludeGst }
      : ctx;

    // 2. VALIDATE order state OUTSIDE TRANSACTION
    if (order.status === OrderStatus.PAID) {
      return res.status(409).json({
        error: "Order is already paid. Cannot print bill."
      });
    }

    // 3. VALIDATE items (check filtered activeItems — exclude removed AND zero-qty)
    const activeItems = order.items.filter(i => !i.removedFromBill && i.quantity > 0);
    if (activeItems.length === 0) {
      return res.status(400).json({
        error: "Cannot print bill: all items have been cancelled"
      });
    }

    // 4. TRANSACTION - Only mutations inside
    // Idempotency check + billNumber generation are atomic inside this transaction.
    // If requestId was already processed for print-bill, return cached result.
    const result = await prisma.$transaction(async (tx) => {
      // ── IDEMPOTENCY CHECK (inside transaction) ──────────────────────────────
      // Must be the first operation so concurrent replays cannot both pass.
      if (requestId) {
        const existing = await tx.processedRequest.findUnique({
          where: {
            requestId_actionType_restaurantId: {
              requestId,
              actionType: 'print-bill',
              restaurantId,
            },
          },
        });
        if (existing) {
          console.log(`[PrintBill] Idempotent replay for requestId=${requestId}, returning cached result`);
          return existing.result as any;
        }
      }

      // FOR UPDATE lock on the order row — prevents two concurrent print-bill
      // requests from both generating bill numbers for the same order.
      const lockedRows = await tx.$queryRaw<Array<{
        id: string; status: string; billNumber: string | null; billingRequestedAt: Date | null;
      }>>`
        SELECT "id", "status", "billNumber", "billingRequestedAt"
        FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
      `;
      const lockedRow = lockedRows[0];

      if (!lockedRow) throw new Error('Order not found inside transaction');

      if (lockedRow.status === 'PAID') {
        throw new Error('Order is already paid. Cannot print bill.');
      }

      // ── DB-LEVEL DEDUP GUARD ──────────────────────────────────────────────
      // If Redis lock failed open (Redis down), this acts as a secondary guard.
      // Rejects near-simultaneous duplicate print requests within the configured window.
      // Legitimate reprints happen minutes later, not within seconds.
      if (lockedRow.billNumber && lockedRow.status === 'BILLING_REQUESTED' && lockedRow.billingRequestedAt) {
        const gapMs = Date.now() - new Date(lockedRow.billingRequestedAt).getTime();
        if (gapMs < BILL_DEDUP_WINDOW_MS) {
          console.warn(`[PrintBill] Duplicate suppressed by DB time-window guard — orderId=${orderId}, gap=${gapMs}ms, window=${BILL_DEDUP_WINDOW_MS}ms — Redis lock likely failed open`);
          throw Object.assign(new Error('Duplicate print request — please wait'), { statusCode: 429 });
        }
      }

      // Generate or reuse bill number
      let billNumber: string;
      const now = new Date();

      if (lockedRow.billNumber) {
        // Reuse existing bill number for reprints (use locked value, not outer-scope)
        billNumber = lockedRow.billNumber;
      } else {
        // Generate new bill number — one global daily counter per restaurantId
        const billCount = await getNextBillNumber(restaurantId, tx);
        billNumber = formatBillNumber(now, billCount);
      }

      // Update order status and store bill number
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.BILLING_REQUESTED,
          billingRequested: true,
          billingRequestedAt: new Date(),
          billNumber: billNumber,  // Store for reprints
        },
      });

      // Update table status — skip for extra tables (parent table still in use separately)
      const updatedTable: any = isExtraTable
        ? await tx.table.findUnique({ where: { id: order.tableId }, include: tableInclude })
        : await tx.table.update({
            where: { id: order.tableId },
            data: {
              status: TableStatus.BILLING_REQUESTED,
              workflowStatus: "Waiting Bill",
            },
            include: tableInclude
          });
      if (!updatedTable) throw new Error("Table not found");

      // Calculate bill details
      const foodItems = activeItems.filter(item => item.menuItem.menuType === "FOOD");
      const liquorItems = activeItems.filter(item => item.menuItem.menuType === "LIQUOR");

      const foodSubtotal = foodItems.reduce((sum, item) =>
        sum + (Number(item.price) * item.quantity), 0
      );
      const liquorSubtotal = liquorItems.reduce((sum, item) =>
        sum + (Number(item.price) * item.quantity), 0
      );
      const subtotal = foodSubtotal + liquorSubtotal;

      // Apply discount — for extra tables use query param override; for regular tables use DB table.discount
      let discount = null;
      let discountAmount = 0;
      const discountSource = isExtraTable && discountPercentOverride != null
        ? Number(discountPercentOverride)
        : (updatedTable.discount ? Number(updatedTable.discount) : 0);
      if (discountSource > 0) {
        discountAmount = Math.round(subtotal * (discountSource / 100) * 100) / 100;
        discount = { percent: discountSource, amount: discountAmount };
        if (isExtraTable) {
          createAuditLog({
            userId: req.user?.userId,
            restaurantId,
            action: 'DISCOUNT_APPLIED',
            entityType: 'ORDER',
            entityId: orderId,
            metadata: { percent: discountSource, source: 'extra_table_override' },
          });
        }
      }

      // Tax calculation (CGST + SGST on food only, AFTER discount) - WITH ROUNDING
      const taxableAmount = foodSubtotal - (discount ? discountAmount * (foodSubtotal / subtotal) : 0);
      const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
      const { cgst, sgst, tax, baseAmount } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!taxSource.pricesIncludeGst);
      const liquorAfterDiscount = liquorSubtotal - (discount ? discountAmount * (liquorSubtotal / subtotal) : 0);
      const displayedSubtotal = Math.round((baseAmount + liquorAfterDiscount) * 100) / 100;
      const grandTotal = Math.round((displayedSubtotal + tax) * 100) / 100;

      // Get all KOT numbers from the session
      const kotHistory = (updatedTable.kotHistory as Array<{ id?: string }>) || [];
      const kotNumbers = isExtraTable && kotNumbersParam
        ? kotNumbersParam.split(',').filter(Boolean)
        : kotHistory
            .map(k => k.id)
            .filter(Boolean);

      // Format table number — use override for extra tables (e.g. "1-X"), otherwise format from DB
      const formattedTableNumber = tableNumberOverride
        ? (isBarOutlet(restaurantId, ctx) ? `B${tableNumberOverride}` : `T${tableNumberOverride}`)
        : formatTableNumber(
            updatedTable.number,
            restaurantId,
            updatedTable.section?.name,
            updatedTable?.sectionTag,
            updatedTable.section?.venue?.venueType,
            ctx
          );

      // Format time in IST
      const timeStr = now.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      });

      // Format date
      const dateStr = now.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
      });

      // Return all data needed for socket emissions
      const printBillResult = {
        order: updatedOrder,
        table: updatedTable,
        billNumber,
        billData: {
          type: "FINAL_BILL",
          data: {
            billNumber,
            date: dateStr,
            time: timeStr,
            kotNumbers,
            tableNumber: formattedTableNumber,
            restaurantId,
            sectionTag: (updatedTable as any).sectionTag || null,
            captain: updatedTable.captainId || "N/A",
            items: (() => {
              const grouped = activeItems.reduce((acc, item) => {
                const key = `${item.name}::${Number(item.price)}`;
                if (!acc[key]) {
                  acc[key] = { name: item.name, quantity: 0, price: Number(item.price), menuType: item.menuItem.menuType };
                }
                acc[key].quantity += item.quantity;
                return acc;
              }, {} as Record<string, any>);
              return Object.values(grouped).map((item: any) => ({
                name: item.name,
                quantity: item.quantity,
                price: item.price,
                amount: item.price * item.quantity,
                menuType: item.menuType
              }));
            })(),
            subtotal: displayedSubtotal,
            discount,
            tax: { cgst, sgst, total: tax },
            grandTotal,
            section: updatedTable.section?.name || "Main Hall",
            itemCount: (() => {
              const grouped = activeItems.reduce((acc, item) => {
                const key = `${item.name}::${Number(item.price)}`;
                if (!acc[key]) {
                  acc[key] = true;
                }
                return acc;
              }, {} as Record<string, boolean>);
              return Object.keys(grouped).length;
            })(),
            qtyCount: activeItems.reduce((sum, item) => sum + item.quantity, 0),
            ...(ctx.gstin ? { gstIn: ctx.gstin } : {}),
          }
        },
        formattedTableNumber,
        grandTotal
      };

      // ── IDEMPOTENCY RECORD (inside same transaction) ──────────────────────
      if (requestId) {
        await tx.processedRequest.create({
          data: {
            requestId,
            actionType: 'print-bill',
            orderId,
            restaurantId,
            result: printBillResult as any,
          },
        });
      }

      return printBillResult;
    }, { timeout: 15000, maxWait: 20000 });

    // 5. EMIT SOCKET EVENTS AFTER TRANSACTION COMMITS
    // Emit print job → dedicated print room (only PrintStation subscribes)
    // Pre-build ESC/POS so PrintStation never calls Render for bill data
    const finalBillEscpos = buildFinalBill(result.billData.data as any);
    await emitToRestaurant(restaurantId, "print_job", {
      ...result.billData,
      data: { ...result.billData.data, escposData: finalBillEscpos },
    });

    // Emit billing requested event
    await emitToRestaurant(restaurantId, "billing:requested", {
      orderId: result.order.id,
      tableId: result.table.id,
      tableNumber: result.formattedTableNumber,
      totalAmount: result.grandTotal
    });

    // table:updated is now emitted by printBillService after the background table update completes

    // 6. Return success
    res.json({
      message: "Bill printed successfully",
      order: result.order,
      table: result.table,
      billNumber: result.billNumber,
      totalAmount: result.grandTotal
    });
  } catch (error: any) {
    console.error("[Orders] Print bill error:", error.message);
    if (error.message && error.message.includes('already paid')) {
      return res.status(409).json({ error: error.message });
    }
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/orders/:id/reprint-kot - Reprint KOT for a given order
router.post("/:id/reprint-kot", async (req, res) => {
  try {
    const orderId = req.params.id as string;
    await assertOrderBelongsToTenant(orderId, req.user?.activeRestaurantId ?? req.user?.restaurantId);
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: true } },
        table: { include: { section: { include: { venue: { select: { venueType: true } } } } } },
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const ctx = await resolveTenantContext(restaurantId);

    const activeItems = order.items.filter(i => !i.removedFromBill && i.quantity > 0);
    if (activeItems.length === 0) {
      return res.status(400).json({ error: "No active items to reprint KOT" });
    }

    const foodItems = activeItems.filter(item => item.menuItem.menuType !== "LIQUOR");
    const liquorItems = activeItems.filter(item => item.menuItem.menuType === "LIQUOR");

    const kotPrintItems = activeItems.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: Number(i.price),
      notes: i.notes ?? null,
      type: (i.menuItem.menuType === "LIQUOR" ? 'liquor' : 'food') as 'food' | 'liquor',
    }));

    const tableNumber = formatTableNumber(
      order.table?.number ?? 0,
      restaurantId,
      order.table?.section?.name,
      (order.table as any)?.sectionTag,
      order.table?.section?.venue?.venueType,
      ctx
    );

    const kotOrderData = {
      tableNumber,
      orderId: order.id,
      items: kotPrintItems,
      kotId: 'REPRINT',
      sectionName: order.table?.section?.name || '',
      captainName: order.table?.captainId || 'Cashier',
      sectionTag: (order.table as any)?.sectionTag || undefined,
    };

    const basePayload = {
      tableNumber,
      orderId: order.id,
      items: activeItems.map(i => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        price: Number(i.price),
        notes: i.notes ?? null,
        menuType: i.menuItem.menuType,
      })),
      restaurantId,
      sectionTag: (order.table as any)?.sectionTag || undefined,
      sectionName: order.table?.section?.name || '',
      captainName: order.table?.captainId || 'Cashier',
    };

    // Emit KOT print jobs
    if (foodItems.length > 0) {
      await emitToRestaurant(restaurantId, "print_job", {
        type: "KOT",
        data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData) }
      });
    }
    if (liquorItems.length > 0) {
      await emitToRestaurant(restaurantId, "print_job", {
        type: "BAR_KOT",
        data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData) }
      });
    }

    res.json({ message: "KOT reprint sent", orderId });
  } catch (error: any) {
    console.error("[Orders] KOT reprint error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/orders/:id/settle - Complete payment settlement (WITHOUT printing bill)
router.post("/:id/settle", requireRole("OWNER", "ADMIN", "CASHIER"), invalidateCache(["tables:*", "sections:list:*", "transactions:*", "analytics:*", "reports:*", "stats:today:*", "venue:sections:*"]), async (req, res) => {
  try {
    const orderId = req.params.id as string;
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const result = await settleOrderService({
      orderId,
      restaurantId,
      userId: req.user?.id,
      paymentMethod: req.body.paymentMethod,
      discountPercent: req.body.discountPercent,
      tableNumber: req.body.tableNumber,
      isExtraTable: req.body.isExtraTable,
      grandTotal: req.body.grandTotal,
      subtotal: req.body.subtotal,
      discountAmount: req.body.discountAmount,
      cgst: req.body.cgst,
      sgst: req.body.sgst,
      requestId: req.body.requestId,
      items: req.body.items,
    });
    return res.json({
      message: result.cached ? "Payment already settled" : "Payment settled successfully",
      order: result.order,
      table: result.table,
      transaction: result.transaction,
    });
  } catch (error: any) {
    console.error("[Orders] Settlement error:", error.message);
    const statusCode = error.statusCode || 500;
    if (statusCode === 409 && error.backendTotal !== undefined) {
      return res.status(409).json({
        error: error.message,
        backendTotal: error.backendTotal,
        frontendTotal: error.frontendTotal,
      });
    }
    return res.status(statusCode).json({ error: error.message });
  }
});

// ── PATCH /:id/cancel-item ────────────────────────────────────────────────────
// Body: { orderItemId: string, cancelledBy: string, cancelQuantity?: number, tableNumber?: number|string }
// Marks a single OrderItem as removed, recalculates the order and table totals,
// and emits a CANCEL_KOT print_job so the bar staff know to stop making it.
router.patch("/:id/cancel-item", requireRole("OWNER", "ADMIN", "CASHIER"), invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  const id = req.params.id as string;
  const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
  if (!restaurantId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { orderItemId, cancelledBy, cancelQuantity, tableNumber, requestId, isExtraTable } = req.body;

  try {
    const result = await cancelOrderItemService({
      orderId: id,
      restaurantId,
      userId: req.user?.id,
      orderItemId,
      cancelledBy,
      cancelQuantity,
      tableNumber,
      requestId,
      isExtraTable,
    });
    return res.json(result.order);
  } catch (error: any) {
    console.error("[cancel-item]", error);
    return res.status(error.statusCode || 500).json({ error: error.message || "Failed to cancel item" });
  }
});


// ── PATCH /:id/cancel-items (BATCH) ──────────────────────────────────────────
// Cancels multiple items in one transaction → emits ONE CANCEL_KOT → one print slip
router.patch("/:id/cancel-items", requireRole("OWNER", "ADMIN", "CASHIER"), invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  const id = req.params.id as string;
  const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
  if (!restaurantId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { items: itemsToCancel, cancelledBy, tableNumber, requestId, isExtraTable } = req.body;

  try {
    const result = await cancelOrderItemsService({
      orderId: id,
      restaurantId,
      userId: req.user?.id,
      items: itemsToCancel,
      cancelledBy,
      tableNumber,
      requestId,
      isExtraTable,
    });
    return res.json(result.order);
  } catch (error: any) {
    console.error("[cancel-items batch]", error);
    return res.status(error.statusCode || 500).json({ error: error.message || "Failed to cancel items" });
  }
});

// ─── Terminate Table Session ──────────────────────────────────────────────
router.post("/terminate-table/:tableId", invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  try {
    const tableId = req.params.tableId as string;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // 1. Verify table belongs to this tenant
    const table = await prisma.table.findFirst({
      where: { id: tableId, restaurantId },
      select: { id: true },
    });
    if (!table) {
      res.status(403).json({ error: "Table not found or access denied" });
      return;
    }

    // 2. Find active order for this table
    const activeOrder = await prisma.order.findFirst({
      where: {
        tableId,
        restaurantId,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
    });

    const result = await prisma.$transaction(async (tx) => {
      let updatedOrder = null;
      
      // 2. If active order exists, cancel it
      if (activeOrder) {
        updatedOrder = await tx.order.update({
          where: { id: activeOrder.id },
          data: { status: OrderStatus.CANCELLED },
          include: orderInclude,
        });
      }

      // 3. Reset the table
      const updatedTable = await tx.table.update({
        where: { id: tableId },
        data: {
          status: TableStatus.AVAILABLE,
          workflowStatus: "Free",
          kotHistory: [],
          currentBill: 0,
          captainId: null,
          guests: 0,
          sessionStartedAt: null,
        },
        include: tableInclude,
      });

      return { order: updatedOrder, table: updatedTable };
    }, { timeout: 15000, maxWait: 20000 });

    // 4. Emit socket events using the already-validated tenant id
    if (result.order && restaurantId) {
      await emitToRestaurant(restaurantId, "order:updated", { order: result.order });
    }
    if (restaurantId) {
      await emitToRestaurant(restaurantId, "table:updated", { table: result.table });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[terminate-table]", error);
    res.status(500).json({ error: "Failed to terminate table session" });
  }
});

// POST /api/orders/offline-sync — Bulk sync endpoint for offline replay

// Accepts an array of pending actions from the client's IndexedDB queue.
// Processes them sequentially per entity (orderId), returns per-action results.
// Each action must carry a requestId for idempotency.
router.post("/offline-sync", async (req, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    const { actions } = req.body as {
      actions: Array<{
        requestId: string;
        actionType: string;
        orderId?: string;
        url: string;
        method: string;
        body: Record<string, any>;
        deviceId?: string;
      }>;
    };

    if (!Array.isArray(actions) || actions.length === 0) {
      return res.json({ results: [], message: "No actions to sync" });
    }

    if (actions.length > 100) {
      return res.status(413).json({ error: "Too many actions in one batch (max 100). Please split and retry." });
    }

    // Group actions by entityId (orderId or tableId) to process entities in parallel
    // but actions within one entity sequentially.
    const entityGroups = new Map<string, typeof actions>();
    for (const action of actions) {
      const entityId = action.orderId || action.body?.tableId || `un grouped-${action.requestId}`;
      if (!entityGroups.has(entityId)) {
        entityGroups.set(entityId, []);
      }
      entityGroups.get(entityId)!.push(action);
    }

    // Pre-allocate results in the same order as the input actions. Entity groups run
    // concurrently, so a plain `results.push(...)` would return results out of order.
    // The frontend matches results by requestId, but keeping the array in input order
    // makes the contract explicit and avoids accidental misalignment.
    const results: Array<{
      requestId: string;
      actionType: string;
      status: "success" | "error" | "skipped";
      statusCode?: number;
      data?: any;
      error?: string;
    }> = new Array(actions.length);

    // Build an action-index map so each group can write its result at the correct position.
    const actionIndexMap = new Map<string, number>();
    actions.forEach((action, index) => actionIndexMap.set(action.requestId, index));

    const pushResult = (requestId: string, result: Omit<typeof results[0], "requestId">) => {
      const idx = actionIndexMap.get(requestId);
      if (idx !== undefined) {
        results[idx] = { requestId, ...result };
      }
    };

    // Process each entity group sequentially, but groups can run concurrently
    const groupPromises = Array.from(entityGroups.entries()).map(async ([_entityId, groupActions]) => {
      for (const action of groupActions) {
        try {
          // Build the internal fetch URL
          const internalUrl = action.url.startsWith("/api/orders")
            ? action.url
            : `/api/orders${action.url}`;

          // Use internal request forwarding instead of HTTP fetch to avoid network overhead
          // We'll use prisma directly based on actionType
          const { requestId, actionType, body } = action;

          if (actionType === "create-order" || (action.method === "POST" && internalUrl === "/api/orders")) {
            if (requestId) {
              const existing = await prisma.processedRequest.findUnique({
                where: {
                  requestId_actionType_restaurantId: {
                    requestId,
                    actionType: "create-order",
                    restaurantId,
                  },
                },
              });
              if (existing) {
                pushResult(requestId, { actionType, status: "skipped", statusCode: 200, data: existing.result });
                continue;
              }
            }

            // Multi-device conflict guard: another tablet already created an active order for this table
            // within the last 60 seconds. This prevents duplicate first-KOT orders when two cashiers
            // send the same table offline simultaneously.
            const tableId = body.tableId;
            if (tableId && action.deviceId) {
              const recentActiveOrder = await prisma.order.findFirst({
                where: {
                  restaurantId,
                  tableId,
                  status: { in: ACTIVE_ORDER_STATUSES },
                  createdAt: { gte: new Date(Date.now() - 60 * 1000) },
                },
                orderBy: { createdAt: 'desc' },
                include: orderInclude,
              });
              if (recentActiveOrder) {
                pushResult(requestId, {
                  actionType,
                  status: "error",
                  statusCode: 409,
                  error: "Another device already created an active order for this table. Please refresh.",
                  data: { order: recentActiveOrder },
                });
                continue;
              }
            }

            try {
              const data = await createOrderService({
                restaurantId,
                tableId: body.tableId,
                items: body.items,
                requestId,
                captainName: body.captainName,
                isExtraTable: body.isExtraTable,
                tableNumber: body.tableNumber,
                platform: body.platform,
                deviceId: action.deviceId,
                user: req.user?.userId ? { userId: req.user.userId, role: req.user.role, name: req.user.name } : undefined,
              });
              pushResult(requestId, { actionType, status: "success", statusCode: 200, data });
            } catch (err: any) {
              pushResult(requestId, { actionType, status: "error", statusCode: err.statusCode || 500, error: err.message || "Create order failed" });
            }
          } else if (actionType === "update-items" || (action.method === "PATCH" && internalUrl.includes("/items"))) {
            const orderId = action.orderId || internalUrl.split("/")[3];
            try {
              const data = await updateOrderItemsService({
                orderId,
                restaurantId,
                items: body.items,
                requestId,
                captainName: body.captainName,
                isExtraTable: body.isExtraTable,
                tableNumber: body.tableNumber,
                lastUpdatedAt: body.lastUpdatedAt,
              });

              // ── Emit KOT / BAR_KOT print jobs (mirrors direct PATCH route) ──
              const syncCtx = await resolveTenantContext(restaurantId);
              const syncMappedItems = data.mappedItems || [];
              const syncKotHistory = data.kotHistory || [];
              const syncTable = data.table;
              const syncLatestKot = syncKotHistory[syncKotHistory.length - 1] as { id?: string } | undefined;
              const syncFormattedTable = body.isExtraTable
                ? (isBarOutlet(restaurantId, syncCtx) ? `B${body.tableNumber}` : `T${body.tableNumber}`)
                : (syncTable?.number
                    ? formatTableNumber(syncTable.number, restaurantId, syncTable.section?.name, (syncTable as any)?.sectionTag, syncTable?.section?.venue?.venueType, syncCtx)
                    : "UNKNOWN");
              const syncBasePayload = {
                kotId: syncLatestKot?.id ?? "??",
                tableNumber: syncFormattedTable,
                restaurantId,
                sectionTag: (syncTable as any)?.sectionTag || null,
                sectionName: syncTable?.section?.name || "Main Hall",
                captainName: body.captainName?.trim() || await getCaptainName(syncTable?.captainId || undefined) || 'Captain',
                timestamp: new Date().toISOString(),
                requestId: requestId || null,
                printerName: syncMappedItems.length === 1 ? syncMappedItems[0].printerName : undefined,
              };
              const syncKotPrintItems = syncMappedItems.map((i: any) => ({
                name: i.name,
                quantity: i.quantity,
                price: i.price,
                notes: i.notes ?? null,
                type: (i.menuType === 'LIQUOR' ? 'liquor' : 'food') as 'food' | 'liquor',
              }));
              const syncKotOrderData = {
                tableNumber: syncBasePayload.tableNumber,
                orderId,
                items: syncKotPrintItems,
                kotId: syncBasePayload.kotId,
                sectionName: syncBasePayload.sectionName,
                captainName: syncBasePayload.captainName,
                sectionTag: syncBasePayload.sectionTag || undefined,
              };

              if (isVenueOutlet(restaurantId, syncCtx)) {
                if (isBarLikeSection(syncBasePayload.sectionTag, syncTable?.section?.venue?.venueType)) {
                  const foodItems = syncMappedItems.filter((i: any) => i.menuType !== "LIQUOR");
                  const liquorItems = syncMappedItems.filter((i: any) => i.menuType === "LIQUOR");
                  if (foodItems.length > 0) {
                    await emitToRestaurant(restaurantId, "print_job", {
                      type: "KOT",
                      data: { ...syncBasePayload, items: foodItems, escposData: buildFoodKOT(syncKotOrderData) }
                    });
                  }
                  if (liquorItems.length > 0) {
                    await emitToRestaurant(restaurantId, "print_job", {
                      type: "BAR_KOT",
                      data: { ...syncBasePayload, items: liquorItems, escposData: buildLiquorKOT(syncKotOrderData) }
                    });
                  }
                } else {
                  const kitchenItems = syncMappedItems.filter((i: any) => i.printerTarget !== 'BAR_PRINTER' && i.menuType !== 'LIQUOR');
                  const counterItems = syncMappedItems.filter((i: any) => i.printerTarget === 'BAR_PRINTER' || i.menuType === 'LIQUOR');
                  if (kitchenItems.length > 0) {
                    const kitchenPrintItems = kitchenItems.map((i: any) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: 'food' as const }));
                    await emitToRestaurant(restaurantId, "print_job", {
                      type: "KOT",
                      data: { ...syncBasePayload, items: kitchenItems, escposData: buildFoodKOT({ ...syncKotOrderData, items: kitchenPrintItems }) }
                    });
                  }
                  if (counterItems.length > 0) {
                    const counterPrintItems = counterItems.map((i: any) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: 'liquor' as const }));
                    await emitToRestaurant(restaurantId, "print_job", {
                      type: "BAR_KOT",
                      data: { ...syncBasePayload, items: counterItems, escposData: buildLiquorKOT({ ...syncKotOrderData, items: counterPrintItems }) }
                    });
                  }
                }
              } else {
                const foodItems = syncMappedItems.filter((i: any) => i.menuType !== "LIQUOR");
                const liquorItems = syncMappedItems.filter((i: any) => i.menuType === "LIQUOR");
                if (foodItems.length > 0) {
                  await emitToRestaurant(restaurantId, "print_job", {
                    type: "KOT",
                    data: { ...syncBasePayload, items: foodItems, escposData: buildFoodKOT(syncKotOrderData) }
                  });
                }
                if (liquorItems.length > 0) {
                  await emitToRestaurant(restaurantId, "print_job", {
                    type: "BAR_KOT",
                    data: { ...syncBasePayload, items: liquorItems, escposData: buildLiquorKOT(syncKotOrderData) }
                  });
                }
              }

              pushResult(requestId, { actionType, status: "success", statusCode: 200, data });
            } catch (err: any) {
              pushResult(requestId, { actionType, status: "error", statusCode: err.statusCode || 500, error: err.message || "Update items failed" });
            }
          } else if (actionType === "print-bill") {
            const orderId = action.orderId || internalUrl.split("/")[3];
            try {
              const data = await printBillService({
                orderId,
                restaurantId,
                tableNumber: body.tableNumber,
                discountPercent: body.discountPercent,
                kotNumbers: body.kotNumbers,
                requestId,
              });

              // ── Emit FINAL_BILL print job (mirrors direct POST route) ──
              if (data?.billData) {
                const finalBillEscpos = buildFinalBill(data.billData.data as any);
                await emitToRestaurant(restaurantId, "print_job", {
                  ...data.billData,
                  data: { ...data.billData.data, escposData: finalBillEscpos },
                });
              }

              pushResult(requestId, { actionType, status: "success", statusCode: 200, data });
            } catch (err: any) {
              pushResult(requestId, { actionType, status: "error", statusCode: err.statusCode || 500, error: err.message || "Print bill failed" });
            }
          } else if (actionType === "settle") {
            const orderId = action.orderId || internalUrl.split("/")[3];
            try {
              const data = await settleOrderService({
                orderId,
                restaurantId,
                userId: req.user?.id,
                paymentMethod: body.paymentMethod,
                discountPercent: body.discountPercent,
                tableNumber: body.tableNumber,
                isExtraTable: body.isExtraTable,
                grandTotal: body.grandTotal,
                subtotal: body.subtotal,
                discountAmount: body.discountAmount,
                cgst: body.cgst,
                sgst: body.sgst,
                requestId,
                deviceId: action.deviceId,
                items: body.items,
              });
              pushResult(requestId, { actionType, status: "success", statusCode: 200, data });
            } catch (err: any) {
              pushResult(requestId, { actionType, status: "error", statusCode: err.statusCode || 500, error: err.message || "Settlement failed" });
            }
          } else if (actionType === "cancel-items") {
            const orderId = action.orderId || internalUrl.split("/")[3];
            try {
              const data = await cancelOrderItemsService({
                orderId,
                restaurantId,
                userId: req.user?.id,
                items: body.items,
                cancelledBy: body.cancelledBy,
                tableNumber: body.tableNumber,
                requestId,
                isExtraTable: body.isExtraTable,
              });
              pushResult(requestId, { actionType, status: "success", statusCode: 200, data: data.order });
            } catch (err: any) {
              pushResult(requestId, { actionType, status: "error", statusCode: err.statusCode || 500, error: err.message || "Cancel items failed" });
            }
          } else if (actionType === "cancel-item") {
            const orderId = action.orderId || internalUrl.split("/")[3];
            try {
              const data = await cancelOrderItemService({
                orderId,
                restaurantId,
                userId: req.user?.id,
                orderItemId: body.orderItemId,
                cancelledBy: body.cancelledBy,
                cancelQuantity: body.cancelQuantity,
                tableNumber: body.tableNumber,
                requestId,
                isExtraTable: body.isExtraTable,
              });
              pushResult(requestId, { actionType, status: "success", statusCode: 200, data: data.order });
            } catch (err: any) {
              pushResult(requestId, { actionType, status: "error", statusCode: err.statusCode || 500, error: err.message || "Cancel item failed" });
            }
          } else if (actionType === "transfer-items") {
            const tableId = action.orderId || internalUrl.split("/")[3];
            try {
              const data = await transferOrderItemsService({
                sourceTableId: tableId,
                targetTableId: body.targetTableId,
                itemIds: body.itemIds,
                transferredBy: body.transferredBy,
                requestId,
                restaurantId,
              });
              pushResult(requestId, { actionType, status: "success", statusCode: 200, data });
            } catch (err: any) {
              pushResult(requestId, { actionType, status: "error", statusCode: err.statusCode || 500, error: err.message || "Transfer items failed" });
            }
          } else {
            pushResult(requestId, { actionType, status: "skipped", statusCode: 200, error: `Unknown actionType: ${actionType}` });
          }
        } catch (err: any) {
          pushResult(action.requestId, { actionType: action.actionType, status: "error", error: err.message || "Network error" });
        }
      }
    });

    await Promise.all(groupPromises);

    const succeeded = results.filter(r => r.status === "success").length;
    const skipped = results.filter(r => r.status === "skipped").length;
    const failed = results.filter(r => r.status === "error").length;

    res.json({
      message: `Sync complete: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed`,
      results,
      summary: { total: results.length, succeeded, skipped, failed },
    });
  } catch (error: any) {
    console.error("[OfflineSync] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/sync-state — Reconciliation endpoint for offline clients
// Returns the current server-side state of all active orders + tables for this restaurant.
// The client compares this with its local IndexedDB cache to detect drift after offline sync.
router.get("/sync-state", async (req, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    // Fetch all active orders with items for this restaurant
    const activeOrders = await prisma.order.findMany({
      where: {
        restaurantId,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        billNumber: true,
        billingRequested: true,
        tableId: true,
        totalAmount: true,
        lastRequestId: true,
        items: {
          where: { removedFromBill: false },
          select: {
            id: true,
            name: true,
            quantity: true,
            price: true,
            removedFromBill: true,
            menuItemId: true,
          },
        },
      },
    });

    // Fetch all tables with their current state
    const tables = await prisma.table.findMany({
      where: { restaurantId },
      select: {
        id: true,
        number: true,
        status: true,
        workflowStatus: true,
        currentBill: true,
        captainId: true,
        updatedAt: true,
        kotHistory: true,
      },
    });

    // Fetch recent transactions (last 24h) for reconciliation
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTxns = await prisma.transaction.findMany({
      where: {
        restaurantId,
        paidAt: { gte: since },
      },
      select: {
        id: true,
        orderId: true,
        txnNumber: true,
        billNumber: true,
        amount: true,
        method: true,
        paidAt: true,
      },
      orderBy: { paidAt: 'desc' },
      take: 200,
    });

    // Build a map of processed requestIds for quick client-side dedup check
    const processedRequests = await prisma.processedRequest.findMany({
      where: {
        restaurantId,
        createdAt: { gte: since },
      },
      select: {
        requestId: true,
        actionType: true,
        orderId: true,
      },
    });

    res.json({
      serverTime: new Date().toISOString(),
      activeOrders,
      tables,
      recentTransactions: recentTxns,
      processedRequests: processedRequests.map(pr => ({
        requestId: pr.requestId,
        actionType: pr.actionType,
        orderId: pr.orderId,
      })),
    });
  } catch (error: any) {
    console.error("[SyncState] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
