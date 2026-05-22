import { PrismaClient, TableStatus } from "@prisma/client";
import { Router } from "express";
import { getIo } from "../socket";

const router = Router();
const prisma = new PrismaClient();

const VALID_STATUSES = new Set<string>(Object.values(TableStatus));

const tableInclude = {
  section: {
    select: { id: true, name: true, restaurantId: true },
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
    case "Waiting Bill":
      return TableStatus.OCCUPIED;
    case "Reserved":
      return TableStatus.RESERVED;
    case "Cleaning":
      return TableStatus.CLEANING;
    case "Free":
    default:
      return TableStatus.AVAILABLE;
  }
}

router.get("/", async (_req, res) => {
  try {
    const tables = await prisma.table.findMany({
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

router.get("/sections", async (_req, res) => {
  try {
    const sections = await prisma.section.findMany({
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

    const updated = await prisma.table.update({
      where: { id },
      data: {
        status: status as TableStatus,
        workflowStatus: status === TableStatus.AVAILABLE ? "Free" : undefined,
        captainId: status === TableStatus.AVAILABLE ? null : undefined,
        guests: status === TableStatus.AVAILABLE ? 0 : undefined,
        sessionStartedAt: status === TableStatus.AVAILABLE ? null : undefined,
        currentBill: status === TableStatus.AVAILABLE ? 0 : undefined,
        kotHistory: status === TableStatus.AVAILABLE ? [] : undefined,
      },
      include: tableInclude,
    });

    const io = getIo();
    console.log("[Socket] Emitting table:updated for table:", updated.id);
    io.emit("table:updated", updated);

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

    console.log("[Socket] Emitting table:updated for session:", updated.id);
    getIo().emit("table:updated", updated);

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update table session" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { number, capacity, sectionId, restaurantId, status } = req.body as {
      number?: string;
      capacity?: number;
      sectionId?: string;
      restaurantId?: string;
      status?: string;
    };

    if (!number?.trim() || !sectionId?.trim() || !restaurantId?.trim()) {
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

    const section = await prisma.section.findUnique({
      where: { id: sectionId },
    });
    if (!section) {
      res.status(404).json({ error: "Section not found" });
      return;
    }

    const created = await prisma.table.create({
      data: {
        number: number.trim(),
        capacity: capacity ?? 4,
        sectionId,
        restaurantId: restaurantId.trim(),
        status: (status as TableStatus) ?? TableStatus.AVAILABLE,
      },
      include: tableInclude,
    });

    getIo().emit("table:created", created);

    res.status(201).json(created);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create table" });
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

    getIo().emit("table:deleted", { id });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete table" });
  }
});

export default router;
