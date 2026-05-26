import { OrderStatus, PrismaClient, TableStatus } from "@prisma/client";
import { Router } from "express";
import { getIo } from "../socket";

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
    include: { items: true },
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
  const restaurantId = typeof reqRestaurantId === "string" ? reqRestaurantId.trim() : "";
  if (!restaurantId) {
    res.status(400).json({ error: "restaurantId is required" });
    return null;
  }
  return restaurantId;
}

function emitTableUpdated(restaurantId: string, table: unknown): void {
  getIo().to(restaurantId).emit("table:updated", { restaurantId, table });
}

router.get("/", async (req, res) => {
  try {
    const restaurantId = requireRestaurantId(req.query.restaurantId, res);
    if (!restaurantId) return;

    const sections = await prisma.section.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
      include: {
        tables: {
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
    const restaurantId = requireRestaurantId(req.query.restaurantId, res);
    if (!restaurantId) return;

    const tables = await prisma.table.findMany({
      where: { restaurantId },
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
    const restaurantId = requireRestaurantId(req.query.restaurantId, res);
    if (!restaurantId) return;

    const sections = await prisma.section.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
      include: {
        tables: {
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
    const { number, capacity, sectionId, restaurantId, status } = req.body as {
      number?: number | string;
      capacity?: number;
      sectionId?: string;
      restaurantId?: string;
      status?: string;
    };

    const parsedNumber = Number(number);
    if (!Number.isInteger(parsedNumber) || parsedNumber <= 0 || !sectionId?.trim() || !restaurantId?.trim()) {
      res.status(400).json({
        error: "number, sectionId, and restaurantId are required",
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
      where: { id: sectionId, restaurantId: restaurantId.trim() },
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
        restaurantId: restaurantId.trim(),
        status: (status as TableStatus | undefined) ?? TableStatus.AVAILABLE,
      },
      include: tableInclude,
    });

    emitTableUpdated(created.restaurantId, created);
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

    const existing = await prisma.table.findUnique({ where: { id } });
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

    emitTableUpdated(updated.restaurantId, updated);
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
      kotHistory,
    } = req.body as {
      status?: TableWorkflowStatus;
      captainId?: string | null;
      guests?: number | null;
      time?: string | null;
      currentBill?: number | null;
      kotHistory?: unknown;
    };

    if (status && !VALID_WORKFLOW_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid workflow status",
        validStatuses: Array.from(VALID_WORKFLOW_STATUSES),
      });
      return;
    }

    if (kotHistory !== undefined && !Array.isArray(kotHistory)) {
      res.status(400).json({ error: "kotHistory must be an array" });
      return;
    }

    const existing = await prisma.table.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const workflowStatus = status ?? existing.workflowStatus ?? "Free";
    const isFree = workflowStatus === "Free";
    const existingKotHistory = Array.isArray(existing.kotHistory)
      ? existing.kotHistory
      : [];

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
        kotHistory: isFree ? [] : kotHistory ?? existingKotHistory,
      },
      include: tableInclude,
    });

    emitTableUpdated(updated.restaurantId, updated);
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update table session" });
  }
});

router.post("/:id/swap", async (req, res) => {
  try {
    const { id } = req.params;
    const { targetTableId, swappedBy, restaurantId } = req.body as {
      targetTableId?: string;
      swappedBy?: string;
      restaurantId?: string;
    };

    if (!targetTableId?.trim() || !restaurantId?.trim()) {
      res.status(400).json({ error: "targetTableId and restaurantId are required" });
      return;
    }

    if (id === targetTableId) {
      res.status(400).json({ error: "Source and destination tables must be different" });
      return;
    }

    // Fetch both tables in parallel
    const [sourceTable, targetTable] = await Promise.all([
      prisma.table.findUnique({ where: { id }, include: tableInclude }),
      prisma.table.findUnique({ where: { id: targetTableId }, include: tableInclude }),
    ]);

    if (!sourceTable) {
      res.status(404).json({ error: "Source table not found" });
      return;
    }
    if (!targetTable) {
      res.status(404).json({ error: "Target table not found" });
      return;
    }
    if (sourceTable.status === TableStatus.AVAILABLE) {
      res.status(400).json({ error: "Source table has no active session" });
      return;
    }
    if (targetTable.status !== TableStatus.AVAILABLE) {
      res.status(409).json({ error: "Target table is not free" });
      return;
    }

    // Atomic transaction: move session to target, clear source
    await prisma.$transaction(async (tx) => {
      // 1. Reassign all active orders to target table
      await tx.order.updateMany({
        where: {
          tableId: id,
          status: { in: ACTIVE_ORDER_STATUSES },
        },
        data: { tableId: targetTableId },
      });

      // 2. Copy session fields from source → target
      await tx.table.update({
        where: { id: targetTableId },
        data: {
          status: sourceTable.status,
          workflowStatus: sourceTable.workflowStatus,
          captainId: sourceTable.captainId,
          guests: sourceTable.guests,
          sessionStartedAt: sourceTable.sessionStartedAt,
          currentBill: sourceTable.currentBill,
          kotHistory: (sourceTable.kotHistory as object[]) ?? [],
        },
      });

      // 3. Clear source table
      await tx.table.update({
        where: { id },
        data: {
          status: TableStatus.AVAILABLE,
          workflowStatus: "Free",
          captainId: null,
          guests: 0,
          sessionStartedAt: null,
          currentBill: 0,
          kotHistory: [],
        },
      });
    });

    // Re-fetch both tables outside transaction for fresh socket payloads
    const [updatedSource, updatedTarget] = await Promise.all([
      prisma.table.findUnique({ where: { id }, include: tableInclude }),
      prisma.table.findUnique({ where: { id: targetTableId }, include: tableInclude }),
    ]);

    // Emit table:updated for both tables
    emitTableUpdated(restaurantId, updatedSource);
    emitTableUpdated(restaurantId, updatedTarget);

    // Emit table:swapped for any UI that wants to react specially
    getIo().to(restaurantId).emit("table:swapped", {
      restaurantId,
      sourceTableId: id,
      targetTableId,
      sourceTable: updatedSource,
      targetTable: updatedTarget,
      swappedBy: swappedBy || "Staff",
    });

    // Emit TABLE_SWAP print job → kitchen printer
    getIo().to(restaurantId).emit("print_job", {
      type: "TABLE_SWAP",
      data: {
        fromTableNumber: sourceTable.number,
        toTableNumber: targetTable.number,
        swappedBy: swappedBy || "Staff",
        timestamp: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      sourceTable: updatedSource,
      targetTable: updatedTarget,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to swap tables" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.table.findUnique({ where: { id } });
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

export default router;
