import { OrderStatus, Prisma, TableStatus, PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import { getKolkataDateString } from "../utils/date";
import { isBeerItem } from "../utils/itemHelpers";
import prisma from "../lib/prisma";
import { resolveItemPrice, buildVenuePriceMap } from "../lib/priceResolver";
import { resolveTenantContext, resolveKitchenRestaurantId, isBarOutlet, isVenueOutlet, type TenantContext } from "../lib/tenantContext";
import { getGstBreakdownWithRate, getEffectiveGstRate } from "../utils/gst";
import { createAuditLog } from "../lib/auditLog";
import { cacheClear, getRedisClient } from "../lib/cache";
import { acquireLock, releaseLock } from "../lib/redisLock";
import { getCaptainName } from "../utils/captainMap";
import {
  getNextTxnNumber,
  getNextBillNumber,
  formatBillNumber,
  buildTxnItemsFromOrderItems,
  upsertPendingTransaction,
  upsertCancelledTransaction,
  completedTxnWhere,
} from "../lib/transactionHelpers";
import {
  buildFoodKOT,
  buildLiquorKOT,
  buildCancelKOT,
} from "../utils/escpos";

const BAR_UNIT_ML = 30;

const warnedPrinterConfigRestaurantIds = new Set<string>();
const warnedNoPrintersRestaurantIds = new Set<string>();
const warnedUnrecognizedTargetRestaurantIds = new Set<string>();

const orderIncludeWithCancelled = {
  table: {
    include: {
      section: { select: { id: true, name: true, restaurantId: true, venue: { select: { id: true, venueType: true, kotEnabled: true } } } },
    },
  },
  items: {
    orderBy: { id: "asc" },
    include: {
      menuItem: { select: { gstEnabled: true, menuType: true } },
    },
  },
} as const;

const EMIT_LOCK_KEY = (key: string) => `emit_lock:order:${key}`;
const EMIT_LOCK_TTL = 10; // seconds

// Compute a stable signature for a set of items to detect duplicate submissions
function computeItemSignature(items: Array<{ menuItemId: string; quantity: number; notes?: string | null }>): string {
  return items
    .map(i => `${i.menuItemId}:${i.quantity}:${i.notes ?? ''}`)
    .sort()
    .join('|');
}

// Redis-based dedup: returns true if this exact payload was seen recently (within dedupTtlSeconds)
async function isDuplicatePayload(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false; // fail-open
  try {
    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === null; // null means key already existed → duplicate
  } catch {
    return false; // fail-open
  }
}

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

const printerConfigCache = new Map<string, { data: Record<string, any>, expires: number }>();
const PRINTER_CONFIG_TTL_MS = 60_000;

export async function loadPrinterConfig(restaurantId: string) {
  const cached = printerConfigCache.get(restaurantId);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }
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
  printerConfigCache.set(restaurantId, { data: config, expires: Date.now() + PRINTER_CONFIG_TTL_MS });
  return config;
}

export function resolvePrinterName(
  restaurantId: string,
  itemPrinterName: string | null | undefined,
  itemPrinterTarget: string | null | undefined,
  categoryPrinterTarget: string | null | undefined,
  printerConfig: Record<string, any>
): string | undefined {
  // 1. Direct item-level physical printer override (highest priority)
  if (itemPrinterName) return itemPrinterName;

  const target = (itemPrinterTarget || categoryPrinterTarget)?.trim();
  if (!target) return undefined;

  // 2. If target is an actual known printer name (from configured or agent-reported), use it directly
  const { printers, valid } = normalizePrinterConfig(printerConfig);
  const available: string[] = printerConfig?.availablePrinters || [];
  const allKnownNames = new Set([
    ...(valid ? printers.map((p: any) => p.name).filter(Boolean) : []),
    ...available,
  ]);

  if (allKnownNames.has(target)) return target;

  // 3. Legacy fallback: old enum values still in DB
  const normalized = (valid ? printers : []).map((p: any) => ({
    name: p.name,
    type: String(p.type || '').toUpperCase(),
    nameLower: String(p.name || '').toLowerCase(),
  }));

  const legacyTarget = target.toUpperCase();
  if (legacyTarget === 'BAR_PRINTER') {
    return normalized.find((p) => p.type === 'BAR')?.name
      || normalized.find((p) => p.nameLower.includes('bar'))?.name;
  }
  if (legacyTarget === 'KOT_PRINTER') {
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

export const orderInclude = {
  table: {
    include: {
      section: { select: { id: true, name: true, restaurantId: true, venue: { select: { id: true, venueType: true, kotEnabled: true } } } },
    },
  },
  items: {
    where: { removedFromBill: false, quantity: { gt: 0 } },
    orderBy: { id: "asc" },
    include: {
      menuItem: { select: { gstEnabled: true, menuType: true } },
    },
  },
} as const;

export const tableInclude = {
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

export type NormalizedOrderItem = {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  notes: string | null;
  menuType: "FOOD" | "LIQUOR";
};

export function normalizeItems(items: unknown): NormalizedOrderItem[] {
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
      quantity: Math.round(quantity),
      notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null,
      menuType,
    };
  });
}

export function totalAmount(items: Array<{ price: number | Prisma.Decimal; quantity: number }>): Prisma.Decimal {
  return items.reduce(
    (sum, item) => sum.add(new Prisma.Decimal(item.price).mul(new Prisma.Decimal(item.quantity))),
    new Prisma.Decimal(0)
  );
}

function deduplicatePassedItems(
  items: Array<{ id?: string; name: string; quantity: number; price: number; menuType?: string; menuItemId?: string; gstEnabled?: boolean }>
): Array<{ id?: string; name: string; quantity: number; price: number; menuType?: string; menuItemId?: string; gstEnabled?: boolean }> {
  const map = new Map<string, { id?: string; name: string; quantity: number; price: number; menuType?: string; menuItemId?: string; gstEnabled?: boolean }>();
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;
    const menuItemId = item.menuItemId;
    const key = menuItemId
      ? `id:${menuItemId}`
      : `${(item.name || '').trim().toLowerCase()}::${Number(item.price) || 0}`;
    const existing = map.get(key);
    if (existing) {
      existing.quantity += qty;
    } else {
      map.set(key, {
        id: item.id,
        name: (item.name || '').trim(),
        quantity: qty,
        price: Number(item.price) || 0,
        menuType: item.menuType || 'FOOD',
        menuItemId: menuItemId || undefined,
        gstEnabled: item.gstEnabled ?? true,
      });
    }
  }
  return Array.from(map.values());
}

