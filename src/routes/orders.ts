import { OrderStatus, Prisma, TableStatus, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { randomUUID } from "crypto";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import { getKolkataDateString } from "../utils/date";
import { isBeerItem } from "../utils/itemHelpers";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache, cacheClear } from "../lib/cache";
import { resolveTenantContext, isBarOutlet, isVenueOutlet, type TenantContext } from "../lib/tenantContext";
import { getGstBreakdown } from "../utils/gst";
import { authenticate } from "../middleware/auth";

const router = Router();

router.use(authenticate);
const BAR_UNIT_ML = 30;
const BAR_FULL_BOTTLE_MULTIPLIER = 25;

// Server-side print lock to prevent duplicate prints from the same order
const printLocks = new Map<string, number>(); // orderId -> timestamp
const PRINT_LOCK_TTL_MS = 5000;

// Emit-level lock to prevent duplicate print_job emissions for the same logical job
const emitLocks = new Map<string, number>(); // key -> timestamp
const EMIT_LOCK_TTL_MS = 10000;

import { getCaptainName } from "../utils/captainMap";
import {
  buildFoodKOT,
  buildLiquorKOT,
  buildFinalBill,
  buildBill,
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
  section: { select: { id: true, name: true, restaurantId: true } },
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
    id: String(kotNumber).padStart(3, '0'),   // "001", "002" — resets daily, supports up to 999 KOTs
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

function emitToRestaurant(restaurantId: string, eventName: string, payload: Record<string, unknown>): void {
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
    const now = Date.now();
    const lockTs = emitLocks.get(emitKey);
    if (lockTs && now - lockTs < EMIT_LOCK_TTL_MS) {
      console.warn(`[Orders] Duplicate print_job emit blocked: ${emitKey}`);
      return;
    }
    emitLocks.set(emitKey, now);
    // Clean up old locks
    for (const [key, ts] of emitLocks.entries()) {
      if (now - ts > EMIT_LOCK_TTL_MS) emitLocks.delete(key);
    }

    const eventId = randomUUID();
    const enriched = {
      restaurantId,
      ...payload,
      eventId,  // TOP LEVEL — so bufferPrintJob can read payload.eventId
      data: { ...(payload.data as Record<string, unknown>), eventId },  // also in data for PrintStation client dedup
    };
    // Buffer for reconnect recovery (PrintStation may miss events during brief disconnect)
    bufferPrintJob(restaurantId, enriched).catch(() => {});
    getIo().to(printRoom).emit(eventName, enriched);
  } else {
    getIo().to(restaurantId).emit(eventName, { restaurantId, ...payload });
  }
}

