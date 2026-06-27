import { Router } from "express";
import logger from "../lib/logger";
import prisma from "../lib/prisma";
import { restoreBarMenuImagesByType } from "../services/restoreBarMenuImages";
import { getIo } from "../socket";
import { cacheMiddleware, invalidateCache } from "../lib/cache";
import { authenticate, optionalAuth } from "../middleware/auth";

const router = Router();

function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}
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
router.get("/items", optionalAuth, cacheMiddleware("barMenu:items", 5 * 60_000), async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) || '';
    const items = await prisma.menuItem.findMany({
      where: { restaurantId, isDeleted: false, category: { isActive: true } },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      select: itemSelect,
    });

    // Fetch venue prices for bar items
    const itemIds = items.map((i) => i.id);
    const venuePrices = await prisma.venuePrice.findMany({
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
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch bar menu" });
  }
});

/* ─── GET /pos-view — POS/customer view (only available, non-deleted) ─── */
router.get("/pos-view", optionalAuth, cacheMiddleware("barMenu:pos-view", 5 * 60_000), async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) || '';
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
    logger.error({ err: error }, "[GET /api/bar/menu/pos-view]");
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: "Failed to fetch bar menu", detail: msg });
  }
});

/* ─── POST /items — create a new bar menu item ─── */
router.post("/items", authenticate, invalidateCache(["barMenu:*"]), async (req: any, res) => {
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

    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(400).json({ error: "restaurantId is required" });
      return;
    }
    if (!name || price === undefined) {
      res.status(400).json({ error: "name and price are required" });
      return;
    }

    // Find or create the category for this bar
    let cat = await prisma.category.findFirst({
      where: {
        restaurantId,
        name: { equals: category || "General", mode: "insensitive" },
      },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: {
          name: category || "General",
          restaurantId,
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
        restaurantId: getUserRestaurantId(req) ?? '',
        categoryId: cat.id,
        isDeleted: false,
        variants: {
          create: {
            name: "Regular",
            price: Number(price),
            isDefault: true,
            restaurantId: getUserRestaurantId(req) ?? '',
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
          restaurantId: getUserRestaurantId(req) ?? '',
        }));
      if (venuePriceData.length > 0) {
        await prisma.venuePrice.createMany({
          data: venuePriceData,
          skipDuplicates: true,
        });
      }
    }

    res.status(201).json(flatItem(created));

    // Emit socket event for real-time sync
    try {
      const io = getIo();
      const restaurantId = getUserRestaurantId(req) ?? '';
      io.to(restaurantId).emit("menu-item-updated", {
        itemId: created.id,
        action: "created",
        restaurantId,
        updatedItem: flatItem(created)
      });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", {
        itemId: created.id,
        action: "created",
        restaurantId,
        updatedItem: flatItem(created)
      });
    } catch (e) {
      logger.warn({ err: e }, "[barMenu] Failed to emit socket event:");
    }
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create bar menu item" });
  }
});

/* ─── DELETE /items/:id — SOFT DELETE ─── */
router.delete("/items/:id", authenticate, invalidateCache(["barMenu:*"]), async (req: any, res) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.menuItem.findFirst({
      where: { id, isDeleted: false },
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
    logger.error(error);
    res.status(500).json({ error: "Failed to delete bar menu item" });
  }
});

/* ─── PATCH /items/:id — update item fields ─── */
router.patch("/items/:id", authenticate, invalidateCache(["barMenu:*"]), async (req: any, res) => {
  try {
    const id = req.params.id as string;
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
      where: { id, isDeleted: false },
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
          restaurantId: getUserRestaurantId(req) ?? '',
          name: { equals: category || "General", mode: "insensitive" },
        },
      });
      if (!cat) {
        cat = await prisma.category.create({
          data: {
            name: category || "General",
            restaurantId: getUserRestaurantId(req) ?? '',
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
        await prisma.venuePrice.upsert({
          where: { venueId_menuItemId: { venueId: up.venueId, menuItemId: up.menuItemId } },
          create: { venueId: up.venueId, menuItemId: up.menuItemId, price: up.price, isActive: true, restaurantId: getUserRestaurantId(req) ?? '' },
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
      const restaurantId = getUserRestaurantId(req) ?? '';
      io.to(restaurantId).emit("menu-item-updated", {
        itemId: id,
        action: "updated",
        restaurantId,
        updatedItem: responseItem,
      });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", {
        itemId: id,
        action: "updated",
        restaurantId,
        updatedItem: responseItem,
      });
    } catch (e) {
      logger.warn({ err: e }, "[barMenu] Failed to emit socket event:");
    }
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update bar menu item" });
  }
});

/* ─── PATCH /items/:id/availability — toggle availability ─── */
router.patch("/items/:id/availability", authenticate, invalidateCache(["barMenu:*"]), async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.menuItem.findFirst({
      where: { id, isDeleted: false },
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
    logger.error(error);
    res.status(500).json({ error: "Failed to toggle availability" });
  }
});

/* ─── POST /restore-images — re-link Cloudinary URLs for bar menu items ─── */
router.post("/restore-images", authenticate, async (_req, res) => {
  try {
    const result = await restoreBarMenuImagesByType(prisma);
    res.json({ ok: true, ...result });
  } catch (error) {
    logger.error({ err: error }, "[BarMenu] restore-images failed:");
    res.status(500).json({
      error: "Failed to restore bar menu images",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

/* ─── POST /upload-image — Cloudinary unsigned upload proxy ─── */
router.post("/upload-image", authenticate, async (req: any, res) => {
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

    logger.info('Cloudinary payload fields:');
    for (const [key, value] of formData.entries()) {
      logger.info(`  ${key}: ${String(value).substring(0, 100)}`);
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

    if (process.env.NODE_ENV !== 'production') {
      logger.info(`Cloudinary status: ${cloudRes.status}`);
      logger.info(`Cloudinary response: ${JSON.stringify(cloudData)}`);
    }

    if (!cloudRes.ok) {
      res.status(502).json({ error: "Cloudinary upload failed", detail: cloudData });
      return;
    }

    res.json({ url: cloudData.secure_url });
  } catch (error) {
    logger.error({ err: error }, "[Cloudinary] Proxy error:");
    res.status(500).json({ error: "Image upload failed" });
  }
});

export default router;
