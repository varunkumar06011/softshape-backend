import { OrderStatus, Prisma, TableStatus, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { randomUUID } from "crypto";
import { getIo } from "../socket";
import { getKolkataDateString } from "../utils/date";
import { isBeerItem } from "../utils/itemHelpers";
import prisma from "../lib/prisma";

const router = Router();
const BAR_UNIT_ML = 30;
const BAR_FULL_BOTTLE_MULTIPLIER = 25;

const CAPTAIN_NAMES: Record<string, string> = {
  'C1': 'Ajay Kumar',
  'C2': 'Raja Behera',
  'C3': 'Sagar',
  'C4': 'Durga Prasad',
  'C5': 'Subbaiah',
  'C6': 'Happy',
};

const getCaptainName = (id?: string): string | undefined => {
  if (!id) return undefined;
  return CAPTAIN_NAMES[id] || undefined;
};

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
    where: { removedFromBill: false },
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
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
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
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
) {
  const kotNumber = await getNextKotNumber(restaurantId, tx);
  const now = new Date();
  return {
    id: String(kotNumber).padStart(2, '0'),   // "01", "02", "03" — resets daily (bill has "KOT NO -" prefix)
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
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
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
    const enriched = {
      restaurantId,
      ...payload,
      data: { ...(payload.data as Record<string, unknown>), eventId: randomUUID() },
    };
    getIo().to(printRoom).emit(eventName, enriched);
  } else {
    getIo().to(restaurantId).emit(eventName, { restaurantId, ...payload });
  }
}


/**
 * Format table number with prefix based on restaurantId
 * @param tableNumber - The table number (e.g., 3, "5")
 * @param restaurantId - The restaurant ID ("bar-001" or "restaurant-001")
 * @param sectionName - Optional section name for venue-001 formatting
 * @returns Formatted table number (e.g., "B3" for bar, "T5" for restaurant, "CONF-1" for venue)
 */
function formatTableNumber(tableNumber: number | string, restaurantId: string, sectionName?: string): string {
  if (tableNumber === 999 || String(tableNumber) === '999') return 'Vijay Kumar (Counter)';
  if (restaurantId === 'venue-001' && sectionName) {
    const sec = sectionName.toLowerCase();
    if (sec.includes('conference') && (sec.includes('1') || sec.includes('conf1'))) return 'Conference Hall';
    if (sec.includes('conference') && (sec.includes('2') || sec.includes('conf2'))) return 'Conference Hall';
    if (sec.includes('conference')) return 'Conference Hall';
    if (sec.includes('pdr')) return `PDR ${tableNumber}`;
    if (sec.includes('room')) return `Room ${tableNumber}`;
    if (sec.includes('parcel')) return 'Parcel';
    return `V${tableNumber}`;
  }
  const prefix = restaurantId === 'bar-001' ? 'B' : 'T';
  return `${prefix}${tableNumber}`;
}

// ── Daily-sequential Bill counter ──────────────────────────────────────────
// Must be called inside a Prisma transaction (tx) so the increment is atomic.
async function getNextBillNumber(
  restaurantId: string,
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
): Promise<number> {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const counterDate = nowIST.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const counter = await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { billCount: { increment: 1 } },
    create: { restaurantId, counterDate, billCount: 1 },
  });

  return counter.billCount;
}

function formatBillNumber(_date: Date, billNumber: number): string {
  // Plain incrementing number per day: 1, 2, 3... resets via DailyCounter
  return String(billNumber);
}

