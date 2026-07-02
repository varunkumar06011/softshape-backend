// ─────────────────────────────────────────────────────────────────────────────
// Bar Menu Routes — Liquor menu management with variants and price overrides
// ─────────────────────────────────────────────────────────────────────────────
// Manages the bar/liquor menu: categories, items, variants (30ml/60ml/full bottle),
// and image management. Supports both bar-type and regular restaurant menus.
//
// Features:
//   - CRUD for bar menu items with variants (different pour sizes)
//   - Category management (create, reorder, delete)
//   - Image upload and restore via S3/Cloudflare R2
//   - Price overrides per venue (via PriceProfile system)
//   - Real-time socket updates on menu changes
//   - Cache invalidation on mutations
//   - Optional auth for public menu viewing
//
// Constants:
//   BAR_UNIT_ML = 30 (standard pour size in ml)
//   BAR_FULL_BOTTLE_MULTIPLIER = 25 (full bottle = 25 units of 30ml = 750ml)
//
// Endpoints:
//   GET    /api/bar/menu              — list all bar menu items (optionally by category)
//   POST   /api/bar/menu              — create a new bar menu item
//   PATCH  /api/bar/menu/:id          — update a bar menu item
//   DELETE /api/bar/menu/:id          — soft-delete a bar menu item
//   POST   /api/bar/menu/:id/restore-image — restore item image from backup
//   GET    /api/bar/categories        — list all bar categories
//   POST   /api/bar/categories        — create a category
//   PATCH  /api/bar/categories/:id    — update a category
//   DELETE /api/bar/categories/:id    — delete a category
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import prisma from "../lib/prisma";
import { restoreBarMenuImagesByType } from "../services/restoreBarMenuImages";
import { getIo } from "../socket";
import { cacheMiddleware, invalidateCache } from "../lib/cache";
import { authenticate, optionalAuth } from "../middleware/auth";
import { buildAllVenuePriceMaps, buildVenuePriceMap } from "../lib/priceResolver";

const router = Router();

// Helper: extract the effective restaurantId from the authenticated user
function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}
// Standard bar pour size in milliliters (used for variant pricing calculations)
const BAR_UNIT_ML = 30;
// Full bottle = 25 units of 30ml = 750ml (standard wine/liquor bottle size)
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
  printerTarget: true,
  printerName: true,
  category: { select: { name: true, printerTarget: true } },
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
    printerTarget: item.printerTarget ?? null,
    printerName: item.printerName ?? null,
    category: item.category.name,
    categoryPrinterTarget: item.category.printerTarget ?? null,
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
    const restaurantId = getUserRestaurantId(req) || (req.query.restaurantId as string) || '';
    const items = await prisma.menuItem.findMany({
      where: { restaurantId, isDeleted: false, category: { isActive: true } },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      select: itemSelect,
    });

    // Fetch venue prices for bar items via PriceProfile
    const allVenuePrices = await buildAllVenuePriceMaps(restaurantId);
    const priceMap = new Map<string, Record<string, number>>();
    for (const [venueId, itemPriceMap] of allVenuePrices) {
      for (const [menuItemId, price] of itemPriceMap) {
        const existing = priceMap.get(menuItemId) || {};
        existing[venueId] = price;
        priceMap.set(menuItemId, existing);
      }
    }

    // Fetch per-venue availability
    const venueAvailRecords = await prisma.venueMenuItemAvailability.findMany({
      where: { restaurantId },
      select: { venueId: true, menuItemId: true, isAvailable: true },
    });
    const venueAvailByItem: Record<string, Record<string, boolean>> = {};
    for (const rec of venueAvailRecords) {
      if (!venueAvailByItem[rec.menuItemId]) venueAvailByItem[rec.menuItemId] = {};
      venueAvailByItem[rec.menuItemId][rec.venueId] = rec.isAvailable;
    }

    res.json(items.map((item) => ({
      ...flatItem(item),
      venuePrices: priceMap.get(item.id) || {},
      venueAvailabilities: venueAvailByItem[item.id] || {},
    })));
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch bar menu" });
  }
});

