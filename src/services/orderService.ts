import { OrderStatus, Prisma, TableStatus, PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import { getKolkataDateString } from "../utils/date";
import { isBeerItem } from "../utils/itemHelpers";
import prisma from "../lib/prisma";
import { resolveItemPrice } from "../lib/priceResolver";
import { resolveTenantContext, isBarOutlet, isVenueOutlet, type TenantContext } from "../lib/tenantContext";
import { getGstBreakdownWithRate, getEffectiveGstRate } from "../utils/gst";
import { createAuditLog } from "../lib/auditLog";
import { cacheClear } from "../lib/cache";
import { acquireLock } from "../lib/redisLock";
import { getCaptainName } from "../utils/captainMap";
import {
  buildFoodKOT,
  buildLiquorKOT,
} from "../utils/escpos";

const BAR_UNIT_ML = 30;
const BAR_FULL_BOTTLE_MULTIPLIER = 25;

const warnedPrinterConfigRestaurantIds = new Set<string>();
const warnedNoPrintersRestaurantIds = new Set<string>();
const warnedUnrecognizedTargetRestaurantIds = new Set<string>();

const EMIT_LOCK_KEY = (key: string) => `emit_lock:order:${key}`;
const EMIT_LOCK_TTL = 10; // seconds

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

export async function loadPrinterConfig(restaurantId: string) {
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

export function resolvePrinterName(
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

export const orderInclude = {
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

export const tableInclude = {
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

export async function getNextTxnNumber(
  restaurantId: string,
  tx: any
): Promise<number> {
  const counterDate = getKolkataDateString();

  return await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { txnCount: { increment: 1 } },
    create: { restaurantId, counterDate, txnCount: 1 },
    select: { txnCount: true }
  }).then((c: { txnCount: number }) => c.txnCount);
}

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

async function getNextKotNumber(restaurantId: string, tx: any): Promise<number> {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const counterDate = nowIST.toISOString().slice(0, 10);

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
    id: String(kotNumber).padStart(3, '0'),
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

export async function appendKotHistory(
  existing: unknown,
  items: Array<{ name: string; price: number; quantity: number; id?: string; orderItemId?: string } | any>,
  restaurantId: string,
  tx: any
) {
  const history = Array.isArray(existing) ? existing : [];
  return [...history, await kotEntryFromItems(items, restaurantId, tx)];
}

export async function emitToRestaurant(restaurantId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
  if (eventName === "print_job") {
    const printRoom = `print:${restaurantId}`;
    const type = (payload as any).type;
    const orderId = (payload as any).orderId || (payload.data as any)?.orderId;
    const kotId = (payload as any).kotId || (payload.data as any)?.kotId;
    const tableNumber = (payload as any).tableNumber || (payload.data as any)?.tableNumber;
    const itemCount = (payload.data as any)?.items?.length || 0;
    const requestId = (payload as any).requestId || (payload.data as any)?.requestId || '';
    const billNumber = (payload as any).billNumber || (payload.data as any)?.billNumber || '';
    const emitKey = `${restaurantId}-${type}-${orderId || kotId || tableNumber}-${itemCount}-${billNumber}-${requestId}`;
    const acquired = await acquireLock(EMIT_LOCK_KEY(emitKey), EMIT_LOCK_TTL);
    if (!acquired) {
      return;
    }

    const eventId = randomUUID();
    const enriched = {
      restaurantId,
      ...payload,
      eventId,
      data: { ...(payload.data as Record<string, unknown>), eventId },
    };
    bufferPrintJob(restaurantId, enriched).catch(() => {});
    getIo().to(printRoom).emit(eventName, enriched);
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
  const { restaurantId: tenantId, tableId, items: rawItems, requestId, captainName: incomingCaptainName, isExtraTable, tableNumber: extraTableNumber, platform } = input;

  if (!tenantId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  if (!tableId?.trim()) {
    throw Object.assign(new Error("tableId and restaurantId are required"), { statusCode: 400 });
  }

  const items = normalizeItems(rawItems);
  const ctx = await resolveTenantContext(tenantId);
  const printerConfig = await loadPrinterConfig(tenantId);

  const savedOrder = await prisma.$transaction(
    async (tx) => {
      const ids = items.map(i => i.menuItemId);
      const foundMenuItems = await tx.menuItem.findMany({
        where: { id: { in: ids }, restaurantId: tenantId },
        include: { category: { select: { name: true, printerTarget: true } } },
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

      const table = await tx.table.findFirst({
        where: { id: tableId, restaurantId: tenantId },
        include: {
          section: {
            include: {
              venue: { select: { id: true, venueType: true } },
            },
          },
        },
      });
      if (!table) {
        throw new Error("Table not found");
      }

      const venueId = table.section?.venue?.id ?? undefined;
      const resolvedItems = await Promise.all(
        items.map(async (item) => {
          const resolvedPrice = await resolveItemPrice(item.menuItemId, venueId, tenantId, tx);
          return { ...item, price: resolvedPrice };
        })
      );

      const order = await tx.order.create({
        data: {
          tableId,
          restaurantId: tenantId,
          status: OrderStatus.PREPARING,
          platform: platform || 'DINE_IN',
          totalAmount: totalAmount(resolvedItems),
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
        },
        include: orderInclude,
      });

      return { order, menuItemCategoryMap, table };
    },
    { timeout: 15000, maxWait: 20000 }
  );

  let updatedTable: any = null;
  let newKotHistory: any[] = savedOrder.table.kotHistory as any[] || [];
  if (!isExtraTable) {
    newKotHistory = await appendKotHistory(savedOrder.table.kotHistory, savedOrder.order.items, tenantId, prisma);
    updatedTable = await prisma.table.update({
      where: { id: tableId },
      data: {
        status: TableStatus.OCCUPIED,
        workflowStatus: "Preparing",
        currentBill: { increment: savedOrder.order.totalAmount },
        kotHistory: newKotHistory,
      },
      include: tableInclude,
    });
  } else {
    newKotHistory = await appendKotHistory([], savedOrder.order.items, tenantId, prisma);
    updatedTable = await prisma.table.findUnique({ where: { id: tableId! }, include: tableInclude });
  }

  await emitToRestaurant(tenantId, "order:created", { order: savedOrder.order, isExtraTable: !!isExtraTable });
  if (updatedTable && !isExtraTable) await emitToRestaurant(tenantId, "table:updated", { table: updatedTable });

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

  const latestKot = newKotHistory[newKotHistory.length - 1] as { id?: string } | undefined;
  const formattedTableNumber = extraTableNumber
    ? (isBarOutlet(tenantId, ctx) ? `B${extraTableNumber}` : `T${extraTableNumber}`)
    : (updatedTable?.number
        ? formatTableNumber(updatedTable.number, tenantId, updatedTable.section?.name, (updatedTable as any)?.sectionTag, updatedTable?.section?.venue?.venueType, ctx)
        : "UNKNOWN");
  const basePayload = {
    kotId: latestKot?.id ?? "??",
    tableNumber: formattedTableNumber,
    restaurantId: tenantId,
    sectionTag: (updatedTable as any)?.sectionTag || null,
    sectionName: updatedTable?.section?.name || "Main Hall",
    captainName: incomingCaptainName?.trim() || await getCaptainName(updatedTable?.captainId || undefined) || 'Captain',
    timestamp: new Date().toISOString(),
    requestId: requestId || null,
    printerName: mappedItems.length === 1 ? mappedItems[0].printerName : undefined,
  };

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
    kotId: basePayload.kotId,
    sectionName: basePayload.sectionName,
    captainName: basePayload.captainName,
    sectionTag: basePayload.sectionTag || undefined,
  };

  if (isVenueOutlet(tenantId, ctx)) {
    if (isBarLikeSection(basePayload.sectionTag, updatedTable?.section?.venue?.venueType)) {
      const foodItems = mappedItems.filter((i) => i.menuType !== "LIQUOR");
      const liquorItems = mappedItems.filter((i) => i.menuType === "LIQUOR");
      if (foodItems.length > 0) {
        await emitToRestaurant(tenantId, "print_job", {
          type: "KOT",
          data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData) }
        });
      }
      if (liquorItems.length > 0) {
        await emitToRestaurant(tenantId, "print_job", {
          type: "BAR_KOT",
          data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData) }
        });
      }
    } else {
      const counterItems = mappedItems.filter((i) => i.printerTarget === 'BAR_PRINTER' || i.menuType === 'LIQUOR');
      const kitchenItems = mappedItems.filter((i) => i.printerTarget !== 'BAR_PRINTER' && i.menuType !== 'LIQUOR');

      if (kitchenItems.length > 0) {
        const kitchenPrintItems = kitchenItems.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          notes: i.notes ?? null,
          type: 'food' as const,
        }));
        await emitToRestaurant(tenantId, "print_job", {
          type: "KOT",
          data: {
            ...basePayload,
            items: kitchenItems,
            escposData: buildFoodKOT({ ...kotOrderData, items: kitchenPrintItems }),
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
        await emitToRestaurant(tenantId, "print_job", {
          type: "KOT",
          data: {
            ...basePayload,
            items: counterItems,
            escposDataCounter: buildLiquorKOT({ ...kotOrderData, items: counterPrintItems }),
          }
        });
      }
    }
  } else {
    const foodItems = mappedItems.filter((i) => i.menuType !== "LIQUOR");
    const liquorItems = mappedItems.filter((i) => i.menuType === "LIQUOR");
    if (foodItems.length > 0) {
      await emitToRestaurant(tenantId, "print_job", {
        type: "KOT",
        data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData) }
      });
    }
    if (liquorItems.length > 0) {
      await emitToRestaurant(tenantId, "print_job", {
        type: "BAR_KOT",
        data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData) }
      });
    }
  }

  return { order: savedOrder.order, kotHistory: newKotHistory, table: updatedTable };
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
}

