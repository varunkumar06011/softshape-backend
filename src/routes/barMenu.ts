import { Router } from "express";
import { restoreBarMenuImagesByType } from "../services/restoreBarMenuImages";
import prisma from "../lib/prisma";

const router = Router();
const BAR_ID = "bar-001";
const BAR_UNIT_ML = 30;
const BAR_FULL_BOTTLE_MULTIPLIER = 25;

/* ─── Shared select for flat-list responses ─── */
const itemSelect = {
  id: true,
  name: true,
  isVeg: true,
  isAvailable: true,
  isDeleted: true,
  imageUrl: true,
  menuType: true,
  category: { select: { name: true } },
  variants: {
    select: { id: true, name: true, price: true, isDefault: true },
    orderBy: { price: "asc" as const },
  },
};

function flatItem(item: any) {
  const defaultPrice =
    item.variants.find((v: any) => v.isDefault)?.price ??
    item.variants[0]?.price ??
    0;

  const isLiquor = item.menuType === "LIQUOR";
  const isSpirit = isLiquor && item.variants.some((v: any) => v.name === "30ml");
  const isBottleItem = isLiquor && !isSpirit;

  let unitMl: number | null = null;
  let fullBottleQty: number | null = null;
  let fullBottlePrice: number | null = null;

  if (isSpirit) {
    const thirtyMlVariant = item.variants.find((v: any) => v.name === "30ml");
    unitMl = BAR_UNIT_ML;
    fullBottleQty = BAR_FULL_BOTTLE_MULTIPLIER;
    fullBottlePrice = Math.round(Number(thirtyMlVariant?.price ?? defaultPrice) * BAR_FULL_BOTTLE_MULTIPLIER);
  }

  return {
    id: item.id,
    name: item.name,
    isVeg: item.isVeg,
    isAvailable: item.isAvailable,
    imageUrl: item.imageUrl ?? null,
    menuType: item.menuType,
    category: item.category.name,
    price: defaultPrice,
    variants: item.variants,
    unitMl,
    fullBottleQty,
    fullBottlePrice,
    isBottleItem,
  };
}

/* ─── GET /items — admin view (all non-deleted items, including unavailable) ─── */
router.get("/items", async (_req, res) => {
  try {
    const items = await prisma.menuItem.findMany({
      where: { restaurantId: BAR_ID, isDeleted: false, category: { isActive: true } },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      select: itemSelect,
    });

    res.json(items.map(flatItem));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch bar menu" });
  }
});

/* ─── GET /pos-view — POS/customer view (only available, non-deleted) ─── */
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
          where: { isAvailable: true, isDeleted: false },
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

    // Add computed fields for LIQUOR items
    const categoriesWithComputedFields = categories.map((category) => ({
      ...category,
      items: category.items.map((item) => {
        const defaultPrice = Number(
          item.variants.find((v: any) => v.isDefault)?.price ??
          item.variants[0]?.price ??
          0
        );
        const isLiquor = item.menuType === "LIQUOR";
        const isSpirit = isLiquor && item.variants.some((v: any) => v.name === "30ml");
        const isBottleItem = isLiquor && !isSpirit;

        let unitMl: number | null = null;
        let fullBottleQty: number | null = null;
        let fullBottlePrice: number | null = null;

        if (isSpirit) {
          const thirtyMlVariant = item.variants.find((v: any) => v.name === "30ml");
          unitMl = BAR_UNIT_ML;
          fullBottleQty = BAR_FULL_BOTTLE_MULTIPLIER;
          fullBottlePrice = Math.round(Number(thirtyMlVariant?.price ?? defaultPrice) * BAR_FULL_BOTTLE_MULTIPLIER);
        }

        return {
          ...item,
          unitMl,
          fullBottleQty,
          fullBottlePrice,
          isBottleItem,
        };
      }),
    }));

    // Filter out empty categories after items are filtered
    res.json(categoriesWithComputedFields.filter((c) => c.items.length > 0));
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
        isDeleted: false,
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

/* ─── DELETE /items/:id — SOFT DELETE ─── */
router.delete("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId: BAR_ID, isDeleted: false },
    });

    if (!existing) {
      res.status(404).json({ error: "Bar menu item not found" });
      return;
    }

    await prisma.menuItem.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    res.json({ ok: true, id });
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

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId: BAR_ID, isDeleted: false },
      include: { variants: true },
    });
    if (!existing) {
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

/* ─── PATCH /items/:id/availability — toggle availability ─── */
router.patch("/items/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId: BAR_ID, isDeleted: false },
    });
    if (!existing) {
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

/* ─── POST /restore-images — re-link Cloudinary URLs for bar menu items ─── */
router.post("/restore-images", async (_req, res) => {
  try {
    const result = await restoreBarMenuImagesByType(prisma);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("[BarMenu] restore-images failed:", error);
    res.status(500).json({
      error: "Failed to restore bar menu images",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

/* ─── POST /upload-image — Cloudinary unsigned upload proxy ─── */
router.post("/upload-image", async (req, res) => {
  try {
    const { base64 } = req.body as { base64: string };
    if (!base64) {
      res.status(400).json({ error: "base64 image data is required" });
      return;
    }

    const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
    const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!CLOUD_NAME || !UPLOAD_PRESET) {
      res.status(500).json({ error: "Cloudinary not configured on server" });
      return;
    }

    const formData = new FormData();
    formData.append("file", base64);
    formData.append("upload_preset", UPLOAD_PRESET);

    console.log('Cloudinary payload fields:');
    for (const [key, value] of formData.entries()) {
      console.log(`  ${key}: ${String(value).substring(0, 100)}`);
    }

    const cloudRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
      { method: "POST", body: formData }
    );

    let cloudData;
    try {
      cloudData = await cloudRes.json() as any;
    } catch (e) {
      cloudData = { error: "Non-JSON response from Cloudinary" };
    }

    console.log('Cloudinary status:', cloudRes.status);
    console.log('Cloudinary response:', JSON.stringify(cloudData));

    if (!cloudRes.ok) {
      res.status(502).json({ error: "Cloudinary upload failed", detail: cloudData });
      return;
    }

    res.json({ url: cloudData.secure_url });
  } catch (error) {
    console.error("[Cloudinary] Proxy error:", error);
    res.status(500).json({ error: "Image upload failed" });
  }
});

export default router;
