import { OrderStatus, PrismaClient, TableStatus } from "@prisma/client";
import { Router } from "express";
import { getIo } from "../socket";

const BAR_ID = "bar-001";
const router = Router();
const prisma = new PrismaClient();

const VALID_STATUSES = new Set<string>(Object.values(TableStatus));
const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.BILLING_REQUESTED,
];

const tableInclude = {
  section: {
    select: { id: true, name: true, restaurantId: true },
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

type TableWorkflowStatus =
  | "Free"
  | "Occupied"
  | "Preparing"
  | "Ready"
  | "Waiting Bill"
  | "Reserved"
  | "Cleaning";

const VALID_WORKFLOW_STATUSES = new Set<TableWorkflowStatus>([
  "Free",
  "Occupied",
  "Preparing",
  "Ready",
  "Waiting Bill",
  "Reserved",
  "Cleaning",
]);

function toBackendStatus(workflowStatus?: string): TableStatus {
  switch (workflowStatus) {
    case "Occupied":
    case "Preparing":
    case "Ready":
      return TableStatus.OCCUPIED;
    case "Waiting Bill":
      return TableStatus.BILLING_REQUESTED;
    case "Reserved":
      return TableStatus.RESERVED;
    case "Cleaning":
      return TableStatus.CLEANING;
    case "Free":
    default:
      return TableStatus.AVAILABLE;
  }
}

function requireRestaurantId(reqRestaurantId: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }): string | null {
  // Override this for bar to always use BAR_ID
  return BAR_ID;
}

function emitTableUpdated(restaurantId: string, table: unknown): void {
  getIo().to(BAR_ID).emit("table:updated", { restaurantId: BAR_ID, table });
}

router.get("/", async (req, res) => {
  try {
    const restaurantId = BAR_ID;

    // Ensure Table 999 (Vijay Kumar Counter) exists
    let vkTable = await prisma.table.findFirst({ where: { number: 999, restaurantId: BAR_ID } });
    if (!vkTable) {
      let section = await prisma.section.findFirst({ where: { name: "Counter", restaurantId: BAR_ID } });
      if (!section) {
        section = await prisma.section.create({ data: { name: "Counter", restaurantId: BAR_ID } });
      }
      await prisma.table.create({
        data: {
          number: 999,
          capacity: 0,
          status: TableStatus.AVAILABLE,
          sectionId: section.id,
          restaurantId: BAR_ID,
        },
      });
    }

    const sections = await prisma.section.findMany({
      where: { restaurantId: BAR_ID },
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId: BAR_ID },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.set("Cache-Control", "no-store");
    res.json(sections);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});

router.get("/flat", async (req, res) => {
  try {
    const restaurantId = BAR_ID;

    // Ensure Table 999 exists for flat view as well
    let vkTable = await prisma.table.findFirst({ where: { number: 999, restaurantId: BAR_ID } });
    if (!vkTable) {
      let section = await prisma.section.findFirst({ where: { name: "Counter", restaurantId: BAR_ID } });
      if (!section) {
        section = await prisma.section.create({ data: { name: "Counter", restaurantId: BAR_ID } });
      }
      await prisma.table.create({
        data: {
          number: 999,
          capacity: 0,
          status: TableStatus.AVAILABLE,
          sectionId: section.id,
          restaurantId: BAR_ID,
        },
      });
    }

    const tables = await prisma.table.findMany({
      where: { restaurantId: BAR_ID },
      orderBy: [{ section: { name: "asc" } }, { number: "asc" }],
      include: tableInclude,
    });

    res.set("Cache-Control", "no-store");
    res.json(tables);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});

router.get("/sections", async (req, res) => {
  try {
    const restaurantId = BAR_ID;

    const sections = await prisma.section.findMany({
      where: { restaurantId: BAR_ID },
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId: BAR_ID },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.json(sections);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch sections" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { number, capacity, sectionId, status } = req.body as {
      number?: number | string;
      capacity?: number;
      sectionId?: string;
      status?: string;
    };
    const restaurantId = BAR_ID;

    const parsedNumber = Number(number);
    if (!Number.isInteger(parsedNumber) || parsedNumber <= 0 || !sectionId?.trim()) {
      res.status(400).json({
        error: "number and sectionId are required",
      });
      return;
    }

    if (status && !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid status",
        validStatuses: Array.from(VALID_STATUSES),
      });
      return;
    }

    const section = await prisma.section.findFirst({
      where: { id: sectionId, restaurantId: BAR_ID },
    });
    if (!section) {
      res.status(404).json({ error: "Section not found" });
      return;
    }

    const created = await prisma.table.create({
      data: {
        number: parsedNumber,
        capacity: capacity ?? 4,
        sectionId,
        restaurantId: BAR_ID,
        status: (status as TableStatus | undefined) ?? TableStatus.AVAILABLE,
      },
      include: tableInclude,
    });

    emitTableUpdated(BAR_ID, created);
    res.status(201).json(created);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create table" });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };

    if (!status || !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid status",
        validStatuses: Array.from(VALID_STATUSES),
      });
      return;
    }

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: BAR_ID } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const isAvailable = status === TableStatus.AVAILABLE;
    const updated = await prisma.table.update({
      where: { id },
      data: {
        status: status as TableStatus,
        workflowStatus:
          status === TableStatus.BILLING_REQUESTED
            ? "Waiting Bill"
            : isAvailable
              ? "Free"
              : undefined,
        captainId: isAvailable ? null : undefined,
        guests: isAvailable ? 0 : undefined,
        sessionStartedAt: isAvailable ? null : undefined,
        currentBill: isAvailable ? 0 : undefined,
        kotHistory: isAvailable ? [] : undefined,
      },
      include: tableInclude,
    });

    emitTableUpdated(BAR_ID, updated);
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update table status" });
  }
});