function isBarLikeSection(sectionTag: string | null | undefined): boolean {
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
  ctx?: TenantContext
): string {
  if (tableNumber === 999 || String(tableNumber) === '999') return 'Counter';

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

async function assertOrderBelongsToTenant(orderId: string, requestingRestaurantId: string | undefined): Promise<void> {
  if (!requestingRestaurantId) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
  const ctx = await resolveTenantContext(requestingRestaurantId);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { restaurantId: true }
  });
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  if (!ctx.allIds.includes(order.restaurantId)) {
    throw Object.assign(new Error('Cross-tenant access denied'), { statusCode: 403 });
  }
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
    const restaurantId = req.user?.restaurantId;
    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { tableId, requestId, captainName: incomingCaptainName, isExtraTable, tableNumber: extraTableNumber } = req.body as {
      tableId?: string;
      requestId?: string;
      captainName?: string;
      isExtraTable?: boolean;
      tableNumber?: string;
    };
    const tenantId = restaurantId;
    const items = normalizeItems(req.body.items);

    if (!tableId?.trim() || !tenantId) {
      res.status(400).json({ error: "tableId and restaurantId are required" });
      return;
    }

    // Resolve tenant context once per request — used for outlet-specific routing below
    const ctx = await resolveTenantContext(tenantId);

    // ── Atomic writes only ─────────────────────────────────────────────────
    const savedOrder = await prisma.$transaction(
      async (tx) => {
        // Validate menu items inside the transaction to batch reads
        const ids = items.map(i => i.menuItemId);
        const foundMenuItems = await tx.menuItem.findMany({
          where: { id: { in: ids }, restaurantId: tenantId },
          include: { category: { select: { name: true, printerTarget: true } } },
        });
        const menuItemCategoryMap = new Map(
          foundMenuItems.map(m => [m.id, { name: m.category?.name || 'Unknown', printerTarget: m.category?.printerTarget || null }])
        );
        const foundIds = new Set(foundMenuItems.map(m => m.id));
        const missing = ids.filter(id => !foundIds.has(id));
        if (missing.length) {
          const err = new Error("Invalid menuItemIds") as any;
          err.missing = missing;
          throw err;
        }

        // Validate table inside the transaction
        const table = await tx.table.findFirst({
          where: { id: tableId, restaurantId: tenantId },
        });
        if (!table) {
          throw new Error("Table not found");
        }

        const order = await tx.order.create({
          data: {
            tableId,
            restaurantId: tenantId,
            status: OrderStatus.PREPARING,
            totalAmount: totalAmount(items),
            items: {
              create: items.map((item) => ({
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
    // ───────────────────────────────────────────────────────────────────────

    // Non-critical mutations outside transaction (don't hold DB lock)
    // For extra tables: skip parent table mutation — extra table is isolated client-side
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
      // Extra table: use empty base so KOT numbering starts fresh for this session,
      // independent of the parent table's (potentially reset) kotHistory.
      newKotHistory = await appendKotHistory([], savedOrder.order.items, tenantId, prisma);
      updatedTable = await prisma.table.findUnique({ where: { id: tableId! }, include: tableInclude });
    }

    emitToRestaurant(tenantId, "order:created", { order: savedOrder.order, isExtraTable: !!isExtraTable });
    // Skip table:updated for extra tables — would overwrite original table state on other devices
    if (updatedTable && !isExtraTable) emitToRestaurant(tenantId, "table:updated", { table: updatedTable });

    // ── print_job events → cashier PC's /print-station handles QZ Tray ────
    // Captain's device never needs QZ Tray installed.
    const allItems = (savedOrder.order as unknown as { items?: Array<{ name: string; price: number; quantity: number; menuType?: string; menuItemId?: string; notes?: string | null }> }).items ?? [];
    const mappedItems = allItems.map((i) => {
      const cat = savedOrder.menuItemCategoryMap.get(i.menuItemId || '') || { name: 'Unknown', printerTarget: null };
      return {
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        notes: i.notes ?? null,
        menuType: i.menuType,
        category: cat.name,
        printerTarget: cat.printerTarget,
      };
    });

    // Use the sequential KOT id from the entry just appended to kotHistory
    const latestKot = newKotHistory[newKotHistory.length - 1] as { id?: string } | undefined;
    const formattedTableNumber = extraTableNumber
      ? (isBarOutlet(tenantId, ctx) ? `B${extraTableNumber}` : `T${extraTableNumber}`)
      : (updatedTable?.number
          ? formatTableNumber(updatedTable.number, tenantId, updatedTable.section?.name, (updatedTable as any)?.sectionTag, ctx)
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
    };

    // Pre-build ESC/POS data so PrintStation never hits Render for print data
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

    // For family-restaurant / parcel venues, split by printerTarget + menuType.
    // Counter items (BAR_PRINTER target or LIQUOR) → Dine in Bill.
    // Kitchen items (everything else) → KOT FAMILY.
    // For bar-like venues (Conference, PDR, Rooms, Owner/Parcel), use standard bar rules:
    // Food → KOT (kitchen), Liquor → BAR_KOT (bar printer).
    if (isVenueOutlet(tenantId, ctx)) {
      if (isBarLikeSection(basePayload.sectionTag)) {
        const foodItems = mappedItems.filter((i) => i.menuType !== "LIQUOR");
        const liquorItems = mappedItems.filter((i) => i.menuType === "LIQUOR");
        if (foodItems.length > 0) {
          emitToRestaurant(tenantId, "print_job", {
            type: "KOT",
            data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData) }
          });
        }
        if (liquorItems.length > 0) {
          emitToRestaurant(tenantId, "print_job", {
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
          emitToRestaurant(tenantId, "print_job", {
            type: "KOT",
            data: {
              ...basePayload,
              items: kitchenItems,
              escposData: buildFoodKOT({
                ...kotOrderData,
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
          emitToRestaurant(tenantId, "print_job", {
            type: "KOT",
            data: {
              ...basePayload,
              items: counterItems,
              escposDataCounter: buildLiquorKOT({
                ...kotOrderData,
                items: counterPrintItems,
              }),
            }
          });
        }
      }
    } else {
      const foodItems = mappedItems.filter((i) => i.menuType !== "LIQUOR");
      const liquorItems = mappedItems.filter((i) => i.menuType === "LIQUOR");
      if (foodItems.length > 0) {
        emitToRestaurant(tenantId, "print_job", {
          type: "KOT",
          data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData) }
        });
      }
      if (liquorItems.length > 0) {
        emitToRestaurant(tenantId, "print_job", {
          type: "BAR_KOT",
          data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData) }
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    res.status(201).json({
      ...savedOrder.order,
      kotHistory: newKotHistory
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
    const restaurantId = req.user?.restaurantId ?? "";
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
    const restaurantId = req.user?.restaurantId;
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
    await assertOrderBelongsToTenant(id, req.user?.restaurantId);
    const { requestId, captainName: incomingCaptainName2, isExtraTable: isExtraTable2, tableNumber: extraTableNumber2, lastUpdatedAt } = req.body as {
      requestId?: string;
      captainName?: string;
      isExtraTable?: boolean;
      tableNumber?: string;
      lastUpdatedAt?: string;
    };
    const items = normalizeItems(req.body.items);

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { items: true, table: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    // Fetch category names for print_job beverage/food split — scoped to the order's tenant
    const itemIds = items.map(i => i.menuItemId);
    const menuItemsWithCat = await prisma.menuItem.findMany({
      where: { id: { in: itemIds }, restaurantId: existing.restaurantId },
      include: { category: { select: { name: true, printerTarget: true } } },
    });
    const menuItemCategoryMap = new Map(
      menuItemsWithCat.map(m => [m.id, { name: m.category?.name || 'Unknown', printerTarget: m.category?.printerTarget || null }])
    );
    if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
      res.status(409).json({ error: "Only active orders can be updated" });
      return;
    }

    const ctx = await resolveTenantContext(existing.restaurantId);

    // Optimistic lock: prevent stale overwrites when two captains add items simultaneously
    // ±2s tolerance avoids false 409s from client→string→Date round-trip precision loss.
    if (lastUpdatedAt && existing.updatedAt) {
      const clientTime = new Date(lastUpdatedAt).getTime();
      const serverTime = new Date(existing.updatedAt).getTime();
      if (Math.abs(clientTime - serverTime) > 2000) {
        res.status(409).json({
          error: "Order was modified by another user. Please refresh and try again.",
          serverUpdatedAt: existing.updatedAt,
        });
        return;
      }
    }

    if (requestId && existing.lastRequestId === requestId) {
      res.json({ order: existing, kotHistory: existing.table.kotHistory });
      return;
    }

    // ── Atomic writes only ─────────────────────────────────────────────────
    const updatedOrder = await prisma.$transaction(
      async (tx) => {
        // 1. Fetch existing active items for dedup
        const existingItems = await tx.orderItem.findMany({
          where: { orderId: id, removedFromBill: false },
        });

        // 2. Build dedup map keyed by menuItemId::notes
        const dedupMap = new Map<string, typeof existingItems[number]>();
        for (const ei of existingItems) {
          const key = `${ei.menuItemId}::${ei.notes ?? ''}`;
          dedupMap.set(key, ei);
        }

        // 3. Process incoming items: merge or collect for creation
        const toCreate: Array<{
          orderId: string;
          menuItemId: string;
          name: string;
          price: number;
          quantity: number;
          notes: string | null;
          menuType: "FOOD" | "LIQUOR";
        }> = [];
        const createDedupMap = new Map<string, number>(); // key → index in toCreate

        for (const item of items) {
          const key = `${item.menuItemId}::${item.notes ?? ''}`;
          const existingMatch = dedupMap.get(key);

          if (existingMatch) {
            // Merge: increment existing row's quantity
            await tx.orderItem.update({
              where: { id: existingMatch.id },
              data: { quantity: { increment: item.quantity } },
            });
          } else {
            // Check if same key already in toCreate (same-batch dedup)
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

        // 4. Batch insert only genuinely new items
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

        return { order, itemsWithIds };
      },
      { timeout: 15000, maxWait: 20000 }
    );
    // ───────────────────────────────────────────────────────────────────────

    // Non-critical mutations outside transaction (don't hold DB lock)
    // For extra tables: skip parent table mutation — extra table is isolated client-side
    const baseKotHistory = isExtraTable2 ? [] : existing.table.kotHistory;
    const newKotHistory = await appendKotHistory(baseKotHistory, updatedOrder.itemsWithIds, existing.restaurantId, prisma);
    let updatedTable2: any = null;
    if (!isExtraTable2) {
      updatedTable2 = await prisma.table.update({
        where: { id: existing.tableId },
        data: {
          status: existing.status === OrderStatus.BILLING_REQUESTED ? TableStatus.BILLING_REQUESTED : TableStatus.OCCUPIED,
          workflowStatus: existing.status === OrderStatus.BILLING_REQUESTED ? "Waiting Bill" : "Preparing",
          currentBill: updatedOrder.order.totalAmount,
          kotHistory: newKotHistory,
        },
        include: tableInclude,
      });
    } else {
      updatedTable2 = await prisma.table.findUnique({ where: { id: existing.tableId }, include: tableInclude });
    }
    const updatedTable = updatedTable2;

    emitToRestaurant(existing.restaurantId, "order:updated", { order: updatedOrder.order, isExtraTable: !!isExtraTable2 });
    // Skip table:updated for extra tables — would overwrite original table state on other devices
    if (updatedTable && !isExtraTable2) emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable });

    // ── print_job for supplemental KOT (same flow as order creation) ────────
    // print_job uses only the incoming KOT items from this request, not all DB rows.
    const mappedItems2 = items.map((i) => {
      const cat = menuItemCategoryMap.get(i.menuItemId) || { name: 'Unknown', printerTarget: null };
      return {
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        notes: i.notes ?? null,
        menuType: i.menuType,
        category: cat.name,
        printerTarget: cat.printerTarget,
      };
    });

    const latestKot2 = newKotHistory[newKotHistory.length - 1] as { id?: string } | undefined;
    const formattedTableNumber2 = extraTableNumber2
      ? (isBarOutlet(existing.restaurantId, ctx) ? `B${extraTableNumber2}` : `T${extraTableNumber2}`)
      : (updatedTable?.number
          ? formatTableNumber(updatedTable.number, existing.restaurantId, updatedTable.section?.name, (updatedTable as any)?.sectionTag, ctx)
          : "UNKNOWN");
    const basePayload = {
      kotId: latestKot2?.id ?? "??",
      tableNumber: formattedTableNumber2,
      restaurantId: existing.restaurantId,
      sectionTag: (updatedTable as any)?.sectionTag || null,
      sectionName: updatedTable?.section?.name || "Main Hall",
      captainName: incomingCaptainName2?.trim() || await getCaptainName(updatedTable?.captainId || undefined) || 'Captain',
      timestamp: new Date().toISOString(),
      requestId: requestId || null,
    };

    // Pre-build ESC/POS data so PrintStation never hits Render for print data
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

    if (isVenueOutlet(existing.restaurantId, ctx)) {
      if (isBarLikeSection(basePayload.sectionTag)) {
        const foodItems = mappedItems2.filter((i) => i.menuType !== "LIQUOR");
        const liquorItems = mappedItems2.filter((i) => i.menuType === "LIQUOR");
        if (foodItems.length > 0) {
          emitToRestaurant(existing.restaurantId, "print_job", {
            type: "KOT",
            data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData2) }
          });
        }
        if (liquorItems.length > 0) {
          emitToRestaurant(existing.restaurantId, "print_job", {
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
          emitToRestaurant(existing.restaurantId, "print_job", {
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
          emitToRestaurant(existing.restaurantId, "print_job", {
            type: "KOT",
            data: {
              ...basePayload,
              items: counterItems,
              escposDataCounter: buildLiquorKOT({
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
        emitToRestaurant(existing.restaurantId, "print_job", {
          type: "KOT",
          data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData2) }
        });
      }
      if (liquorItems.length > 0) {
        emitToRestaurant(existing.restaurantId, "print_job", {
          type: "BAR_KOT",
          data: { ...basePayload, items: liquorItems, escposData: buildLiquorKOT(kotOrderData2) }
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    res.json({
      order: {
        ...updatedOrder.order,
        kotHistory: newKotHistory
      }
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
    await assertOrderBelongsToTenant(id, req.user?.restaurantId);
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

    const order = await prisma.order.update({
      where: { id },
      data: { status: requestedStatus },
      include: orderInclude,
    });

    emitToRestaurant(order.restaurantId, "order:updated", { order });
    res.json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

router.post("/:id/request-billing", invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.restaurantId);

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

    emitToRestaurant(existing.restaurantId, "billing:requested", result);
    emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });
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

router.patch("/:id/settle", invalidateCache(["tables:*", "sections:list:*", "transactions:*", "analytics:*", "reports:*", "stats:today:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.restaurantId);
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

    emitToRestaurant(existing.restaurantId, "order:updated", { order: result.order });
    emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });
    res.json(result.order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to settle order items" });
  }
});

router.patch("/:id/bill-edit", invalidateCache(["tables:*", "sections:list:*", "transactions:*", "analytics:*", "reports:*", "stats:today:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.restaurantId);
    const {
      removedItemIds,
      editQuantities,
      addedItems,
      editedBy,
    } = req.body as {
      removedItemIds?: string[];
      editQuantities?: Record<string, number>;
      addedItems?: Array<{ menuItemId: string; name: string; price: number; quantity: number; notes?: string | null; menuType?: string }>;
      editedBy?: string;
    };

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { items: true, table: true },
    });

    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
      res.status(409).json({ error: "Cannot edit a settled or paid order" });
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

        for (const item of addedItems) {
          const menuItemId = item.menuItemId?.trim();
          const name = item.name?.trim();
          const price = Number(item.price);
          const quantity = Math.round(Number(item.quantity));
          const menuType: "FOOD" | "LIQUOR" = item.menuType === "LIQUOR" ? "LIQUOR" : "FOOD";
          const notes = typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : null;

          if (!menuItemId || !name || !Number.isFinite(price) || price < 0 || quantity <= 0) continue;

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

    emitToRestaurant(existing.restaurantId, "order:updated", { order: result.order });
    emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });

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
    await assertOrderBelongsToTenant(orderId, req.user?.restaurantId);
    const restaurantId = req.user!.restaurantId;
    const { tableNumber: tableNumberOverride, discountPercent: discountPercentOverride, kotNumbers: kotNumbersParam } = req.query as { tableNumber?: string; discountPercent?: string; kotNumbers?: string };
    const isExtraTable = !!tableNumberOverride;

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    // Server-side print lock to prevent duplicate prints from the same order
    const now = Date.now();
    const lockTs = printLocks.get(orderId);
    if (lockTs && now - lockTs < PRINT_LOCK_TTL_MS) {
      return res.status(429).json({ error: "Duplicate print request — please wait" });
    }
    printLocks.set(orderId, now);
    // Clean up old locks
    for (const [oid, ts] of printLocks.entries()) {
      if (now - ts > PRINT_LOCK_TTL_MS) printLocks.delete(oid);
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
          include: { section: true }
        }
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const ctx = await resolveTenantContext(restaurantId);

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
    const result = await prisma.$transaction(async (tx) => {
      // Generate or reuse bill number
      let billNumber: string;
      const now = new Date();

      if (order.billNumber) {
        // Reuse existing bill number for reprints
        billNumber = order.billNumber;
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
      const updatedTable = isExtraTable
        ? await tx.table.findUnique({ where: { id: order.tableId }, include: { section: true } })
        : await tx.table.update({
            where: { id: order.tableId },
            data: {
              status: TableStatus.BILLING_REQUESTED,
              workflowStatus: "Waiting Bill",
            },
            include: { section: true }
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
      }

      // Tax calculation (CGST + SGST on food only, AFTER discount) - WITH ROUNDING
      const taxableAmount = foodSubtotal - (discount ? discountAmount * (foodSubtotal / subtotal) : 0);
      const { cgst, sgst, tax, baseAmount } = getGstBreakdown(taxableAmount, ctx.gstCategory, !!ctx.pricesIncludeGst);
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
            (updatedTable as any)?.sectionTag,
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
      return {
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
    }, { timeout: 15000, maxWait: 20000 });

    // 5. EMIT SOCKET EVENTS AFTER TRANSACTION COMMITS
    // Emit print job → dedicated print room (only PrintStation subscribes)
    // Pre-build ESC/POS so PrintStation never calls Render for bill data
    const finalBillEscpos = buildFinalBill(result.billData.data as any);
    emitToRestaurant(restaurantId, "print_job", {
      ...result.billData,
      data: { ...result.billData.data, escposData: finalBillEscpos },
    });

    // Emit billing requested event
    emitToRestaurant(restaurantId, "billing:requested", {
      orderId: result.order.id,
      tableId: result.table.id,
      tableNumber: result.formattedTableNumber,
      totalAmount: result.grandTotal
    });

    // Emit table updated event (skip for extra tables — parent table was not mutated)
    if (!isExtraTable) {
      emitToRestaurant(restaurantId, "table:updated", { table: result.table });
    }

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
    res.status(500).json({ error: error.message });
  }
});

// POST /api/orders/:id/reprint-kot - Reprint KOT for a given order
router.post("/:id/reprint-kot", async (req, res) => {
  try {
    const orderId = req.params.id as string;
    await assertOrderBelongsToTenant(orderId, req.user?.restaurantId);
    const restaurantId = req.user!.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: true } },
        table: { include: { section: true } },
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
      emitToRestaurant(restaurantId, "print_job", {
        type: "KOT",
        data: { ...basePayload, items: foodItems, escposData: buildFoodKOT(kotOrderData) }
      });
    }
    if (liquorItems.length > 0) {
      emitToRestaurant(restaurantId, "print_job", {
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
router.post("/:id/settle", invalidateCache(["tables:*", "sections:list:*", "transactions:*", "analytics:*", "reports:*", "stats:today:*", "venue:sections:*"]), async (req, res) => {
  try {
    const orderId = req.params.id as string;
    await assertOrderBelongsToTenant(orderId, req.user?.restaurantId);
    const restaurantId = req.user!.restaurantId;
    const {
      paymentMethod,
      discountPercent: bodyDiscountPercent,
      tableNumber: bodyTableNumber,
      isExtraTable,
      grandTotal: bodyGrandTotal,
      subtotal: bodySubtotal,
      discountAmount: bodyDiscountAmount,
      cgst: bodyCgst,
      sgst: bodySgst,
    } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    if (!paymentMethod) {
      return res.status(400).json({
        error: "paymentMethod is required (CASH, CARD, UPI)"
      });
    }

    // 1. VALIDATE OUTSIDE TRANSACTION - Find order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: true }
        },
        table: { include: { section: true } }
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const ctx = await resolveTenantContext(restaurantId);

    // Guard: prevent double inventory deduction on retry
    if (order.inventoryDeducted) {
      console.log(`[Inventory] Order ${orderId} already had inventory deducted — skipping`);
      // Still allow the payment to proceed, just skip inventory
    }

    // 2. VALIDATE order state OUTSIDE TRANSACTION
    if (order.status === OrderStatus.PAID) {
      return res.status(409).json({
        error: "Order is already paid"
      });
    }

    // 3. Calculate grandTotal with discount + GST (matches print-bill logic exactly)
    // If frontend sends pre-calculated values (from printed bill), use them to avoid
    // floating-point drift between frontend and backend recalculation.

    // Deduplicate order items by menuItemId — sum quantities to prevent double-count on rapid settle
    const deduplicatedItemsMap = new Map<string, typeof order.items[0]>();
    for (const item of order.items) {
      const existing = deduplicatedItemsMap.get(item.menuItemId);
      if (existing) {
        deduplicatedItemsMap.set(item.menuItemId, {
          ...existing,
          quantity: existing.quantity + item.quantity,
        });
      } else {
        deduplicatedItemsMap.set(item.menuItemId, { ...item });
      }
    }
    const deduplicatedItems = Array.from(deduplicatedItemsMap.values());

    const foodItems = deduplicatedItems.filter(item => item.menuItem.menuType === "FOOD");
    const liquorItems = deduplicatedItems.filter(item => item.menuItem.menuType === "LIQUOR");

    const foodSubtotal = foodItems.reduce((sum, item) =>
      sum + (Number(item.price) * item.quantity), 0
    );
    const liquorSubtotal = liquorItems.reduce((sum, item) =>
      sum + (Number(item.price) * item.quantity), 0
    );
    const calculatedSubtotal = foodSubtotal + liquorSubtotal;

    // For extra tables: use discount passed in body (parent table discount is irrelevant)
    const discountPercent = (isExtraTable && bodyDiscountPercent != null)
      ? Number(bodyDiscountPercent)
      : (order.table.discount ? Number(order.table.discount) : 0);
    const calculatedDiscountAmount = discountPercent > 0
      ? Math.round(calculatedSubtotal * (discountPercent / 100) * 100) / 100
      : 0;

    const calculatedTaxableFood = foodSubtotal - (calculatedDiscountAmount > 0 && calculatedSubtotal > 0 ? calculatedDiscountAmount * (foodSubtotal / calculatedSubtotal) : 0);
    const { cgst: calculatedCgst, sgst: calculatedSgst, tax: calculatedTax, baseAmount: calculatedBaseAmount } = getGstBreakdown(calculatedTaxableFood, ctx.gstCategory, !!ctx.pricesIncludeGst);
    const calculatedLiquorAfterDiscount = liquorSubtotal - (calculatedDiscountAmount > 0 && calculatedSubtotal > 0 ? calculatedDiscountAmount * (liquorSubtotal / calculatedSubtotal) : 0);
    const calculatedDisplayedSubtotal = Math.round((calculatedBaseAmount + calculatedLiquorAfterDiscount) * 100) / 100;
    const calculatedGrandTotal = Math.round((calculatedDisplayedSubtotal + calculatedTax) * 100) / 100;

    // Reject frontend-provided totals that deviate from server-side calculation.
    // Always use server-side computed values to prevent manipulation.
    if (typeof bodyGrandTotal === 'number' && Math.abs(Number(bodyGrandTotal) - calculatedGrandTotal) > 0.50) {
      return res.status(409).json({
        error: "Bill total mismatch — please refresh and retry",
        backendTotal: calculatedGrandTotal,
        frontendTotal: Number(bodyGrandTotal),
      });
    }

    const subtotal = calculatedSubtotal;
    const discountAmount = calculatedDiscountAmount;
    const cgst = calculatedCgst;
    const sgst = calculatedSgst;
    const tax = calculatedTax;
    const grandTotal = calculatedGrandTotal;

    // 4. TRANSACTION - All reads AND mutations inside
    const result = await prisma.$transaction(async (tx) => {

      // Re-read order with a lock inside the transaction for consistency
      const lockedOrder = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            where: { removedFromBill: false, quantity: { gt: 0 } },
            include: { menuItem: true },
          },
          table: { include: { section: true } },
        },
      });

      if (!lockedOrder) throw new Error('Order not found inside transaction');

      // Use lockedOrder.billNumber — guaranteed consistent after print-bill commit
      const resolvedBillNumber = lockedOrder.billNumber ?? order.billNumber ?? null;

      // Use lockedOrder.items for itemCount and items JSON
      const freshItems = lockedOrder.items.length > 0
        ? lockedOrder.items
        : order.items; // fallback to outer-scope fetch

      // Deduplicate by menuItemId — prevents doubled totals/itemCount from race-appended items
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

      // 4. Create transaction record (integrated)
      const txnDate = getKolkataDateString();

      // Get next transaction number using the same helper function
      const txnNumber = await getNextTxnNumber(restaurantId, tx);

      await tx.transaction.create({
        data: {
          restaurantId,
          orderId: lockedOrder.id,
          tableNumber: lockedOrder.table.number,
          tableLabel: isExtraTable && bodyTableNumber
            ? (isBarOutlet(restaurantId, ctx) ? `B${bodyTableNumber}` : `T${bodyTableNumber}`)
            : null,
          sectionTag: (lockedOrder.table as any)?.sectionTag || null,
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

      // Process liquor inventory deduction — use lockedOrder.items (transaction-scoped, not outer scope)
      const liquorItems = lockedOrder.items.filter(
        (item) => item.menuItem.menuType === "LIQUOR"
      );

      const inventoryUpdates: Array<{
        id: string;
        name: string;
        currentStock: number;
        reorderLevel: number;
        unitOfMeasure: string;
        isLowStock: boolean;
      }> = [];

      // Only deduct inventory once, ever — re-check on lockedOrder to prevent race condition
      if (!lockedOrder.inventoryDeducted) {
        // Batch-fetch all inventory items at once (replaces N+1 individual lookups)
        const liquorMenuItemIds = liquorItems.map((i) => i.menuItemId);
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
            console.warn(
              `[Inventory] Liquor item (menuItemId: ${menuItemId}) has no linked inventory. Skipping.`
            );
            continue;
          }

          // Determine ml to deduct based on item type
          const isBeer = isBeerItem(inventoryItem.menuItem);
          const isSpirit = !isBeer && inventoryItem.menuItem.variants.some(
            (v: { name: string }) => v.name.trim().toLowerCase() === '30ml'
          );
          const mlPerUnit = isBeer ? 650 : isSpirit ? BAR_UNIT_ML : Number(inventoryItem.bottleSize);
          const mlConsumed = mlPerUnit; // per unit sold

          const totalMl = mlConsumed * totalQuantity;

          if (Number(inventoryItem.currentStock) < totalMl) {
            throw new Error(`Insufficient stock for ${inventoryItem.menuItem?.name ?? 'Unknown Item'}: available ${inventoryItem.currentStock}ml, required ${totalMl}ml`);
          }

          // Deduct stock
          const updatedItem = await tx.inventoryItem.update({
            where: { id: inventoryItem.id },
            data: {
              currentStock: {
                decrement: totalMl,
              },
            },
          });

          // Record transaction
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

          // Write snapshot
          const snapshotDate = getKolkataDateString(); // YYYY-MM-DD
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

          console.log(
            `[Inventory] Deducted ${totalMl}ml of ${inventoryItem.menuItem.name} ` +
            `(${inventoryItem.currentStock}ml → ${updatedItem.currentStock}ml)`
          );

          // Collect inventory updates for socket emission AFTER transaction
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

      // ========================================
      // KITCHEN INVENTORY DEDUCTION (Phase 5)
      // ========================================
      // Deduct kitchen ingredients for FOOD items that have recipes.
      // Runs inside the same transaction — atomic with settlement.
      // The ENTIRE block is wrapped in try/catch so recipe data errors
      // never roll back the payment/bar deduction.
      if (!lockedOrder.inventoryDeducted) {
        try {
          const foodItems = lockedOrder.items.filter(
            (item) => item.menuItem.menuType === "FOOD"
          );

          if (foodItems.length > 0) {
            const foodMenuItemIds = foodItems.map((i) => i.menuItemId);
            const recipes = await tx.menuItemRecipe.findMany({
              where: { menuItemId: { in: foodMenuItemIds } },
              include: { ingredient: true },
            });

            // Aggregate ingredient quantities across all food items
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
                  data: {
                    currentStock: { decrement: new Prisma.Decimal(totalQty) },
                  },
                });

                // Update or create today's daily entry
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
                  // No entry for today — create one with 0 opening
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

                // Low stock warning
                if (Number(updatedIngredient.currentStock) <= Number(updatedIngredient.reorderLevel)) {
                  console.warn(
                    `[Kitchen] Low stock: ${updatedIngredient.name} ` +
                    `(${updatedIngredient.currentStock} ${updatedIngredient.unit}, ` +
                    `reorder at ${updatedIngredient.reorderLevel})`
                  );

                  // Emit socket event for low stock
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
                    // Socket errors are non-critical
                  }
                }
              } catch (err: any) {
                // Per-ingredient error — log and continue to next ingredient
                console.error(`[Kitchen] Deduction failed for ingredient ${ingredientId}:`, err.message);
              }
            }
          }
        } catch (err: any) {
          // Entire kitchen deduction block failed — log but NEVER block settle
          console.error("[Kitchen] Inventory deduction block failed, settling anyway:", err.message);
        }
      }

      // Update order to PAID
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

      // Reset table to AVAILABLE — skip for extra tables (parent table still has its own session)
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
        // Read parent table without mutating it
        settleTable = await tx.table.findUnique({ where: { id: order.tableId } });
      }
      const updatedTable = settleTable;

      return { order: updatedOrder, table: updatedTable, inventoryUpdates, isExtraTable: !!isExtraTable };
    }, { timeout: 15000, maxWait: 20000 });

    // 5. EXPLICITLY INVALIDATE TRANSACTIONS CACHE so concurrent reads get fresh data
    cacheClear('transactions:');

    // 6. EMIT SOCKET EVENTS AFTER TRANSACTION COMMITS
    const io = getIo();

    // Emit order paid event
    io.to(restaurantId).emit("order:paid", {
      orderId: result.order.id,
      tableId: result.table?.id,
      paymentMethod,
      isExtraTable: result.isExtraTable,
    });

    // Skip table:updated for extra tables — parent table was not mutated
    if (!result.isExtraTable) {
      const tableForEmit = await prisma.table.findUnique({
        where: { id: result.table!.id },
        include: tableInclude,
      });
      io.to(restaurantId).emit("table:updated", { table: tableForEmit ?? result.table });
    }

    // Emit inventory updates (if any)
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

    res.json({
      message: "Payment settled successfully",
      order: result.order,
      table: result.table
    });
  } catch (error: any) {
    console.error("[Orders] Settlement error:", error.message);
    if (error.message && error.message.includes("Insufficient stock")) {
      return res.status(409).json({ error: error.message });
    }
    // Handle unique constraint violation on Transaction.orderId (concurrent settle attempts)
    if (error?.code === 'P2002' && error?.meta?.target?.includes('orderId')) {
      return res.status(409).json({ error: 'Order is already paid (concurrent settlement)' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/pay", invalidateCache(["tables:*", "sections:list:*", "transactions:*", "analytics:*", "reports:*", "stats:today:*", "venue:sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    await assertOrderBelongsToTenant(id, req.user?.restaurantId);
    const { paymentMethod } = req.body as { paymentMethod?: string };

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { table: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const ctx = await resolveTenantContext(existing.restaurantId);

    // Guard: prevent double inventory deduction on retry
    if (existing.inventoryDeducted) {
      console.log(`[Inventory] Order ${id} already had inventory deducted — skipping`);
      // Still allow the payment to proceed, just skip inventory
    }

    // Guard: prevent double-pay
    if (existing.status === OrderStatus.PAID) {
      res.status(409).json({ error: "Order is already paid" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // Re-read order inside transaction to get locked inventoryDeducted value
      const lockedOrder = await tx.order.findUnique({
        where: { id },
        select: { id: true, inventoryDeducted: true },
      });
      if (!lockedOrder) throw new Error('Order not found inside transaction');

      const order = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.PAID,
          billingRequested: false,
          inventoryDeducted: true,
        },
        include: orderInclude,
      });

      // ========================================
      // INVENTORY DEDUCTION FOR LIQUOR ITEMS
      // ========================================

      // Filter liquor items that haven't been removed from bill
      const liquorItems = order.items.filter(
        item =>
          item.menuType === 'LIQUOR' &&
          !item.removedFromBill
      );

      const inventorySocketUpdates: Array<{
        itemId: string;
        currentStock: any;
        isLowStock: boolean;
        name: string;
        reorderLevel: any;
        unitOfMeasure: string;
      }> = [];

      // Only deduct inventory once, ever — re-check on lockedOrder to prevent race condition
      if (!lockedOrder.inventoryDeducted) {
        // Batch-fetch all inventory items at once (replaces N+1 individual lookups)
        const liquorMenuItemIds = liquorItems.map((i) => i.menuItemId);
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

        // Process each liquor item
        for (const [menuItemId, totalQuantity] of aggregatedLiquorItems.entries()) {
          const inventoryItem = inventoryMap.get(menuItemId) ?? null;

          if (!inventoryItem) {
            // No inventory tracking for this item, skip
            console.log(`[Inventory] No tracking for menuItem ${menuItemId}`);
            continue;
          }

          // Determine ml to deduct based on item type
          const isBeer = isBeerItem(inventoryItem.menuItem);
          const isSpirit = !isBeer && inventoryItem.menuItem.variants.some(
            (v: { name: string }) => v.name.trim().toLowerCase() === '30ml'
          );
          const mlPerUnit = isBeer ? 650 : isSpirit ? BAR_UNIT_ML : Number(inventoryItem.bottleSize);
          const mlConsumed = mlPerUnit; // per unit sold

          // Total ML for this item (serving size * quantity ordered)
          const totalMl = mlConsumed * totalQuantity;

          // Check if sufficient stock exists
          if (Number(inventoryItem.currentStock) < totalMl) {
            throw new Error(`Insufficient stock for ${inventoryItem.menuItem?.name ?? 'Unknown Item'}: available ${inventoryItem.currentStock}ml, required ${totalMl}ml`);
          }

          // Deduct stock
          const updatedItem = await tx.inventoryItem.update({
            where: { id: inventoryItem.id },
            data: {
              currentStock: {
                decrement: totalMl,
              },
            },
          });

          // Record transaction
          await tx.inventoryTransaction.create({
            data: {
              restaurantId: existing.restaurantId,
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

          // Write snapshot
          const snapshotDate = getKolkataDateString(); // YYYY-MM-DD
          await tx.dailyInventorySnapshot.upsert({
            where: {
              restaurantId_snapshotDate_itemId: {
                restaurantId: existing.restaurantId,
                snapshotDate,
                itemId: inventoryItem.id,
              }
            },
            create: {
              restaurantId: existing.restaurantId,
              itemId: inventoryItem.id,
              snapshotDate,
              itemName: inventoryItem.menuItem.name,
              purchased: 0,
              sold: totalMl,
              wastage: 0,
              adjusted: 0,
              openingStock: inventoryItem.currentStock, // Initial opening stock
              closingStock: updatedItem.currentStock,
            },
            update: {
              sold: { increment: totalMl },
              closingStock: updatedItem.currentStock,
            }
          });

          console.log(
            `[Inventory] Deducted ${totalMl}ml of ${inventoryItem.menuItem.name} ` +
            `(${inventoryItem.currentStock}ml → ${updatedItem.currentStock}ml)`
          );

          // Collect for emission AFTER transaction commits (moved out of setTimeout)
          inventorySocketUpdates.push({
            itemId: updatedItem.id,
            currentStock: updatedItem.currentStock,
            isLowStock: Number(updatedItem.currentStock) <= Number(updatedItem.reorderLevel),
            name: inventoryItem.menuItem.name,
            reorderLevel: updatedItem.reorderLevel,
            unitOfMeasure: updatedItem.unitOfMeasure,
          });
        }
      }

      // ========================================
      // RESET TABLE TO AVAILABLE
      // ========================================
      const table = await tx.table.update({
        where: { id: existing.tableId },
        data: {
          status: TableStatus.AVAILABLE,
          workflowStatus: "Free",
          captainId: null,
          guests: 0,
          sessionStartedAt: null,
          currentBill: 0,
          kotHistory: [],
        },
        include: tableInclude,
      });

      return { order, table, inventorySocketUpdates };
    }, { timeout: 15000, maxWait: 20000 });

    // Emit inventory socket events AFTER transaction commits
    for (const update of result.inventorySocketUpdates) {
      getIo().to(existing.restaurantId).emit("inventory:updated", {
        restaurantId: existing.restaurantId,
        item: {
          id: update.itemId,
          name: update.name,
          currentStock: update.currentStock,
          reorderLevel: update.reorderLevel,
          unitOfMeasure: update.unitOfMeasure,
        }
      });
      if (update.isLowStock) {
        getIo().to(existing.restaurantId).emit("inventory:low_stock", {
          restaurantId: existing.restaurantId,
          item: {
            id: update.itemId,
            name: update.name,
            currentStock: update.currentStock,
            reorderLevel: update.reorderLevel,
            unitOfMeasure: update.unitOfMeasure,
          },
        });
      }
    }

    emitToRestaurant(existing.restaurantId, "order:paid", {
      orderId: result.order.id,
      tableId: result.table.id,
    });
    emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });

    // Emit print job so the Cashier PrintStation auto-prints the receipt
    const formattedTableNumber3 = result.table.number
      ? formatTableNumber(result.table.number, existing.restaurantId, result.table.section?.name, (result.table as any)?.sectionTag, ctx)
      : existing.tableId;

    const restaurantForBill = await prisma.restaurant.findUnique({
      where: { id: existing.restaurantId },
      select: {
        name: true,
        receiptHeader: true,
        receiptSubHeader: true,
        address: true,
        phone: true,
        gstin: true,
      },
    });

    const billEscposData = buildBill({
      tableNumber: formattedTableNumber3,
      items: ((result.order as unknown as { items?: Array<{ name: string; price: number; quantity: number; menuType?: string }> }).items ?? []).map((i) => ({
        name: i.name,
        price: Number(i.price),
        quantity: i.quantity,
        menuType: (i.menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD') as "FOOD" | "LIQUOR",
      })),
      totalAmount: Number(result.order.totalAmount),
      restaurant: restaurantForBill as BillPrintRestaurant | undefined,
      sectionTag: (result.table as any)?.sectionTag || null,
      gstCategory: ctx.gstCategory,
      pricesIncludeGst: ctx.pricesIncludeGst,
    });

    emitToRestaurant(existing.restaurantId, "print_job", {
      type: "BILL",
      data: {
        orderId: result.order.id,
        tableNumber: formattedTableNumber3,
        restaurantId: existing.restaurantId,
        paymentMethod: paymentMethod ?? "CASH",
        timestamp: new Date().toISOString(),
        items: (result.order as unknown as { items?: Array<{ name: string; price: number; quantity: number }> }).items ?? [],
        totalAmount: result.order.totalAmount,
        escposData: billEscposData,
        gstCategory: ctx.gstCategory,
        pricesIncludeGst: ctx.pricesIncludeGst,
      },
    });

    console.log(`[PAY] Order ${id} marked PAID via ${paymentMethod ?? "CASH"} — print_job emitted`);
    res.json(result.order);
  } catch (error: any) {
    console.error("[PAY] Failed:", error);
    if (error.message && error.message.includes("Insufficient stock")) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: "Failed to mark order as paid" });
  }
});

// ── PATCH /:id/cancel-item ────────────────────────────────────────────────────
// Body: { orderItemId: string, cancelledBy: string, cancelQuantity?: number, tableNumber?: number|string }
// Marks a single OrderItem as removed, recalculates the order and table totals,
// and emits a CANCEL_KOT print_job so the bar staff know to stop making it.
router.patch("/:id/cancel-item", invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  const id = req.params.id as string;
  await assertOrderBelongsToTenant(id, req.user?.restaurantId);
  const { orderItemId, cancelledBy, cancelQuantity, tableNumber, requestId, isExtraTable } = req.body as {
    orderItemId?: string;
    cancelledBy?: string;
    cancelQuantity?: number;
    tableNumber?: string | number;
    requestId?: string;
    isExtraTable?: boolean;
  };

  if (!orderItemId || !cancelledBy) {
    return res.status(400).json({ error: "orderItemId and cancelledBy are required" });
  }

  // Idempotency: if same requestId already processed, return 200 immediately
  if (requestId) {
    const existingOrder = await prisma.order.findUnique({
      where: { id: req.params.id as string },
      select: { lastRequestId: true },
    });
    if (existingOrder?.lastRequestId === requestId) {
      return res.json({ message: 'Already processed' });
    }
  }

  const quantityToCancel = Math.max(1, Math.round(Number(cancelQuantity ?? 1)));
  if (!Number.isFinite(quantityToCancel) || quantityToCancel <= 0) {
    return res.status(400).json({ error: "cancelQuantity must be a positive number" });
  }

  try {
    // 1. Load the order with all items and the table
    const existing = await prisma.order.findUnique({
      where: { id: req.params.id as string },
      include: {
        items: { include: { menuItem: { include: { category: { select: { printerTarget: true } } } } } },
        table: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
      return res.status(409).json({ error: "Only active orders can be modified" });
    }

    const ctx = await resolveTenantContext(existing.restaurantId);

    // 2. Locate the specific item
    const cancelledItem = existing.items.find((i) => i.id === orderItemId);
    if (!cancelledItem) {
      return res.status(404).json({ error: "Item not found in this order" });
    }
    if (cancelledItem.removedFromBill) {
      return res.status(409).json({ error: "Item already cancelled" });
    }
    if (quantityToCancel > cancelledItem.quantity) {
      return res.status(400).json({ error: "cancelQuantity exceeds remaining quantity" });
    }

    const printerTarget = (cancelledItem as any)?.menuItem?.category?.printerTarget || null;

    // 3. Transaction: mark item cancelled + recalculate totals
    const { updatedOrder, updatedTable } = await prisma.$transaction(
      async (tx) => {
        // a. Mark the item
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

        // b. Recalculate order total from surviving items
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

        // c. Update Order total + reset billing state so reprinting works
        const order = await tx.order.update({
          where: { id: existing.id },
          data: {
            totalAmount: newTotal,
            // Reset billing state so cashier can reprint the bill cleanly
            status: existing.status === OrderStatus.BILLING_REQUESTED
              ? OrderStatus.CONFIRMED
              : existing.status,
            billingRequested: false,
            billingRequestedAt: null,
            lastRequestId: requestId || undefined,
          },
          include: orderIncludeWithCancelled,
        });

        // d. For extra tables, do not mutate the parent table — extra table state is client-side.
        //    For regular tables, update currentBill/status and patch kotHistory so cancelled items
        //    survive a captain page refresh.
        let table;
        if (isExtraTable) {
          table = await tx.table.findUnique({ where: { id: existing.tableId }, include: tableInclude });
        } else {
          const kotHistoryRaw = Array.isArray((existing.table as any).kotHistory)
            ? (existing.table as any).kotHistory as any[]
            : [];
          const tableUpdateData: Record<string, any> = { currentBill: allCancelled ? 0 : newTotal };
          if (isFullCancel) {
            tableUpdateData.kotHistory = kotHistoryRaw.map((kot: any) => ({
              ...kot,
              items: (kot.items ?? []).map((i: any) =>
                i.orderItemId === orderItemId ? { ...i, s: 'Cancelled' } : i
              ),
            }));
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

        return { updatedOrder: order, updatedTable: table };
      },
      { timeout: 15000, maxWait: 20000 }
    );

    // 5. Emit socket events (use transaction-returned data to avoid extra DB round-trips)
    //    The transaction now returns the final table state (including auto-free), so clients
    //    receive the correct AVAILABLE/OCCUPIED status immediately.
    //    For extra tables, do not emit table:updated — would overwrite the parent table state.
    emitToRestaurant(existing.restaurantId, "order:updated", { order: updatedOrder, isExtraTable: !!isExtraTable });
    if (!isExtraTable && updatedTable) {
      emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable });
    }
    const formattedTableNumber4 = tableNumber
      ? formatTableNumber(tableNumber, existing.restaurantId, undefined, undefined, ctx)
      : (existing.table.number ? formatTableNumber(existing.table.number, existing.restaurantId, undefined, (existing.table as any)?.sectionTag, ctx) : existing.tableId);

    const cancelRestaurant = await prisma.restaurant.findUnique({
      where: { id: existing.restaurantId },
      select: { name: true, receiptHeader: true },
    });

    const cancelItem = {
      name: cancelledItem.name,
      quantity: quantityToCancel,
      menuType: cancelledItem.menuType === 'LIQUOR' ? 'BAR' : 'FOOD',
    };

    const cancelEscposData = buildCancelKOT({
      tableNumber: formattedTableNumber4,
      cancelledBy,
      timestamp: new Date().toISOString(),
      items: [cancelItem],
      sectionName: updatedTable?.section?.name || "Main Hall",
      sectionTag: (updatedTable as any)?.sectionTag || null,
      restaurant: cancelRestaurant as BillPrintRestaurant | undefined,
    });

    emitToRestaurant(existing.restaurantId, "print_job", {
      type: "CANCEL_KOT",
      data: {
        tableNumber: formattedTableNumber4,
        cancelledBy,
        restaurantId: existing.restaurantId,
        sectionTag: (updatedTable as any)?.sectionTag || null,
        sectionName: updatedTable?.section?.name || "Main Hall",
        timestamp: new Date().toISOString(),
        requestId: requestId || null,
        item: cancelItem,
        items: [cancelItem],
        printerTarget,
        escposData: cancelEscposData,
      },
    });

    return res.json(updatedOrder);
  } catch (error) {
    console.error("[cancel-item]", error);
    return res.status(500).json({ error: "Failed to cancel item" });
  }
});

// ── PATCH /:id/cancel-items (BATCH) ──────────────────────────────────────────
// Cancels multiple items in one transaction → emits ONE CANCEL_KOT → one print slip
router.patch("/:id/cancel-items", invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  const id = req.params.id as string;
  await assertOrderBelongsToTenant(id, req.user?.restaurantId);
  const { items: itemsToCancel, cancelledBy, tableNumber, requestId, isExtraTable } = req.body as {
    items?: Array<{ orderItemId: string; cancelQuantity?: number }>;
    cancelledBy?: string;
    tableNumber?: string | number;
    requestId?: string;
    isExtraTable?: boolean;
  };

  if (!itemsToCancel || !Array.isArray(itemsToCancel) || itemsToCancel.length === 0)
    return res.status(400).json({ error: "items array is required and must be non-empty" });
  if (!cancelledBy)
    return res.status(400).json({ error: "cancelledBy is required" });

  if (requestId) {
    const existingOrder = await prisma.order.findUnique({
      where: { id: req.params.id as string },
      select: { lastRequestId: true },
    });
    if (existingOrder?.lastRequestId === requestId)
      return res.json({ message: "Already processed" });
  }

  try {
    const existing = await prisma.order.findUnique({
      where: { id: req.params.id as string },
      include: {
        items: { include: { menuItem: { include: { category: { select: { printerTarget: true } } } } } },
        table: true,
      },
    });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (!ACTIVE_ORDER_STATUSES.includes(existing.status))
      return res.status(409).json({ error: "Order is not active" });

    const ctx = await resolveTenantContext(existing.restaurantId);

    const cancelledItemsMeta: Array<{ name: string; quantity: number; menuType: string; printerTarget: string | null }> = [];
    const fullyCancelledIds = new Set<string>();

    const printerTargetMap = new Map(
      existing.items.map(i => [i.id, (i as any)?.menuItem?.category?.printerTarget ?? null])
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
        });
      }

      const allItems = await tx.orderItem.findMany({ where: { orderId: existing.id } });
      const allCancelled = allItems.every((i) => i.removedFromBill);
      const newTotal = allItems
        .filter((i) => !i.removedFromBill && i.quantity > 0)
        .reduce((sum, i) => sum.add(new Prisma.Decimal(i.price).mul(new Prisma.Decimal(i.quantity))), new Prisma.Decimal(0));

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

      // For extra tables, do not mutate the parent table. For regular tables, patch kotHistory
      // and update table status in the same transaction.
      let table;
      if (isExtraTable) {
        table = await tx.table.findUnique({ where: { id: existing.tableId }, include: tableInclude });
      } else {
        const currentTable = await tx.table.findUnique({ where: { id: existing.tableId }, select: { kotHistory: true } });
        const kotHistoryRaw = Array.isArray(currentTable?.kotHistory) ? currentTable.kotHistory as any[] : [];
        const updatedKotHistory = fullyCancelledIds.size > 0
          ? kotHistoryRaw.map((kot: any) => ({
              ...kot,
              items: (kot.items ?? []).map((i: any) =>
                fullyCancelledIds.has(i.orderItemId) ? { ...i, s: 'Cancelled' } : i
              ),
            }))
          : kotHistoryRaw;

        const tableUpdateData: Record<string, any> = {
          currentBill: allCancelled ? 0 : newTotal,
          kotHistory: updatedKotHistory as any,
        };
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

    // Emit the transaction-returned table, which already reflects the final AVAILABLE/OCCUPIED state.
    // For extra tables, do not emit table:updated — would overwrite the parent table state.
    emitToRestaurant(existing.restaurantId, "order:updated", { order: updatedOrder, isExtraTable: !!isExtraTable });
    if (!isExtraTable && updatedTable) emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable });

    if (cancelledItemsMeta.length > 0) {
      const formattedTN = tableNumber
        ? formatTableNumber(tableNumber, existing.restaurantId, undefined, undefined, ctx)
        : (existing.table.number ? formatTableNumber(existing.table.number, existing.restaurantId, undefined, (existing.table as any)?.sectionTag, ctx) : existing.tableId);

      const batchCancelRestaurant = await prisma.restaurant.findUnique({
        where: { id: existing.restaurantId },
        select: { name: true, receiptHeader: true },
      });

      const batchCancelEscposData = buildCancelKOT({
        tableNumber: formattedTN,
        cancelledBy,
        timestamp: new Date().toISOString(),
        items: cancelledItemsMeta,
        sectionName: updatedTable?.section?.name || "Main Hall",
        sectionTag: (updatedTable as any)?.sectionTag || null,
        restaurant: batchCancelRestaurant as BillPrintRestaurant | undefined,
      });

      emitToRestaurant(existing.restaurantId, "print_job", {
        type: "CANCEL_KOT",
        data: {
          tableNumber: formattedTN,
          cancelledBy,
          restaurantId: existing.restaurantId,
          sectionTag: (updatedTable as any)?.sectionTag || null,
          sectionName: updatedTable?.section?.name || "Main Hall",
          timestamp: new Date().toISOString(),
          requestId: requestId || null,
          items: cancelledItemsMeta,
          item: cancelledItemsMeta[0],
          printerTarget: cancelledItemsMeta[0]?.printerTarget || null,
          escposData: batchCancelEscposData,
        },
      });
    }

    return res.json(updatedOrder);
  } catch (error) {
    console.error("[cancel-items batch]", error);
    return res.status(500).json({ error: "Failed to cancel items" });
  }
});

// ─── Terminate Table Session ──────────────────────────────────────────────
router.post("/terminate-table/:tableId", invalidateCache(["tables:*", "sections:list:*", "venue:sections:*"]), async (req, res) => {
  try {
    const tableId = req.params.tableId as string;
    const restaurantId = req.user?.restaurantId;
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
      emitToRestaurant(restaurantId, "order:updated", { order: result.order });
    }
    if (restaurantId) {
      emitToRestaurant(restaurantId, "table:updated", { table: result.table });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[terminate-table]", error);
    res.status(500).json({ error: "Failed to terminate table session" });
  }
});

export default router;