/* ─── GET /pos-view — POS/customer view (only available, non-deleted) ─── */
router.get("/pos-view", optionalAuth, cacheMiddleware("barMenu:pos-view", 5 * 60_000), async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) || (req.query.restaurantId as string) || '';
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
    const { name, category, isVeg, price, menuType, imageUrl, unit, venuePrices, printerTarget, printerName } = req.body as {
      name: string;
      category: string;
      isVeg?: boolean;
      price: number;
      menuType?: "FOOD" | "LIQUOR";
      imageUrl?: string;
      unit?: string;
      venuePrices?: Record<string, number>;
      printerTarget?: string | null;
      printerName?: string | null;
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
        printerTarget: printerTarget ?? null,
        printerName: printerName ?? null,
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

    // Create venue prices if provided (via PriceProfileItem)
    if (venuePrices && typeof venuePrices === "object") {
      const restaurantId = getUserRestaurantId(req) ?? '';
      const venueEntries = Object.entries(venuePrices)
        .filter(([, p]) => Number(p) > 0)
        .map(([venueId, p]) => ({ venueId, menuItemId: created.id, price: Number(p) }));

      // Fetch venues to get their priceProfileId
      const venueIds = venueEntries.map(v => v.venueId);
      const venues = await prisma.venue.findMany({
        where: { id: { in: venueIds }, isDeleted: false },
        select: { id: true, name: true, priceProfileId: true },
      });

      for (const entry of venueEntries) {
        const venue = venues.find(v => v.id === entry.venueId);
        if (!venue) continue;

        let ppId = venue.priceProfileId;
        if (!ppId) {
          const pp = await prisma.priceProfile.create({
            data: { restaurantId, name: venue.name || entry.venueId },
          });
          await prisma.venue.update({
            where: { id: entry.venueId },
            data: { priceProfileId: pp.id },
          });
          ppId = pp.id;
        }

        await prisma.priceProfileItem.upsert({
          where: {
            priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId: entry.menuItemId },
          },
          create: { priceProfileId: ppId, menuItemId: entry.menuItemId, price: entry.price, restaurantId },
          update: { price: entry.price },
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

    // Emit socket event for real-time sync
    try {
      const io = getIo();
      const restaurantId = getUserRestaurantId(req) ?? '';
      io.to(restaurantId).emit("menu-item-updated", {
        itemId: id,
        action: "deleted",
        restaurantId,
      });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", {
        itemId: id,
        action: "deleted",
        restaurantId,
      });
    } catch (e) {
      logger.warn({ err: e }, "[barMenu] Failed to emit delete socket event:");
    }

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
    const { name, category, isVeg, isAvailable, price, imageUrl, menuType, unit, venuePrices, categoryPrinterTarget, printerTarget, printerName } = req.body as {
      name?: string;
      category?: string;
      isVeg?: boolean;
      isAvailable?: boolean;
      price?: number;
      imageUrl?: string;
      menuType?: string;
      unit?: string;
      venuePrices?: Record<string, number>;
      categoryPrinterTarget?: string | null;
      printerTarget?: string | null;
      printerName?: string | null;
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
    if (printerTarget !== undefined) itemData.printerTarget = printerTarget || null;
    if (printerName !== undefined) itemData.printerName = printerName || null;

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

    // Update the category's printerTarget if provided
    if (categoryPrinterTarget !== undefined) {
      const targetCategoryId = category !== undefined
        ? (itemData.categoryId as string)
        : existing.categoryId;
      if (targetCategoryId) {
        await prisma.category.update({
          where: { id: targetCategoryId },
          data: { printerTarget: categoryPrinterTarget || null },
        });
      }
    }

    const updated = await prisma.menuItem.update({
      where: { id },
      data: itemData,
      select: itemSelect,
    });

    // Update venue prices if provided (via PriceProfileItem)
    if (venuePrices && typeof venuePrices === "object") {
      const restaurantId = getUserRestaurantId(req) ?? '';
      const updates = Object.entries(venuePrices)
        .filter(([, p]) => Number(p) >= 0)
        .map(([venueId, p]) => ({ venueId, menuItemId: id, price: Number(p) }));

      const venueIds = updates.map(u => u.venueId);
      const venues = await prisma.venue.findMany({
        where: { id: { in: venueIds }, isDeleted: false },
        select: { id: true, name: true, priceProfileId: true },
      });

      for (const up of updates) {
        const venue = venues.find(v => v.id === up.venueId);
        if (!venue) continue;

        let ppId = venue.priceProfileId;
        if (!ppId) {
          const pp = await prisma.priceProfile.create({
            data: { restaurantId, name: venue.name || up.venueId },
          });
          await prisma.venue.update({
            where: { id: up.venueId },
            data: { priceProfileId: pp.id },
          });
          ppId = pp.id;
        }

        await prisma.priceProfileItem.upsert({
          where: {
            priceProfileId_menuItemId: { priceProfileId: ppId, menuItemId: up.menuItemId },
          },
          create: { priceProfileId: ppId, menuItemId: up.menuItemId, price: up.price, restaurantId },
          update: { price: up.price },
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

    // Emit socket event for real-time sync
    try {
      const io = getIo();
      const restaurantId = getUserRestaurantId(req) ?? '';
      io.to(restaurantId).emit("menu-item-updated", {
        itemId: id,
        action: "updated",
        updatedItem: { id: updated.id, isAvailable: updated.isAvailable },
        restaurantId,
      });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", {
        itemId: id,
        action: "updated",
        updatedItem: { id: updated.id, isAvailable: updated.isAvailable },
        restaurantId,
      });
    } catch (e) {
      logger.warn({ err: e }, "[barMenu] Failed to emit availability socket event:");
    }

    res.json({ id: updated.id, isAvailable: updated.isAvailable });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to toggle availability" });
  }
});

/* ─── PATCH /items/:id/venue-availability — toggle per-venue availability ─── */
router.patch("/items/:id/venue-availability", authenticate, invalidateCache(["barMenu:*"]), async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const { venueId } = req.body as { venueId?: string };
    const restaurantId = getUserRestaurantId(req) ?? '';

    if (!venueId) {
      res.status(400).json({ error: "venueId is required" });
      return;
    }

    const existing = await prisma.menuItem.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Bar menu item not found" });
      return;
    }

    const existingAvail = await prisma.venueMenuItemAvailability.findUnique({
      where: { venueId_menuItemId: { venueId, menuItemId: id } },
    });

    const newValue = existingAvail ? !existingAvail.isAvailable : false;

    const updated = await prisma.venueMenuItemAvailability.upsert({
      where: { venueId_menuItemId: { venueId, menuItemId: id } },
      create: {
        venueId,
        menuItemId: id,
        restaurantId: restaurantId ?? existing.restaurantId,
        isAvailable: newValue,
      },
      update: { isAvailable: newValue },
    });

    try {
      const io = getIo();
      io.to(restaurantId).emit("menu-item-updated", {
        itemId: id,
        action: "updated",
        updatedItem: {
          id,
          venueId,
          isAvailable: existing.isAvailable,
          venueAvailabilities: { [venueId]: newValue },
        },
        restaurantId,
      });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", {
        itemId: id,
        action: "updated",
        updatedItem: {
          id,
          venueId,
          isAvailable: existing.isAvailable,
          venueAvailabilities: { [venueId]: newValue },
        },
        restaurantId,
      });
    } catch (e) {
      logger.warn({ err: e }, "[barMenu] Failed to emit venue availability socket event:");
    }

    res.json({ id: updated.menuItemId, venueId: updated.venueId, isAvailable: updated.isAvailable });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update venue availability" });
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