export async function getNextKotNumber(restaurantId: string, tx?: any): Promise<number> {
  const counterDate = getKolkataDateString();

  // Try Redis INCR first — O(1), no row-level lock contention
  const redis = getRedisClient();
  if (redis) {
    try {
      const counterKey = `kot:counter:${restaurantId}:${counterDate}`;
      const kotNumber = await redis.incr(counterKey);
      // Set expiry once per day (first INCR sets it)
      if (kotNumber === 1) {
        await redis.expire(counterKey, 86_400);
      }
      return kotNumber;
    } catch {
      // fall through to DB-based counter
    }
  }

  // Fallback: DB-based counter (requires tx)
  const db = tx ?? prisma;
  const counter = await db.dailyCounter.upsert({
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

export async function createKotRecord(
  tx: any,
  restaurantId: string,
  tableId: string,
  orderId: string,
  orderItems: Array<{ id: string; menuItemId: string; name: string; price: any; quantity: number; notes: string | null }>,
  preReservedKotNumber?: number
): Promise<{ id: string; kotNumber: number; items: any[] }> {
  const kotNumber = preReservedKotNumber ?? await getNextKotNumber(restaurantId, tx);
  const kot = await tx.kot.create({
    data: {
      restaurantId,
      tableId,
      orderId,
      kotNumber,
      items: {
        create: orderItems.map((item) => ({
          orderItemId: item.id,
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          notes: item.notes,
          status: 'SENT',
        })),
      },
    },
    include: { items: true },
  });
  return {
    id: kot.id,
    kotNumber: kot.kotNumber,
    items: kot.items.map((ki: any) => ({
      id: ki.menuItemId || ki.id,
      n: ki.name,
      p: Number(ki.price),
      q: ki.quantity,
      s: ki.status === 'CANCELLED' ? 'Cancelled' : 'KOT Sent',
      orderItemId: ki.orderItemId,
      notes: ki.notes,
    })),
  };
}

export function buildKotHistoryFromTable(table: any): any[] {
  const kotsArr = (table?.kots as any[]) || [];
  if (kotsArr.length === 0) return [];
  return kotsArr.map((kot: any) => ({
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
  }));
}

export async function appendKotHistory(
  existing: unknown,
  items: Array<{ name: string; price: number; quantity: number; id?: string; orderItemId?: string } | any>,
  restaurantId: string,
  tx: any,
  preReservedKotNumber?: number
) {
  const history = Array.isArray(existing) ? existing : [];
  return [...history, await kotEntryFromItems(items, restaurantId, tx, preReservedKotNumber)];
}

export async function emitToRestaurant(restaurantId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
  if (eventName === "print_job") {
    const type = (payload as any).type;
    const orderId = (payload as any).orderId || (payload.data as any)?.orderId;
    const kotId = (payload as any).kotId || (payload.data as any)?.kotId;
    const tableNumber = (payload as any).tableNumber || (payload.data as any)?.tableNumber;
    const itemCount = (payload.data as any)?.items?.length || 0;
    const requestId = (payload as any).requestId || (payload.data as any)?.requestId || '';
    const billNumber = (payload as any).billNumber || (payload.data as any)?.billNumber || '';
    const printerName = (payload.data as any)?.printerName || '';
    const emitKey = `${restaurantId}-${type}-${orderId || kotId || tableNumber}-${itemCount}-${billNumber}-${requestId}-${printerName}`;
    // Use the eventId from the frontend (kotEventIds) if provided.
    // This ensures the Print Agent's seenEventIds dedup catches duplicates
    // when local print succeeded but the response was lost (timeout).
    const frontendEventId = (payload as any).eventId || (payload.data as any)?.eventId || null;
    const eventId = frontendEventId || randomUUID();
    const enriched = {
      restaurantId,
      ...payload,
      eventId,
      data: { ...(payload.data as Record<string, unknown>), eventId },
    };
    // If localPrinted is set, the frontend already printed via the local Print Agent.
    // Skip the socket emit to prevent duplicate prints, but still buffer for durability.
    if ((payload as any).localPrinted || (payload.data as any)?.localPrinted) {
      bufferPrintJob(restaurantId, { ...enriched, localPrinted: true }).catch(err => console.error('[orderService] bufferPrintJob failed for localPrinted job:', err.message));
      return;
    }
    // Route to printer-specific room when possible, fall back to general print room.
    // Printer-specific room: print:<restaurantId>:<printerName> or print:<restaurantId>:<type>
    // General room: print:<restaurantId> (for agents that haven't sent stations/printerNames)
    const targetRoom = printerName
      ? `print:${restaurantId}:${printerName}`
      : `print:${restaurantId}:${type}`;
    const generalRoom = `print:${restaurantId}`;
    // Emit to the specific room only — agents that join station/printer rooms
    // also join the general room, so emitting to both causes duplicate delivery.
    // The agent's seenEventIds dedup catches duplicates, but we avoid the double
    // emit entirely to prevent double print:ack and false UI flashes.
    getIo().to(targetRoom).emit(eventName, enriched);
    // Only emit to general room if targetRoom is different AND no sockets are in
    // the target room (legacy agents that only joined the general room).
    // Socket.IO doesn't expose room membership synchronously, so we emit to both
    // only when targetRoom === generalRoom (no specific routing available).
    if (targetRoom === generalRoom) {
      // Already emitted above
    } else {
      // Check if any socket is in the target room; if not, fall back to general
      const io = getIo();
      const socketsInTarget = await (io as any).adapter.sockets(new Set([targetRoom]));
      if (socketsInTarget.size === 0) {
        getIo().to(generalRoom).emit(eventName, enriched);
      }
    }
    // Then do Redis lock + buffer async (non-blocking)
    acquireLock(EMIT_LOCK_KEY(emitKey), EMIT_LOCK_TTL).then(acquired => {
      if (!acquired) {
        console.warn(`[emitToRestaurant] Buffer lock not acquired for ${emitKey} — job already emitted and buffered by concurrent call`);
        return;
      }
      bufferPrintJob(restaurantId, enriched).catch(err => console.error('[emitToRestaurant] Buffer failed:', err.message));
    });
  } else {
    getIo().to(restaurantId).emit(eventName, { restaurantId, ...payload });
  }
}

export function isBarLikeSection(sectionTag: string | null | undefined, venueType?: string | null): boolean {
  if (venueType) {
    return ['BAR', 'PDR', 'CONFERENCE', 'BANQUET', 'ROOM_SERVICE'].includes(venueType.toUpperCase());
  }
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

export function formatTableNumber(
  tableNumber: number | string,
  restaurantId: string,
  sectionName?: string,
  sectionTag?: string | null,
  venueType?: string | null,
  ctx?: TenantContext
): string {
  if (tableNumber === 999 || String(tableNumber) === '999') return 'Counter';

  if (venueType) {
    const vt = venueType.toUpperCase();
    if (vt === 'CONFERENCE') return `C${tableNumber}`;
    if (vt === 'PDR') return `PDR${tableNumber}`;
    if (vt === 'ROOM_SERVICE') return `R${tableNumber}`;
    if (vt === 'BAR') return `B${tableNumber}`;
    if (vt === 'TAKEAWAY' || vt === 'DELIVERY') return 'P1';
    if (vt === 'BANQUET') return `B${tableNumber}`;
    if (vt === 'DINE_IN' || vt === 'CAFE') return `T${tableNumber}`;
  }

  if (sectionTag) {
    const tag = sectionTag.toLowerCase();
    if (tag.includes('conference')) return `C${tableNumber}`;
    if (tag.includes('pdr')) return `PDR${tableNumber}`;
    if (tag.includes('room')) return `R${tableNumber}`;
    if (tag.includes('gobox')) return `GB${tableNumber}`;
    if (tag.includes('parcel')) return 'P1';
    if (tag.includes('family-restaurant') || tag.includes('family_restaurant')) return `F${tableNumber}`;
    if (tag.includes('bar')) return `B${tableNumber}`;
  }

  if (sectionName) {
    const sec = sectionName.toLowerCase();
    if (sec.includes('conference')) return `C${tableNumber}`;
    if (sec.includes('pdr')) return `PDR${tableNumber}`;
    if (sec.includes('room')) return `R${tableNumber}`;
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

export async function assertOrderBelongsToTenant(
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

export interface CreateOrderInput {
  restaurantId: string;
  tableId: string;
  items: Array<{
    menuItemId: string;
    name: string;
    price?: number;
    quantity: number;
    notes?: string | null;
    menuType?: string;
  }>;
  requestId?: string;
  captainName?: string;
  isExtraTable?: boolean;
  tableNumber?: string;
  platform?: string;
  deviceId?: string;
  user?: { userId: string; role: string; name?: string };
  preReservedKotNumber?: number;
  localPrinted?: boolean;
  kotEventIds?: string[];
}

export interface CreateOrderResult {
  order: any;
  kotHistory: any[];
  table: any;
}

/**
 * Core create-order logic, extracted from the POST /api/orders route.
 * Reused by the offline-sync bulk endpoint to avoid self-HTTP loopback.
 */
export async function createOrderService(input: CreateOrderInput): Promise<CreateOrderResult> {
  const { restaurantId: tenantId, tableId, items: rawItems, requestId, captainName: incomingCaptainName, isExtraTable, tableNumber: extraTableNumber, platform, preReservedKotNumber, localPrinted, kotEventIds } = input;

  if (!tenantId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  if (!tableId?.trim()) {
    throw Object.assign(new Error("tableId and restaurantId are required"), { statusCode: 400 });
  }

  const items = normalizeItems(rawItems);
  const ctx = await resolveTenantContext(tenantId);
  const printerConfig = await loadPrinterConfig(tenantId);

  // ── Idempotency: if requestId was already processed for this table, return the existing order ──
  // This prevents duplicate order creation when withRetry retries the API call after a timeout.
  if (requestId) {
    const existingOrder = await prisma.order.findFirst({
      where: {
        tableId,
        restaurantId: tenantId,
        lastRequestId: requestId,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      include: orderInclude,
    });
    if (existingOrder) {
      const existingTable = await prisma.table.findUnique({
        where: { id: tableId },
        include: tableInclude,
      });
      const kotsArr = (existingTable?.kots as any[]) || [];
      const legacyKotHistory = Array.isArray((existingTable as any)?.kotHistory) ? (existingTable as any).kotHistory : [];
      return {
        order: existingOrder,
        kotHistory: kotsArr.length > 0
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
          : legacyKotHistory,
        table: existingTable,
      };
    }
  }

  // ── ProcessedRequest DB-level idempotency (stronger than lastRequestId) ──
  if (requestId) {
    const existingPr = await prisma.processedRequest.findUnique({
      where: {
        requestId_actionType_restaurantId: {
          requestId,
          actionType: 'create-order',
          restaurantId: tenantId,
        },
      },
    });
    if (existingPr) {
      const cached = existingPr.result as any;
      if (cached?.order) {
        return cached as CreateOrderResult;
      }
    }
  }

  // ── Redis reservation reuse: if the client's reserve-kot-number call
  // succeeded but the response was lost (network timeout), the counter was
  // already incremented. Reuse that number instead of wasting it and
  // creating a gap in the KOT sequence.
  let resolvedPreReservedKotNumber = preReservedKotNumber ?? null;
  if (resolvedPreReservedKotNumber == null && requestId) {
    const redis = getRedisClient();
    if (redis) {
      const reserveKey = `kot:reserve:${tenantId}:${requestId}`;
      const cached = await redis.get(reserveKey);
      if (cached) {
        resolvedPreReservedKotNumber = Number(cached);
        console.log(`[createOrder] Reusing reserved KOT #${resolvedPreReservedKotNumber} from Redis for requestId=${requestId}`);
      }
    }
  }

  // ── Redis item-signature dedup: catches double-clicks within 5s even with different requestIds ──
  const itemSig = computeItemSignature(items);
  const dedupKey = `kot:dedup:create:${tableId}:${itemSig}`;
  if (await isDuplicatePayload(dedupKey, 5)) {
    throw Object.assign(new Error("Duplicate KOT detected — please wait a few seconds and retry if needed."), { statusCode: 409 });
  }

  // Guard: if the table already has an active order, reject — caller should use updateOrderItems instead
  if (!isExtraTable) {
    const existingActiveOrder = await prisma.order.findFirst({
      where: {
        tableId,
        restaurantId: tenantId,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      include: orderInclude,
    });
    if (existingActiveOrder) {
      throw Object.assign(new Error("Table already has an active order — use update items instead"), { statusCode: 409, existingOrderId: existingActiveOrder.id });
    }
  }

  // ── Pre-transaction reads: menu items, table, venue price map (outside the DB transaction to minimize lock duration) ──
  const ids = items.map(i => i.menuItemId);
  const foundMenuItems = await prisma.menuItem.findMany({
    where: { id: { in: ids }, restaurantId: tenantId },
    include: {
      category: { select: { name: true, printerTarget: true } },
      variants: { where: { isDefault: true }, select: { price: true }, take: 1 },
    },
  });
  const menuItemCategoryMap = new Map(
    foundMenuItems.map(m => [m.id, {
      name: m.category?.name || 'Unknown',
      printerTarget: m.category?.printerTarget || null,
      itemPrinterTarget: m.printerTarget || null,
      itemPrinterName: m.printerName || null,
    }])
  );
  const foundIds = new Set(foundMenuItems.map(m => m.id));
  const missing = ids.filter(id => !foundIds.has(id));
  if (missing.length) {
    const err = new Error("Invalid menuItemIds") as any;
    err.missing = missing;
    throw err;
  }

  const table = await prisma.table.findFirst({
    where: { id: tableId, restaurantId: tenantId },
    include: {
      section: {
        include: {
          venue: { select: { id: true, venueType: true, kotEnabled: true } },
        },
      },
    },
  });
  if (!table) {
    throw new Error("Table not found");
  }

  const venueId = table.section?.venue?.id ?? undefined;
  const priceMap = venueId ? await buildVenuePriceMap(venueId, tenantId) : new Map<string, number>();
  const resolvedItems = items.map((item) => {
    const found = foundMenuItems.find(m => m.id === item.menuItemId);
    const resolvedPrice = priceMap.get(item.menuItemId)
      ?? (Number(found?.basePrice ?? 0)
        || Number(found?.variants[0]?.price ?? 0));
    return { ...item, price: resolvedPrice };
  });

  const hasLiquorItems = foundMenuItems.some(m => { const mt = m.menuType as string; return mt === 'LIQUOR' || mt === 'BAR'; });

  const captainId = input.user?.role === 'CAPTAIN' && input.user?.userId
    ? input.user.userId
    : table.captainId || undefined;

  const createdByUserId = input.user?.userId || undefined;

  // ── Minimal transaction: only order.create + kot.create + table.update ──
  let savedOrder: any;
  try {
    savedOrder = await prisma.$transaction(
    async (tx) => {
      const orderData: any = {
        tableId,
        restaurantId: tenantId,
        status: OrderStatus.PREPARING,
        platform: platform || 'DINE_IN',
        totalAmount: totalAmount(resolvedItems),
        captainId,
        createdByUserId,
        barInventoryDeducted: !hasLiquorItems,
        ...(requestId ? { lastRequestId: requestId } : {}),
        items: {
          create: resolvedItems.map((item) => ({
            menuItemId: item.menuItemId,
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            notes: item.notes,
            menuType: item.menuType,
          })),
        },
      };

      const order = await tx.order.create({
        data: orderData,
        include: orderInclude,
      });

      let updatedTable: any = null;
      let newKotRecord: { id: string; kotNumber: number; items: any[] } | null = null;
      if (!isExtraTable) {
        newKotRecord = await createKotRecord(tx, tenantId, tableId, order.id, order.items, resolvedPreReservedKotNumber ?? undefined);
        updatedTable = await tx.table.update({
          where: { id: tableId },
          data: {
            status: TableStatus.OCCUPIED,
            workflowStatus: "Preparing",
            currentBill: { increment: order.totalAmount },
          },
          include: tableInclude,
        });
      } else {
        newKotRecord = await createKotRecord(tx, tenantId, tableId, order.id, order.items, resolvedPreReservedKotNumber ?? undefined);
        updatedTable = await tx.table.findUnique({ where: { id: tableId! }, include: tableInclude });
      }

      return { order, menuItemCategoryMap, updatedTable, newKotRecord };
    },
    { timeout: 10000, maxWait: 15000 }
  );

  const updatedTable = savedOrder.updatedTable;
  const newKotRecord = savedOrder.newKotRecord;

  // Emit order:created and table:updated immediately (non-blocking socket emits)
  const fullKotHistoryForCreate = buildKotHistoryFromTable(updatedTable);
  emitToRestaurant(tenantId, "order:created", { order: { ...savedOrder.order, kotHistory: fullKotHistoryForCreate }, isExtraTable: !!isExtraTable, requestId: requestId || null });
  if (updatedTable && !isExtraTable) emitToRestaurant(tenantId, "table:updated", { table: updatedTable, requestId: requestId || null });

  const allItems = (savedOrder.order as unknown as { items?: Array<{ name: string; price: number; quantity: number; menuType?: string; menuItemId?: string; notes?: string | null }> }).items ?? [];
  const mappedItems = allItems.map((i) => {
    const cat = savedOrder.menuItemCategoryMap.get(i.menuItemId || '') || { name: 'Unknown', printerTarget: null, itemPrinterTarget: null, itemPrinterName: null };
    const resolvedPrinterName = resolvePrinterName(tenantId, cat.itemPrinterName, cat.itemPrinterTarget, cat.printerTarget, printerConfig);
    return {
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      notes: i.notes ?? null,
      menuType: i.menuType,
      category: cat.name,
      printerTarget: cat.itemPrinterTarget || cat.printerTarget,
      printerName: resolvedPrinterName,
    };
  });

  const latestKot = newKotRecord;
  const formattedTableNumber = extraTableNumber
    ? (isBarOutlet(tenantId, ctx) ? `B${extraTableNumber}` : `T${extraTableNumber}`)
    : (updatedTable?.number
        ? formatTableNumber(updatedTable.number, tenantId, updatedTable.section?.name, (updatedTable as any)?.sectionTag, updatedTable?.section?.venue?.venueType, ctx)
        : "UNKNOWN");
  let resolvedCaptainName = incomingCaptainName?.trim() || '';
  let orderByRole = 'CAPTAIN';

  if (input.user?.userId) {
    if (input.user.role === 'CASHIER' || input.user.role === 'ADMIN' || input.user.role === 'OWNER') {
      resolvedCaptainName = input.user.name?.trim() || input.user.role.toLowerCase();
      orderByRole = input.user.role;
    } else if (!resolvedCaptainName) {
      resolvedCaptainName = input.user.name?.trim() || '';
    }
  }
  if (!resolvedCaptainName) {
    resolvedCaptainName = await getCaptainName(updatedTable?.captainId || undefined) || 'Captain';
  }

  const basePayload = {
    kotId: latestKot ? String(latestKot.kotNumber) : "??",
    tableNumber: formattedTableNumber,
    restaurantId: tenantId,
    sectionTag: (updatedTable as any)?.sectionTag || null,
    sectionName: updatedTable?.section?.name || "Main Hall",
    captainName: resolvedCaptainName,
    orderByRole,
    timestamp: new Date().toISOString(),
    requestId: requestId || null,
    localPrinted: localPrinted || false,
  };

  // Use cached tenant context for KOT header (avoids extra DB query)
  const kotRestaurantName = ctx.receiptHeader?.trim() || ctx.name?.trim() || undefined;

  const kotPrintItems = mappedItems.map(i => ({
    name: i.name,
    quantity: i.quantity,
    price: i.price,
    notes: i.notes ?? null,
    type: (i.menuType === 'LIQUOR' ? 'liquor' : 'food') as 'food' | 'liquor',
  }));
  const kotOrderData = {
    tableNumber: basePayload.tableNumber,
    orderId: savedOrder.order.id,
    items: kotPrintItems,
    restaurantName: kotRestaurantName,
    kotId: basePayload.kotId,
    sectionName: basePayload.sectionName,
    captainName: basePayload.captainName,
    orderByRole: basePayload.orderByRole,
    sectionTag: basePayload.sectionTag || undefined,
  };

  const venueKotEnabled = updatedTable?.section?.venue?.kotEnabled !== false;

  if (venueKotEnabled) {
    // Hybrid grouping: items WITH a resolved printer name → group by that name.
    // Items WITHOUT a resolved printer name → legacy fallback by menuType.
    const groupedByPrinter = new Map<string | undefined, typeof mappedItems>();
    for (const item of mappedItems) {
      const key = item.printerName;
      if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
      groupedByPrinter.get(key)!.push(item);
    }

    // Map kotEventIds from frontend to emit calls for dedup.
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
          emitPromises.push(emitToRestaurant(tenantId, "print_job", {
            type: "KOT",
            eventId: eventIds[eventIdIdx++] || undefined,
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
          emitPromises.push(emitToRestaurant(tenantId, "print_job", {
            type: "BAR_KOT",
            eventId: eventIds[eventIdIdx++] || undefined,
            data: {
              ...basePayload,
              items: counterItems,
              escposData: buildLiquorKOT({ ...kotOrderData, items: counterPrintItems }),
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
        emitPromises.push(emitToRestaurant(tenantId, "print_job", {
          type: jobType,
          eventId: eventIds[eventIdIdx++] || undefined,
          data: {
            ...basePayload,
            printerName,
            items: groupItems,
            escposData: builder({ ...kotOrderData, items: printItems }),
          }
        }));
      }
    }
    Promise.all(emitPromises).catch(err => console.error('[KOT] Print emission failed (createOrder):', err.message));
  }

  // ── Record ProcessedRequest for DB-level idempotency on future retries ──
  if (requestId) {
    await prisma.processedRequest.create({
      data: {
        requestId,
        actionType: 'create-order',
        orderId: savedOrder.order.id,
        restaurantId: tenantId,
        deviceId: null,
        result: { order: savedOrder.order, kotHistory: fullKotHistoryForCreate, table: updatedTable } as any,
      },
    }).catch(err => console.error('[orderService] createAuditLog failed (createOrder):', err.message));
  }

  // ── Clean up Redis reservation key after successful creation ──
  if (requestId && resolvedPreReservedKotNumber != null) {
    const redis = getRedisClient();
    if (redis) {
      redis.del(`kot:reserve:${tenantId}:${requestId}`).catch(err => console.error('[orderService] Redis del failed for KOT reservation key:', err.message));
    }
  }

  return { order: savedOrder.order, kotHistory: fullKotHistoryForCreate, table: updatedTable };
  } catch (err: any) {
    // P2002: Unique constraint violation — two captains created an order for the same table simultaneously.
    // The partial unique index "Order_active_per_table" catches this at the DB level.
    // Return the same 409 the existingActiveOrder guard would have returned.
    if (err?.code === 'P2002') {
      const existingActiveOrder = await prisma.order.findFirst({
        where: { tableId, restaurantId: tenantId, status: { in: ACTIVE_ORDER_STATUSES } },
        include: orderInclude,
      });
      if (existingActiveOrder) {
        throw Object.assign(new Error("Table already has an active order — use update items instead"), { statusCode: 409, existingOrderId: existingActiveOrder.id });
      }
    }
    throw err;
  }
}

export interface UpdateOrderItemsInput {
  orderId: string;
  restaurantId: string;
  items: Array<{
    menuItemId: string;
    name: string;
    price?: number;
    quantity: number;
    notes?: string | null;
    menuType?: string;
  }>;
  requestId?: string;
  captainName?: string;
  isExtraTable?: boolean;
  tableNumber?: string;
  lastUpdatedAt?: string;
  preReservedKotNumber?: number;
  localPrinted?: boolean;
  kotEventIds?: string[];
}

export interface UpdateOrderItemsResult {
  order: any;
  kotHistory: any[];
  table: any;
  mappedItems: any[];
}

/**
 * Core update-order-items logic, extracted from PATCH /api/orders/:id/items.
 * Reused by the offline-sync bulk endpoint to avoid self-HTTP loopback.
 */
export async function updateOrderItemsService(input: UpdateOrderItemsInput): Promise<UpdateOrderItemsResult> {
  const { orderId: id, restaurantId: callerRestaurantId, items: rawItems, requestId, captainName: incomingCaptainName, isExtraTable, tableNumber: extraTableNumber, lastUpdatedAt, preReservedKotNumber, localPrinted, kotEventIds } = input;

  if (!id) {
    throw Object.assign(new Error("Order ID is required"), { statusCode: 400 });
  }

  const items = normalizeItems(rawItems);

  const existing = await prisma.order.findUnique({
    where: { id },
    include: { items: true, table: { include: { kots: { select: { kotNumber: true } } } } },
  });
  if (!existing) {
    throw Object.assign(new Error("Order not found"), { statusCode: 404 });
  }

  // Tenant check: the caller must match the order's restaurant
  const ctx = await assertOrderBelongsToTenant(id, callerRestaurantId);

  // Fetch category names for print_job beverage/food split — scoped to the order's tenant
  const itemIds = items.map(i => i.menuItemId);
  const menuItemsWithCat = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, restaurantId: existing.restaurantId },
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

  const newItemsHaveLiquor = menuItemsWithCat.some(m => { const mt = m.menuType as string; return mt === 'LIQUOR' || mt === 'BAR'; });

  if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
    throw Object.assign(new Error("Only active orders can be updated"), { statusCode: 409 });
  }

  // Optimistic lock: prevent stale overwrites when two captains add items simultaneously
  if (lastUpdatedAt && existing.updatedAt) {
    const clientTime = new Date(lastUpdatedAt).getTime();
    const serverTime = new Date(existing.updatedAt).getTime();
    if (Math.abs(clientTime - serverTime) > 2000) {
      const err = new Error("Order was modified by another user. Please refresh and try again.") as any;
      err.statusCode = 409;
      err.serverUpdatedAt = existing.updatedAt;
      throw err;
    }
  }

  if (requestId && existing.lastRequestId === requestId) {
    const kotsArr = ((existing.table as any).kots as any[]) || [];
    const legacyKotHistory = Array.isArray((existing.table as any)?.kotHistory) ? (existing.table as any).kotHistory : [];
    return {
      order: existing,
      kotHistory: kotsArr.length > 0
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
        : legacyKotHistory,
      table: existing.table,
      mappedItems: [],
    };
  }

  // ── ProcessedRequest DB-level idempotency (stronger than lastRequestId) ──
  if (requestId) {
    const existingPr = await prisma.processedRequest.findUnique({
      where: {
        requestId_actionType_restaurantId: {
          requestId,
          actionType: 'update-items',
          restaurantId: existing.restaurantId,
        },
      },
    });
    if (existingPr) {
      const cached = existingPr.result as any;
      if (cached?.order) {
        return cached as UpdateOrderItemsResult;
      }
    }
  }

  // ── Redis reservation reuse: if the client's reserve-kot-number call
  // succeeded but the response was lost (network timeout), the counter was
  // already incremented. Reuse that number instead of wasting it.
  let resolvedPreReservedKotNumber = preReservedKotNumber ?? null;
  if (resolvedPreReservedKotNumber == null && requestId) {
    const redis = getRedisClient();
    if (redis) {
      const reserveKey = `kot:reserve:${existing.restaurantId}:${requestId}`;
      const cached = await redis.get(reserveKey);
      if (cached) {
        resolvedPreReservedKotNumber = Number(cached);
        console.log(`[updateOrderItems] Reusing reserved KOT #${resolvedPreReservedKotNumber} from Redis for requestId=${requestId}`);
      }
    }
  }

  // ── Redis item-signature dedup: catches double-clicks within 5s even with different requestIds ──
  const itemSig = computeItemSignature(items);
  const dedupKey = `kot:dedup:${id}:${itemSig}`;
  if (await isDuplicatePayload(dedupKey, 5)) {
    throw Object.assign(new Error("Duplicate KOT detected — please wait a few seconds and retry if needed."), { statusCode: 409 });
  }

  // ── Atomic writes only ─────────────────────────────────────────────────
  const updatedOrder = await prisma.$transaction(
    async (tx) => {
      const existingItems = await tx.orderItem.findMany({
        where: { orderId: id, removedFromBill: false },
      });

      const dedupMap = new Map<string, typeof existingItems[number]>();
      for (const ei of existingItems) {
        const key = `${ei.menuItemId}::${ei.notes ?? ''}`;
        dedupMap.set(key, ei);
      }

      const toCreate: Array<{
        orderId: string;
        menuItemId: string;
        name: string;
        price: number;
        quantity: number;
        notes: string | null;
        menuType: "FOOD" | "LIQUOR";
      }> = [];
      const createDedupMap = new Map<string, number>();

      for (const item of items) {
        const key = `${item.menuItemId}::${item.notes ?? ''}`;
        const existingMatch = dedupMap.get(key);

        if (existingMatch) {
          await tx.orderItem.update({
            where: { id: existingMatch.id },
            data: { quantity: { increment: item.quantity } },
          });
        } else {
          const existingCreateIdx = createDedupMap.get(key);
          if (existingCreateIdx !== undefined) {
            toCreate[existingCreateIdx].quantity += item.quantity;
          } else {
            createDedupMap.set(key, toCreate.length);
            toCreate.push({
              orderId: id,
              menuItemId: item.menuItemId,
              name: item.name,
              price: item.price,
              quantity: item.quantity,
              notes: item.notes ?? null,
              menuType: item.menuType,
            });
          }
        }
      }

      if (toCreate.length > 0) {
        await tx.orderItem.createMany({ data: toCreate });
      }

      const allItems = await tx.orderItem.findMany({
        where: { orderId: id },
        orderBy: { id: "asc" },
      });
      const order = await tx.order.update({
        where: { id },
        data: {
          status: existing.status === OrderStatus.BILLING_REQUESTED ? existing.status : OrderStatus.PREPARING,
          totalAmount: totalAmount(allItems),
          ...(newItemsHaveLiquor ? { barInventoryDeducted: false } : {}),
          ...(requestId ? { lastRequestId: requestId } : {}),
        },
        include: orderInclude,
      });

      const itemsWithIds = items.map((item) => {
        const matches = allItems.filter(
          (row) =>
            !row.removedFromBill &&
            row.menuItemId === item.menuItemId &&
            (row.notes ?? null) === (item.notes ?? null)
        );
        const dbItem = matches[matches.length - 1];
        return { ...item, orderItemId: dbItem?.id };
      });

      // Create Kot + KotItem rows for the new/updated items in this KOT
      const kotOrderItems = itemsWithIds
        .filter((item) => item.orderItemId)
        .map((item) => {
          const dbItem = allItems.find((row) => row.id === item.orderItemId)!;
          return {
            id: dbItem.id,
            menuItemId: dbItem.menuItemId,
            name: dbItem.name,
            price: dbItem.price,
            quantity: item.quantity,
            notes: dbItem.notes,
          };
        });

      const newKotRecord = await createKotRecord(tx, existing.restaurantId, existing.tableId, id, kotOrderItems, resolvedPreReservedKotNumber ?? undefined);
      let updatedTable: any = null;
      if (!isExtraTable) {
        updatedTable = await tx.table.update({
          where: { id: existing.tableId },
          data: {
            status: existing.status === OrderStatus.BILLING_REQUESTED ? TableStatus.BILLING_REQUESTED : TableStatus.OCCUPIED,
            workflowStatus: existing.status === OrderStatus.BILLING_REQUESTED ? "Waiting Bill" : "Preparing",
            currentBill: order.totalAmount,
          },
          include: tableInclude,
        });
      } else {
        updatedTable = await tx.table.findUnique({ where: { id: existing.tableId }, include: tableInclude });
      }

      return { order, itemsWithIds, updatedTable, newKotRecord };
    },
    { timeout: 10000, maxWait: 15000 }
  );

  const updatedTable = updatedOrder.updatedTable;
  const newKotRecord = updatedOrder.newKotRecord;

  // Emit order:updated and table:updated immediately (non-blocking)
  const fullKotHistory = buildKotHistoryFromTable(updatedTable);
  emitToRestaurant(existing.restaurantId, "order:updated", { order: { ...updatedOrder.order, kotHistory: fullKotHistory }, isExtraTable: !!isExtraTable, requestId: requestId || null });
  if (updatedTable && !isExtraTable) emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable, requestId: requestId || null });

  // Build mapped items for the caller to use for KOT printing
  const printerConfig = await loadPrinterConfig(existing.restaurantId);
  const mappedItems = items.map((i) => {
    const cat = menuItemCategoryMap.get(i.menuItemId) || { name: 'Unknown', printerTarget: null, itemPrinterTarget: null, itemPrinterName: null };
    const resolvedPrinterName = resolvePrinterName(existing.restaurantId, cat.itemPrinterName, cat.itemPrinterTarget, cat.printerTarget, printerConfig);
    return {
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      notes: i.notes ?? null,
      menuType: i.menuType,
      category: cat.name,
      printerTarget: cat.itemPrinterTarget || cat.printerTarget,
      printerName: resolvedPrinterName,
    };
  });

  // ── Record ProcessedRequest for DB-level idempotency on future retries ──
  if (requestId) {
    await prisma.processedRequest.create({
      data: {
        requestId,
        actionType: 'update-items',
        orderId: id,
        restaurantId: existing.restaurantId,
        deviceId: null,
        result: { order: { ...updatedOrder.order, kotHistory: fullKotHistory }, kotHistory: fullKotHistory, table: updatedTable, mappedItems } as any,
      },
    }).catch(err => console.error('[orderService] createAuditLog failed (updateItems):', err.message));
  }

  // ── Clean up Redis reservation key after successful update ──
  if (requestId && resolvedPreReservedKotNumber != null) {
    const redis = getRedisClient();
    if (redis) {
      redis.del(`kot:reserve:${existing.restaurantId}:${requestId}`).catch(err => console.error('[orderService] Redis del failed for KOT reservation key:', err.message));
    }
  }

  return { order: { ...updatedOrder.order, kotHistory: fullKotHistory }, kotHistory: fullKotHistory, table: updatedTable, mappedItems };
}

export interface CancelOrderItemInput {
  orderId: string;
  restaurantId: string;
  userId?: string;
  orderItemId: string;
  cancelledBy: string;
  cancelQuantity?: number;
  tableNumber?: string | number;
  requestId?: string;
  isExtraTable?: boolean;
}

export interface CancelOrderItemResult {
  order: any;
  table: any;
}

/**
 * Core cancel single item logic, extracted from PATCH /api/orders/:id/cancel-item.
 * Reused by the offline-sync bulk endpoint to avoid self-HTTP loopback.
 */
export async function cancelOrderItemService(input: CancelOrderItemInput): Promise<CancelOrderItemResult> {
  const { orderId: id, restaurantId: callerRestaurantId, orderItemId, cancelledBy, cancelQuantity, tableNumber, requestId, isExtraTable, userId } = input;

  if (!id || !orderItemId || !cancelledBy) {
    throw Object.assign(new Error("orderItemId and cancelledBy are required"), { statusCode: 400 });
  }

  const quantityToCancel = Math.max(1, Math.round(Number(cancelQuantity ?? 1)));
  if (!Number.isFinite(quantityToCancel) || quantityToCancel <= 0) {
    throw Object.assign(new Error("cancelQuantity must be a positive number"), { statusCode: 400 });
  }

  // Idempotency: if same requestId already processed, return 200 immediately
  if (requestId) {
    const existingResult = await prisma.processedRequest.findUnique({
      where: {
        requestId_actionType_restaurantId: {
          requestId,
          actionType: 'cancel-item',
          restaurantId: callerRestaurantId,
        },
      },
    });
    if (existingResult) {
      const existingOrder = await prisma.order.findUnique({
        where: { id },
        select: { id: true, status: true, restaurantId: true },
      });
      return { order: existingOrder, table: null };
    }
  }

  await assertOrderBelongsToTenant(id, callerRestaurantId);

  const existing = await prisma.order.findUnique({
    where: { id },
    include: {
      items: { include: { menuItem: { include: { category: { select: { printerTarget: true } } } } } },
      table: { include: { section: { include: { venue: { select: { venueType: true } } } } } },
    },
  });
  if (!existing) {
    throw Object.assign(new Error("Order not found"), { statusCode: 404 });
  }
  if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
    throw Object.assign(new Error("Only active orders can be modified"), { statusCode: 409 });
  }

  const cancelledItem = existing.items.find((i) => i.id === orderItemId);
  if (!cancelledItem) {
    throw Object.assign(new Error("Item not found in this order"), { statusCode: 404 });
  }
  if (cancelledItem.removedFromBill) {
    throw Object.assign(new Error("Item already cancelled"), { statusCode: 409 });
  }
  if (quantityToCancel > cancelledItem.quantity) {
    throw Object.assign(new Error("cancelQuantity exceeds remaining quantity"), { statusCode: 400 });
  }

  const ctx = await resolveTenantContext(existing.restaurantId);
  const printerConfig = await loadPrinterConfig(existing.restaurantId);
  const menuItem = (cancelledItem as any)?.menuItem;
  const categoryPrinterTarget = menuItem?.category?.printerTarget || null;
  const itemPrinterTarget = menuItem?.printerTarget || null;
  const itemPrinterName = menuItem?.printerName || null;
  const printerTarget = itemPrinterTarget || categoryPrinterTarget;
  const printerName = resolvePrinterName(existing.restaurantId, itemPrinterName, itemPrinterTarget, categoryPrinterTarget, printerConfig);

  const { updatedOrder, updatedTable } = await prisma.$transaction(
    async (tx) => {
      const isFullCancel = quantityToCancel >= cancelledItem.quantity;
      await tx.orderItem.update({
        where: { id: orderItemId },
        data: isFullCancel
          ? {
              quantity: 0,
              cancelledQuantity: { increment: quantityToCancel },
              originalQuantity: cancelledItem.originalQuantity ?? cancelledItem.quantity,
              removedFromBill: true,
              removedBy: cancelledBy,
              removedAt: new Date(),
            }
          : {
              quantity: { decrement: quantityToCancel },
              cancelledQuantity: { increment: quantityToCancel },
              originalQuantity: cancelledItem.originalQuantity ?? cancelledItem.quantity,
              removedFromBill: false,
              removedBy: cancelledBy,
              removedAt: new Date(),
            },
      });

      const allItems = await tx.orderItem.findMany({
        where: { orderId: existing.id },
      });
      const allCancelled = allItems.every((i) => i.removedFromBill);
      const newTotal = allItems
        .filter((i) => !i.removedFromBill && i.quantity > 0)
        .reduce(
          (sum, i) => sum.add(new Prisma.Decimal(i.price).mul(new Prisma.Decimal(i.quantity))),
          new Prisma.Decimal(0)
        );

      const order = await tx.order.update({
        where: { id: existing.id },
        data: {
          totalAmount: newTotal,
          status: existing.status === OrderStatus.BILLING_REQUESTED ? OrderStatus.CONFIRMED : existing.status,
          billingRequested: false,
          billingRequestedAt: null,
          lastRequestId: requestId || undefined,
        },
        include: orderIncludeWithCancelled,
      });

      let table;
      if (isExtraTable) {
        table = await tx.table.findUnique({ where: { id: existing.tableId }, include: tableInclude });
      } else {
        const tableUpdateData: Record<string, any> = { currentBill: allCancelled ? 0 : newTotal };
        if (isFullCancel) {
          // Mark the KotItem as CANCELLED in the relational table
          await tx.kotItem.updateMany({
            where: { orderItemId },
            data: { status: 'CANCELLED' },
          });
        }
        if (allCancelled) {
          tableUpdateData.status = TableStatus.AVAILABLE;
          tableUpdateData.workflowStatus = 'Free';
        } else if (existing.table.status === TableStatus.BILLING_REQUESTED) {
          tableUpdateData.status = TableStatus.OCCUPIED;
          tableUpdateData.workflowStatus = 'Preparing';
        }
        table = await tx.table.update({
          where: { id: existing.tableId },
          data: tableUpdateData,
          include: tableInclude,
        });
      }

      // Record idempotency inside the transaction
      if (requestId) {
        await tx.processedRequest.create({
          data: {
            requestId,
            actionType: 'cancel-item',
            orderId: id,
            restaurantId: existing.restaurantId,
          },
        });
      }

      return { updatedOrder: order, updatedTable: table };
    },
    { timeout: 15000, maxWait: 20000 }
  );

  await emitToRestaurant(existing.restaurantId, "order:updated", { order: updatedOrder, isExtraTable: !!isExtraTable });
  if (!isExtraTable && updatedTable) {
    await emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable });
  }

  const formattedTableNumber = tableNumber
    ? formatTableNumber(tableNumber, existing.restaurantId, undefined, undefined, undefined, ctx)
    : (existing.table.number ? formatTableNumber(existing.table.number, existing.restaurantId, undefined, (existing.table as any)?.sectionTag, existing.table?.section?.venue?.venueType, ctx) : existing.tableId);

  const cancelRestaurant = await prisma.outlet.findUnique({
    where: { id: existing.restaurantId },
    select: { name: true, receiptHeader: true },
  });

  const cancelItem = {
    name: cancelledItem.name,
    quantity: quantityToCancel,
    menuType: cancelledItem.menuType === 'LIQUOR' ? 'BAR' : 'FOOD',
  };

  const cancelEscposData = buildCancelKOT({
    tableNumber: formattedTableNumber,
    cancelledBy,
    timestamp: new Date().toISOString(),
    items: [cancelItem],
    sectionName: updatedTable?.section?.name || "Main Hall",
    sectionTag: (updatedTable as any)?.sectionTag || null,
    restaurant: cancelRestaurant as any,
  });

  await emitToRestaurant(existing.restaurantId, "print_job", {
    type: "CANCEL_KOT",
    data: {
      tableNumber: formattedTableNumber,
      cancelledBy,
      restaurantId: existing.restaurantId,
      sectionTag: (updatedTable as any)?.sectionTag || null,
      sectionName: updatedTable?.section?.name || "Main Hall",
      timestamp: new Date().toISOString(),
      requestId: requestId || null,
      item: cancelItem,
      items: [cancelItem],
      printerTarget,
      printerName,
      escposData: cancelEscposData,
    },
  });

  createAuditLog({
    userId,
    restaurantId: existing.restaurantId,
    action: 'ITEM_CANCEL',
    entityType: 'Order',
    entityId: existing.id,
    metadata: {
      orderItemId,
      quantityCancelled: quantityToCancel,
      cancelledBy,
    },
  });

  return { order: updatedOrder, table: updatedTable };
}

export interface CancelOrderItemsInput {
  orderId: string;
  restaurantId: string;
  userId?: string;
  items: Array<{ orderItemId: string; cancelQuantity?: number }>;
  cancelledBy: string;
  tableNumber?: string | number;
  requestId?: string;
  isExtraTable?: boolean;
}

export interface CancelOrderItemsResult {
  order: any;
  table: any;
}

/**
 * Core batch cancel-items logic, extracted from PATCH /api/orders/:id/cancel-items.
 * Reused by the offline-sync bulk endpoint to avoid self-HTTP loopback.
 */
export async function cancelOrderItemsService(input: CancelOrderItemsInput): Promise<CancelOrderItemsResult> {
  const { orderId: id, restaurantId: callerRestaurantId, items: itemsToCancel, cancelledBy, tableNumber, requestId, isExtraTable, userId } = input;

  if (!itemsToCancel || !Array.isArray(itemsToCancel) || itemsToCancel.length === 0) {
    throw Object.assign(new Error("items array is required and must be non-empty"), { statusCode: 400 });
  }
  if (!cancelledBy) {
    throw Object.assign(new Error("cancelledBy is required"), { statusCode: 400 });
  }

  if (requestId) {
    const existingPr = await prisma.processedRequest.findUnique({
      where: {
        requestId_actionType_restaurantId: {
          requestId,
          actionType: 'cancel-items',
          restaurantId: callerRestaurantId,
        },
      },
    });
    if (existingPr) {
      return { order: (existingPr.result as any), table: null };
    }
  }

  await assertOrderBelongsToTenant(id, callerRestaurantId);

  const existing = await prisma.order.findUnique({
    where: { id },
    include: {
      items: { include: { menuItem: { include: { category: { select: { printerTarget: true } } } } } },
      table: { include: { section: { include: { venue: { select: { venueType: true } } } } } },
    },
  });
  if (!existing) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
  if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
    throw Object.assign(new Error("Order is not active"), { statusCode: 409, serverUpdatedAt: existing.updatedAt });
  }

  const ctx = await resolveTenantContext(existing.restaurantId);
  const printerConfig = await loadPrinterConfig(existing.restaurantId);

  const cancelledItemsMeta: Array<{ name: string; quantity: number; menuType: string; printerTarget: string | null; printerName?: string }> = [];
  const fullyCancelledIds = new Set<string>();

  const printerTargetMap = new Map(
    existing.items.map(i => [i.id, (i as any)?.menuItem?.printerTarget || (i as any)?.menuItem?.category?.printerTarget || null])
  );
  const printerNameMap = new Map<string, string | undefined>(
    existing.items.map((i: any) => [i.id, resolvePrinterName(
      existing.restaurantId,
      i?.menuItem?.printerName ?? null,
      i?.menuItem?.printerTarget ?? null,
      i?.menuItem?.category?.printerTarget ?? null,
      printerConfig
    )])
  );

  const { updatedOrder, updatedTable } = await prisma.$transaction(async (tx) => {
    for (const { orderItemId, cancelQuantity } of itemsToCancel) {
      const cancelledItem = existing.items.find((i) => i.id === orderItemId);
      if (!cancelledItem || cancelledItem.removedFromBill) continue;

      const qty = Math.max(1, Math.min(Math.round(Number(cancelQuantity ?? 1)), cancelledItem.quantity));
      const isFullCancel = qty >= cancelledItem.quantity;
      if (isFullCancel) fullyCancelledIds.add(orderItemId);

      await tx.orderItem.update({
        where: { id: orderItemId },
        data: isFullCancel
          ? { quantity: 0, cancelledQuantity: { increment: qty }, originalQuantity: cancelledItem.originalQuantity ?? cancelledItem.quantity, removedFromBill: true, removedBy: cancelledBy, removedAt: new Date() }
          : { quantity: { decrement: qty }, cancelledQuantity: { increment: qty }, originalQuantity: cancelledItem.originalQuantity ?? cancelledItem.quantity, removedFromBill: false, removedBy: cancelledBy, removedAt: new Date() },
      });

      cancelledItemsMeta.push({
        name: cancelledItem.name,
        quantity: qty,
        menuType: cancelledItem.menuType === "LIQUOR" ? "BAR" : "FOOD",
        printerTarget: printerTargetMap.get(orderItemId) ?? null,
        printerName: printerNameMap.get(orderItemId) ?? undefined,
      });
    }

    const allItems = await tx.orderItem.findMany({ where: { orderId: existing.id } });
    const allCancelled = allItems.every((i) => i.removedFromBill);
    const newTotal = allItems
      .filter((i) => !i.removedFromBill && i.quantity > 0)
      .reduce((sum, i) => sum.add(new Prisma.Decimal(i.price).mul(new Prisma.Decimal(i.quantity))), new Prisma.Decimal(0));

    // If all items are cancelled and a PENDING transaction exists (bill was printed),
    // mark it as CANCELLED for audit trail.
    if (allCancelled) {
      const existingTxn = await tx.transaction.findUnique({ where: { orderId: existing.id } });
      if (existingTxn && existingTxn.status === 'PENDING') {
        const billItems = buildTxnItemsFromOrderItems(
          existing.items.map(i => ({ ...i, price: Number(i.price) }))
        );
        await upsertCancelledTransaction(tx, {
          restaurantId: existing.restaurantId,
          orderId: existing.id,
          tableNumber: existing.table?.number ?? null,
          tableLabel: null,
          captainId: (existing.table as any)?.captainId || null,
          sectionTag: (existing.table as any)?.sectionTag || null,
          sectionId: existing.table?.sectionId || null,
          platform: existing.platform || null,
          createdByUserId: userId || null,
          billNumber: existing.billNumber || existingTxn.billNumber || null,
          items: billItems,
          subtotal: Number(existingTxn.subtotal ?? 0),
          discountPercent: Number(existingTxn.discountPercent ?? 0),
          discountAmount: Number(existingTxn.discountAmount ?? 0),
          cgst: Number(existingTxn.cgst ?? 0),
          sgst: Number(existingTxn.sgst ?? 0),
          grandTotal: Number(existingTxn.grandTotal ?? existingTxn.amount ?? 0),
          roundOff: Number(existingTxn.roundOff ?? 0),
          tipAmount: Number(existingTxn.tipAmount ?? 0),
          itemCount: billItems.length,
        });
      }
    }

    const order = await tx.order.update({
      where: { id: existing.id },
      data: {
        totalAmount: newTotal,
        status: existing.status === OrderStatus.BILLING_REQUESTED ? OrderStatus.CONFIRMED : existing.status,
        billingRequested: false,
        billingRequestedAt: null,
        lastRequestId: requestId || undefined,
      },
      include: orderIncludeWithCancelled,
    });

    let table;
    if (isExtraTable) {
      table = await tx.table.findUnique({ where: { id: existing.tableId }, include: tableInclude });
    } else {
      const tableUpdateData: Record<string, any> = {
        currentBill: allCancelled ? 0 : newTotal,
      };
      // Mark fully cancelled items' KotItem rows as CANCELLED
      if (fullyCancelledIds.size > 0) {
        await tx.kotItem.updateMany({
          where: { orderItemId: { in: Array.from(fullyCancelledIds) } },
          data: { status: 'CANCELLED' },
        });
      }
      if (allCancelled) {
        tableUpdateData.status = TableStatus.AVAILABLE;
        tableUpdateData.workflowStatus = 'Free';
      } else if (existing.table.status === TableStatus.BILLING_REQUESTED) {
        tableUpdateData.status = TableStatus.OCCUPIED;
        tableUpdateData.workflowStatus = 'Preparing';
      }
      table = await tx.table.update({ where: { id: existing.tableId }, data: tableUpdateData, include: tableInclude });
    }

    return { updatedOrder: order, updatedTable: table };
  }, { timeout: 15000, maxWait: 20000 });

  await emitToRestaurant(existing.restaurantId, "order:updated", { order: updatedOrder, isExtraTable: !!isExtraTable });
  if (!isExtraTable && updatedTable) await emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable });

  if (cancelledItemsMeta.length > 0) {
    const formattedTN = tableNumber
      ? formatTableNumber(tableNumber, existing.restaurantId, undefined, undefined, undefined, ctx)
      : (existing.table.number ? formatTableNumber(existing.table.number, existing.restaurantId, undefined, (existing.table as any)?.sectionTag, existing.table?.section?.venue?.venueType, ctx) : existing.tableId);

    const batchCancelRestaurant = await prisma.outlet.findUnique({
      where: { id: existing.restaurantId },
      select: { name: true, receiptHeader: true },
    });

    // Group cancelled items by effective printer target so e.g. 2 liquor
    // items go to bar and 1 food item goes to kitchen, each as its own print
    // job. When printerTarget is not configured, fall back to menuType —
    // mirroring how regular KOT splits (BAR_PRINTER or LIQUOR → bar, else → kitchen).
    const printerGroups = new Map<string, { items: typeof cancelledItemsMeta; effectiveTarget: string }>();
    for (const item of cancelledItemsMeta) {
      const effectiveTarget = item.printerTarget
        || (item.menuType === 'BAR' ? 'BAR_PRINTER' : 'KOT_PRINTER');
      const key = `${effectiveTarget}::${item.printerName || '__default__'}`;
      if (!printerGroups.has(key)) printerGroups.set(key, { items: [], effectiveTarget });
      printerGroups.get(key)!.items.push(item);
    }

    for (const [, { items: groupItems, effectiveTarget }] of printerGroups) {
      const printerName = groupItems[0]?.printerName || undefined;
      const groupEscposData = buildCancelKOT({
        tableNumber: formattedTN,
        cancelledBy,
        timestamp: new Date().toISOString(),
        items: groupItems,
        sectionName: updatedTable?.section?.name || "Main Hall",
        sectionTag: (updatedTable as any)?.sectionTag || null,
        restaurant: batchCancelRestaurant as any,
      });

      await emitToRestaurant(existing.restaurantId, "print_job", {
        type: "CANCEL_KOT",
        data: {
          tableNumber: formattedTN,
          cancelledBy,
          restaurantId: existing.restaurantId,
          sectionTag: (updatedTable as any)?.sectionTag || null,
          sectionName: updatedTable?.section?.name || "Main Hall",
          timestamp: new Date().toISOString(),
          requestId: requestId || null,
          items: groupItems,
          item: groupItems[0],
          printerTarget: effectiveTarget,
          printerName,
          escposData: groupEscposData,
        },
      });
    }
  }

  if (requestId) {
    await prisma.processedRequest.create({
      data: {
        requestId,
        actionType: 'cancel-items',
        orderId: id,
        restaurantId: existing.restaurantId,
        deviceId: null,
        result: { order: updatedOrder } as any,
      },
    }).catch(err => console.error('[orderService] createAuditLog failed (settleOrder):', err.message));
  }

  createAuditLog({
    userId,
    restaurantId: existing.restaurantId,
    action: 'ITEM_CANCEL',
    entityType: 'Order',
    entityId: existing.id,
    metadata: {
      cancelledItems: cancelledItemsMeta.map((i) => ({ name: i.name, quantity: i.quantity })),
      cancelledBy,
    },
  });

  return { order: updatedOrder, table: updatedTable };
}

export interface SettleOrderInput {
  orderId: string;
  restaurantId: string;
  userId?: string;
  paymentMethod: string;
  discountPercent?: number;
  tableNumber?: string;
  isExtraTable?: boolean;
  grandTotal?: number;
  subtotal?: number;
  discountAmount?: number;
  cgst?: number;
  sgst?: number;
  requestId?: string;
  deviceId?: string;
  tipAmount?: number;
  cashTipAmount?: number;
  cardTipAmount?: number;
  cashAmount?: number;
  cardAmount?: number;
  items?: Array<{ id?: string; name: string; quantity: number; price: number; menuType?: string; menuItemId?: string }>;
}

export interface PrintBillInput {
  orderId: string;
  restaurantId: string;
  tableNumber?: string;
  discountPercent?: string;
  kotNumbers?: string;
  requestId?: string;
}

export interface PrintBillResult {
  order: any;
  table: any;
  billNumber: string;
  billData: any;
  formattedTableNumber: string;
  grandTotal: number;
  isExtraTable: boolean;
}

export async function printBillService(input: PrintBillInput): Promise<PrintBillResult> {
  const { orderId, restaurantId, tableNumber: tableNumberOverride, discountPercent: discountPercentOverride, kotNumbers: kotNumbersParam, requestId } = input;

  if (!restaurantId) {
    throw Object.assign(new Error("restaurantId is required"), { statusCode: 400 });
  }

  await assertOrderBelongsToTenant(orderId, restaurantId);
  const isExtraTable = !!tableNumberOverride;

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
    throw Object.assign(new Error("Order not found"), { statusCode: 404 });
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

  if (order.status === OrderStatus.PAID) {
    throw Object.assign(new Error("Order is already paid. Cannot print bill."), { statusCode: 409 });
  }

  const activeItems = order.items.filter((i: any) => !i.removedFromBill && i.quantity > 0);
  if (activeItems.length === 0) {
    throw Object.assign(new Error("Cannot print bill: all items have been cancelled"), { statusCode: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
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
        return existing.result as any;
      }
    }

    const lockedRows = await tx.$queryRaw<Array<{ id: string; status: string; billNumber: string | null }>>`
      SELECT "id", "status", "billNumber"
      FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
    `;
    const lockedRow = lockedRows[0];
    if (!lockedRow) throw new Error('Order not found inside transaction');
    if (lockedRow.status === 'PAID') {
      throw new Error('Order is already paid. Cannot print bill.');
    }

    let billNumber: string;
    const now = new Date();
    if (lockedRow.billNumber) {
      billNumber = lockedRow.billNumber;
    } else {
      const billCount = await getNextBillNumber(restaurantId, tx);
      billNumber = formatBillNumber(now, billCount);
    }

    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.BILLING_REQUESTED,
        billingRequested: true,
        billingRequestedAt: new Date(),
        billNumber,
      },
    });

    let updatedTable = await tx.table.findUnique({ where: { id: order.tableId }, include: tableInclude });
    if (!updatedTable) throw new Error("Table not found");

    if (!isExtraTable) {
      updatedTable = await tx.table.update({
        where: { id: order.tableId },
        data: {
          status: TableStatus.BILLING_REQUESTED,
          workflowStatus: "Waiting Bill",
        },
        include: tableInclude,
      });
    }

    // ── RE-FETCH ITEMS INSIDE TRANSACTION ──────────────────────────────
    // The outer-scope `activeItems` may be stale if a cancel/edit happened
    // between the outer fetch and the FOR UPDATE lock. Re-fetch now.
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

    const foodItems = freshActiveItems.filter((item: any) => item.menuItem.menuType === "FOOD");
    const liquorItems = freshActiveItems.filter((item: any) => { const mt = item.menuItem.menuType as string; return mt === "LIQUOR" || mt === "BAR"; });

    const foodSubtotal = foodItems.reduce((sum: number, item: any) => sum + (Number(item.price) * item.quantity), 0);
    const liquorSubtotal = liquorItems.reduce((sum: number, item: any) => sum + (Number(item.price) * item.quantity), 0);
    const subtotal = foodSubtotal + liquorSubtotal;

    // Food: GST-exempt only when gstEnabled=false. Liquor/bar: always GST-exempt.
    const gstExemptFood = foodItems
      .filter((item: any) => item.menuItem.gstEnabled === false)
      .reduce((sum: number, item: any) => sum + (Number(item.price) * item.quantity), 0);
    const gstExemptLiquor = liquorItems
      .reduce((sum: number, item: any) => sum + (Number(item.price) * item.quantity), 0);
    const gstExemptTotal = gstExemptFood + gstExemptLiquor;

    let discount = null;
    let discountAmount = 0;
    const discountSource = isExtraTable && discountPercentOverride != null
      ? Number(discountPercentOverride)
      : (updatedTable.discount ? Number(updatedTable.discount) : 0);
    if (discountSource > 0) {
      discountAmount = Math.round(subtotal * (discountSource / 100) * 100) / 100;
      discount = { percent: discountSource, amount: discountAmount };
    }

    const discountedSubtotal = Math.max(0, subtotal - discountAmount);
    const gstExemptAfterDiscount = Math.max(0, gstExemptTotal - (discountAmount > 0 && subtotal > 0 ? discountAmount * (gstExemptTotal / subtotal) : 0));
    const taxableAmount = Math.max(0, discountedSubtotal - gstExemptAfterDiscount);
    const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
    const { cgst, sgst, tax } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!taxSource.pricesIncludeGst);
    const printScPercent = Number(ctx.serviceChargePercent || 0);
    const printServiceChargeAmount = printScPercent > 0
      ? (discountedSubtotal + tax) * (printScPercent / 100)
      : 0;
    const rawGrandTotal = Math.max(0, discountedSubtotal + tax + printServiceChargeAmount);
    const grandTotal = Math.round(rawGrandTotal);
    const roundOff = Math.round((grandTotal - rawGrandTotal) * 100) / 100;

    // CGST/SGST are NOT rounded — only grand total is rounded
    const roundedSubtotal = Math.round(subtotal);
    const roundedDiscountAmount = Math.round(discountAmount);
    const roundedGrandTotal = Math.max(0, grandTotal);

    const kotHistory = (updatedTable.kots as Array<{ kotNumber: number }>) || [];
    const kotNumbers = isExtraTable && kotNumbersParam
      ? kotNumbersParam.split(',').filter(Boolean)
      : kotHistory.map(k => String(k.kotNumber)).filter(Boolean);

    const formattedTableNumber = tableNumberOverride
      ? (isBarOutlet(restaurantId, ctx) ? `B${tableNumberOverride}` : `T${tableNumberOverride}`)
      : formatTableNumber(
          updatedTable.number,
          restaurantId,
          updatedTable.section?.name,
          (updatedTable as any)?.sectionTag,
          updatedTable.section?.venue?.venueType,
          ctx
        );

    const nowDate = new Date();
    const timeStr = nowDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
    const dateStr = nowDate.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });

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
            const grouped = freshActiveItems.reduce((acc: any, item: any) => {
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
          subtotal: roundedSubtotal,
          discount: discount ? { percent: discount.percent, amount: roundedDiscountAmount } : undefined,
          serviceCharge: printServiceChargeAmount > 0 ? { percent: printScPercent, amount: printServiceChargeAmount } : undefined,
          tax: { cgst, sgst, total: tax },
          grandTotal: roundedGrandTotal,
          roundOff,
          section: updatedTable.section?.name || "Main Hall",
          itemCount: (() => {
            const grouped = freshActiveItems.reduce((acc: any, item: any) => {
              const key = `${item.name}::${Number(item.price)}`;
              if (!acc[key]) {
                acc[key] = true;
              }
              return acc;
            }, {} as Record<string, boolean>);
            return Object.keys(grouped).length;
          })(),
          qtyCount: freshActiveItems.reduce((sum: number, item: any) => sum + item.quantity, 0),
          ...(ctx.gstin ? { gstIn: ctx.gstin } : {}),
          restaurant: billRestaurant as any,
        }
      },
      formattedTableNumber,
      grandTotal: roundedGrandTotal,
    };

    // Persist a PENDING transaction so every printed bill is visible in Past
    // Transactions even if settlement fails or the table is terminated.
    await upsertPendingTransaction(tx, {
      restaurantId,
      orderId,
      tableNumber: updatedTable.number,
      tableLabel: isExtraTable && tableNumberOverride ? (isBarOutlet(restaurantId, ctx) ? `B${tableNumberOverride}` : `T${tableNumberOverride}`) : null,
      captainId: updatedTable.captainId || order.captainId || null,
      sectionTag: (updatedTable as any).sectionTag || null,
      sectionId: updatedTable.sectionId || null,
      platform: order.platform || null,
      createdByUserId: (order as any).createdByUserId || null,
      billNumber,
      items: printBillResult.billData.data.items,
      subtotal: roundedSubtotal,
      discountPercent: discount ? discount.percent : 0,
      discountAmount: roundedDiscountAmount,
      cgst,
      sgst,
      serviceChargeAmount: printServiceChargeAmount,
      grandTotal: roundedGrandTotal,
      roundOff,
      tipAmount: 0,
      itemCount: printBillResult.billData.data.itemCount,
    });

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

  if (!isExtraTable) {
    emitToRestaurant(restaurantId, "table:updated", { table: result.table }).catch(err => console.error('[orderService] emitToRestaurant failed (table:updated):', err.message));
  }

  return { ...result, isExtraTable };
}

