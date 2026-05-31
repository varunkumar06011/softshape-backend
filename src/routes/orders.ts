import { OrderStatus, Prisma, PrismaClient, TableStatus } from "@prisma/client";
import { Router } from "express";
import { randomUUID } from "crypto";
import { getIo } from "../socket";

const router = Router();
const prisma = new PrismaClient();
const BAR_UNIT_ML = 30;
const FULL_BOTTLE_ML = 750;
const BAR_FULL_BOTTLE_MULTIPLIER = 25;

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
    orderBy: { id: "asc" },
  },
} as const;

const tableInclude = {
  section: { select: { id: true, name: true, restaurantId: true } },
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: { updatedAt: "desc" },
    take: 1,
    include: { items: true },
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
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  return {
    id: String(kotNumber).padStart(2, '0'),   // "01", "02", "03" — resets daily (bill has "KOT NO -" prefix)
    time: nowIST.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
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
  // Inject a unique eventId into every print_job so the frontend
  // can deduplicate even if the same event is delivered twice (e.g.
  // due to reconnect or duplicate socket room membership).
  const enriched = eventName === "print_job"
    ? { restaurantId, ...payload, data: { ...(payload.data as Record<string, unknown>), eventId: randomUUID() } }
    : { restaurantId, ...payload };
  getIo().to(restaurantId).emit(eventName, enriched);
}

/**
 * Format table number with prefix based on restaurantId
 * @param tableNumber - The table number (e.g., 3, "5")
 * @param restaurantId - The restaurant ID ("bar-001" or "restaurant-001")
 * @returns Formatted table number (e.g., "B3" for bar, "T5" for restaurant)
 */
function formatTableNumber(tableNumber: number | string, restaurantId: string): string {
  if (tableNumber === 999 || String(tableNumber) === '999') return 'Vijay Kumar (Counter)';
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

// Format bill number as DD/MM/YY-XXX
function formatBillNumber(date: Date, billNumber: number): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  const num = String(billNumber).padStart(3, '0');
  return `${day}/${month}/${year}-${num}`;
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
      where: { id: { in: ids } }
    });
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
    const allItems = (savedOrder.order as unknown as { items?: Array<{ name: string; price: number; quantity: number; menuType?: string; notes?: string | null }> }).items ?? [];
    const foodItems = allItems
      .filter((i) => i.menuType !== "LIQUOR")
      .map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null }));
    const liquorItems = allItems
      .filter((i) => i.menuType === "LIQUOR")
      .map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null }));

    // Use the sequential KOT id from the entry just appended to kotHistory
    const latestKot = savedOrder.kotHistory[savedOrder.kotHistory.length - 1] as { id?: string } | undefined;
    const formattedTableNumber = updatedTable?.number
      ? formatTableNumber(updatedTable.number, tenantId)
      : "UNKNOWN";
    const basePayload = {
      kotId: latestKot?.id ?? (savedOrder.order as { id: string }).id,
      tableNumber: formattedTableNumber,
      restaurantId: tenantId,
      timestamp: latestKot?.id ?? (savedOrder.order as { id: string }).id,
    };
    if (foodItems.length > 0) {
      emitToRestaurant(tenantId, "print_job", { type: "KOT", data: { ...basePayload, items: foodItems } });
    }
    if (liquorItems.length > 0) {
      emitToRestaurant(tenantId, "print_job", { type: "BAR_KOT", data: { ...basePayload, items: liquorItems } });
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
    const items = normalizeItems(req.body.items);

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

    // ── Atomic writes only ─────────────────────────────────────────────────
    const updatedOrder = await prisma.$transaction(
      async (tx) => {
        for (const item of items) {
          const matching = existing.items.find(
            (row) => row.menuItemId === item.menuItemId && (row.notes ?? null) === (item.notes ?? null)
          );

          if (matching) {
            await tx.orderItem.update({
              where: { id: matching.id },
              data: { quantity: { increment: item.quantity } },
            });
          } else {
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
        }

        const allItems = await tx.orderItem.findMany({ where: { orderId: id } });
        const order = await tx.order.update({
          where: { id },
          data: {
            status: existing.status === OrderStatus.BILLING_REQUESTED ? existing.status : OrderStatus.PREPARING,
            totalAmount: totalAmount(allItems),
          },
          include: orderInclude,
        });

        const itemsWithIds = items.map((item) => {
          const dbItem = allItems.find(
            (row) => row.menuItemId === item.menuItemId && (row.notes ?? null) === (item.notes ?? null)
          );
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
    const foodItems = items
      .filter((i) => i.menuType !== "LIQUOR")
      .map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null }));
    const liquorItems = items
      .filter((i) => i.menuType === "LIQUOR")
      .map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null }));

    const latestKot2 = updatedOrder.kotHistory[updatedOrder.kotHistory.length - 1] as { id?: string } | undefined;
    const formattedTableNumber2 = updatedTable?.number
      ? formatTableNumber(updatedTable.number, existing.restaurantId)
      : "UNKNOWN";
    const basePayload = {
      kotId: latestKot2?.id ?? updatedOrder.order.id,
      tableNumber: formattedTableNumber2,
      restaurantId: existing.restaurantId,
      timestamp: latestKot2?.id ?? updatedOrder.order.id,
    };
    if (foodItems.length > 0) {
      emitToRestaurant(existing.restaurantId, "print_job", { type: "KOT", data: { ...basePayload, items: foodItems } });
    }
    if (liquorItems.length > 0) {
      emitToRestaurant(existing.restaurantId, "print_job", { type: "BAR_KOT", data: { ...basePayload, items: liquorItems } });
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
      addedItems,
      editedBy,
    } = req.body as {
      removedItemIds?: string[];
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
        await tx.orderItem.updateMany({
          where: {
            orderId: id,
            id: { in: removedItemIds },
            removedFromBill: false,
          },
          data: {
            removedFromBill: true,
            removedBy: editedBy || "Cashier",
            removedAt: new Date(),
          },
        });
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

    // 3. VALIDATE items (check filtered activeItems)
    const activeItems = order.items.filter(i => !i.removedFromBill);
    if (activeItems.length === 0) {
      return res.status(400).json({
        error: "Cannot print bill with no items"
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
        // Generate new bill number
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

      // Format table number
      const formattedTableNumber = formatTableNumber(
        updatedTable.number,
        restaurantId
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
            captain: updatedTable.captainId || "N/A",
            items: activeItems.map(item => ({
              name: item.name,
              quantity: item.quantity,
              price: Number(item.price),
              amount: Number(item.price) * item.quantity,
              menuType: item.menuItem.menuType
            })),
            subtotal,
            discount,
            tax: { cgst, sgst, total: tax },
            grandTotal,
            section: updatedTable.section?.name || "Main Hall",
            itemCount: activeItems.length,
            qtyCount: activeItems.reduce((sum, item) => sum + item.quantity, 0)
          }
        },
        formattedTableNumber,
        grandTotal
      };
    });

    // 5. EMIT SOCKET EVENTS AFTER TRANSACTION COMMITS
    const io = getIo();

    // Emit print job
    io.to(restaurantId).emit("print_job", result.billData);

    // Emit billing requested event
    io.to(restaurantId).emit("billing:requested", {
      orderId: result.order.id,
      tableId: result.table.id,
      tableNumber: result.formattedTableNumber,
      totalAmount: result.grandTotal
    });

    // Emit table updated event
    io.to(restaurantId).emit("table:updated", { table: result.table });

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
          where: { removedFromBill: false },
          include: { menuItem: true }
        },
        table: { include: { section: true } }
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // 2. VALIDATE order state OUTSIDE TRANSACTION
    if (order.status === OrderStatus.PAID) {
      return res.status(409).json({
        error: "Order is already paid"
      });
    }

    // 3. Calculate total amount (outside transaction)
    const totalAmount = order.items.reduce((sum, item) =>
      sum + (Number(item.price) * item.quantity), 0
    );

    // 4. TRANSACTION - Only mutations inside
    const result = await prisma.$transaction(async (tx) => {

      // 4. Create transaction record (integrated)
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const nowIST = new Date(Date.now() + IST_OFFSET_MS);
      const txnDate = nowIST.toISOString().slice(0, 10);

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
          amount: totalAmount,
          method: paymentMethod,
          itemCount: order.items.length,
          items: order.items.map(item => ({
            name: item.name,
            quantity: item.quantity,
            price: Number(item.price)
          })),
          txnNumber: counter.txnCount,
          txnDate,
          paidAt: new Date()
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

      for (const item of liquorItems) {
        const inventoryItem = await tx.inventoryItem.findUnique({
          where: { menuItemId: item.menuItemId },
          include: { menuItem: { include: { variants: true } } },
        });

        if (!inventoryItem) {
          console.warn(
            `[Inventory] Liquor item ${item.name} has no linked inventory. Skipping.`
          );
          continue;
        }

        // Determine ml to deduct based on item type
        const isSpirit = inventoryItem.menuItem.variants.some(
          (v: { name: string }) => v.name === '30ml'
        );
        const mlPerUnit = isSpirit ? BAR_UNIT_ML : Number(inventoryItem.bottleSize);
        const mlConsumed = mlPerUnit; // per unit sold

        const totalMl = mlConsumed * item.quantity;

        if (Number(inventoryItem.currentStock) < totalMl) {
          console.warn(
            `[Inventory] Insufficient stock for ${inventoryItem.menuItem.name}: ` +
            `need ${totalMl}ml, have ${inventoryItem.currentStock}ml - proceeding anyway`
          );
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
            notes: `Order #${order.id} - ${item.quantity}x ${isSpirit ? `${BAR_UNIT_ML}ml` : 'bottle'}`,
            transactionDate: new Date(),
          },
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

      // Update order to PAID
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.PAID,
          billingRequested: false,
          paidAt: new Date(),
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
        itemId: update.id,
        currentStock: update.currentStock,
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

      // Process each liquor item
      for (const item of liquorItems) {
        // Check if this menu item has inventory tracking
        const inventoryItem = await tx.inventoryItem.findUnique({
          where: { menuItemId: item.menuItemId },
          include: { menuItem: { include: { variants: true } } },
        });

        if (!inventoryItem) {
          // No inventory tracking for this item, skip
          console.log(`[Inventory] No tracking for menuItem ${item.menuItemId} (${item.name})`);
          continue;
        }

        // Determine ml to deduct based on item type
        const isSpirit = inventoryItem.menuItem.variants.some(
          (v: { name: string }) => v.name === '30ml'
        );
        const mlPerUnit = isSpirit ? BAR_UNIT_ML : Number(inventoryItem.bottleSize);
        const mlConsumed = mlPerUnit; // per unit sold

        // Total ML for this item (serving size * quantity ordered)
        const totalMl = mlConsumed * item.quantity;

        // Check if sufficient stock exists
        if (Number(inventoryItem.currentStock) < totalMl) {
          // Log warning but don't block the payment
          console.warn(
            `[Inventory] Insufficient stock for ${inventoryItem.menuItem.name}: ` +
            `need ${totalMl}ml, have ${inventoryItem.currentStock}ml - proceeding anyway`
          );
          // Continue anyway - payment already processed
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
            notes: `Order #${order.id} - ${item.quantity}x ${isSpirit ? `${BAR_UNIT_ML}ml` : 'bottle'}`,
            transactionDate: new Date(),
          },
        });

        console.log(
          `[Inventory] Deducted ${totalMl}ml of ${inventoryItem.menuItem.name} ` +
          `(${inventoryItem.currentStock}ml → ${updatedItem.currentStock}ml)`
        );

        // Check if stock fell below reorder level and emit alert
        if (Number(updatedItem.currentStock) <= Number(updatedItem.reorderLevel)) {
          // Emit low stock alert after transaction commits
          setTimeout(() => {
            getIo().to(existing.restaurantId).emit("inventory:low_stock", {
              restaurantId: existing.restaurantId,
              item: {
                id: updatedItem.id,
                name: inventoryItem.menuItem.name,
                currentStock: updatedItem.currentStock,
                reorderLevel: updatedItem.reorderLevel,
                unitOfMeasure: updatedItem.unitOfMeasure,
              },
            });
          }, 100);
        }

        // Emit inventory updated event
        setTimeout(() => {
          getIo().to(existing.restaurantId).emit("inventory:updated", {
            restaurantId: existing.restaurantId,
            itemId: updatedItem.id,
            currentStock: updatedItem.currentStock,
          });
        }, 100);
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

      return { order, table };
    }, { timeout: 15000, maxWait: 5000 });

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
  } catch (error) {
    console.error("[PAY] Failed:", error);
    res.status(500).json({ error: "Failed to mark order as paid" });
  }
});

