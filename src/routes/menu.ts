import { PrismaClient } from "@prisma/client";
import { Router } from "express";

const router = Router();
const prisma = new PrismaClient();

router.get("/pos-view", async (_req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      include: {
        items: {
          where: { isAvailable: true },
          orderBy: { sortOrder: "asc" },
          include: {
            variants: true,
            addons: { where: { isAvailable: true } },
          },
        },
      },
    });

    res.json(categories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch menu" });
  }
});

router.patch("/items/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.menuItem.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }

    const updated = await prisma.menuItem.update({
      where: { id },
      data: { isAvailable: !existing.isAvailable },
    });

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update availability" });
  }
});

export default router;