export interface SettleOrderResult {
  order: any;
  table: any;
  transaction: any;
  isExtraTable: boolean;
  inventoryUpdates: any[];
  kitchenDeductionErrors?: string[];
  barDeductionErrors?: string[];
  missingRecipeItems?: string[];
  cached?: boolean;
}

/**
 * Core settlement logic, extracted so it can be reused by both the HTTP route
 * and the offline-sync bulk endpoint. This removes the self-HTTP loopback and
 * keeps tenant validation, idempotency, inventory deduction, and socket
 * emission in one place.
 */
export async function settleOrderService(input: SettleOrderInput): Promise<SettleOrderResult> {
  const {
    orderId,
    restaurantId,
    userId,
    paymentMethod,
    discountPercent: bodyDiscountPercent,
    tableNumber: bodyTableNumber,
    isExtraTable,
    grandTotal: bodyGrandTotal,
    subtotal: bodySubtotal,
    discountAmount: bodyDiscountAmount,
    cgst: bodyCgst,
    sgst: bodySgst,
    requestId,
    tipAmount: bodyTipAmount,
    cashTipAmount: bodyCashTipAmount,
    cardTipAmount: bodyCardTipAmount,
    cashAmount: bodyCashAmount,
    cardAmount: bodyCardAmount,
    items: passedItems,
  } = input;

  if (!restaurantId) {
    throw Object.assign(new Error("restaurantId is required"), { statusCode: 400 });
  }
  if (!paymentMethod) {
    throw Object.assign(new Error("paymentMethod is required (CASH, CARD, UPI, OTHER)"), { statusCode: 400 });
  }

  await assertOrderBelongsToTenant(orderId, restaurantId);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: true }
      },
      table: { include: { section: { include: { venue: { include: { taxProfile: true } } } } } }
    },
  });

  if (!order) {
    throw Object.assign(new Error("Order not found"), { statusCode: 404 });
  }

  const ctx = await resolveTenantContext(restaurantId);
  const venueTaxProfile = order.table?.section?.venue?.taxProfile;
  const taxSource = venueTaxProfile
    ? { gstRate: venueTaxProfile.gstRate, gstCategory: venueTaxProfile.gstCategory, gstRegistered: venueTaxProfile.gstRegistered, pricesIncludeGst: ctx.pricesIncludeGst }
    : ctx;

  if (order.status === OrderStatus.PAID) {
    throw Object.assign(new Error("Order is already paid"), { statusCode: 409 });
  }

  // Discount percent: use table discount first, fall back to frontend-provided value.
  // Fix: previously the frontend discount was ignored for non-extra tables, causing
  // the discount to be silently lost if the table PATCH failed (offline/network error).
  const discountPercent = (isExtraTable && bodyDiscountPercent != null)
    ? Math.max(0, Math.min(100, Number(bodyDiscountPercent)))
    : (order.table.discount
        ? Number(order.table.discount)
        : (bodyDiscountPercent != null ? Math.max(0, Math.min(100, Number(bodyDiscountPercent))) : 0));

  const result = await prisma.$transaction(async (tx) => {
    if (requestId) {
      const existing = await tx.processedRequest.findUnique({
        where: {
          requestId_actionType_restaurantId: {
            requestId,
            actionType: 'settle',
            restaurantId,
          },
        },
      });
      if (existing) {
        console.log(`[Settle] Idempotent replay for requestId=${requestId}, returning cached result`);
        return { ...existing.result as any, cached: true } as SettleOrderResult;
      }
    }

    const lockedRows = await tx.$queryRaw<Array<{
      id: string; status: string; billNumber: string | null; tableId: string;
      inventoryDeducted: boolean; barInventoryDeducted: boolean; platform: string | null;
    }>>`
      SELECT "id", "status", "billNumber", "tableId", "inventoryDeducted", "barInventoryDeducted", "platform"
      FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
    `;
    const lockedRow = lockedRows[0];
    if (!lockedRow) throw new Error('Order not found inside transaction');
    if (lockedRow.status === 'PAID') {
      throw Object.assign(new Error('Order is already paid'), { statusCode: 409 });
    }

    const lockedOrder = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: true },
        },
        table: { include: { section: { include: { venue: { select: { venueType: true } } } } } },
      },
    });
    if (!lockedOrder) throw new Error('Order not found inside transaction (post-lock)');

    const resolvedBillNumber = lockedOrder.billNumber ?? order.billNumber ?? null;
    const freshItems = lockedOrder.items.length > 0 ? lockedOrder.items : order.items;

    // Use freshItems directly — no menuItemId dedup (matches printBillService).
    // Fix: previously dedup by menuItemId kept only the first price when the same
    // item appeared multiple times, causing a subtotal mismatch between the printed
    // bill and the settled transaction.
    const txnItems = freshItems;

    // Recalculate all totals inside the transaction using locked (fresh) items.
    // Fix: previously these were calculated in the outer scope using potentially
    // stale item data fetched before the FOR UPDATE lock.
    const foodItems = freshItems.filter(item => item.menuItem.menuType === "FOOD");
    const liquorItems = freshItems.filter(item => { const mt = item.menuItem.menuType as string; return mt === "LIQUOR" || mt === "BAR"; });

    const foodSubtotal = foodItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
    const liquorSubtotal = liquorItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
    const calculatedSubtotal = foodSubtotal + liquorSubtotal;

    // Food: GST-exempt only when gstEnabled=false. Liquor/bar: always GST-exempt.
    const gstExemptFood = foodItems
      .filter(item => item.menuItem.gstEnabled === false)
      .reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
    const gstExemptLiquor = liquorItems
      .reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
    const gstExemptTotal = gstExemptFood + gstExemptLiquor;

    const calculatedDiscountAmount = discountPercent > 0
      ? Math.round(calculatedSubtotal * (discountPercent / 100) * 100) / 100
      : 0;

    const calculatedDiscountedSubtotal = Math.max(0, calculatedSubtotal - calculatedDiscountAmount);
    const calculatedGstExemptAfterDiscount = Math.max(0, gstExemptTotal - (calculatedDiscountAmount > 0 && calculatedSubtotal > 0 ? calculatedDiscountAmount * (gstExemptTotal / calculatedSubtotal) : 0));
    const calculatedTaxableAmount = Math.max(0, calculatedDiscountedSubtotal - calculatedGstExemptAfterDiscount);
    const calculatedEffectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
    const { cgst: calculatedCgst, sgst: calculatedSgst, tax: calculatedTax } = getGstBreakdownWithRate(calculatedTaxableAmount, calculatedEffectiveRate, !!taxSource.pricesIncludeGst);
    const calculatedScPercent = Number(ctx.serviceChargePercent || 0);
    const calculatedServiceChargeAmount = calculatedScPercent > 0
      ? (calculatedDiscountedSubtotal + calculatedTax) * (calculatedScPercent / 100)
      : 0;
    const rawGrandTotal = Math.max(0, calculatedDiscountedSubtotal + calculatedTax + calculatedServiceChargeAmount);
    const calculatedGrandTotal = Math.round(rawGrandTotal);
    const calculatedRoundOff = Math.round((calculatedGrandTotal - rawGrandTotal) * 100) / 100;

    if (typeof bodyGrandTotal === 'number' && Math.abs(Number(bodyGrandTotal) - calculatedGrandTotal) > 1) {
      console.warn(
        `[Settlement] Bill total mismatch for order ${orderId}: backend=${calculatedGrandTotal}, frontend=${Number(bodyGrandTotal)}. ` +
        `Using backend-calculated total to prevent silent settlement failure.`
      );
    }

    const subtotal = calculatedSubtotal;
    const discountAmount = calculatedDiscountAmount;
    const cgst = calculatedCgst;
    const sgst = calculatedSgst;
    const tax = calculatedTax;
    const grandTotal = calculatedGrandTotal;
    const roundOff = calculatedRoundOff;

    // Look up any existing transaction created at print-bill or terminate time.
    const existingTxn = await tx.transaction.findUnique({
      where: { orderId: lockedOrder.id },
      select: { id: true, txnNumber: true, status: true },
    });

    const txnNumber = existingTxn?.txnNumber ?? (await getNextTxnNumber(restaurantId, tx));
    const settlementTime = new Date();
    const settlementTxnDate = getKolkataDateString();

    if (!lockedOrder.platform) {
      console.warn(`[Settlement] Order ${lockedOrder.id} has no platform; defaulting transaction to DINE_IN`);
    }
    if (!lockedOrder.table?.sectionId) {
      console.warn(`[Settlement] Table ${lockedOrder.tableId} for order ${lockedOrder.id} has no sectionId`);
    }

    const transactionCaptainId = lockedOrder.captainId || (lockedOrder.table as any)?.captainId || 'N/A';

    const txnData: any = {
        restaurantId,
        orderId: lockedOrder.id,
        tableNumber: lockedOrder.table.number,
        tableLabel: isExtraTable && bodyTableNumber
          ? (isBarOutlet(restaurantId, ctx) ? `B${bodyTableNumber}` : `T${bodyTableNumber}`)
          : null,
        sectionTag: (lockedOrder.table as any)?.sectionTag || null,
        sectionId: lockedOrder.table.sectionId || null,
        platform: lockedOrder.platform || null,
        captainId: transactionCaptainId,
        createdByUserId: (lockedOrder as any).createdByUserId || input.userId || null,
        amount: new Prisma.Decimal(grandTotal),
        method: paymentMethod,
        status: 'COMPLETED',
        itemCount: (() => {
          if (passedItems && passedItems.length > 0) {
            const deduped = deduplicatePassedItems(passedItems);
            return deduped.length;
          }
          return txnItems.length;
        })(),
        items: (() => {
          if (passedItems && passedItems.length > 0) {
            return deduplicatePassedItems(passedItems);
          }
          return txnItems.map(item => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            price: Number(item.price),
            menuType: item.menuItem?.menuType || (item as any).menuType || 'FOOD',
            menuItemId: item.menuItemId || undefined,
            gstEnabled: item.menuItem?.gstEnabled ?? true,
          }));
        })(),
        txnNumber,
        txnDate: settlementTxnDate,
        billNumber: resolvedBillNumber,
        paidAt: settlementTime,
        confirmedAt: settlementTime,
        subtotal: new Prisma.Decimal(subtotal),
        discountPercent: new Prisma.Decimal(discountPercent),
        discountAmount: new Prisma.Decimal(discountAmount),
        cgst: new Prisma.Decimal(cgst),
        sgst: new Prisma.Decimal(sgst),
        serviceChargeAmount: new Prisma.Decimal(calculatedServiceChargeAmount || 0),
        grandTotal: new Prisma.Decimal(grandTotal),
        roundOff: new Prisma.Decimal(roundOff),
        tipAmount: new Prisma.Decimal(bodyTipAmount || 0),
        cashTipAmount: new Prisma.Decimal(bodyCashTipAmount ?? (paymentMethod === 'CASH' ? (bodyTipAmount || 0) : 0)),
        cardTipAmount: new Prisma.Decimal(bodyCardTipAmount ?? (paymentMethod === 'CARD' ? (bodyTipAmount || 0) : 0)),
        cashAmount: new Prisma.Decimal(bodyCashAmount || 0),
        cardAmount: new Prisma.Decimal(bodyCardAmount || 0),
      };

    let createdTxn: any;
    if (existingTxn) {
      createdTxn = await tx.transaction.update({
        where: { id: existingTxn.id },
        data: txnData,
      });
    } else {
      createdTxn = await tx.transaction.create({
        data: txnData,
      });
    }

    const inventoryUpdates: Array<{
      id: string;
      name: string;
      currentStock: number;
      reorderLevel: number;
      unitOfMeasure: string;
      isLowStock: boolean;
    }> = [];

    const barDeductionErrors: string[] = [];

    if (!lockedRow.barInventoryDeducted) {
      // Fetch ALL inventory items for this restaurant (not just by menuItemId)
      // because bar inventory items are linked to hidden menu items, not the
      // visible ordered ones. We match by name instead.
      const allInventoryItems = await tx.inventoryItem.findMany({
        where: { restaurantId },
        include: { menuItem: { include: { variants: true, category: { select: { name: true } } } } },
      });

      // Lock all inventory rows for this restaurant to prevent concurrent modifications
      if (allInventoryItems.length > 0) {
        const allInvIds = allInventoryItems.map(i => i.id);
        await tx.$queryRaw`
          SELECT "id" FROM "inventory_items"
          WHERE "id" IN (${Prisma.join(allInvIds)})
          ORDER BY "id" FOR UPDATE
        `;
      }

      // Build name → inventoryItem map (lowercase trimmed name)
      const inventoryByName = new Map<string, any>();
      for (const inv of allInventoryItems) {
        const name = (inv.menuItem?.name || '').toLowerCase().trim();
        if (name) {
          inventoryByName.set(name, inv);
        }
      }

      // Dynamically detect dual-variant inventory items (e.g., "X 750ml" + "X 180ml")
      const dualVariantMap = new Map<string, { inv750: any; inv180: any }>();
      for (const [invName, inv] of inventoryByName.entries()) {
        const match750 = invName.match(/^(.+)\s+750ml$/);
        const match180 = invName.match(/^(.+)\s+180ml$/);
        if (match750) {
          const base = match750[1];
          const inv180 = inventoryByName.get(`${base} 180ml`);
          if (inv180) dualVariantMap.set(base, { inv750: inv, inv180 });
        } else if (match180) {
          const base = match180[1];
          const inv750 = inventoryByName.get(`${base} 750ml`);
          if (inv750 && !dualVariantMap.has(base)) dualVariantMap.set(base, { inv750, inv180: inv });
        }
      }

      // Helper: find inventory item(s) by matching the ordered menu item name
      // to bar inventory items. Bar inventory items may have the same base name
      // (e.g., "Royal Stag") or include a size suffix for dual-variant items
      // (e.g., "Mansion House XO 750ml", "Mansion House XO 180ml").
      function findInventoryForOrderedItem(orderedName: string): { primary: any | null; secondary: any | null } {
        const normalized = orderedName.toLowerCase().trim();
        // Direct name match (e.g., "Royal Stag" → "Royal Stag")
        const direct = inventoryByName.get(normalized);
        if (direct) return { primary: direct, secondary: null };

        // Check if this is a dual-variant item (dynamically detected)
        for (const [baseName, { inv750, inv180 }] of dualVariantMap.entries()) {
          if (normalized === baseName || normalized.startsWith(baseName)) {
            return { primary: inv750 ?? null, secondary: inv180 ?? null };
          }
        }

        // Try partial match: strip size suffixes from ordered name and try again
        const stripped = normalized.replace(/\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i, '').trim();
        if (stripped !== normalized) {
          const partialMatch = inventoryByName.get(stripped);
          if (partialMatch) return { primary: partialMatch, secondary: null };
        }

        // Fuzzy fallback: prefix match only — inventory name starts with ordered name or vice versa.
        // This prevents "Royal Stag" from matching "Royal Stag Special" incorrectly.
        for (const [invName, inv] of inventoryByName.entries()) {
          if (invName === normalized) continue;
          if (invName.startsWith(normalized + ' ') || normalized.startsWith(invName + ' ')) {
            console.warn(`[Inventory] Fuzzy prefix match: "${orderedName}" → "${inv.menuItem?.name}"`);
            return { primary: inv, secondary: null };
          }
        }

        return { primary: null, secondary: null };
      }

      // Aggregate by menuItemId + price so we can match each order item's price
      // to its variant and determine the actual pour size (ml) per unit.
      const aggregatedLiquorItems = new Map<string, { menuItemId: string; menuItemName: string; quantity: number; price: number }>();
      for (const item of liquorItems) {
        const key = `${item.menuItemId}:${Number(item.price)}`;
        const existing = aggregatedLiquorItems.get(key);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          aggregatedLiquorItems.set(key, {
            menuItemId: item.menuItemId,
            menuItemName: item.menuItem.name,
            quantity: item.quantity,
            price: Number(item.price),
          });
        }
      }

      for (const [, { menuItemId, menuItemName, quantity: totalQuantity, price: itemPrice }] of aggregatedLiquorItems.entries()) {
        const { primary: primaryInv, secondary: secondaryInv } = findInventoryForOrderedItem(menuItemName);
        if (!primaryInv) {
          console.warn(`[Inventory] Liquor item "${menuItemName}" (menuItemId: ${menuItemId}) has no matching bar inventory. Skipping.`);
          barDeductionErrors.push(`Liquor item "${menuItemName}" has no matching bar inventory item.`);
          continue;
        }

        try {
        const isBeer = isBeerItem(primaryInv.menuItem);
        const isSpirit = !isBeer && primaryInv.menuItem.variants.some(
          (v: { name: string }) => v.name.trim().toLowerCase() === '30ml'
        );

        // Price-based heuristic: match the order item's price to a variant to determine ml per unit.
        // Falls back to BAR_UNIT_ML (30ml) if no match found.
        let mlPerUnit: number;
        let variantLabel: string;
        if (isBeer) {
          const variants = primaryInv.menuItem.variants as Array<{ name: string; price: any }>;
          const matchedVariant = variants.find(v => Number(v.price) === itemPrice);
          if (matchedVariant) {
            const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
            mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? 650 : parsedMl;
            variantLabel = `${mlPerUnit}ml`;
          } else {
            mlPerUnit = 650;
            variantLabel = '650ml bottle';
          }
        } else if (isSpirit) {
          const variants = primaryInv.menuItem.variants as Array<{ name: string; price: any }>;
          const matchedVariant = variants.find(v => Number(v.price) === itemPrice);
          if (matchedVariant) {
            const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
            mlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? BAR_UNIT_ML : parsedMl;
            variantLabel = `${mlPerUnit}ml`;
          } else {
            mlPerUnit = BAR_UNIT_ML;
            variantLabel = `${BAR_UNIT_ML}ml (unmatched price ₹${itemPrice})`;
            console.warn(`[Inventory] No variant price match for ${primaryInv.menuItem.name} at ₹${itemPrice}, defaulting to ${BAR_UNIT_ML}ml`);
          }
        } else {
          mlPerUnit = Number(primaryInv.bottleSize);
          variantLabel = 'bottle';
        }
        const totalMl = mlPerUnit * totalQuantity;

        // For dual-variant items (Mansion House XO, Black Dog Reserve):
        // Deduct from 750ml inventory first, then 180ml inventory.
        // For all other items: deduct from the single matched inventory item.
        const isDualVariant = secondaryInv !== null;

        if (isDualVariant) {
          // Calculate how much to deduct from each inventory item
          const stock750 = Number(primaryInv.currentStock);
          let deductFrom750: number;
          let deductFrom180: number;

          if (stock750 >= totalMl) {
            deductFrom750 = totalMl;
            deductFrom180 = 0;
          } else if (stock750 > 0) {
            deductFrom750 = stock750;
            deductFrom180 = totalMl - stock750;
          } else {
            deductFrom750 = 0;
            deductFrom180 = totalMl;
          }

          // Check sufficient stock across both items
          const totalAvailable = stock750 + Number(secondaryInv.currentStock);
          if (totalAvailable < totalMl) {
            throw Object.assign(
              new Error(`Insufficient stock for ${menuItemName}: available ${totalAvailable}ml (750ml: ${stock750}ml, 180ml: ${secondaryInv.currentStock}ml), required ${totalMl}ml`),
              { statusCode: 409 }
            );
          }

          // Deduct from 750ml inventory
          if (deductFrom750 > 0) {
            const updated750 = await tx.inventoryItem.update({
              where: { id: primaryInv.id },
              data: { currentStock: { decrement: deductFrom750 } },
            });

            await tx.inventoryTransaction.create({
              data: {
                restaurantId,
                itemId: primaryInv.id,
                orderId: lockedOrder.id,
                type: 'SALE',
                quantityChange: -deductFrom750,
                stockBefore: new Prisma.Decimal(Number(updated750.currentStock) + deductFrom750),
                stockAfter: updated750.currentStock,
                notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel} (750ml stock)`,
                transactionDate: new Date(),
                createdBy: userId || null,
              },
            });

            const snapshotDate = getKolkataDateString();
            await tx.dailyInventorySnapshot.upsert({
              where: {
                restaurantId_snapshotDate_itemId: {
                  restaurantId, snapshotDate, itemId: primaryInv.id,
                }
              },
              create: {
                restaurantId,
                itemId: primaryInv.id,
                snapshotDate,
                itemName: primaryInv.menuItem.name,
                purchased: 0,
                sold: deductFrom750,
                wastage: 0,
                adjusted: 0,
                openingStock: primaryInv.currentStock,
                closingStock: updated750.currentStock,
              },
              update: {
                sold: { increment: deductFrom750 },
                closingStock: updated750.currentStock,
              }
            });

            const isLowStock = Number(updated750.currentStock) <= Number(updated750.reorderLevel);
            inventoryUpdates.push({
              id: updated750.id,
              name: primaryInv.menuItem.name,
              currentStock: Number(updated750.currentStock),
              reorderLevel: Number(updated750.reorderLevel),
              unitOfMeasure: updated750.unitOfMeasure,
              isLowStock
            });
          }

          // Deduct from 180ml inventory
          if (deductFrom180 > 0) {
            const updated180 = await tx.inventoryItem.update({
              where: { id: secondaryInv.id },
              data: { currentStock: { decrement: deductFrom180 } },
            });

            await tx.inventoryTransaction.create({
              data: {
                restaurantId,
                itemId: secondaryInv.id,
                orderId: lockedOrder.id,
                type: 'SALE',
                quantityChange: -deductFrom180,
                stockBefore: new Prisma.Decimal(Number(updated180.currentStock) + deductFrom180),
                stockAfter: updated180.currentStock,
                notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel} (180ml stock)`,
                transactionDate: new Date(),
                createdBy: userId || null,
              },
            });

            const snapshotDate = getKolkataDateString();
            await tx.dailyInventorySnapshot.upsert({
              where: {
                restaurantId_snapshotDate_itemId: {
                  restaurantId, snapshotDate, itemId: secondaryInv.id,
                }
              },
              create: {
                restaurantId,
                itemId: secondaryInv.id,
                snapshotDate,
                itemName: secondaryInv.menuItem.name,
                purchased: 0,
                sold: deductFrom180,
                wastage: 0,
                adjusted: 0,
                openingStock: secondaryInv.currentStock,
                closingStock: updated180.currentStock,
              },
              update: {
                sold: { increment: deductFrom180 },
                closingStock: updated180.currentStock,
              }
            });

            const isLowStock = Number(updated180.currentStock) <= Number(updated180.reorderLevel);
            inventoryUpdates.push({
              id: updated180.id,
              name: secondaryInv.menuItem.name,
              currentStock: Number(updated180.currentStock),
              reorderLevel: Number(updated180.reorderLevel),
              unitOfMeasure: updated180.unitOfMeasure,
              isLowStock
            });
          }
        } else {
          // Single inventory item deduction (standard case)
          if (Number(primaryInv.currentStock) < totalMl) {
            throw Object.assign(
              new Error(`Insufficient stock for ${primaryInv.menuItem?.name ?? 'Unknown Item'}: available ${primaryInv.currentStock}ml, required ${totalMl}ml`),
              { statusCode: 409 }
            );
          }

          const updatedItem = await tx.inventoryItem.update({
            where: { id: primaryInv.id },
            data: { currentStock: { decrement: totalMl } },
          });

          await tx.inventoryTransaction.create({
            data: {
              restaurantId,
              itemId: primaryInv.id,
              orderId: lockedOrder.id,
              type: 'SALE',
              quantityChange: -totalMl,
              stockBefore: new Prisma.Decimal(Number(updatedItem.currentStock) + totalMl),
              stockAfter: updatedItem.currentStock,
              notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${variantLabel}`,
              transactionDate: new Date(),
              createdBy: userId || null,
            },
          });

          const snapshotDate = getKolkataDateString();
          await tx.dailyInventorySnapshot.upsert({
            where: {
              restaurantId_snapshotDate_itemId: {
                restaurantId,
                snapshotDate,
                itemId: primaryInv.id,
              }
            },
            create: {
              restaurantId,
              itemId: primaryInv.id,
              snapshotDate,
              itemName: primaryInv.menuItem.name,
              purchased: 0,
              sold: totalMl,
              wastage: 0,
              adjusted: 0,
              openingStock: primaryInv.currentStock,
              closingStock: updatedItem.currentStock,
            },
            update: {
              sold: { increment: totalMl },
              closingStock: updatedItem.currentStock,
            }
          });

          const isLowStock = Number(updatedItem.currentStock) <= Number(updatedItem.reorderLevel);
          inventoryUpdates.push({
            id: updatedItem.id,
            name: primaryInv.menuItem.name,
            currentStock: Number(updatedItem.currentStock),
            reorderLevel: Number(updatedItem.reorderLevel),
            unitOfMeasure: updatedItem.unitOfMeasure,
            isLowStock
          });
        }
        } catch (err: any) {
          const errMsg = `Bar item "${menuItemName}": ${err.message}`;
          console.error(`[Inventory] Bar deduction failed: ${errMsg}`);
          barDeductionErrors.push(errMsg);
        }
      }
    }

    const kitchenDeductionErrors: string[] = [];
    const missingRecipeItems: string[] = [];

    if (!lockedOrder.inventoryDeducted) {
      const foodItems = lockedOrder.items.filter((item) => item.menuItem.menuType === "FOOD");
      if (foodItems.length > 0) {
        const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
        const foodMenuItemIds = foodItems.map((i) => i.menuItemId);
        const recipes = await tx.menuItemRecipe.findMany({
          where: { menuItemId: { in: foodMenuItemIds }, restaurantId },
          include: { ingredient: true },
        });

        const recipeMenuItemIds = new Set(recipes.map(r => r.menuItemId));
        for (const item of foodItems) {
          if (!recipeMenuItemIds.has(item.menuItemId)) {
            if (!missingRecipeItems.includes(item.menuItem.name)) {
              missingRecipeItems.push(item.menuItem.name);
            }
          }
        }

        const ingredientDeductions = new Map<string, { totalQty: number; menuItemIds: string[] }>();
        for (const item of foodItems) {
          for (const recipe of recipes.filter((r) => r.menuItemId === item.menuItemId)) {
            const existing = ingredientDeductions.get(recipe.ingredientId);
            if (existing) {
              existing.totalQty += Number(recipe.quantity) * item.quantity;
              if (!existing.menuItemIds.includes(item.menuItemId)) {
                existing.menuItemIds.push(item.menuItemId);
              }
            } else {
              ingredientDeductions.set(recipe.ingredientId, {
                totalQty: Number(recipe.quantity) * item.quantity,
                menuItemIds: [item.menuItemId],
              });
            }
          }
        }

        // Fetch existing deduction logs for this order so we can skip already-successful ingredients.
        const existingLogs = await tx.orderDeductionLog.findMany({
          where: { orderId: lockedOrder.id },
        });
        const successLogIds = new Set(existingLogs.filter(l => l.status === 'SUCCESS').map(l => l.ingredientId));

        const today = getKolkataDateString();
        for (const [ingredientId, { totalQty, menuItemIds }] of ingredientDeductions.entries()) {
          if (successLogIds.has(ingredientId)) {
            console.log(`[Kitchen] Skipping ingredient ${ingredientId} — already deducted successfully in a prior attempt.`);
            continue;
          }

          try {
            const updatedIngredient = await tx.kitchenInventoryItem.update({
              where: { id: ingredientId },
              data: { currentStock: { decrement: new Prisma.Decimal(totalQty) } },
            });

            const existingEntry = await tx.inventoryDailyEntry.findUnique({
              where: {
                restaurantId_itemId_entryDate: { restaurantId: kitchenRestaurantId, itemId: ingredientId, entryDate: today },
              },
            });

            if (existingEntry) {
              await tx.inventoryDailyEntry.update({
                where: { id: existingEntry.id },
                data: {
                  consumedStock: { increment: new Prisma.Decimal(totalQty) },
                  closingStock: updatedIngredient.currentStock,
                },
              });
            } else {
              const priorEntry = await tx.inventoryDailyEntry.findFirst({
                where: { restaurantId: kitchenRestaurantId, itemId: ingredientId, entryDate: { lt: today } },
                orderBy: { entryDate: 'desc' },
              });
              const openingForToday = priorEntry
                ? priorEntry.closingStock
                : updatedIngredient.currentStock.add(new Prisma.Decimal(totalQty));

              await tx.inventoryDailyEntry.create({
                data: {
                  restaurantId: kitchenRestaurantId,
                  itemId: ingredientId,
                  entryDate: today,
                  openingStock: openingForToday,
                  consumedStock: new Prisma.Decimal(totalQty),
                  closingStock: updatedIngredient.currentStock,
                },
              });
            }

            // Record successful deduction in the log for idempotent retries.
            await tx.orderDeductionLog.upsert({
              where: { orderId_ingredientId: { orderId: lockedOrder.id, ingredientId } },
              create: {
                orderId: lockedOrder.id,
                restaurantId,
                ingredientId,
                menuItemId: menuItemIds[0] || null,
                quantity: new Prisma.Decimal(totalQty),
                status: 'SUCCESS',
              },
              update: {
                quantity: new Prisma.Decimal(totalQty),
                status: 'SUCCESS',
                error: null,
              },
            });

            if (Number(updatedIngredient.currentStock) <= Number(updatedIngredient.reorderLevel)) {
              console.warn(`[Kitchen] Low stock: ${updatedIngredient.name} (${updatedIngredient.currentStock} ${updatedIngredient.unit}, reorder at ${updatedIngredient.reorderLevel})`);
              try {
                const io = getIo();
                if (io) {
                  io.to(`kitchen:${kitchenRestaurantId}`).emit("kitchen:low-stock", {
                    ingredientId: updatedIngredient.id,
                    name: updatedIngredient.name,
                    currentStock: Number(updatedIngredient.currentStock),
                    reorderLevel: Number(updatedIngredient.reorderLevel),
                    unit: updatedIngredient.unit,
                  });
                }
              } catch (socketErr) {
                // non-critical
              }
            }
          } catch (err: any) {
            const errMsg = `Ingredient ${ingredientId}: ${err.message}`;
            console.error(`[Kitchen] Deduction failed for ${errMsg}`);
            kitchenDeductionErrors.push(errMsg);

            // Record failed deduction in the log so we know what to retry.
            await tx.orderDeductionLog.upsert({
              where: { orderId_ingredientId: { orderId: lockedOrder.id, ingredientId } },
              create: {
                orderId: lockedOrder.id,
                restaurantId,
                ingredientId,
                menuItemId: menuItemIds[0] || null,
                quantity: new Prisma.Decimal(totalQty),
                status: 'FAILED',
                error: err.message,
              },
              update: {
                status: 'FAILED',
                error: err.message,
              },
            });

            try {
              const io = getIo();
              if (io) {
                io.to(`kitchen:${kitchenRestaurantId}`).emit("kitchen:deduction-failed", {
                  ingredientId,
                  restaurantId: kitchenRestaurantId,
                  orderId: lockedOrder.id,
                  quantity: totalQty,
                  error: err.message,
                });
              }
            } catch (socketErr) { /* non-critical */ }
          }
        }
      }
    }

    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.PAID,
        billingRequested: false,
        paidAt: new Date(),
        inventoryDeducted: kitchenDeductionErrors.length === 0,
        barInventoryDeducted: barDeductionErrors.length === 0,
      },
      include: {
        items: { include: { menuItem: true } },
        table: { include: { section: true } }
      }
    });

    let settleTable: any = null;
    if (!isExtraTable) {
      // Delete all Kot + KotItem rows for this table (cascade deletes KotItem)
      await tx.kot.deleteMany({ where: { tableId: order.tableId } });
      settleTable = await tx.table.update({
        where: { id: order.tableId },
        data: {
          status: TableStatus.AVAILABLE,
          workflowStatus: "Free",
          captainId: null,
          guests: 0,
          sessionStartedAt: null,
          currentBill: 0,
          kotHistory: [],
          discount: null,
        },
      });
    } else {
      settleTable = await tx.table.findUnique({ where: { id: order.tableId } });
    }

    const settleResult: SettleOrderResult = {
      order: updatedOrder,
      table: settleTable,
      inventoryUpdates,
      isExtraTable: !!isExtraTable,
      transaction: createdTxn,
      kitchenDeductionErrors,
      barDeductionErrors,
      missingRecipeItems,
    };

    if (requestId) {
      await tx.processedRequest.create({
        data: {
          requestId,
          actionType: 'settle',
          orderId: lockedOrder.id,
          restaurantId,
          deviceId: input.deviceId || null,
          result: settleResult as any,
        },
      });
    }

    return settleResult;
  }, { timeout: 15000, maxWait: 20000 });

  cacheClear('transactions:');

  const io = getIo();
  io.to(restaurantId).emit("order:paid", {
    orderId: result.order.id,
    tableId: result.table?.id,
    paymentMethod,
    isExtraTable: result.isExtraTable,
    transaction: result.transaction,
  });

  // NOTE: Settlement no longer auto-prints a bill. The final bill is printed
  // only when the cashier clicks "Final Bill" (handleFinalBill → /api/orders/:id/print-bill).
  // Reprint is handled by handleReprintBill using the same endpoint (bill number is reused).

  if (!result.isExtraTable) {
    const tableForEmit = await prisma.table.findUnique({
      where: { id: result.table!.id },
      include: tableInclude,
    });
    io.to(restaurantId).emit("table:updated", { table: tableForEmit ?? result.table });
  }

  for (const update of result.inventoryUpdates) {
    io.to(restaurantId).emit("inventory:updated", {
      restaurantId,
      item: {
        id: update.id,
        name: update.name,
        currentStock: update.currentStock,
        reorderLevel: update.reorderLevel,
        unitOfMeasure: update.unitOfMeasure,
      }
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

  createAuditLog({
    userId,
    restaurantId,
    action: 'ORDER_SETTLE',
    entityType: 'Order',
    entityId: orderId,
    metadata: {
      paymentMethod,
      grandTotal: Number(result.transaction?.grandTotal ?? 0),
      tipAmount: Number(result.transaction?.tipAmount ?? 0),
      discountPercent: Number(result.transaction?.discountPercent ?? discountPercent),
      discountAmount: Number(result.transaction?.discountAmount ?? 0),
    },
  });

  return result;
}

/**
 * Auto-settle all BILLING_REQUESTED orders for a restaurant.
 * This is a recovery function that finds orders stuck in BILLING_REQUESTED
 * and settles them with the specified payment method (default CASH).
 * Uses backend-calculated totals — no frontend input needed.
 * Returns a summary of settled and failed orders.
 */
export async function autoSettleBillingRequestedOrders(
  restaurantId: string,
  paymentMethod: string = 'CASH',
  olderThanMinutes: number = 0,
): Promise<{ settled: Array<{ orderId: string; billNumber: string | null; grandTotal: number }>; failed: Array<{ orderId: string; error: string }> }> {
  const where: any = {
    restaurantId,
    status: OrderStatus.BILLING_REQUESTED,
  };
  if (olderThanMinutes > 0) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    where.billingRequestedAt = { lt: cutoff };
  }
  const stuckOrders = await prisma.order.findMany({
    where,
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        include: { menuItem: true },
      },
      table: { include: { section: { include: { venue: { include: { taxProfile: true } } } } } },
    },
  });

  const settled: Array<{ orderId: string; billNumber: string | null; grandTotal: number }> = [];
  const failed: Array<{ orderId: string; error: string }> = [];

  for (const order of stuckOrders) {
    try {
      const result = await settleOrderService({
        orderId: order.id,
        restaurantId,
        paymentMethod,
        requestId: `auto-settle-${order.id}-${Date.now()}`,
      });
      settled.push({
        orderId: order.id,
        billNumber: result.order?.billNumber ?? null,
        grandTotal: result.transaction?.grandTotal ? Number(result.transaction.grandTotal) : 0,
      });
      console.log(`[AutoSettle] Settled order ${order.id}, bill ${result.order?.billNumber}, total ${result.transaction?.grandTotal}`);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('already paid')) {
        console.log(`[AutoSettle] Order ${order.id} already paid, skipping`);
        continue;
      }
      console.error(`[AutoSettle] Failed to settle order ${order.id}:`, errMsg);
      failed.push({ orderId: order.id, error: errMsg });
    }
  }

  console.log(`[AutoSettle] Restaurant ${restaurantId}: settled=${settled.length}, failed=${failed.length}`);
  return { settled, failed };
}

// Re-export build helpers so route handlers can keep emitting the same payloads.
export { buildFoodKOT, buildLiquorKOT } from "../utils/escpos";
