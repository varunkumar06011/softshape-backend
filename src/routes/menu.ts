import { PrismaClient } from "@prisma/client";
import { Router } from "express";

const router = Router();
const prisma = new PrismaClient();

const RESTAURANT_ID = "restaurant-001";

/** Lean flat list for POS — only fields the UI needs */
router.get("/items", async (req, res) => {
  try {
    const restaurantId = (req.query.restaurantId as string) || RESTAURANT_ID;

    const items = await prisma.menuItem.findMany({
      where: {
        restaurantId,
        isAvailable: true,
        isDeleted: false,
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
        menuType: true,
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
        menuType: item.menuType,
        category: item.category.name,
        price: item.variants[0]?.price ?? 0,
      }))
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch menu items" });
  }
});

router.get("/pos-view", async (req, res) => {
  try {
    const restaurantId = (req.query.restaurantId as string) || RESTAURANT_ID;

    const categories = await prisma.category.findMany({
      where: { restaurantId, isActive: true },
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
            description: true,
            imageUrl: true,
            isVeg: true,
            menuType: true,
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

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId: RESTAURANT_ID, isDeleted: false },
    });
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

/** POST /items — create a new menu item */
router.post("/items", async (req, res) => {
  try {
    const { name, category, isVeg, price, menuType, imageUrl } = req.body as {
      name: string;
      category: string;
      isVeg: boolean;
      price: number;
      menuType?: string;
      imageUrl?: string;
    };

    if (!name || price == null) {
      res.status(400).json({ error: "name and price are required" });
      return;
    }

    // Resolve or create category
    let cat = await prisma.category.findFirst({
      where: {
        restaurantId: RESTAURANT_ID,
        name: { equals: category, mode: "insensitive" },
      },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: { name: category, restaurantId: RESTAURANT_ID },
      });
    }

    const item = await prisma.menuItem.create({
      data: {
        name,
        isVeg: isVeg ?? true,
        menuType: (menuType as any) ?? "FOOD",
        restaurantId: RESTAURANT_ID,
        imageUrl: imageUrl ?? null,
        isDeleted: false,
        categoryId: cat.id,
        variants: {
          create: [{ name: "Regular", price, isDefault: true }],
        },
      },
      include: { variants: true, category: true },
    });

    res.status(201).json(item);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create item" });
  }
});

/** PATCH /items/:id — update name, isVeg, price, imageUrl */
router.patch("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, isVeg, price, imageUrl } = req.body as {
      name?: string;
      isVeg?: boolean;
      price?: number;
      imageUrl?: string;
    };

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId: RESTAURANT_ID, isDeleted: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (isVeg !== undefined) updateData.isVeg = isVeg;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;

    if (Object.keys(updateData).length > 0) {
      await prisma.menuItem.update({ where: { id }, data: updateData });
    }

    if (price !== undefined) {
      const defaultVariant = await prisma.menuItemVariant.findFirst({
        where: { menuItemId: id, isDefault: true },
      });
      const fallbackVariant =
        defaultVariant ??
        (await prisma.menuItemVariant.findFirst({
          where: { menuItemId: id },
          orderBy: { price: "asc" },
        }));
      if (fallbackVariant) {
        await prisma.menuItemVariant.update({
          where: { id: fallbackVariant.id },
          data: { price },
        });
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update item" });
  }
});

/** DELETE /items/:id — soft delete */
router.delete("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId: RESTAURANT_ID, isDeleted: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    await prisma.menuItem.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

/** POST /upload-image — Cloudinary proxy */
router.post("/upload-image", async (req, res) => {
  try {
    const { base64 } = req.body as { base64: string };
    if (!base64) {
      res.status(400).json({ error: "base64 required" });
      return;
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!cloudName || !uploadPreset) {
      res.status(500).json({ error: "Cloudinary not configured on server" });
      return;
    }

    const formData = new URLSearchParams();
    formData.append("file", base64);
    formData.append("upload_preset", uploadPreset);
    formData.append("folder", "restaurant-menu");

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      { method: "POST", body: formData }
    );

    let cloudData;
    try {
      cloudData = await response.json() as any;
    } catch (e) {
      cloudData = { error: "Non-JSON response from Cloudinary" };
    }

    console.log('Cloudinary status:', response.status);
    console.log('Cloudinary response:', JSON.stringify(cloudData));

    if (!response.ok) {
      res.status(502).json({ error: "Cloudinary upload failed", detail: cloudData });
      return;
    }

    res.json({ url: cloudData.secure_url });
  } catch (error) {
    console.error("[Cloudinary] Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

export default router;
