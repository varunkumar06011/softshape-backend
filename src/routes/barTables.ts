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
  // Override this for bar to always use BAR_ID
  return BAR_ID;
}

function emitTableUpdated(restaurantId: string, table: unknown): void {
  getIo().to(BAR_ID).emit("table:updated", { restaurantId: BAR_ID, table });
}

router.get("/", async (req, res) => {
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

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: BAR_ID } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const workflowStatus = status ?? existing.workflowStatus ?? "Free";
    const isFree = workflowStatus === "Free";
    const existingKotHistory = Array.isArray(existing.kotHistory)
      ? existing.kotHistory
      : [];

    const updated = await prisma.table.update({
      where: { id },
      data: {
        status: toBackendStatus(workflowStatus),
        workflowStatus,
        captainId: isFree ? null : captainId ?? existing.captainId,
        guests: isFree ? 0 : guests ?? existing.guests,
        sessionStartedAt: isFree ? null : time ?? existing.sessionStartedAt,
        currentBill: isFree ? 0 : currentBill ?? existing.currentBill,
        kotHistory: isFree ? [] : kotHistory ?? existingKotHistory,
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

export default router;
