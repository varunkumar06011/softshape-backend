import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { restoreBarMenuImagesByType } from "../services/restoreBarMenuImages";
import { getIo } from "../socket";

const router = Router();
const prisma = new PrismaClient();
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
  unit: true,
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
    unit: item.unit ?? null,
    category: item.category.name,
    price:
      item.variants.find((v: any) => v.isDefault)?.price ??
      item.variants[0]?.price ??
      0,
    variants: item.variants,
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

    // Fetch venue prices for bar items
    const itemIds = items.map((i) => i.id);
    const venuePrices = await (prisma as any).venuePrice.findMany({
      where: { menuItemId: { in: itemIds } },
      select: { menuItemId: true, venueId: true, price: true },
    });
    const priceMap = new Map<string, Record<string, number>>();
    for (const vp of venuePrices) {
      const existing = priceMap.get(vp.menuItemId) || {};
      existing[vp.venueId] = Number(vp.price);
      priceMap.set(vp.menuItemId, existing);
    }

    res.json(items.map((item) => ({
      ...flatItem(item),
      venuePrices: priceMap.get(item.id) || {},
    })));
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
    // Filter out empty categories after items are filtered
    res.json(categories.filter((c) => c.items.length > 0));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch bar menu" });
  }
});

/* ─── POST /items — create a new bar menu item ─── */
router.post("/items", async (req, res) => {
  try {
    const { name, category, isVeg, price, menuType, imageUrl, unit, venuePrices } = req.body as {
      name: string;
      category: string;
      isVeg?: boolean;
      price: number;
      menuType?: "FOOD" | "LIQUOR";
      imageUrl?: string;
      unit?: string;
      venuePrices?: Record<string, number>;
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
        unit: unit ?? null,
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

    // Create venue prices if provided
    if (venuePrices && typeof venuePrices === "object") {
      const venuePriceData = Object.entries(venuePrices)
        .filter(([, p]) => Number(p) > 0)
        .map(([venueId, p]) => ({
          venueId,
          menuItemId: created.id,
          price: Number(p),
          isActive: true,
        }));
      if (venuePriceData.length > 0) {
        await (prisma as any).venuePrice.createMany({
          data: venuePriceData,
          skipDuplicates: true,
        });
      }
    }

    res.status(201).json(flatItem(created));

    // Emit socket event for real-time sync
    try {
      const io = getIo();
      io.emit("menu-item-updated", {
        itemId: created.id,
        action: "created",
        restaurantId: BAR_ID,
        updatedItem: flatItem(created)
      });
    } catch (e) {
      console.warn("[barMenu] Failed to emit socket event:", e);
    }
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
    const { name, category, isVeg, isAvailable, price, imageUrl, menuType, unit, venuePrices } = req.body as {
      name?: string;
      category?: string;
      isVeg?: boolean;
      isAvailable?: boolean;
      price?: number;
      imageUrl?: string;
      menuType?: string;
      unit?: string;
      venuePrices?: Record<string, number>;
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
    if (menuType !== undefined) itemData.menuType = menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD';
    if (unit !== undefined) itemData.unit = unit;

    if (category !== undefined) {
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
      itemData.categoryId = cat.id;
    }

    const updated = await prisma.menuItem.update({
      where: { id },
      data: itemData,
      select: itemSelect,
    });

    // Update venue prices if provided
    if (venuePrices && typeof venuePrices === "object") {
      const updates = Object.entries(venuePrices)
        .filter(([, p]) => Number(p) >= 0)
        .map(([venueId, p]) => ({
          venueId,
          menuItemId: id,
          price: Number(p),
          isActive: true,
        }));
      for (const up of updates) {
        await (prisma as any).venuePrice.upsert({
          where: { venueId_menuItemId: { venueId: up.venueId, menuItemId: up.menuItemId } },
          create: { venueId: up.venueId, menuItemId: up.menuItemId, price: up.price, isActive: true },
          update: { price: up.price, isActive: true },
        });
      }
    }

    // If a single price is supplied and the item has exactly one variant, update it
    let responseItem: any;
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
      responseItem = {
        ...flatItem(updated),
        price:
          freshVariants.find((v) => v.isDefault)?.price ??
          freshVariants[0]?.price ??
          0,
        variants: freshVariants,
      };
    } else {
      responseItem = flatItem(updated);
    }

    res.json(responseItem);

    // Emit socket event for real-time sync
    try {
      const io = getIo();
      io.emit("menu-item-updated", {
        itemId: id,
        action: "updated",
        restaurantId: BAR_ID,
        updatedItem: responseItem,
      });
    } catch (e) {
      console.warn("[barMenu] Failed to emit socket event:", e);
    }
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