// ── PATCH /:id/cancel-item ────────────────────────────────────────────────────
// Body: { orderItemId: string, cancelledBy: string, tableNumber?: number|string }
// Marks a single OrderItem as removed, recalculates the order and table totals,
// and emits a CANCEL_KOT print_job so the bar staff know to stop making it.
router.patch("/:id/cancel-item", async (req, res) => {
  const { orderItemId, cancelledBy, tableNumber } = req.body as {
    orderItemId?: string;
    cancelledBy?: string;
    tableNumber?: string | number;
  };

  if (!orderItemId || !cancelledBy) {
    return res.status(400).json({ error: "orderItemId and cancelledBy are required" });
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

    // 3. Transaction: mark item cancelled + recalculate totals
    await prisma.$transaction(
      async (tx) => {
        // a. Mark the item
        await tx.orderItem.update({
          where: { id: orderItemId },
          data: {
            removedFromBill: true,
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

        // c. Update Order total
        await tx.order.update({
          where: { id: existing.id },
          data: { totalAmount: newTotal },
        });

        // d. Update Table currentBill
        await tx.table.update({
          where: { id: existing.tableId },
          data: { currentBill: newTotal },
        });
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // 4. Re-fetch updated order with full include
    const updatedOrder = await prisma.order.findUnique({
      where: { id: existing.id },
      include: orderInclude,
    });

    // 5. Emit socket events
    emitToRestaurant(existing.restaurantId, "order:updated", { order: updatedOrder });
    const formattedTableNumber4 = tableNumber
      ? formatTableNumber(tableNumber, existing.restaurantId)
      : (existing.table.number ? formatTableNumber(existing.table.number, existing.restaurantId) : existing.tableId);
    emitToRestaurant(existing.restaurantId, "print_job", {
      type: "CANCEL_KOT",
      data: {
        tableNumber: formattedTableNumber4,
        cancelledBy,
        restaurantId: existing.restaurantId,
        timestamp: new Date().toISOString(),
        item: {
          name: cancelledItem.name,
          quantity: cancelledItem.quantity,
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

export default router;
