import { OrderStatus, Prisma, PrismaClient, TableStatus } from "@prisma/client";
import { Router } from "express";
import { getIo } from "../socket";

const router = Router();
const prisma = new PrismaClient();

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
    id: String(kotNumber),   // "1", "2", "3" — resets daily
    time: nowIST.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
    items: items.map((item) => ({
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
  getIo().to(restaurantId).emit(eventName, { restaurantId, ...payload });
}

router.post("/", async (req, res) => {
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
    const basePayload = {
      kotId: latestKot?.id ?? (savedOrder.order as { id: string }).id,
      tableNumber: updatedTable?.number ?? tableId,
      restaurantId: tenantId,
      timestamp: new Date().toISOString(),
    };
    if (foodItems.length > 0) {
      emitToRestaurant(tenantId, "print_job", { type: "KOT", data: { ...basePayload, items: foodItems } });
    }
    if (liquorItems.length > 0) {
      emitToRestaurant(tenantId, "print_job", { type: "BAR_KOT", data: { ...basePayload, items: liquorItems } });
    }
    // ─────────────────────────────────────────────────────────────────────

    res.status(201).json(savedOrder.order);
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
    const basePayload = {
      kotId: latestKot2?.id ?? updatedOrder.order.id,
      tableNumber: updatedTable?.number ?? existing.tableId,
      restaurantId: existing.restaurantId,
      timestamp: new Date().toISOString(),
    };
    if (foodItems.length > 0) {
      emitToRestaurant(existing.restaurantId, "print_job", { type: "KOT", data: { ...basePayload, items: foodItems } });
    }
    if (liquorItems.length > 0) {
      emitToRestaurant(existing.restaurantId, "print_job", { type: "BAR_KOT", data: { ...basePayload, items: liquorItems } });
    }
    // ─────────────────────────────────────────────────────────────────────────

    res.json(updatedOrder.order);

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
    console.error(error);
    res.status(500).json({ error: "Failed to request billing" });
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
    emitToRestaurant(existing.restaurantId, "print_job", {
      type: "BILL",
      data: {
        orderId: result.order.id,
        tableNumber: result.table.number ?? existing.tableId,
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
    emitToRestaurant(existing.restaurantId, "print_job", {
      type: "CANCEL_KOT",
      data: {
        tableNumber: tableNumber ?? existing.table.number,
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
