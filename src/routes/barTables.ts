import { OrderStatus, TableStatus } from "@prisma/client";
import { Router } from "express";
import { getIo } from "../socket";
import prisma from "../lib/prisma";
import { invalidateCache } from "../lib/cache";
import { authenticate } from "../middleware/auth";

function getUserRestaurantId(req: any): string | undefined {
  return req.user?.restaurantId;
}
const router = Router();

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

function requireRestaurantId(_reqRestaurantId: unknown, _res: { status: (code: number) => { json: (body: unknown) => void } }, req?: any): string | null {
  if (req) return getUserRestaurantId(req) ?? null;
  return null;
}

function emitTableUpdated(restaurantId: string, table: unknown): void {
  getIo().to(restaurantId).emit("table:updated", { restaurantId, table });
}

router.get("/", authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);

    // Ensure Table 999 (Counter) exists
    let vkTable = await prisma.table.findFirst({ where: { number: 999 } });
    if (!vkTable) {
      let section = await prisma.section.findFirst({ where: { name: "Counter" } });
      if (!section) {
        section = await prisma.section.create({ data: { name: "Counter", restaurantId: restaurantId ?? '' } });
      }
      await prisma.table.create({
        data: {
          number: 999,
          capacity: 0,
          status: TableStatus.AVAILABLE,
          sectionId: section.id,
          restaurantId: restaurantId ?? '',
        },
      });
    }

    const sections = await prisma.section.findMany({
      where: {},
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId: getUserRestaurantId(req) ?? '' },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.set("Cache-Control", "no-store");
    res.json(sections);
  } catch (error) {
    console.error("[GET /api/bar/tables]", error);
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: "Failed to fetch tables", detail: msg });
  }
});

router.get("/flat", authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);

    // Ensure Table 999 (Counter) exists for flat view as well
    let vkTable = await prisma.table.findFirst({ where: { number: 999 } });
    if (!vkTable) {
      let section = await prisma.section.findFirst({ where: { name: "Counter" } });
      if (!section) {
        section = await prisma.section.create({ data: { name: "Counter", restaurantId: restaurantId ?? '' } });
      }
      await prisma.table.create({
        data: {
          number: 999,
          capacity: 0,
          status: TableStatus.AVAILABLE,
          sectionId: section.id,
          restaurantId: restaurantId ?? '',
        },
      });
    }

    const tables = await prisma.table.findMany({
      where: {},
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

router.get("/sections", authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) ?? '';

    const sections = await prisma.section.findMany({
      where: { restaurantId: getUserRestaurantId(req) ?? '' },
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId: getUserRestaurantId(req) ?? '' },
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

router.post("/", authenticate, async (req: any, res) => {
  try {
    const { number, capacity, sectionId, status } = req.body as {
      number?: number | string;
      capacity?: number;
      sectionId?: string;
      status?: string;
    };
    const restaurantId = getUserRestaurantId(req) ?? '';

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
      where: { id: sectionId, restaurantId: getUserRestaurantId(req) ?? '' },
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
        restaurantId: getUserRestaurantId(req) ?? '',
        status: (status as TableStatus | undefined) ?? TableStatus.AVAILABLE,
      },
      include: tableInclude,
    });

    emitTableUpdated(restaurantId ?? '', created);
    res.status(201).json(created);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create table" });
  }
});

router.patch("/:id/status", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const { status } = req.body as { status?: string };

    if (!status || !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid status",
        validStatuses: Array.from(VALID_STATUSES),
      });
      return;
    }

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: getUserRestaurantId(req) ?? '' } });
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

    emitTableUpdated(getUserRestaurantId(req) ?? '', updated);
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update table status" });
  }
});

router.patch("/:id/session", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;
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

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: getUserRestaurantId(req) ?? '' } });
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

    emitTableUpdated(getUserRestaurantId(req) ?? '', updated);
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update table session" });
  }
});

// PATCH /api/tables/:id — update specific fields on a table (e.g. discount before billing)
router.patch("/:id", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;
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

router.delete("/:id", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.table.findFirst({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    await prisma.table.delete({ where: { id } });
    getIo().to(existing.restaurantId).emit("table:deleted", {
      restaurantId: existing.restaurantId,
      id,
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete table" });
  }
});

// ─── Terminate Table Session ──────────────────────────────────────────────
router.post("/terminate-table/:tableId", authenticate, invalidateCache(["tables:*", "sections:list:*"]), async (req: any, res) => {
  try {
    const tableId = req.params.tableId as string;

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
    }, { timeout: 15000, maxWait: 20000 });

    // 4. Emit socket events
    const restaurantId = (result.table as any).restaurantId || result.table.section?.restaurantId;
    if (!restaurantId) {
      console.warn('[barTables] Cannot emit table update: missing restaurantId');
    } else if (result.order) {
      emitTableUpdated(restaurantId, result.table);
      getIo().to(restaurantId).emit("order:updated", { order: result.order });
    } else {
      emitTableUpdated(restaurantId, result.table);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[terminate-table bar]", error);
    res.status(500).json({ error: "Failed to terminate bar table session" });
  }
});

export default router;
