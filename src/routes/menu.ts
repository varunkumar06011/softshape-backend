import { PrismaClient } from "@prisma/client";
import { Router } from "express";

const router = Router();
const prisma = new PrismaClient();

/** Lean flat list for POS — only fields the UI needs */
router.get("/items", async (_req, res) => {
  try {
    const items = await prisma.menuItem.findMany({
      where: {
        isAvailable: true,
        category: { isActive: true },
      },
      orderBy: [
        { category: { sortOrder: "asc" } },
        { sortOrder: "asc" },
      ],
      select: {
        id: true,
        name: true,
        description: true,
        imageUrl: true,
        isVeg: true,
        category: { select: { name: true } },
        variants: {
          where: { isDefault: true },
          select: { price: true },
          take: 1,
        },
      },
    });

    res.json(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        imageUrl: item.imageUrl,
        isVeg: item.isVeg,
        category: item.category.name,
        price: item.variants[0]?.price ?? 0,
      }))
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch menu items" });
  }
});

router.get("/pos-view", async (_req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        sortOrder: true,
        items: {
          where: { isAvailable: true },
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            name: true,
            description: true,
            imageUrl: true,
            isVeg: true,
            sortOrder: true,
            variants: {
              where: { isDefault: true },
              select: { id: true, name: true, price: true, isDefault: true },
              take: 1,
            },
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