router.post("/", async (req, res) => {
  console.log("=== INCOMING ORDER ===");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const { tableId, restaurantId } = req.body as {
      tableId?: string;
      restaurantId?: string;
    };
    const tenantId = restaurantId?.trim();
    const items = normalizeItems(req.body.items);

    if (!tableId?.trim() || !tenantId) {
      res.status(400).json({ error: "tableId and restaurantId are required" });
      return;
    }

    // Explicit validation to catch invalid menuItemIds before Prisma fails
    const ids = items.map(i => i.menuItemId);
    const foundMenuItems = await prisma.menuItem.findMany({
      where: { id: { in: ids } },
      include: { category: { select: { name: true, printerTarget: true } } },
    });
    // Build a map of menuItemId → { name, printerTarget } for print_job payloads
    const menuItemCategoryMap = new Map(
      foundMenuItems.map(m => [m.id, { name: m.category?.name || 'Unknown', printerTarget: m.category?.printerTarget || null }])
    );
    const foundIds = new Set(foundMenuItems.map(m => m.id));
    const missing = ids.filter(id => !foundIds.has(id));

    if (missing.length) {
      console.error("Invalid menuItemIds — not found in DB:", missing);
      console.error("Received IDs:", ids);
      console.error("Found IDs in DB:", Array.from(foundIds));
      res.status(400).json({
        error: "Invalid menuItemIds",
        missing,
      });
      return;
    }

    // Read-only pre-check — outside the transaction to avoid holding the lock
    const table = await prisma.table.findFirst({
      where: { id: tableId, restaurantId: tenantId },
    });
    if (!table) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    // ── Atomic writes only ─────────────────────────────────────────────────
    // Keep only the two writes inside the transaction.
    // The expensive tableInclude (orders → items) is fetched AFTER commit.
    const savedOrder = await prisma.$transaction(
      async (tx) => {
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

        const newKotHistory = await appendKotHistory(table.kotHistory, order.items, tenantId, tx);
        await tx.table.update({
          where: { id: tableId },
          data: {
            status: TableStatus.OCCUPIED,
            workflowStatus: "Preparing",
            currentBill: { increment: order.totalAmount },
            kotHistory: newKotHistory,
          },
        });

        return { order, kotHistory: newKotHistory };
      },
      { timeout: 15000, maxWait: 5000 }
    );
    // ───────────────────────────────────────────────────────────────────────

    // Re-fetch the full table (with nested orders/section) AFTER commit
    // so we never hold the transaction open for an expensive read.
    const updatedTable = await prisma.table.findUnique({
      where: { id: tableId },
      include: tableInclude,
    });

    emitToRestaurant(tenantId, "order:created", { order: savedOrder.order });
    if (updatedTable) emitToRestaurant(tenantId, "table:updated", { table: updatedTable });

    // ── print_job events → cashier PC's /print-station handles QZ Tray ────
    // Captain's device never needs QZ Tray installed.
    const allItems = (savedOrder.order as unknown as { items?: Array<{ name: string; price: number; quantity: number; menuType?: string; menuItemId?: string; notes?: string | null }> }).items ?? [];
    const mappedItems = allItems.map((i) => {
      const cat = menuItemCategoryMap.get(i.menuItemId || '') || { name: 'Unknown', printerTarget: null };
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
    const latestKot = savedOrder.kotHistory[savedOrder.kotHistory.length - 1] as { id?: string } | undefined;
    const formattedTableNumber = updatedTable?.number
      ? formatTableNumber(updatedTable.number, tenantId, updatedTable.section?.name)
      : "UNKNOWN";
    const basePayload = {
      kotId: latestKot?.id ?? "??",
      tableNumber: formattedTableNumber,
      restaurantId: tenantId,
      sectionTag: (updatedTable as any)?.sectionTag || null,
      sectionName: updatedTable?.section?.name || "Main Hall",
      captainName: getCaptainName(updatedTable?.captainId || undefined),
      timestamp: new Date().toISOString(),
    };

    // For venue-001 (family restaurant / parcel), route EVERYTHING through KOT
    // so PrintStation can split by beverage category. Bar and old restaurant keep
    // the classic food→KOT / liquor→BAR_KOT split.
    if (tenantId === 'venue-001') {
      if (mappedItems.length > 0) {
        emitToRestaurant(tenantId, "print_job", { type: "KOT", data: { ...basePayload, items: mappedItems } });
      }
    } else {
      const foodItems = mappedItems.filter((i) => i.menuType !== "LIQUOR");
      const liquorItems = mappedItems.filter((i) => i.menuType === "LIQUOR");
      if (foodItems.length > 0) {
        emitToRestaurant(tenantId, "print_job", { type: "KOT", data: { ...basePayload, items: foodItems } });
      }
      if (liquorItems.length > 0) {
        emitToRestaurant(tenantId, "print_job", { type: "BAR_KOT", data: { ...basePayload, items: liquorItems } });
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    res.status(201).json({
      ...savedOrder.order,
      kotHistory: savedOrder.kotHistory
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to create order";
    res.status(message.startsWith("Invalid") || message.includes("items") ? 400 : 500).json({ error: message });
  }
});


router.get("/", async (req, res) => {
  try {
    const restaurantId = typeof req.query.restaurantId === "string" ? req.query.restaurantId.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";

    if (!restaurantId) {
      res.status(400).json({ error: "restaurantId is required" });
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
    const { tableId } = req.params;
    const order = await prisma.order.findFirst({
      where: {
        tableId,
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

router.patch("/:id/items", async (req, res) => {
  try {
    const { id } = req.params;
    const { requestId } = req.body as { requestId?: string };
    const items = normalizeItems(req.body.items);

    // Fetch category names for print_job beverage/food split
    const itemIds = items.map(i => i.menuItemId);
    const menuItemsWithCat = await prisma.menuItem.findMany({
      where: { id: { in: itemIds } },
      include: { category: { select: { name: true, printerTarget: true } } },
    });
    const menuItemCategoryMap = new Map(
      menuItemsWithCat.map(m => [m.id, { name: m.category?.name || 'Unknown', printerTarget: m.category?.printerTarget || null }])
    );

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { items: true, table: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
      res.status(409).json({ error: "Only active orders can be updated" });
      return;
    }

    if (requestId && existing.lastRequestId === requestId) {
      res.json({ order: existing, kotHistory: existing.table.kotHistory });
      return;
    }

    // ── Atomic writes only ─────────────────────────────────────────────────
    const updatedOrder = await prisma.$transaction(
      async (tx) => {
        // Each KOT is a fresh slice — always create new rows, never merge with old ones.
        // This prevents already-sent items from re-appearing in the next KOT print.
        for (const item of items) {
          await tx.orderItem.create({
            data: {
              orderId: id,
              menuItemId: item.menuItemId,
              name: item.name,
              price: item.price,
              quantity: item.quantity,
              notes: item.notes,
              menuType: item.menuType,
            },
          });
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

        const newKotHistory = await appendKotHistory(existing.table.kotHistory, itemsWithIds, existing.restaurantId, tx);
        await tx.table.update({
          where: { id: existing.tableId },
          data: {
            status: existing.status === OrderStatus.BILLING_REQUESTED ? TableStatus.BILLING_REQUESTED : TableStatus.OCCUPIED,
            workflowStatus: existing.status === OrderStatus.BILLING_REQUESTED ? "Waiting Bill" : "Preparing",
            currentBill: order.totalAmount,
            kotHistory: newKotHistory,
          },
        });

        return { order, kotHistory: newKotHistory };
      },
      { timeout: 15000, maxWait: 5000 }
    );
    // ───────────────────────────────────────────────────────────────────────

    // Re-fetch the full table after commit (outside the lock)
    const updatedTable = await prisma.table.findUnique({
      where: { id: existing.tableId },
      include: tableInclude,
    });

    emitToRestaurant(existing.restaurantId, "order:updated", { order: updatedOrder.order });
    if (updatedTable) emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable });

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

    const latestKot2 = updatedOrder.kotHistory[updatedOrder.kotHistory.length - 1] as { id?: string } | undefined;
    const formattedTableNumber2 = updatedTable?.number
      ? formatTableNumber(updatedTable.number, existing.restaurantId, updatedTable.section?.name)
      : "UNKNOWN";
    const basePayload = {
      kotId: latestKot2?.id ?? "??",
      tableNumber: formattedTableNumber2,
      restaurantId: existing.restaurantId,
      sectionTag: (updatedTable as any)?.sectionTag || null,
      sectionName: updatedTable?.section?.name || "Main Hall",
      captainName: getCaptainName(updatedTable?.captainId || undefined),
      timestamp: new Date().toISOString(),
    };

    if (existing.restaurantId === 'venue-001') {
      if (mappedItems2.length > 0) {
        emitToRestaurant(existing.restaurantId, "print_job", { type: "KOT", data: { ...basePayload, items: mappedItems2 } });
      }
    } else {
      const foodItems = mappedItems2.filter((i) => i.menuType !== "LIQUOR");
      const liquorItems = mappedItems2.filter((i) => i.menuType === "LIQUOR");
      if (foodItems.length > 0) {
        emitToRestaurant(existing.restaurantId, "print_job", { type: "KOT", data: { ...basePayload, items: foodItems } });
      }
      if (liquorItems.length > 0) {
        emitToRestaurant(existing.restaurantId, "print_job", { type: "BAR_KOT", data: { ...basePayload, items: liquorItems } });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    res.json({
      order: {
        ...updatedOrder.order,
        kotHistory: updatedOrder.kotHistory
      }
    });

  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to update order items";
    res.status(message.startsWith("Invalid") || message.includes("items") ? 400 : 500).json({ error: message });
  }
});


router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };

    if (!status || !Object.values(OrderStatus).includes(status as OrderStatus)) {
      res.status(400).json({ error: "Invalid status", validStatuses: Object.values(OrderStatus) });
      return;
    }

    const order = await prisma.order.update({
      where: { id },
      data: { status: status as OrderStatus },
      include: orderInclude,
    });

    emitToRestaurant(order.restaurantId, "order:updated", { order });
    res.json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

router.post("/:id/request-billing", async (req, res) => {
  try {
    const { id } = req.params;

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
    });

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

router.patch("/:id/settle", async (req, res) => {
  try {
    const { id } = req.params;
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
      const validItems = allItems.filter(i => !i.removedFromBill);
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
    });

    emitToRestaurant(existing.restaurantId, "order:updated", { order: result.order });
    emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });
    res.json(result.order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to settle order items" });
  }
});

router.patch("/:id/bill-edit", async (req, res) => {
  try {
    const { id } = req.params;
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

        for (const item of itemsToEdit) {
          const requestedQuantity = Math.max(1, Math.round(Number(editQuantities?.[item.id] ?? item.quantity)));
          if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
            throw new Error(`Invalid edit quantity for item ${item.id}`);
          }
          if (requestedQuantity > item.quantity) {
            throw new Error(`edit quantity exceeds remaining quantity for item ${item.id}`);
          }

          const isFullRemoval = requestedQuantity >= item.quantity;
          await tx.orderItem.update({
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
        }
      }

      // 2. Add new cashier-added items
      if (addedItems && addedItems.length > 0) {
        for (const item of addedItems) {
          const menuItemId = item.menuItemId?.trim();
          const name = item.name?.trim();
          const price = Number(item.price);
          const quantity = Math.round(Number(item.quantity));
          const menuType: "FOOD" | "LIQUOR" = item.menuType === "LIQUOR" ? "LIQUOR" : "FOOD";

          if (!menuItemId || !name || !Number.isFinite(price) || price < 0 || quantity <= 0) continue;

          await tx.orderItem.create({
            data: {
              orderId: id,
              menuItemId,
              name,
              price,
              quantity,
              notes: typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : null,
              menuType,
              addedByCashier: true,
            },
          });
        }
      }

      // 3. Recalculate total from all non-removed items
      const allItems = await tx.orderItem.findMany({ where: { orderId: id } });
      const validItems = allItems.filter(i => !i.removedFromBill);
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
    }, { timeout: 15000, maxWait: 5000 });

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
    const { id: orderId } = req.params;
    const { restaurantId } = req.query as { restaurantId: string };

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
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
        // Generate new bill number — use synthetic counter keys for venue-001 sub-sections
        const tableSectionTag = (order.table as any)?.sectionTag || null;
        let counterKey = restaurantId;
        if (restaurantId === 'venue-001' && tableSectionTag === 'venue-family-restaurant') {
          counterKey = 'venue-001-family';
        } else if (restaurantId === 'venue-001' && tableSectionTag === 'venue-restaurant-parcel') {
          counterKey = 'venue-001-parcel';
        }
        const billCount = await getNextBillNumber(counterKey, tx);
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

      // Update table status
      const updatedTable = await tx.table.update({
        where: { id: order.tableId },
        data: {
          status: TableStatus.BILLING_REQUESTED,
          workflowStatus: "Waiting Bill",
        },
        include: {
          section: true
        }
      });

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

      // Apply discount if set on table
      let discount = null;
      let discountAmount = 0;
      if (updatedTable.discount && Number(updatedTable.discount) > 0) {
        const discountPercent = Number(updatedTable.discount);
        discountAmount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
        discount = { percent: discountPercent, amount: discountAmount };
      }

      // Tax calculation (CGST + SGST on food only, AFTER discount) - WITH ROUNDING
      const taxableAmount = foodSubtotal - (discount ? discountAmount * (foodSubtotal / subtotal) : 0);
      const cgst = Math.round(taxableAmount * 0.025 * 100) / 100;  // 2.5%
      const sgst = Math.round(taxableAmount * 0.025 * 100) / 100;  // 2.5%
      const tax = cgst + sgst;

      const grandTotal = Math.round((subtotal - discountAmount + tax) * 100) / 100;

      // Get all KOT numbers from the session
      const kotHistory = (updatedTable.kotHistory as Array<{ id?: string }>) || [];
      const kotNumbers = kotHistory
        .map(k => k.id)
        .filter(Boolean);

      // Format table number — pass sectionName so venue tables get the correct label
      const formattedTableNumber = formatTableNumber(
        updatedTable.number,
        restaurantId,
        updatedTable.section?.name   // ← ADD THIS
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
                const key = item.name;
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
            subtotal,
            discount,
            tax: { cgst, sgst, total: tax },
            grandTotal,
            section: updatedTable.section?.name || "Main Hall",
            itemCount: (() => {
              const grouped = activeItems.reduce((acc, item) => {
                const key = item.name;
                if (!acc[key]) {
                  acc[key] = true;
                }
                return acc;
              }, {} as Record<string, boolean>);
              return Object.keys(grouped).length;
            })(),
            qtyCount: activeItems.reduce((sum, item) => sum + item.quantity, 0)
          }
        },
        formattedTableNumber,
        grandTotal
      };
    });

    // 5. EMIT SOCKET EVENTS AFTER TRANSACTION COMMITS
    // Emit print job → dedicated print room (only PrintStation subscribes)
    emitToRestaurant(restaurantId, "print_job", result.billData);

    // Emit billing requested event
    emitToRestaurant(restaurantId, "billing:requested", {
      orderId: result.order.id,
      tableId: result.table.id,
      tableNumber: result.formattedTableNumber,
      totalAmount: result.grandTotal
    });

    // Emit table updated event
    emitToRestaurant(restaurantId, "table:updated", { table: result.table });

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

// POST /api/orders/:id/settle - Complete payment settlement (WITHOUT printing bill)
router.post("/:id/settle", async (req, res) => {
  try {
    const { id: orderId } = req.params;
    const { restaurantId } = req.query as { restaurantId: string };
    const { paymentMethod } = req.body;

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
    const foodItems = order.items.filter(item => item.menuItem.menuType === "FOOD");
    const liquorItems = order.items.filter(item => item.menuItem.menuType === "LIQUOR");

    const foodSubtotal = foodItems.reduce((sum, item) =>
      sum + (Number(item.price) * item.quantity), 0
    );
    const liquorSubtotal = liquorItems.reduce((sum, item) =>
      sum + (Number(item.price) * item.quantity), 0
    );
    const subtotal = foodSubtotal + liquorSubtotal;

    const discountPercent = order.table.discount ? Number(order.table.discount) : 0;
    const discountAmount = discountPercent > 0
      ? Math.round(subtotal * (discountPercent / 100) * 100) / 100
      : 0;

    const taxableFood = foodSubtotal - (discountAmount > 0 && subtotal > 0 ? discountAmount * (foodSubtotal / subtotal) : 0);
    const cgst = Math.round(taxableFood * 0.025 * 100) / 100;
    const sgst = Math.round(taxableFood * 0.025 * 100) / 100;
    const tax = cgst + sgst;

    const grandTotal = Math.round((subtotal - discountAmount + tax) * 100) / 100;

    // 4. TRANSACTION - Only mutations inside
    const result = await prisma.$transaction(async (tx) => {

      // 4. Create transaction record (integrated)
      const txnDate = getKolkataDateString();

      // Get next transaction number
      const counter = await tx.dailyCounter.upsert({
        where: { restaurantId_counterDate: { restaurantId, counterDate: txnDate } },
        update: { txnCount: { increment: 1 } },
        create: { restaurantId, counterDate: txnDate, txnCount: 1 },
      });

      await tx.transaction.create({
        data: {
          restaurantId,
          orderId: order.id,
          tableNumber: order.table.number,
          captainId: order.table.captainId || "N/A",
          amount: new Prisma.Decimal(grandTotal),
          method: paymentMethod,
          itemCount: order.items.length,
          items: order.items.map(item => ({
            name: item.name,
            quantity: item.quantity,
            price: Number(item.price),
            menuType: item.menuItem?.menuType || item.menuType || 'FOOD',
          })),
          txnNumber: counter.txnCount,
          txnDate,
          paidAt: new Date(),
          subtotal: new Prisma.Decimal(subtotal),
          discountPercent: new Prisma.Decimal(discountPercent),
          discountAmount: new Prisma.Decimal(discountAmount),
          cgst: new Prisma.Decimal(cgst),
          sgst: new Prisma.Decimal(sgst),
          grandTotal: new Prisma.Decimal(grandTotal),
        }
      });

      // Process liquor inventory deduction
      const liquorItems = order.items.filter(
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

      // Only deduct inventory once, ever
      if (!order.inventoryDeducted) {
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
              orderId: order.id,
              type: 'SALE',
              quantityChange: -totalMl,
              stockBefore: inventoryItem.currentStock,
              stockAfter: updatedItem.currentStock,
              notes: `Order #${order.id} - ${totalQuantity}x ${isBeer ? '650ml bottle' : isSpirit ? `${BAR_UNIT_ML}ml` : 'bottle'}`,
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

      // Reset table to AVAILABLE
      const updatedTable = await tx.table.update({
        where: { id: order.tableId },
        data: {
          status: TableStatus.AVAILABLE,
          workflowStatus: "Free",
          captainId: null,
          guests: 0,
          sessionStartedAt: null,
          currentBill: 0,
          kotHistory: [],
          discount: null,  // Reset discount
        },
      });

      return { order: updatedOrder, table: updatedTable, inventoryUpdates };
    }, { timeout: 15000, maxWait: 5000 });

    // 5. EMIT SOCKET EVENTS AFTER TRANSACTION COMMITS
    const io = getIo();

    // Emit order paid event
    io.to(restaurantId).emit("order:paid", {
      orderId: result.order.id,
      tableId: result.table.id,
      paymentMethod
    });

    // Emit table updated event
    io.to(restaurantId).emit("table:updated", { table: result.table });

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
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/pay", async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentMethod } = req.body as { paymentMethod?: string };

    const existing = await prisma.order.findUnique({
      where: { id },
      include: { table: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

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

      // Only deduct inventory once, ever
      if (!existing.inventoryDeducted) {
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
              orderId: order.id,
              type: 'SALE',
              quantityChange: -totalMl,
              stockBefore: inventoryItem.currentStock,
              stockAfter: updatedItem.currentStock,
              notes: `Order #${order.id} - ${totalQuantity}x ${isBeer ? '650ml bottle' : isSpirit ? `${BAR_UNIT_ML}ml` : 'bottle'}`,
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
    }, { timeout: 15000, maxWait: 5000 });

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
      ? formatTableNumber(result.table.number, existing.restaurantId)
      : existing.tableId;
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
router.patch("/:id/cancel-item", async (req, res) => {
  const { orderItemId, cancelledBy, cancelQuantity, tableNumber } = req.body as {
    orderItemId?: string;
    cancelledBy?: string;
    cancelQuantity?: number;
    tableNumber?: string | number;
  };

  if (!orderItemId || !cancelledBy) {
    return res.status(400).json({ error: "orderItemId and cancelledBy are required" });
  }

  const quantityToCancel = Math.max(1, Math.round(Number(cancelQuantity ?? 1)));
  if (!Number.isFinite(quantityToCancel) || quantityToCancel <= 0) {
    return res.status(400).json({ error: "cancelQuantity must be a positive number" });
  }

  try {
    // 1. Load the order with all items and the table
    const existing = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        table: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (!ACTIVE_ORDER_STATUSES.includes(existing.status)) {
      return res.status(409).json({ error: "Order is not active" });
    }

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

    // 3. Transaction: mark item cancelled + recalculate totals
    await prisma.$transaction(
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
        const newTotal = allItems
          .filter((i) => !i.removedFromBill)
          .reduce(
            (sum, i) => sum.add(new Prisma.Decimal(i.price).mul(new Prisma.Decimal(i.quantity))),
            new Prisma.Decimal(0)
          );

        // c. Update Order total + reset billing state so reprinting works
        await tx.order.update({
          where: { id: existing.id },
          data: {
            totalAmount: newTotal,
            // Reset billing state so cashier can reprint the bill cleanly
            status: existing.status === OrderStatus.BILLING_REQUESTED
              ? OrderStatus.CONFIRMED
              : existing.status,
            billingRequested: false,
            billingRequestedAt: null,
            billNumber: null,  // Force new bill number on next print
          },
        });

        // d. Update Table currentBill
        await tx.table.update({
          where: { id: existing.tableId },
          data: { currentBill: newTotal },
        });
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // Reset table status if it was in BILLING_REQUESTED
    if (existing.table.status === TableStatus.BILLING_REQUESTED) {
      await prisma.table.update({
        where: { id: existing.tableId },
        data: {
          status: TableStatus.OCCUPIED,
          workflowStatus: "Preparing",
        },
      });
    }

    // 4. Re-fetch updated order with full include
    const updatedOrder = await prisma.order.findUnique({
      where: { id: existing.id },
      include: orderInclude,
    });

    // 4b. Re-fetch for socket with ALL items (including cancelled) so frontend can render struck-through items
    const orderForSocket = await prisma.order.findUnique({
      where: { id: existing.id },
      include: {
        ...orderInclude,
        items: {
          orderBy: { id: 'asc' },
        },
      },
    });

    const updatedTable = await prisma.table.findUnique({
      where: { id: existing.tableId },
      include: tableInclude,
    });

    // 5. Emit socket events
    emitToRestaurant(existing.restaurantId, "order:updated", { order: orderForSocket });
    if (updatedTable) {
      emitToRestaurant(existing.restaurantId, "table:updated", { table: updatedTable });
    }
    const formattedTableNumber4 = tableNumber
      ? formatTableNumber(tableNumber, existing.restaurantId)
      : (existing.table.number ? formatTableNumber(existing.table.number, existing.restaurantId) : existing.tableId);
    emitToRestaurant(existing.restaurantId, "print_job", {
      type: "CANCEL_KOT",
      data: {
        tableNumber: formattedTableNumber4,
        cancelledBy,
        restaurantId: existing.restaurantId,
        sectionTag: (updatedTable as any)?.sectionTag || null,
        sectionName: updatedTable?.section?.name || "Main Hall",
        timestamp: new Date().toISOString(),
        item: {
          name: cancelledItem.name,
          quantity: quantityToCancel,
          menuType: cancelledItem.menuType === 'LIQUOR' ? 'BAR' : 'FOOD',
        },
      },
    });

    return res.json(updatedOrder);
  } catch (error) {
    console.error("[cancel-item]", error);
    return res.status(500).json({ error: "Failed to cancel item" });
  }
});

// ─── Terminate Table Session ──────────────────────────────────────────────
router.post("/terminate-table/:tableId", async (req, res) => {
  try {
    const { tableId } = req.params;

    // 1. Find active order for this table
    const activeOrder = await prisma.order.findFirst({
      where: {
        tableId,
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
    });

    // 4. Emit socket events
    if (result.order) {
      emitToRestaurant(result.table.restaurantId, "order:updated", { order: result.order });
    }
    emitToRestaurant(result.table.restaurantId, "table:updated", { table: result.table });

    // 5. Emit CANCEL_ORDER print_job for parcel/restaurant full order cancels
    const sectionTag = (result.table as any)?.sectionTag || null;
    if (result.order && sectionTag && (sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel')) {
      const cancelItems = (result.order as any).items || [];
      const formattedTableNum = result.table.number
        ? formatTableNumber(result.table.number, result.table.restaurantId, result.table.section?.name)
        : 'UNKNOWN';
      emitToRestaurant(result.table.restaurantId, "print_job", {
        type: "CANCEL_ORDER",
        data: {
          tableNumber: formattedTableNum,
          cancelledBy: (req.body as any)?.cancelledBy || 'Cashier',
          restaurantId: result.table.restaurantId,
          sectionTag,
          sectionName: result.table.section?.name || "Main Hall",
          timestamp: new Date().toISOString(),
          items: cancelItems.map((i: any) => ({
            name: i.name,
            quantity: i.quantity,
            price: Number(i.price),
          })),
        },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[terminate-table]", error);
    res.status(500).json({ error: "Failed to terminate table session" });
  }
});

export default router;