router.patch("/:id/session", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      captainId,
      guests,
      time,
      currentBill,
    } = req.body as {
      status?: TableWorkflowStatus;
      captainId?: string | null;
      guests?: number | null;
      time?: string | null;
      currentBill?: number | null;
    };

    if (status && !VALID_WORKFLOW_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid workflow status",
        validStatuses: Array.from(VALID_WORKFLOW_STATUSES),
      });
      return;
    }

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: BAR_ID } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const workflowStatus = status ?? existing.workflowStatus ?? "Free";
    const isFree = workflowStatus === "Free";

    let finalSessionStartedAt: string | Date | null | undefined = isFree ? null : time ?? existing.sessionStartedAt;
    if (finalSessionStartedAt) {
      if (typeof finalSessionStartedAt === "number") {
        // Raw JS number timestamp
        finalSessionStartedAt = new Date(Number(finalSessionStartedAt)).toISOString();
      } else if (typeof finalSessionStartedAt === "string") {
        if (/^\d+[a-z]+$/i.test(finalSessionStartedAt)) {
          // Relative string like "1m", "2h" — use now
          finalSessionStartedAt = new Date().toISOString();
        } else if (/^\d+$/.test(finalSessionStartedAt)) {
          // Pure numeric string — Unix ms timestamp
          finalSessionStartedAt = new Date(Number(finalSessionStartedAt)).toISOString();
        } else {
          const d = new Date(finalSessionStartedAt);
          if (!isNaN(d.getTime())) {
            finalSessionStartedAt = d.toISOString();
          } else {
            finalSessionStartedAt = new Date().toISOString();
          }
        }
      } else if (finalSessionStartedAt instanceof Date) {
        finalSessionStartedAt = finalSessionStartedAt.toISOString();
      }
    }

    const updated = await prisma.table.update({
      where: { id },
      data: {
        status: toBackendStatus(workflowStatus),
        workflowStatus,
        captainId: isFree ? null : captainId ?? existing.captainId,
        guests: isFree ? 0 : guests ?? existing.guests,
        sessionStartedAt: finalSessionStartedAt as string | null | undefined,
        currentBill: isFree ? 0 : currentBill ?? existing.currentBill,
        ...(isFree ? { kotHistory: [] } : {}),
      },
      include: tableInclude,
    });

    emitTableUpdated(BAR_ID, updated);
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update table session" });
  }
});

// PATCH /api/tables/:id — update specific fields on a table (e.g. discount before billing)
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { discount } = req.body as { discount?: number };

    const table = await prisma.table.findUnique({ where: { id } });
    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    const updateData: Record<string, unknown> = {};
    if (discount !== undefined) {
      const parsed = parseFloat(String(discount));
      updateData.discount = isNaN(parsed) ? null : Math.max(0, Math.min(100, parsed));
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const updated = await prisma.table.update({
      where: { id },
      data: updateData,
    });

    res.json({ success: true, table: updated });
  } catch (err) {
    console.error("[PATCH /tables/:id]", err);
    res.status(500).json({ error: "Failed to update table" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: BAR_ID } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    await prisma.table.delete({ where: { id } });
    getIo().to(BAR_ID).emit("table:deleted", {
      restaurantId: BAR_ID,
      id,
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete table" });
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
          include: {
            table: {
              include: { section: true }
            }
          },
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
      emitTableUpdated(result.table.restaurantId, result.table);
      getIo().to(result.table.restaurantId).emit("order:updated", { order: result.order });
    } else {
      emitTableUpdated(result.table.restaurantId, result.table);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[terminate-table bar]", error);
    res.status(500).json({ error: "Failed to terminate bar table session" });
  }
});

export default router;
