import { PrismaClient } from "@prisma/client";
import { Router } from "express";

const router = Router();
const prisma = new PrismaClient();
const BAR_ID = "bar-001";

router.get("/items", async (_req, res) => {
  try {
    const items = await prisma.menuItem.findMany({
      where: { restaurantId: BAR_ID, isAvailable: true, category: { isActive: true } },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      select: {
        id: true,
        name: true,
        isVeg: true,
        menuType: true,
        category: { select: { name: true } },
        variants: {
          select: { id: true, name: true, price: true, isDefault: true },
          orderBy: { price: "asc" },
        },
      },
    });

    res.json(items.map((item) => ({
      id: item.id,
      name: item.name,
      isVeg: item.isVeg,
      menuType: item.menuType,
      category: item.category.name,
      price: item.variants.find((v) => v.isDefault)?.price ?? item.variants[0]?.price ?? 0,
      variants: item.variants,
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch bar menu" });
  }
});

router.get("/pos-view", async (_req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { restaurantId: BAR_ID, isActive: true },
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
            isVeg: true,
            menuType: true,
            sortOrder: true,
            variants: {
              select: { id: true, name: true, price: true, isDefault: true },
              orderBy: { price: "asc" },
            },
          },
        },
      },
    });
    res.json(categories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch bar menu" });
  }
});

export default router;
