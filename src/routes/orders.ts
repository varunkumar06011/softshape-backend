import { OrderStatus, PrismaClient, TableStatus } from "@prisma/client";
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
};

type NormalizedOrderItem = {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  notes: string | null;
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

    if (!menuItemId || !name || !Number.isFinite(price) || price < 0 || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Invalid item at index ${index}`);
    }

    return {
      menuItemId,
      name,
      price,
      quantity,
      notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null,
    };
  });
}

function totalAmount(items: Array<{ price: number; quantity: number }>): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function kotEntryFromItems(items: Array<{ name: string; price: number; quantity: number }>) {
  return {
    id: Math.floor(1000 + Math.random() * 9000).toString(),
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    items: items.map((item) => ({
      n: item.name,
      p: item.price,
      q: item.quantity,
      s: "KOT Sent",
    })),
  };
}

function appendKotHistory(existing: unknown, items: Array<{ name: string; price: number; quantity: number }>) {
  const history = Array.isArray(existing) ? existing : [];
  return [...history, kotEntryFromItems(items)];
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

    const table = await prisma.table.findFirst({
      where: { id: tableId, restaurantId: tenantId },
    });
    if (!table) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
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
            })),
          },
        },
        include: orderInclude,
      });

      const updatedTable = await tx.table.update({
        where: { id: tableId },
        data: {
          status: TableStatus.OCCUPIED,
          workflowStatus: "Preparing",
          currentBill: { increment: order.totalAmount },
          kotHistory: appendKotHistory(table.kotHistory, items),
        },
        include: tableInclude,
      });

      return { order, table: updatedTable };
    });

    emitToRestaurant(tenantId, "order:created", { order: result.order });
    emitToRestaurant(tenantId, "table:updated", { table: result.table });
    res.status(201).json(result.order);
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

    const result = await prisma.$transaction(async (tx) => {
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

      const table = await tx.table.update({
        where: { id: existing.tableId },
        data: {
          status: existing.status === OrderStatus.BILLING_REQUESTED ? TableStatus.BILLING_REQUESTED : TableStatus.OCCUPIED,
          workflowStatus: existing.status === OrderStatus.BILLING_REQUESTED ? "Waiting Bill" : "Preparing",
          currentBill: order.totalAmount,
          kotHistory: appendKotHistory(existing.table.kotHistory, items),
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

router.post("/:id/pay", async (req, res) => {
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
    });

    emitToRestaurant(existing.restaurantId, "order:paid", {
      orderId: result.order.id,
      tableId: result.table.id,
    });
    emitToRestaurant(existing.restaurantId, "table:updated", { table: result.table });
    res.json(result.order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to mark order as paid" });
  }
});

export default router;
