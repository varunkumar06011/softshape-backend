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
import { cacheMiddleware, invalidateCache, cacheClear, getRedisClient } from "../lib/cache";
import { resolveTenantContext, isBarOutlet, isVenueOutlet, type TenantContext } from "../lib/tenantContext";
import { getGstBreakdown, getEffectiveGstRate, getGstBreakdownWithRate } from "../utils/gst";
import { authenticate, requireRole } from "../middleware/auth";
import { createAuditLog } from "../lib/auditLog";
import { createOrderService, updateOrderItemsService, cancelOrderItemsService, cancelOrderItemService, printBillService, settleOrderService, autoSettleBillingRequestedOrders, createKotRecord } from "../services/orderService";
import { transferOrderItemsService } from "../services/tableService";

const router = Router();

router.use(authenticate);
const BAR_UNIT_ML = 30;

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
      venue: { select: { id: true, name: true, venueType: true, kotEnabled: true } },
    },
  },
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: { updatedAt: "desc" },
    take: 1,
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        orderBy: { id: "asc" },
        include: {
          menuItem: { select: { gstEnabled: true, menuType: true } },
        },
      },
    },
  },
  kots: {
    orderBy: { createdAt: "asc" },
    include: {
      items: { orderBy: { id: "asc" } },
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
  tx: any,
  preReservedKotNumber?: number
) {
  const kotNumber = preReservedKotNumber ?? await getNextKotNumber(restaurantId, tx);
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
  tx: any,
  preReservedKotNumber?: number
) {
  const history = Array.isArray(existing) ? existing : [];
  return [...history, await kotEntryFromItems(items, restaurantId, tx, preReservedKotNumber)];
}

async function emitToRestaurant(restaurantId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
  if (eventName === "print_job") {
    // print_job goes to the DEDICATED print room (print:<restaurantId>).
    // Only PrintStation joins this room via the "join:print" event.
    // Captain / cashier sockets only join the plain restaurant room, so
    // they will never receive print_job — eliminating the double-delivery bug.
    const printRoom = `print:${restaurantId}`;

    // Use the eventId from the frontend (kotEventIds) if provided.
    // This ensures the Print Agent's seenEventIds dedup catches duplicates
    // when local print succeeded but the response was lost (timeout).
    const frontendEventId = (payload as any).eventId || (payload.data as any)?.eventId || null;
    const eventId = frontendEventId || randomUUID();
    const enriched = {
      restaurantId,
      ...payload,
      eventId,  // TOP LEVEL — so bufferPrintJob can read payload.eventId
      data: { ...(payload.data as Record<string, unknown>), eventId },  // also in data for PrintStation client dedup
    };

    // If localPrinted is set, the frontend already printed via the local Print Agent.
    // Skip the socket emit to prevent duplicate prints, but still buffer for durability.
    if ((payload as any).localPrinted) {
      bufferPrintJob(restaurantId, { ...enriched, localPrinted: true }).catch(() => {});
      return;
    }

    // Emit FIRST — don't let a Redis lock failure silently drop the print job.
    getIo().to(printRoom).emit(eventName, enriched);

    // Buffer for durability — use lock to prevent duplicate buffering on retries.
    // If the lock fails, the job was already buffered by a concurrent call.
    const type = (payload as any).type;
    const orderId = (payload as any).orderId || (payload.data as any)?.orderId;
    const kotId = (payload as any).kotId || (payload.data as any)?.kotId;
    const tableNumber = (payload as any).tableNumber || (payload.data as any)?.tableNumber;
    const itemCount = (payload.data as any)?.items?.length || 0;
    const requestId = (payload as any).requestId || (payload.data as any)?.requestId || '';
    const billNumber = (payload as any).billNumber || (payload.data as any)?.billNumber || '';
    const printerName = (payload.data as any)?.printerName || '';
    const emitKey = `${restaurantId}-${type}-${orderId || kotId || tableNumber}-${itemCount}-${billNumber}-${requestId}-${printerName}`;
    const acquired = await acquireLock(EMIT_LOCK_KEY(emitKey), EMIT_LOCK_TTL);
    if (!acquired) {
      console.warn(`[emitToRestaurant] Buffer lock not acquired for ${emitKey} — job already emitted and buffered by concurrent call`);
      return;
    }
    bufferPrintJob(restaurantId, enriched).catch(err => console.error('[emitToRestaurant] Buffer failed:', err.message));
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

// POST /api/orders/reserve-kot-number
// Lightweight endpoint that reserves a KOT number via dailyCounter.upsert().
// Used by the frontend for local-first printing: the number is reserved before
// local print fires, then passed as preReservedKotNumber to the full order
// creation call so the backend doesn't generate a second number.
router.post("/reserve-kot-number", async (req, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { requestId } = req.body || {};

    // Idempotent reservation: if requestId is provided and we've already
    // reserved a number for it (e.g. the response was lost and the client
    // retried), return the same number instead of incrementing again.
    if (requestId) {
      const redis = getRedisClient();
      if (redis) {
        const reserveKey = `kot:reserve:${restaurantId}:${requestId}`;
        const cached = await redis.get(reserveKey);
        if (cached) {
          res.json({ kotNumber: Number(cached) });
          return;
        }
        const kotNumber = await getNextKotNumber(restaurantId, prisma);
        await redis.set(reserveKey, String(kotNumber), 'EX', 120);
        res.json({ kotNumber });
        return;
      }
    }

    // Fallback: no Redis or no requestId — behave as before
    const kotNumber = await getNextKotNumber(restaurantId, prisma);
    res.json({ kotNumber });
  } catch (error) {
    console.error('[Orders] reserve-kot-number failed:', error);
    res.status(500).json({ error: "Failed to reserve KOT number" });
  }
});

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
    const { tableId, requestId, captainName, isExtraTable, tableNumber, platform, localPrinted, preReservedKotNumber, kotEventIds } = req.body;
    const result = await createOrderService({
      restaurantId,
      tableId,
      items: req.body.items,
      requestId,
      captainName,
      isExtraTable,
      tableNumber,
      platform,
      localPrinted,
      preReservedKotNumber,
      kotEventIds,
      user: req.user ? { userId: req.user.userId, role: req.user.role, name: req.user.name } : undefined,
    });
    res.status(201).json({
      ...result.order,
      kotHistory: result.kotHistory,
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to create order";
    const errAny = error as any;
    const status = errAny?.statusCode || (message.startsWith("Invalid") || message.includes("items") ? 400 : 500);
    const response: any = { error: message };
    if (errAny?.missing) response.missing = errAny.missing;
    if (errAny?.existingOrderId) response.existingOrderId = errAny.existingOrderId;
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
      include: {
        ...orderInclude,
        table: {
          include: {
            section: { select: { id: true, name: true, restaurantId: true, venue: { select: { id: true, venueType: true, kotEnabled: true } } } },
            kots: {
              orderBy: { createdAt: "asc" },
              include: { items: { orderBy: { id: "asc" } } },
            },
          },
        },
      },
    });

    if (!order) {
      res.status(404).json({ error: "Active order not found" });
      return;
    }

    const kotsArr = ((order.table as any)?.kots as any[]) || [];
    const fullKotHistory = kotsArr.length > 0
      ? kotsArr.map((kot: any) => ({
          id: String(kot.kotNumber ?? kot.id ?? ''),
          time: kot.createdAt ? new Date(kot.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null,
          items: (kot.items || []).map((ki: any) => ({
            id: ki.menuItemId || ki.id,
            n: ki.name,
            p: Number(ki.price),
            q: ki.quantity,
            s: ki.status === 'CANCELLED' ? 'Cancelled' : 'KOT Sent',
            orderItemId: ki.orderItemId,
            notes: ki.notes,
          })),
        }))
      : [];

    res.json({ ...order, kotHistory: fullKotHistory });
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
    const { requestId, captainName, isExtraTable, tableNumber: extraTableNumber, lastUpdatedAt, localPrinted, preReservedKotNumber, kotEventIds } = req.body;

    const result = await updateOrderItemsService({
      orderId: id,
      restaurantId,
      items: req.body.items,
      requestId,
      captainName,
      isExtraTable,
      tableNumber: extraTableNumber,
      lastUpdatedAt,
      localPrinted,
      preReservedKotNumber,
      kotEventIds,
    });

    // Respond immediately — print emission is fire-and-forget
    res.json({ order: result.order, kotHistory: result.kotHistory, table: result.table });

    // Fire-and-forget: outlet lookup + KOT payload building + print-job emission
    void (async () => {
      const ctx = await resolveTenantContext(restaurantId);
      const mappedItems2 = result.mappedItems;
      const newKotHistory = result.kotHistory;
      const updatedTable = result.table;
      const existingRestaurantId = restaurantId;
      const incomingCaptainName2 = captainName;
      const extraTableNumber2 = extraTableNumber;
      const updatedOrder = { order: result.order };

      // Fetch outlet data for KOT header (restaurant name from onboarding, not hardcoded)
      const kotRestaurant2 = await prisma.outlet.findUnique({
        where: { id: existingRestaurantId },
        select: { name: true, receiptHeader: true },
      });
      const kotRestaurantName2 = kotRestaurant2?.receiptHeader?.trim() || kotRestaurant2?.name?.trim() || undefined;

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
        localPrinted: localPrinted || false,
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
        restaurantName: kotRestaurantName2,
        kotId: basePayload.kotId,
        sectionName: basePayload.sectionName,
        captainName: basePayload.captainName,
        sectionTag: basePayload.sectionTag || undefined,
      };

      const venueKotEnabled2 = updatedTable?.section?.venue?.kotEnabled !== false;

      if (venueKotEnabled2) {
        // Hybrid grouping: items WITH a resolved printer name → group by that name.
        // Items WITHOUT a resolved printer name → legacy fallback by menuType.
        const groupedByPrinter = new Map<string | undefined, typeof mappedItems2>();
        for (const item of mappedItems2) {
          const key = item.printerName;
          if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
          groupedByPrinter.get(key)!.push(item);
        }

        // Map kotEventIds from frontend to emit calls for dedup.
        // kotEventIds = ["reqId-food", "reqId-liquor"] or similar.
        const eventIds = Array.isArray(kotEventIds) ? kotEventIds : [];
        let eventIdIdx = 0;

        const emitPromises: Promise<void>[] = [];
        for (const [printerName, groupItems] of groupedByPrinter) {
          if (!printerName) {
            // LEGACY FALLBACK: items with no resolved printer → old split by menuType
            const counterItems = groupItems.filter((i) => i.printerTarget === 'BAR_PRINTER' || i.menuType === 'LIQUOR');
            const kitchenItems = groupItems.filter((i) => i.printerTarget !== 'BAR_PRINTER' && i.menuType !== 'LIQUOR');

            if (kitchenItems.length > 0) {
              const kitchenPrintItems = kitchenItems.map((i) => ({
                name: i.name,
                quantity: i.quantity,
                price: i.price,
                notes: i.notes ?? null,
                type: 'food' as const,
              }));
              emitPromises.push(emitToRestaurant(existingRestaurantId, "print_job", {
                type: "KOT",
                eventId: eventIds[eventIdIdx++] || undefined,
                data: {
                  ...basePayload,
                  items: kitchenItems,
                  escposData: buildFoodKOT({ ...kotOrderData2, items: kitchenPrintItems }),
                }
              }));
            }
            if (counterItems.length > 0) {
              const counterPrintItems = counterItems.map((i) => ({
                name: i.name,
                quantity: i.quantity,
                price: i.price,
                notes: i.notes ?? null,
                type: 'liquor' as const,
              }));
              emitPromises.push(emitToRestaurant(existingRestaurantId, "print_job", {
                type: "BAR_KOT",
                eventId: eventIds[eventIdIdx++] || undefined,
                data: {
                  ...basePayload,
                  items: counterItems,
                  escposData: buildLiquorKOT({ ...kotOrderData2, items: counterPrintItems }),
                }
              }));
            }
          } else {
            // NEW BEHAVIOR: precise printer routing by resolved printer name
            const isAllLiquor = groupItems.every((i) => i.menuType === 'LIQUOR');
            const jobType = isAllLiquor ? 'BAR_KOT' : 'KOT';
            const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
            const printItems = groupItems.map((i) => ({
              name: i.name,
              quantity: i.quantity,
              price: i.price,
              notes: i.notes ?? null,
              type: (i.menuType === 'LIQUOR' ? 'liquor' : 'food') as 'food' | 'liquor',
            }));
            emitPromises.push(emitToRestaurant(existingRestaurantId, "print_job", {
              type: jobType,
              eventId: eventIds[eventIdIdx++] || undefined,
              data: {
                ...basePayload,
                printerName,
                items: groupItems,
                escposData: builder({ ...kotOrderData2, items: printItems }),
              }
            }));
          }
        }
        Promise.all(emitPromises).catch(err => console.error('[KOT] Print emission failed (PATCH items):', err.message));
      }
    })().catch(err => console.error('[KOT] Post-response print emission failed (PATCH items):', err.message));

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
      const addedItemsForKot: Array<{ name: string; price: number; quantity: number; id: string; menuItemId: string; menuType: "FOOD" | "LIQUOR" }> = [];
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
            addedItemsForKot.push({
              name: existingMatch.name,
              price: Number(existingMatch.price),
              quantity,
              id: existingMatch.id,
              menuItemId,
              menuType: (existingMatch.menuType as any) === "LIQUOR" ? "LIQUOR" : "FOOD",
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
              addedItemsForKot.push({
                name: justCreated.name,
                price: Number(justCreated.price),
                quantity,
                id: justCreated.id,
                menuItemId,
                menuType: (justCreated.menuType as any) === "LIQUOR" ? "LIQUOR" : "FOOD",
              });
            }
          } else {
            // Create new row
            const created = await tx.orderItem.create({
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
            addedItemsForKot.push({
              name,
              price: Number(price),
              quantity,
              id: created.id,
              menuItemId,
              menuType,
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

      // 4. Create Kot + KotItem rows for cashier-added items
      if (addedItemsForKot.length > 0) {
        const kotOrderItems = addedItemsForKot.map((item) => ({
          id: item.id,
          menuItemId: item.menuItemId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          notes: null,
        }));
        await createKotRecord(tx, restaurantId, existing.tableId, id, kotOrderItems);
      }

      const tableUpdateData: Record<string, any> = { currentBill: newTotal };
      if (validItems.length === 0) {
        tableUpdateData.status = TableStatus.AVAILABLE;
        tableUpdateData.workflowStatus = 'Free';
        tableUpdateData.captainId = null;
        tableUpdateData.guests = 0;
        tableUpdateData.sessionStartedAt = null;
        tableUpdateData.kotHistory = [];
      }
      const table = await tx.table.update({
        where: { id: existing.tableId },
        data: tableUpdateData,
        include: tableInclude,
      });

      return { order, table, addedItemsForKot };
    }, { timeout: 15000, maxWait: 20000 });

    await emitToRestaurant(existing.restaurantId, "order:updated", { order: result.order });
    await emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });

    // Fire-and-forget: KOT print-job emission for cashier-added items
    if (result.addedItemsForKot && result.addedItemsForKot.length > 0) {
      void (async () => {
        try {
          const ctx = await resolveTenantContext(restaurantId);
          const addedItems = result.addedItemsForKot;
          const newKotHistory = result.table.kots as Array<{ kotNumber: number }> || [];
          const latestKot = newKotHistory[newKotHistory.length - 1];
          const table = result.table;

          // Fetch menu items with categories for printer routing
          const menuItemsWithCat = await prisma.menuItem.findMany({
            where: { id: { in: addedItems.map(i => i.menuItemId) }, restaurantId },
            include: { category: { select: { name: true, printerTarget: true } } },
          });
          const menuItemCategoryMap = new Map(
            menuItemsWithCat.map(m => [m.id, {
              name: m.category?.name || 'Unknown',
              printerTarget: m.category?.printerTarget || null,
              itemPrinterTarget: m.printerTarget || null,
              itemPrinterName: m.printerName || null,
            }])
          );

          const printerConfig = await loadPrinterConfig(restaurantId);
          const mappedItems = addedItems.map((i) => {
            const cat = menuItemCategoryMap.get(i.menuItemId) || { name: 'Unknown', printerTarget: null, itemPrinterTarget: null, itemPrinterName: null };
            const resolvedPrinterName = resolvePrinterName(restaurantId, cat.itemPrinterName, cat.itemPrinterTarget, cat.printerTarget, printerConfig);
            return {
              name: i.name,
              quantity: i.quantity,
              price: i.price,
              notes: null,
              menuType: i.menuType,
              category: cat.name,
              printerTarget: cat.itemPrinterTarget || cat.printerTarget,
              printerName: resolvedPrinterName,
            };
          });

          const kotRestaurant = await prisma.outlet.findUnique({
            where: { id: restaurantId },
            select: { name: true, receiptHeader: true },
          });
          const kotRestaurantName = kotRestaurant?.receiptHeader?.trim() || kotRestaurant?.name?.trim() || undefined;

          const formattedTableNumber = table?.number
            ? formatTableNumber(table.number, restaurantId, table.section?.name, (table as any)?.sectionTag, table?.section?.venue?.venueType, ctx)
            : "UNKNOWN";

          const basePayload = {
            kotId: latestKot ? String(latestKot.kotNumber) : "??",
            tableNumber: formattedTableNumber,
            restaurantId,
            sectionTag: (table as any)?.sectionTag || null,
            sectionName: table?.section?.name || "Main Hall",
            captainName: await getCaptainName(table?.captainId || undefined) || 'Cashier',
            timestamp: new Date().toISOString(),
            requestId: requestId || null,
            localPrinted: false,
          };

          const kotPrintItems = mappedItems.map(i => ({
            name: i.name,
            quantity: i.quantity,
            price: i.price,
            notes: i.notes ?? null,
            type: (i.menuType === 'LIQUOR' ? 'liquor' : 'food') as 'food' | 'liquor',
          }));

          const kotOrderData = {
            tableNumber: formattedTableNumber,
            orderId: id,
            items: kotPrintItems,
            restaurantName: kotRestaurantName,
            kotId: basePayload.kotId,
            sectionName: basePayload.sectionName,
            captainName: basePayload.captainName,
            sectionTag: basePayload.sectionTag || undefined,
          };

          const venueKotEnabled = table?.section?.venue?.kotEnabled !== false;
          if (venueKotEnabled) {
            const groupedByPrinter = new Map<string | undefined, typeof mappedItems>();
            for (const item of mappedItems) {
              const key = item.printerName;
              if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
              groupedByPrinter.get(key)!.push(item);
            }

            const emitPromises: Promise<void>[] = [];
            for (const [printerName, groupItems] of groupedByPrinter) {
              if (!printerName) {
                const counterItems = groupItems.filter((i) => i.printerTarget === 'BAR_PRINTER' || i.menuType === 'LIQUOR');
                const kitchenItems = groupItems.filter((i) => i.printerTarget !== 'BAR_PRINTER' && i.menuType !== 'LIQUOR');

                if (kitchenItems.length > 0) {
                  const kitchenPrintItems = kitchenItems.map((i) => ({
                    name: i.name,
                    quantity: i.quantity,
                    price: i.price,
                    notes: i.notes ?? null,
                    type: 'food' as const,
                  }));
                  emitPromises.push(emitToRestaurant(restaurantId, "print_job", {
                    type: "KOT",
                    data: {
                      ...basePayload,
                      items: kitchenItems,
                      escposData: buildFoodKOT({ ...kotOrderData, items: kitchenPrintItems }),
                    }
                  }));
                }
                if (counterItems.length > 0) {
                  const counterPrintItems = counterItems.map((i) => ({
                    name: i.name,
                    quantity: i.quantity,
                    price: i.price,
                    notes: i.notes ?? null,
                    type: 'liquor' as const,
                  }));
                  emitPromises.push(emitToRestaurant(restaurantId, "print_job", {
                    type: "BAR_KOT",
                    data: {
                      ...basePayload,
                      items: counterItems,
                      escposData: buildLiquorKOT({ ...kotOrderData, items: counterPrintItems }),
                    }
                  }));
                }
              } else {
                const isAllLiquor = groupItems.every((i) => i.menuType === 'LIQUOR');
                const jobType = isAllLiquor ? 'BAR_KOT' : 'KOT';
                const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
                const printItems = groupItems.map((i) => ({
                  name: i.name,
                  quantity: i.quantity,
                  price: i.price,
                  notes: i.notes ?? null,
                  type: (i.menuType === 'LIQUOR' ? 'liquor' : 'food') as 'food' | 'liquor',
                }));
                emitPromises.push(emitToRestaurant(restaurantId, "print_job", {
                  type: jobType,
                  data: {
                    ...basePayload,
                    printerName,
                    items: groupItems,
                    escposData: builder({ ...kotOrderData, items: printItems }),
                  }
                }));
              }
            }
            Promise.all(emitPromises).catch(err => console.error('[KOT] Print emission failed (bill-edit):', err.message));
          }
        } catch (err: any) {
          console.error('[KOT] Post-response print emission failed (bill-edit):', err.message);
        }
      })();
    }

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
    const { tableNumber: tableNumberOverride, discountPercent: discountPercentOverride, kotNumbers: kotNumbersParam, requestId, localPrinted: localPrintedParam, billEventId } = req.query as { tableNumber?: string; discountPercent?: string; kotNumbers?: string; requestId?: string; localPrinted?: string; billEventId?: string };
    const isExtraTable = !!tableNumberOverride;
    const localPrinted = localPrintedParam === 'true';

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

    // Fetch outlet data for bill header (restaurant name, address, phone from onboarding)
    const billRestaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, receiptHeader: true, receiptSubHeader: true, address: true, phone: true, gstin: true },
    });

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

      // ── RE-FETCH ITEMS INSIDE TRANSACTION ──────────────────────────────────
      // The outer-scope `activeItems` may be stale if a cancel/edit happened
      // between the outer fetch and the FOR UPDATE lock. Re-fetch now to get
      // the authoritative set of billable items.
      const lockedOrder = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            where: { removedFromBill: false, quantity: { gt: 0 } },
            include: { menuItem: true },
          },
        },
      });
      if (!lockedOrder) throw new Error('Order not found inside transaction (post-lock)');

      const freshActiveItems = lockedOrder.items;
      if (freshActiveItems.length === 0) {
        throw Object.assign(new Error('Cannot print bill: all items have been cancelled'), { statusCode: 400 });
      }

      // Calculate bill details — use freshActiveItems, not stale activeItems
      const foodItems = freshActiveItems.filter(item => item.menuItem.menuType === "FOOD");
      const liquorItems = freshActiveItems.filter(item => { const mt = item.menuItem.menuType as string; return mt === "LIQUOR" || mt === "BAR"; });

      const foodSubtotal = foodItems.reduce((sum, item) =>
        sum + (Number(item.price) * item.quantity), 0
      );
      const liquorSubtotal = liquorItems.reduce((sum, item) =>
        sum + (Number(item.price) * item.quantity), 0
      );
      const subtotal = foodSubtotal + liquorSubtotal;

      // GST-exempt food items (gstEnabled=false on MenuItem)
      const gstExemptFood = foodItems
        .filter((item: any) => item.menuItem.gstEnabled === false)
        .reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);

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

      // Tax calculation (CGST + SGST on food only, AFTER discount, excluding GST-disabled items) - WITH ROUNDING
      const discountedFood = foodSubtotal - (discount ? discountAmount * (foodSubtotal / subtotal) : 0);
      const gstExemptAfterDiscount = Math.max(0, gstExemptFood - (discount ? discountAmount * (gstExemptFood / subtotal) : 0));
      const taxableAmount = Math.max(0, discountedFood - gstExemptAfterDiscount);
      const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
      const { cgst, sgst, tax, baseAmount } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!taxSource.pricesIncludeGst);
      const liquorAfterDiscount = liquorSubtotal - (discount ? discountAmount * (liquorSubtotal / subtotal) : 0);
      const displayedSubtotal = Math.round((baseAmount + gstExemptAfterDiscount + liquorAfterDiscount) * 100) / 100;
      const grandTotal = Math.round((displayedSubtotal + tax) * 100) / 100;

      // Get all KOT numbers from the session
      const kotHistory = (updatedTable.kots as Array<{ kotNumber: number }>) || [];
      const kotNumbers = isExtraTable && kotNumbersParam
        ? kotNumbersParam.split(',').filter(Boolean)
        : kotHistory
            .map(k => String(k.kotNumber))
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
              const grouped = freshActiveItems.reduce((acc, item) => {
                const key = `${item.name}::${Number(item.price)}::${item.notes ?? ''}`;
                if (!acc[key]) {
                  acc[key] = { name: item.name, quantity: 0, price: Number(item.price), menuType: item.menuItem.menuType, notes: item.notes ?? null };
                }
                acc[key].quantity += item.quantity;
                return acc;
              }, {} as Record<string, any>);
              return Object.values(grouped).map((item: any) => ({
                name: item.name,
                quantity: item.quantity,
                price: item.price,
                amount: item.price * item.quantity,
                menuType: item.menuType,
                notes: item.notes
              }));
            })(),
            subtotal: subtotal,
            discount,
            tax: { cgst, sgst, total: tax },
            grandTotal,
            section: updatedTable.section?.name || "Main Hall",
            itemCount: (() => {
              const grouped = freshActiveItems.reduce((acc, item) => {
                const key = `${item.name}::${Number(item.price)}`;
                if (!acc[key]) {
                  acc[key] = true;
                }
                return acc;
              }, {} as Record<string, boolean>);
              return Object.keys(grouped).length;
            })(),
            qtyCount: freshActiveItems.reduce((sum, item) => sum + item.quantity, 0),
            ...(ctx.gstin ? { gstIn: ctx.gstin } : {}),
            restaurant: billRestaurant as any,
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
      eventId: billEventId || undefined,
      localPrinted,
      data: { ...result.billData.data, escposData: finalBillEscpos, eventId: billEventId || undefined },
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
        items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: { include: { category: { select: { printerTarget: true } } } } } },
        table: { include: { section: { include: { venue: { select: { venueType: true } } } } } },
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const ctx = await resolveTenantContext(restaurantId);
    const printerConfig = await loadPrinterConfig(restaurantId);

    const activeItems = order.items.filter(i => !i.removedFromBill && i.quantity > 0);
    if (activeItems.length === 0) {
      return res.status(400).json({ error: "No active items to reprint KOT" });
    }

    // Resolve printerName for each item
    const reprintItems = activeItems.map((i) => {
      const mi = i.menuItem as any;
      const itemPrinterName = mi?.printerName || null;
      const itemPrinterTarget = mi?.printerTarget || null;
      const categoryPrinterTarget = mi?.category?.printerTarget || null;
      const printerName = resolvePrinterName(restaurantId, itemPrinterName, itemPrinterTarget, categoryPrinterTarget, printerConfig);
      return {
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        price: Number(i.price),
        notes: i.notes ?? null,
        menuType: i.menuItem.menuType,
        printerName,
      };
    });

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
      items: reprintItems.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        notes: i.notes ?? null,
        type: (i.menuType === "LIQUOR" ? 'liquor' : 'food') as 'food' | 'liquor',
      })),
      kotId: 'REPRINT',
      sectionName: order.table?.section?.name || '',
      captainName: order.table?.captainId || 'Cashier',
      sectionTag: (order.table as any)?.sectionTag || undefined,
    };

    const basePayload = {
      tableNumber,
      orderId: order.id,
      restaurantId,
      sectionTag: (order.table as any)?.sectionTag || undefined,
      sectionName: order.table?.section?.name || '',
      captainName: order.table?.captainId || 'Cashier',
    };

    // Hybrid grouping for reprint: group by resolved printer name when available,
    // fall back to legacy menuType split when not.
    const groupedByPrinter = new Map<string | undefined, typeof reprintItems>();
    for (const item of reprintItems) {
      const key = item.printerName;
      if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
      groupedByPrinter.get(key)!.push(item);
    }

    const reprintPromises: Promise<void>[] = [];
    for (const [printerName, groupItems] of groupedByPrinter) {
      if (!printerName) {
        // LEGACY FALLBACK: no resolved printer → split by menuType
        const foodItems = groupItems.filter((i) => i.menuType !== "LIQUOR");
        const liquorItems = groupItems.filter((i) => i.menuType === "LIQUOR");
        if (foodItems.length > 0) {
          reprintPromises.push(emitToRestaurant(restaurantId, "print_job", {
            type: "KOT",
            data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData) }
          }));
        }
        if (liquorItems.length > 0) {
          reprintPromises.push(emitToRestaurant(restaurantId, "print_job", {
            type: "BAR_KOT",
            data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData) }
          }));
        }
      } else {
        // NEW BEHAVIOR: precise printer routing
        const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
        const jobType = isAllLiquor ? 'BAR_KOT' : 'KOT';
        const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
        const groupKotData = {
          ...kotOrderData,
          items: groupItems.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            price: i.price,
            notes: i.notes ?? null,
            type: (i.menuType === "LIQUOR" ? 'liquor' : 'food') as 'food' | 'liquor',
          })),
        };
        reprintPromises.push(emitToRestaurant(restaurantId, "print_job", {
          type: jobType,
          data: { ...basePayload, printerName, items: groupItems, escposData: builder(groupKotData) }
        }));
      }
    }
    await Promise.all(reprintPromises);

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
      kitchenDeductionErrors: result.kitchenDeductionErrors ?? [],
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
// Cancels multiple items in one transaction → emits CANCEL_KOT per printer (auto-split food/liquor)
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

    // 2. Find active order for this table — include items and table info for cancelled bill
    const activeOrder = await prisma.order.findFirst({
      where: {
        tableId,
        restaurantId,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      include: {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: true },
        },
        table: {
          include: { section: { include: { venue: { include: { taxProfile: true } } } } },
        },
      },
    });

    // Fetch outlet data for bill header
    const billRestaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, receiptHeader: true, receiptSubHeader: true, address: true, phone: true, gstin: true },
    });

    const ctx = await resolveTenantContext(restaurantId);

    const result = await prisma.$transaction(async (tx) => {
      let updatedOrder = null;
      let cancelledBillNumber: string | null = null;

      if (activeOrder) {
        // Reuse existing bill number if Print Bill was already clicked.
        // Do NOT generate a new bill number for cancelled/terminated orders.
        cancelledBillNumber = activeOrder.billNumber ?? null;

        await tx.orderItem.deleteMany({
          where: { orderId: activeOrder.id },
        });
        updatedOrder = await tx.order.update({
          where: { id: activeOrder.id },
          data: {
            status: OrderStatus.CANCELLED,
            totalAmount: new Prisma.Decimal(0),
            billNumber: cancelledBillNumber,
          },
          include: orderInclude,
        });
      }

      // 3. Reset the table — delete all Kot/KotItem rows for this table
      await tx.kot.deleteMany({ where: { tableId } });
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

      return { order: updatedOrder, table: updatedTable, cancelledBillNumber };
    }, { timeout: 15000, maxWait: 20000 });

    // 4. Emit socket events using the already-validated tenant id
    if (result.order && restaurantId) {
      await emitToRestaurant(restaurantId, "order:updated", { order: result.order });
    }
    if (restaurantId) {
      await emitToRestaurant(restaurantId, "table:updated", { table: result.table });
    }

    // 5. If there were items, build and emit a CANCELLED BILL to the bill printer
    if (activeOrder && activeOrder.items.length > 0 && result.cancelledBillNumber) {
      try {
        const now = new Date();
        const items = activeOrder.items;
        const tbl = activeOrder.table!;

        // Calculate bill details
        const foodItems = items.filter(item => item.menuItem.menuType === "FOOD");
        const liquorItems = items.filter(item => {
          const mt = item.menuItem.menuType as string;
          return mt === "LIQUOR" || mt === "BAR";
        });

        const foodSubtotal = foodItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
        const liquorSubtotal = liquorItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
        const subtotal = foodSubtotal + liquorSubtotal;

        // Tax calculation
        const venueTaxProfile = tbl.section?.venue?.taxProfile;
        const taxSource = venueTaxProfile
          ? { gstRate: venueTaxProfile.gstRate, gstCategory: venueTaxProfile.gstCategory, gstRegistered: venueTaxProfile.gstRegistered, pricesIncludeGst: ctx.pricesIncludeGst }
          : ctx;
        const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
        const { cgst, sgst, tax, baseAmount } = getGstBreakdownWithRate(foodSubtotal, effectiveRate, !!taxSource.pricesIncludeGst);
        const displayedSubtotal = Math.round((baseAmount + liquorSubtotal) * 100) / 100;
        const grandTotal = Math.round((displayedSubtotal + tax) * 100) / 100;

        // Format table number
        const formattedTableNumber = formatTableNumber(
          tbl.number,
          restaurantId,
          tbl.section?.name,
          (tbl as any).sectionTag,
          tbl.section?.venue?.venueType,
          ctx
        );

        // Group items for bill
        const groupedItems = items.reduce((acc, item) => {
          const key = `${item.name}::${Number(item.price)}::${item.notes ?? ''}`;
          if (!acc[key]) {
            acc[key] = { name: item.name, quantity: 0, price: Number(item.price), menuType: item.menuItem.menuType, notes: item.notes ?? null };
          }
          acc[key].quantity += item.quantity;
          return acc;
        }, {} as Record<string, any>);

        const billItems = Object.values(groupedItems).map((item: any) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          amount: item.price * item.quantity,
          menuType: item.menuType,
          notes: item.notes,
        }));

        // KOT numbers from table history (use pre-termination data)
        const kotHistory = (tbl as any).kots as Array<{ kotNumber: number }> || [];
        const kotNumbers = kotHistory.map(k => String(k.kotNumber)).filter(Boolean);

        const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
        const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });

        const billData = {
          billNumber: result.cancelledBillNumber,
          date: dateStr,
          time: timeStr,
          kotNumbers,
          tableNumber: formattedTableNumber,
          captain: (tbl as any).captainId || "N/A",
          items: billItems,
          subtotal,
          discount: null,
          tax: { cgst, sgst, total: tax },
          grandTotal,
          section: tbl.section?.name || "Main Hall",
          sectionTag: (tbl as any).sectionTag || null,
          itemCount: billItems.length,
          qtyCount: items.reduce((sum, item) => sum + item.quantity, 0),
          ...(ctx.gstin ? { gstIn: ctx.gstin } : {}),
          restaurant: billRestaurant as any,
          isCancelled: true,
        };

        const cancelledBillEscpos = buildFinalBill(billData as any);
        await emitToRestaurant(restaurantId, "print_job", {
          type: "CANCELLED_BILL",
          data: { ...billData, escposData: cancelledBillEscpos },
        });
      } catch (printErr) {
        console.error("[terminate-table] Failed to emit cancelled bill print job:", printErr);
      }
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

              // Respond to sync result immediately — print emission is fire-and-forget
              pushResult(requestId, { actionType, status: "success", statusCode: 200, data });

              // Fire-and-forget: KOT print-job emission (mirrors direct PATCH route)
              void (async () => {
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
                  localPrinted: body.localPrinted || false,
                };
                const syncKotPrintItems = syncMappedItems.map((i: any) => ({
                  name: i.name,
                  quantity: i.quantity,
                  price: i.price,
                  notes: i.notes ?? null,
                  type: (i.menuType === 'LIQUOR' ? 'liquor' : 'food') as 'food' | 'liquor',
                }));
                const syncKotRestaurant = await prisma.outlet.findUnique({
                  where: { id: restaurantId },
                  select: { name: true, receiptHeader: true },
                });
                const syncKotRestaurantName = syncKotRestaurant?.receiptHeader?.trim() || syncKotRestaurant?.name?.trim() || undefined;
                const syncKotOrderData = {
                  tableNumber: syncBasePayload.tableNumber,
                  orderId,
                  items: syncKotPrintItems,
                  restaurantName: syncKotRestaurantName,
                  kotId: syncBasePayload.kotId,
                  sectionName: syncBasePayload.sectionName,
                  captainName: syncBasePayload.captainName,
                  sectionTag: syncBasePayload.sectionTag || undefined,
                };

                // Unified splitting: items with printerTarget=BAR_PRINTER or menuType=LIQUOR → BAR_KOT
                // Everything else → KOT. This respects admin's KOT destination setting in all outlet types.
                {
                  const counterItems = syncMappedItems.filter((i: any) => i.printerTarget === 'BAR_PRINTER' || i.menuType === 'LIQUOR');
                  const kitchenItems = syncMappedItems.filter((i: any) => i.printerTarget !== 'BAR_PRINTER' && i.menuType !== 'LIQUOR');
                  const emitPromises: Promise<void>[] = [];
                  if (kitchenItems.length > 0) {
                    const kitchenPrintItems = kitchenItems.map((i: any) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: 'food' as const }));
                    emitPromises.push(emitToRestaurant(restaurantId, "print_job", {
                      type: "KOT",
                      data: { ...syncBasePayload, printerName: kitchenItems[0]?.printerName || undefined, items: kitchenItems, escposData: buildFoodKOT({ ...syncKotOrderData, items: kitchenPrintItems }) }
                    }));
                  }
                  if (counterItems.length > 0) {
                    const counterPrintItems = counterItems.map((i: any) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: 'liquor' as const }));
                    emitPromises.push(emitToRestaurant(restaurantId, "print_job", {
                      type: "BAR_KOT",
                      data: { ...syncBasePayload, printerName: counterItems[0]?.printerName || undefined, items: counterItems, escposData: buildLiquorKOT({ ...syncKotOrderData, items: counterPrintItems }) }
                    }));
                  }
                  Promise.all(emitPromises).catch(err => console.error('[KOT] Print emission failed (sync update-items):', err.message));
                }
              })().catch(err => console.error('[KOT] Post-response print emission failed (sync update-items):', err.message));
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
                  eventId: body.billEventId || undefined,
                  localPrinted: body.localPrinted === true,
                  data: { ...data.billData.data, escposData: finalBillEscpos, eventId: body.billEventId || undefined },
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
        kots: { select: { kotNumber: true } },
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

// ── AUTO-SETTLE STUCK BILLING_REQUESTED ORDERS ──────────────────────────────
// Recovery endpoint: finds all BILLING_REQUESTED orders for the restaurant
// and settles them using backend-calculated totals with the given payment method.
// This prevents orders from being stuck indefinitely when settlement fails.
router.post("/auto-settle-stuck", async (req, res) => {
  try {
    const restaurantId = (req as any).user?.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }
    const paymentMethod = (req.body?.paymentMethod || 'CASH').toUpperCase();
    if (!['CASH', 'UPI', 'CARD'].includes(paymentMethod)) {
      return res.status(400).json({ error: "paymentMethod must be CASH, UPI, or CARD" });
    }

    console.log(`[AutoSettle] Triggered for restaurant ${restaurantId}, paymentMethod=${paymentMethod}`);
    const result = await autoSettleBillingRequestedOrders(restaurantId, paymentMethod, 0);

    res.json({
      message: `Auto-settle complete: ${result.settled.length} settled, ${result.failed.length} failed`,
      settled: result.settled,
      failed: result.failed,
    });
  } catch (error: any) {
    console.error("[AutoSettle] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
