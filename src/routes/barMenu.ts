import { PrismaClient } from "@prisma/client";
import { Router } from "express";

const router = Router();
const prisma = new PrismaClient();
const BAR_ID = "bar-001";

/* ─── Shared select for flat-list responses ─── */
const itemSelect = {
  id: true,
  name: true,
  isVeg: true,
  isAvailable: true,
  imageUrl: true,
  menuType: true,
  category: { select: { name: true } },
  variants: {
    select: { id: true, name: true, price: true, isDefault: true },
    orderBy: { price: "asc" as const },
  },
};

function flatItem(item: any) {
  return {
    id: item.id,
    name: item.name,
    isVeg: item.isVeg,
    isAvailable: item.isAvailable,
    imageUrl: item.imageUrl ?? null,
    menuType: item.menuType,
    category: item.category.name,
    price:
      item.variants.find((v: any) => v.isDefault)?.price ??
      item.variants[0]?.price ??
      0,
    variants: item.variants,
  };
}

/* ─── GET /items ─── */
router.get("/items", async (_req, res) => {
  try {
    const items = await prisma.menuItem.findMany({
      where: { restaurantId: BAR_ID, category: { isActive: true } },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      select: itemSelect,
    });

    res.json(items.map(flatItem));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch bar menu" });
  }
});

/* ─── GET /pos-view ─── */
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
            imageUrl: true,
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

/* ─── POST /items — create a new bar menu item ─── */
router.post("/items", async (req, res) => {
  try {
    const { name, category, isVeg, price, menuType, imageUrl } = req.body as {
      name: string;
      category: string;
      isVeg?: boolean;
      price: number;
      menuType?: "FOOD" | "LIQUOR";
      imageUrl?: string;
    };

    if (!name || price === undefined) {
      res.status(400).json({ error: "name and price are required" });
      return;
    }

    // Find or create the category for this bar
    let cat = await prisma.category.findFirst({
      where: {
        restaurantId: BAR_ID,
        name: { equals: category || "General", mode: "insensitive" },
      },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: {
          name: category || "General",
          restaurantId: BAR_ID,
          sortOrder: 999,
        },
      });
    }

    const created = await prisma.menuItem.create({
      data: {
        name,
        isVeg: isVeg ?? true,
        menuType: menuType === "LIQUOR" ? "LIQUOR" : "FOOD",
        imageUrl: imageUrl ?? null,
        restaurantId: BAR_ID,
        categoryId: cat.id,
        variants: {
          create: {
            name: "Regular",
            price: Number(price),
            isDefault: true,
          },
        },
      },
      select: itemSelect,
    });

    res.status(201).json(flatItem(created));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create bar menu item" });
  }
});

/* ─── DELETE /items/:id ─── */
router.delete("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.menuItem.findUnique({ where: { id } });
    if (!existing || existing.restaurantId !== BAR_ID) {
      res.status(404).json({ error: "Bar menu item not found" });
      return;
    }

    // Cascade delete handles variants & addons via Prisma schema
    await prisma.menuItem.delete({ where: { id } });
    res.json({ deleted: true, id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete bar menu item" });
  }
});

/* ─── PATCH /items/:id — update item fields ─── */
router.patch("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, isVeg, isAvailable, price, imageUrl } = req.body as {
      name?: string;
      isVeg?: boolean;
      isAvailable?: boolean;
      price?: number;
      imageUrl?: string;
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
    if (imageUrl !== undefined) itemData.imageUrl = imageUrl;

    const updated = await prisma.menuItem.update({
      where: { id },
      data: itemData,
      select: itemSelect,
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
        ...flatItem(updated),
        price:
          freshVariants.find((v) => v.isDefault)?.price ??
          freshVariants[0]?.price ??
          0,
        variants: freshVariants,
      });
      return;
    }

    res.json(flatItem(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update bar menu item" });
  }
});

/* ─── PATCH /items/:id/availability — toggle ─── */
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