export interface SettleOrderResult {
  order: any;
  table: any;
  transaction: any;
  isExtraTable: boolean;
  inventoryUpdates: any[];
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
  } = input;

  if (!restaurantId) {
    throw Object.assign(new Error("restaurantId is required"), { statusCode: 400 });
  }
  if (!paymentMethod) {
    throw Object.assign(new Error("paymentMethod is required (CASH, CARD, UPI)"), { statusCode: 400 });
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

  const deduplicatedItemsMap = new Map<string, typeof order.items[0]>();
  for (const item of order.items) {
    const existing = deduplicatedItemsMap.get(item.menuItemId);
    if (existing) {
      deduplicatedItemsMap.set(item.menuItemId, { ...existing, quantity: existing.quantity + item.quantity });
    } else {
      deduplicatedItemsMap.set(item.menuItemId, { ...item });
    }
  }
  const deduplicatedItems = Array.from(deduplicatedItemsMap.values());

  const foodItems = deduplicatedItems.filter(item => item.menuItem.menuType === "FOOD");
  const liquorItems = deduplicatedItems.filter(item => item.menuItem.menuType === "LIQUOR");

  const foodSubtotal = foodItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
  const liquorSubtotal = liquorItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
  const calculatedSubtotal = foodSubtotal + liquorSubtotal;

  const discountPercent = (isExtraTable && bodyDiscountPercent != null)
    ? Math.max(0, Math.min(100, Number(bodyDiscountPercent)))
    : (order.table.discount ? Number(order.table.discount) : 0);
  const calculatedDiscountAmount = discountPercent > 0
    ? Math.round(calculatedSubtotal * (discountPercent / 100) * 100) / 100
    : 0;

  const calculatedTaxableFood = foodSubtotal - (calculatedDiscountAmount > 0 && calculatedSubtotal > 0 ? calculatedDiscountAmount * (foodSubtotal / calculatedSubtotal) : 0);
  const calculatedEffectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
  const { cgst: calculatedCgst, sgst: calculatedSgst, tax: calculatedTax, baseAmount: calculatedBaseAmount } = getGstBreakdownWithRate(calculatedTaxableFood, calculatedEffectiveRate, !!taxSource.pricesIncludeGst);
  const calculatedLiquorAfterDiscount = liquorSubtotal - (calculatedDiscountAmount > 0 && calculatedSubtotal > 0 ? calculatedDiscountAmount * (liquorSubtotal / calculatedSubtotal) : 0);
  const calculatedDisplayedSubtotal = Math.round((calculatedBaseAmount + calculatedLiquorAfterDiscount) * 100) / 100;
  const calculatedGrandTotal = Math.max(0, Math.round((calculatedDisplayedSubtotal + calculatedTax) * 100) / 100);

  if (typeof bodyGrandTotal === 'number' && Math.abs(Number(bodyGrandTotal) - calculatedGrandTotal) > 0.50) {
    const err = Object.assign(
      new Error("Bill total mismatch — please refresh and retry"),
      { statusCode: 409, backendTotal: calculatedGrandTotal, frontendTotal: Number(bodyGrandTotal) }
    );
    throw err;
  }

  const subtotal = calculatedSubtotal;
  const discountAmount = calculatedDiscountAmount;
  const cgst = calculatedCgst;
  const sgst = calculatedSgst;
  const tax = calculatedTax;
  const grandTotal = calculatedGrandTotal;

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
      inventoryDeducted: boolean; platform: string | null;
    }>>`
      SELECT "id", "status", "billNumber", "tableId", "inventoryDeducted", "platform"
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

    const deduplicatedItemsForTxn = new Map<string, typeof freshItems[0]>();
    for (const item of freshItems) {
      const existing = deduplicatedItemsForTxn.get(item.menuItemId);
      if (existing) {
        deduplicatedItemsForTxn.set(item.menuItemId, { ...existing, quantity: existing.quantity + item.quantity });
      } else {
        deduplicatedItemsForTxn.set(item.menuItemId, { ...item });
      }
    }
    const txnItems = Array.from(deduplicatedItemsForTxn.values());

    const txnDate = getKolkataDateString();
    const txnNumber = await getNextTxnNumber(restaurantId, tx);

    if (!lockedOrder.platform) {
      console.warn(`[Settlement] Order ${lockedOrder.id} has no platform; defaulting transaction to DINE_IN`);
    }
    if (!lockedOrder.table?.sectionId) {
      console.warn(`[Settlement] Table ${lockedOrder.tableId} for order ${lockedOrder.id} has no sectionId`);
    }

    const createdTxn = await tx.transaction.create({
      data: {
        restaurantId,
        orderId: lockedOrder.id,
        tableNumber: lockedOrder.table.number,
        tableLabel: isExtraTable && bodyTableNumber
          ? (isBarOutlet(restaurantId, ctx) ? `B${bodyTableNumber}` : `T${bodyTableNumber}`)
          : null,
        sectionTag: (lockedOrder.table as any)?.sectionTag || null,
        sectionId: lockedOrder.table.sectionId || null,
        platform: lockedOrder.platform || null,
        captainId: lockedOrder.table.captainId || 'N/A',
        amount: new Prisma.Decimal(grandTotal),
        method: paymentMethod,
        itemCount: txnItems.length,
        items: txnItems.map(item => ({
          name: item.name,
          quantity: item.quantity,
          price: Number(item.price),
          menuType: item.menuItem?.menuType || (item as any).menuType || 'FOOD',
        })),
        txnNumber,
        txnDate,
        billNumber: resolvedBillNumber,
        paidAt: new Date(),
        subtotal: new Prisma.Decimal(subtotal),
        discountPercent: new Prisma.Decimal(discountPercent),
        discountAmount: new Prisma.Decimal(discountAmount),
        cgst: new Prisma.Decimal(cgst),
        sgst: new Prisma.Decimal(sgst),
        grandTotal: new Prisma.Decimal(grandTotal),
      }
    });

    const inventoryUpdates: Array<{
      id: string;
      name: string;
      currentStock: number;
      reorderLevel: number;
      unitOfMeasure: string;
      isLowStock: boolean;
    }> = [];

    const liquorItems = lockedOrder.items.filter((item) => item.menuItem.menuType === "LIQUOR");
    if (!lockedOrder.inventoryDeducted) {
      const liquorMenuItemIds = liquorItems.map((i) => i.menuItemId);
      if (liquorMenuItemIds.length > 0) {
        await tx.$queryRaw`
          SELECT "id" FROM "inventory_items"
          WHERE "menuItemId" IN (${Prisma.join(liquorMenuItemIds)})
          ORDER BY "id" FOR UPDATE
        `;
      }

      const inventoryItemsBatch = liquorMenuItemIds.length > 0
        ? await tx.inventoryItem.findMany({
            where: { menuItemId: { in: liquorMenuItemIds } },
            include: { menuItem: { include: { variants: true } } },
          })
        : [];
      const inventoryMap = new Map(inventoryItemsBatch.map((inv) => [inv.menuItemId, inv]));

      const aggregatedLiquorItems = new Map<string, number>();
      for (const item of liquorItems) {
        aggregatedLiquorItems.set(item.menuItemId, (aggregatedLiquorItems.get(item.menuItemId) || 0) + item.quantity);
      }

      for (const [menuItemId, totalQuantity] of aggregatedLiquorItems.entries()) {
        const inventoryItem = inventoryMap.get(menuItemId) ?? null;
        if (!inventoryItem) {
          console.warn(`[Inventory] Liquor item (menuItemId: ${menuItemId}) has no linked inventory. Skipping.`);
          continue;
        }

        const isBeer = isBeerItem(inventoryItem.menuItem);
        const isSpirit = !isBeer && inventoryItem.menuItem.variants.some(
          (v: { name: string }) => v.name.trim().toLowerCase() === '30ml'
        );
        const mlPerUnit = isBeer ? 650 : isSpirit ? BAR_UNIT_ML : Number(inventoryItem.bottleSize);
        const mlConsumed = mlPerUnit;
        const totalMl = mlConsumed * totalQuantity;

        if (Number(inventoryItem.currentStock) < totalMl) {
          throw Object.assign(
            new Error(`Insufficient stock for ${inventoryItem.menuItem?.name ?? 'Unknown Item'}: available ${inventoryItem.currentStock}ml, required ${totalMl}ml`),
            { statusCode: 409 }
          );
        }

        const updatedItem = await tx.inventoryItem.update({
          where: { id: inventoryItem.id },
          data: { currentStock: { decrement: totalMl } },
        });

        await tx.inventoryTransaction.create({
          data: {
            restaurantId,
            itemId: inventoryItem.id,
            orderId: lockedOrder.id,
            type: 'SALE',
            quantityChange: -totalMl,
            stockBefore: inventoryItem.currentStock,
            stockAfter: updatedItem.currentStock,
            notes: `Order #${lockedOrder.id} - ${totalQuantity}x ${isBeer ? '650ml bottle' : isSpirit ? `${BAR_UNIT_ML}ml` : 'bottle'}`,
            transactionDate: new Date(),
          },
        });

        const snapshotDate = getKolkataDateString();
        await tx.dailyInventorySnapshot.upsert({
          where: {
            restaurantId_snapshotDate_itemId: {
              restaurantId,
              snapshotDate,
              itemId: inventoryItem.id,
            }
          },
          create: {
            restaurantId,
            itemId: inventoryItem.id,
            snapshotDate,
            itemName: inventoryItem.menuItem.name,
            purchased: 0,
            sold: totalMl,
            wastage: 0,
            adjusted: 0,
            openingStock: inventoryItem.currentStock,
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
          name: inventoryItem.menuItem.name,
          currentStock: Number(updatedItem.currentStock),
          reorderLevel: Number(updatedItem.reorderLevel),
          unitOfMeasure: updatedItem.unitOfMeasure,
          isLowStock
        });
      }
    }

    if (!lockedOrder.inventoryDeducted) {
      try {
        const foodItems = lockedOrder.items.filter((item) => item.menuItem.menuType === "FOOD");
        if (foodItems.length > 0) {
          const foodMenuItemIds = foodItems.map((i) => i.menuItemId);
          const recipes = await tx.menuItemRecipe.findMany({
            where: { menuItemId: { in: foodMenuItemIds } },
            include: { ingredient: true },
          });

          const ingredientDeductions = new Map<string, number>();
          for (const item of foodItems) {
            for (const recipe of recipes.filter((r) => r.menuItemId === item.menuItemId)) {
              const current = ingredientDeductions.get(recipe.ingredientId) || 0;
              ingredientDeductions.set(recipe.ingredientId, current + Number(recipe.quantity) * item.quantity);
            }
          }

          const today = getKolkataDateString();
          for (const [ingredientId, totalQty] of ingredientDeductions.entries()) {
            try {
              const updatedIngredient = await tx.kitchenInventoryItem.update({
                where: { id: ingredientId },
                data: { currentStock: { decrement: new Prisma.Decimal(totalQty) } },
              });

              const existingEntry = await tx.inventoryDailyEntry.findUnique({
                where: {
                  restaurantId_itemId_entryDate: { restaurantId, itemId: ingredientId, entryDate: today },
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
                await tx.inventoryDailyEntry.create({
                  data: {
                    restaurantId,
                    itemId: ingredientId,
                    entryDate: today,
                    openingStock: new Prisma.Decimal(0),
                    consumedStock: new Prisma.Decimal(totalQty),
                    closingStock: updatedIngredient.currentStock,
                  },
                });
              }

              if (Number(updatedIngredient.currentStock) <= Number(updatedIngredient.reorderLevel)) {
                console.warn(`[Kitchen] Low stock: ${updatedIngredient.name} (${updatedIngredient.currentStock} ${updatedIngredient.unit}, reorder at ${updatedIngredient.reorderLevel})`);
                try {
                  const io = getIo();
                  if (io) {
                    io.to(`restaurant:${restaurantId}`).emit("kitchen:low-stock", {
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
              console.error(`[Kitchen] Deduction failed for ingredient ${ingredientId}:`, err.message);
            }
          }
        }
      } catch (err: any) {
        console.error("[Kitchen] Inventory deduction block failed, settling anyway:", err.message);
      }
    }

    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.PAID,
        billingRequested: false,
        paidAt: new Date(),
        inventoryDeducted: true,
      },
      include: {
        items: { include: { menuItem: true } },
        table: { include: { section: true } }
      }
    });

    let settleTable: any = null;
    if (!isExtraTable) {
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
    };

    if (requestId) {
      await tx.processedRequest.create({
        data: {
          requestId,
          actionType: 'settle',
          orderId: lockedOrder.id,
          restaurantId,
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
      grandTotal,
      discountPercent: Number(discountPercent),
      discountAmount: Number(discountAmount),
    },
  });

  return result;
}

// Re-export build helpers so route handlers can keep emitting the same payloads.
export { buildFoodKOT, buildLiquorKOT };
