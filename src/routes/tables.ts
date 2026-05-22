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

router.get("/", async (_req, res) => {
  try {
    const tables = await prisma.table.findMany({
      orderBy: [{ section: { name: "asc" } }, { number: "asc" }],
      include: tableInclude,
    });

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
      data: { status: status as TableStatus },
      include: tableInclude,
    });

    getIo().emit("table:updated", updated);

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update table status" });
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
