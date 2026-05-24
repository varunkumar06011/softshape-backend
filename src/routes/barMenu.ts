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

router.patch("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, isVeg, isAvailable, price } = req.body as {
      name?: string;
      isVeg?: boolean;
      isAvailable?: boolean;
      price?: number;
    };

    const existing = await prisma.menuItem.findUnique({
      where: { id },
      include: { variants: true },
    });
    if (!existing || existing.restaurantId !== BAR_ID) {
      res.status(404).json({ error: "Bar menu item not found" });
      return;
    }

    // Build item-level update payload
    const itemData: Record<string, unknown> = {};
    if (name !== undefined) itemData.name = name;
    if (isVeg !== undefined) itemData.isVeg = isVeg;
    if (isAvailable !== undefined) itemData.isAvailable = isAvailable;

    const updated = await prisma.menuItem.update({
      where: { id },
      data: itemData,
      select: {
        id: true,
        name: true,
        isVeg: true,
        isAvailable: true,
        menuType: true,
        category: { select: { name: true } },
        variants: {
          select: { id: true, name: true, price: true, isDefault: true },
          orderBy: { price: "asc" },
        },
      },
    });

    // If a single price is supplied and the item has exactly one variant, update it
    if (price !== undefined && existing.variants.length === 1) {
      await prisma.menuItemVariant.update({
        where: { id: existing.variants[0].id },
        data: { price },
      });
      // Refresh the updated variant in the response
      const freshVariants = await prisma.menuItemVariant.findMany({
        where: { menuItemId: id },
        select: { id: true, name: true, price: true, isDefault: true },
        orderBy: { price: "asc" },
      });
      res.json({
        id: updated.id,
        name: updated.name,
        isVeg: updated.isVeg,
        isAvailable: updated.isAvailable,
        menuType: updated.menuType,
        category: updated.category.name,
        price: freshVariants.find((v) => v.isDefault)?.price ?? freshVariants[0]?.price ?? 0,
        variants: freshVariants,
      });
      return;
    }

    res.json({
      id: updated.id,
      name: updated.name,
      isVeg: updated.isVeg,
      isAvailable: updated.isAvailable,
      menuType: updated.menuType,
      category: updated.category.name,
      price: updated.variants.find((v) => v.isDefault)?.price ?? updated.variants[0]?.price ?? 0,
      variants: updated.variants,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update bar menu item" });
  }
});

router.patch("/items/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.menuItem.findUnique({ where: { id } });
    if (!existing || existing.restaurantId !== BAR_ID) {
      res.status(404).json({ error: "Bar menu item not found" });
      return;
    }
    const updated = await prisma.menuItem.update({
      where: { id },
      data: { isAvailable: !existing.isAvailable },
    });
    res.json({ id: updated.id, isAvailable: updated.isAvailable });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to toggle availability" });
  }
});

export default router;
