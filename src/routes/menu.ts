import { Router } from "express";
import multer from "multer";
import xlsx from "xlsx";

import prisma from "../lib/prisma";

import { getIo } from "../socket";

import { cacheMiddleware, clearCache, invalidateCache } from "../lib/cache";

import { authenticate } from "../middleware/auth";



const router = Router();

// Enforce authentication on any mutating menu route. Read routes remain optional
// so unauthenticated customer-facing menus still work. The /upload endpoint is
// parse-only (no DB writes) so it stays public for the onboarding flow.
router.use((req, res, next) => {
  if (req.method === "GET" || req.path === "/upload") {
    next();
  } else {
    authenticate(req, res, next);
  }
});

function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}

async function upsertVenuePrices(menuItemId: string, restaurantId: string, venuePrices?: Record<string, number>) {
  if (!venuePrices || typeof venuePrices !== "object") return;

  const updates = Object.entries(venuePrices)
    .map(([venueId, rawPrice]) => ({
      venueId,
      menuItemId,
      price: Number(rawPrice) || 0,
    }));

  if (updates.length === 0) return;

  await Promise.all(
    updates.map(async (p) => {
      // Scope to this restaurant to prevent cross-tenant corruption
      const existing = await prisma.venuePrice.findFirst({
        where: { restaurantId, venueId: p.venueId, menuItemId: p.menuItemId },
      });
      if (existing) {
        await prisma.venuePrice.update({
          where: { id: existing.id },
          data: { price: p.price, isActive: true },
        });
      } else {
        await prisma.venuePrice.create({
          data: { venueId: p.venueId, menuItemId: p.menuItemId, price: p.price, isActive: true, restaurantId } as any,
        });
      }
    })
  );
}



/** GET / — structured menu for admin price profiles and other owner-authenticated UIs.
 * Not cached: owner-authenticated responses must not share a cache bucket with public menus.
 */
router.get("/", async (req, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) ?? (req.query.restaurantId as string);
    if (!restaurantId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const categories = await prisma.category.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, sortOrder: true },
    });

    const items = await prisma.menuItem.findMany({
      where: {
        restaurantId,
        isDeleted: false,
        category: { isActive: true },
      },
      select: {
        id: true,
        name: true,
        basePrice: true,
        menuType: true,
        isVeg: true,
        unit: true,
        categoryId: true,
        variants: {
          where: { isDefault: true },
          select: { price: true },
          take: 1,
        },
      },
      orderBy: { sortOrder: "asc" },
    });

    const itemsByCategory = new Map<string, typeof items>();
    for (const item of items) {
      const list = itemsByCategory.get(item.categoryId) || [];
      list.push(item);
      itemsByCategory.set(item.categoryId, list);
    }

    const result = categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: (itemsByCategory.get(c.id) || []).map((i) => ({
        id: i.id,
        name: i.name,
        basePrice: Number(i.basePrice),
        defaultVariantPrice: i.variants[0] ? Number(i.variants[0].price) : null,
        menuType: i.menuType,
        isVeg: i.isVeg,
        unit: i.unit,
      })),
    }));

    return res.json({ categories: result });
  } catch (error: any) {
    console.error("[Menu GET /] Error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

/** GET /categories — all active categories for admin dropdowns */

router.get("/categories", cacheMiddleware("menu:categories", 120_000), async (req, res) => {

  try {

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) ?? "";

    const categories = await prisma.category.findMany({

      where: { restaurantId, isActive: true },

      orderBy: { sortOrder: "asc" },

      select: { id: true, name: true, printerTarget: true, sortOrder: true, isActive: true },

    });

    res.json(categories);

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Failed to fetch categories" });

  }

});



/** Admin list — all non-deleted items including unavailable, for the admin menu table */

router.get("/items/admin", async (req, res) => {

  try {

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) ?? "";

    const items = await prisma.menuItem.findMany({

      where: { restaurantId, isDeleted: false },

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

        isAvailable: true,

        menuType: true,

        unit: true,

        category: { select: { name: true, printerTarget: true } },

        variants: {
          where: { isDefault: true },
          select: { price: true },
          take: 1,
        },

      },

    });



    const venuePriceRows = await prisma.venuePrice.findMany({
      where: {
        isActive: true,
        restaurantId: getUserRestaurantId(req) ?? '',
        menuItemId: { in: items.map((item) => item.id) },
      },
      select: { venueId: true, menuItemId: true, price: true },
    });



    const venuePricesByItem: Record<string, Record<string, number>> = {};

    for (const row of venuePriceRows) {

      if (!venuePricesByItem[row.menuItemId]) venuePricesByItem[row.menuItemId] = {};

      venuePricesByItem[row.menuItemId][row.venueId] = Number(row.price);

    }



    res.json(

      items.map((item) => ({

        id: item.id,

        name: item.name,

        description: item.description,

        imageUrl: item.imageUrl,

        isVeg: item.isVeg,

        isAvailable: item.isAvailable,

        menuType: item.menuType,

        category: item.category.name,

        categoryPrinterTarget: item.category.printerTarget,

        price: item.variants[0]?.price ?? 0,

        unit: (item as any).unit ?? null,

        venuePrices: venuePricesByItem[item.id] ?? {},

      }))

    );

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Failed to fetch admin menu items" });

  }

});



/** Lean flat list for POS — only fields the UI needs */
router.get("/items", cacheMiddleware("menu:items", 60_000), async (req, res) => {
  try {

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string ?? (req.query.restaurantId as string) ?? "";

    const venueId = req.query.venueId as string | undefined;



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

        unit: true,

        category: { select: { name: true } },

        variants: {

          where: { isDefault: true },

          select: { price: true },

          take: 1,

        },

      },

    });



    // If venueId is provided, fetch venue-specific prices

    let venuePriceMap: Record<string, { price: number; isActive: boolean }> = {};

    if (venueId) {

      const venuePrices = await prisma.venuePrice.findMany({

        where: {

          venueId,

          menuItemId: { in: items.map((item) => item.id) },

        },

        select: { menuItemId: true, price: true, isActive: true },

      });



      for (const vp of venuePrices) {

        venuePriceMap[vp.menuItemId] = { price: Number(vp.price), isActive: vp.isActive };

      }

    }



    const filteredItems = items

      .map((item) => {

        let price: number = Number(item.variants[0]?.price ?? 0);

        let shouldShow = true;



        // If venueId is provided, use venue-specific price and filter

        if (venueId) {

          const venuePrice = venuePriceMap[item.id];

          if (venuePrice) {

            price = venuePrice.price;

            shouldShow = venuePrice.isActive && price > 0;

          } else {

            // No venue price record means item not available in this venue

            shouldShow = false;

          }

        }



        if (!shouldShow) return null;



        return {

          id: item.id,

          name: item.name,

          description: item.description,

          imageUrl: item.imageUrl,

          isVeg: item.isVeg,

          menuType: item.menuType,

          category: item.category.name,

          price: price,

          unit: (item as any).unit ?? null,

        };

      })

      .filter((item): item is NonNullable<typeof item> => item !== null);



    res.json(filteredItems);

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Failed to fetch menu items" });

  }

});

router.get("/pos-view", cacheMiddleware("menu:pos-view", 60_000), async (req, res) => {
  try {

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string ?? (req.query.restaurantId as string) ?? "";



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



router.patch("/items/:id/availability", invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;



    const existing = await prisma.menuItem.findFirst({
      where: { id, isDeleted: false },
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

router.post("/items", invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const { name, category, isVeg, price, menuType, imageUrl, unit, venuePrices, categoryPrinterTarget, printerTarget, printerName } = req.body as {

      name: string;

      category: string;

      isVeg: boolean;

      price: number;

      menuType?: string;

      imageUrl?: string;

      unit?: string;

      venuePrices?: Record<string, number>;

      categoryPrinterTarget?: string | null;

      printerTarget?: string | null;

      printerName?: string | null;

    };



    if (!name || price == null) {

      res.status(400).json({ error: "name and price are required" });

      return;

    }



    // Validate unit field length (max 20 characters)

    if (unit && unit.length > 20) {

      res.status(400).json({ error: "unit field must be 20 characters or less" });

      return;

    }



    // Resolve or create category

    const restaurantId = getUserRestaurantId(req) ?? '';

    let cat = await prisma.category.findFirst({

      where: {
        restaurantId,
        name: { equals: category, mode: "insensitive" },
      },

    });

    if (!cat) {

      cat = await prisma.category.create({

        data: { name: category, restaurantId, printerTarget: categoryPrinterTarget || null },

      });

    } else if (categoryPrinterTarget !== undefined) {

      await prisma.category.update({

        where: { id: cat.id },

        data: { printerTarget: categoryPrinterTarget || null },

      });

    }



    const item = await prisma.menuItem.create({
      data: {
        name,
        isVeg: isVeg ?? true,
        menuType: (menuType as any) ?? "FOOD",
        restaurantId: restaurantId ?? '',
        imageUrl: imageUrl ?? null,

        unit: unit ?? null,

        printerTarget: printerTarget ?? null,
        printerName: printerName ?? null,

        isDeleted: false,

        categoryId: cat.id,

        variants: {

          create: [{ name: "Regular", price, isDefault: true }],

        },

      },

      include: { variants: true, category: true },

    });



    await upsertVenuePrices(item.id, restaurantId ?? '', venuePrices);



    // Emit socket event for real-time sync

    try {

      const io = getIo();

      const restaurantId = getUserRestaurantId(req);
      if (restaurantId) {
        io.to(restaurantId).emit("menu-item-updated", {

          itemId: item.id,

          action: "created",

          updatedItem: item,

          restaurantId,

        });
        io.to(`public:${restaurantId}`).emit("menu-item-updated", {

          itemId: item.id,

          action: "created",

          updatedItem: item,

          restaurantId,

        });
      }

    } catch (e) {

      console.warn("[menu] Failed to emit socket event:", e);

    }



    // Clear cache to ensure fresh data on next fetch

    clearCache("menu:");



    res.status(201).json(item);

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Failed to create item" });

  }

});



/** PATCH /items/:id — update name, isVeg, price, imageUrl, unit */

router.patch("/items/:id", invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;

    const { name, category, isVeg, price, imageUrl, menuType, unit, venuePrices, categoryPrinterTarget, printerTarget, printerName } = req.body as {

      name?: string;

      category?: string;

      isVeg?: boolean;

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

    });

    if (!existing) {

      res.status(404).json({ error: "Item not found" });

      return;

    }



    // Validate unit field length (max 20 characters)

    if (unit && unit.length > 20) {

      res.status(400).json({ error: "unit field must be 20 characters or less" });

      return;

    }



    const updateData: any = {};

    if (name !== undefined) updateData.name = name;

    if (isVeg !== undefined) updateData.isVeg = isVeg;

    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;

    if (menuType !== undefined) updateData.menuType = menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD';

    if (unit !== undefined) (updateData as any).unit = unit;

    if (printerTarget !== undefined) updateData.printerTarget = printerTarget || null;
    if (printerName !== undefined) updateData.printerName = printerName || null;



    if (category !== undefined) {

      const restaurantId = getUserRestaurantId(req) ?? '';
      let cat = await prisma.category.findFirst({

        where: {
          restaurantId,
          name: { equals: category, mode: "insensitive" },
        },

      });

      if (!cat) {

        cat = await prisma.category.create({
          data: { name: category, restaurantId },
        });

      }

      updateData.categoryId = cat.id;

    }



    // Update the category's printerTarget if provided

    if (categoryPrinterTarget !== undefined) {

      const targetCategoryId = category !== undefined

        ? updateData.categoryId

        : existing.categoryId;

      if (targetCategoryId) {

        await prisma.category.update({

          where: { id: targetCategoryId },

          data: { printerTarget: categoryPrinterTarget || null },

        });

      }

    }



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



    await upsertVenuePrices(id, getUserRestaurantId(req) ?? '', venuePrices);



    // Return the full updated item so the frontend can update state optimistically

    const updatedItem = await prisma.menuItem.findFirst({

      where: { id },

      include: { variants: true, category: true },

    });



    // Emit socket event for real-time sync

    try {

      const io = getIo();

      const restaurantId = getUserRestaurantId(req);
      if (restaurantId) {
        io.to(restaurantId).emit("menu-item-updated", {

          itemId: id,

          action: "updated",

          updatedItem,

          restaurantId,

        });
        io.to(`public:${restaurantId}`).emit("menu-item-updated", {

          itemId: id,

          action: "updated",

          updatedItem,

          restaurantId,

        });
      }

    } catch (e) {

      console.warn("[menu] Failed to emit socket event:", e);

    }



    // Clear cache to ensure fresh data on next fetch

    clearCache("menu:");



    res.json(updatedItem ?? { ok: true });

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Failed to update item" });

  }

});



/** DELETE /items/:id — soft delete */

router.delete("/items/:id", invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;



    const existing = await prisma.menuItem.findFirst({

      where: { id, isDeleted: false },

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

router.post("/upload-image", authenticate, async (req, res) => {

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



    const formData = new FormData();

    formData.append("file", base64);

    formData.append("upload_preset", uploadPreset);



    if (process.env.NODE_ENV !== 'production') {
      console.log('Cloudinary payload fields:');
      for (const [key, value] of formData.entries()) {
        console.log(`  ${key}: ${String(value).substring(0, 100)}`);
      }
    }



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



    if (process.env.NODE_ENV !== 'production') {
      console.log('Cloudinary status:', response.status);
      console.log('Cloudinary response:', JSON.stringify(cloudData));
    }



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



/** GET /api/menu/public/:slug — Public menu endpoint for customer-facing menus
 *
 * No auth required. Resolves restaurant by slug, returns unified menu.
 * Optionally accepts ?venue= for venue-specific pricing.
 * Also accepts ?tableId= and ?sig= for HMAC verification (returns tableNumber if valid).
 */
router.get("/public/:slug", cacheMiddleware("menu:public", 10_000), async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const venue = String(req.query.venue || "restaurant");
    const tableId = req.query.tableId ? String(req.query.tableId) : undefined;
    const sig = req.query.sig ? String(req.query.sig) : undefined;

    const { resolvePublicRestaurant } = await import("../lib/resolvePublicRestaurant");
    const resolved = await resolvePublicRestaurant(tableId, slug);
    if (!resolved) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const restaurantId = resolved.restaurantId;

    // If tableId + sig provided, verify HMAC signature
    let tableNumber: number | undefined;
    if (tableId && sig) {
      const { verifyTableSignature } = await import("../lib/tableSignature");
      if (!verifyTableSignature(slug, tableId, restaurantId, sig)) {
        return res.status(403).json({ error: "Invalid table signature" });
      }
      const table = await prisma.table.findUnique({
        where: { id: tableId },
        select: { number: true },
      });
      if (table) tableNumber = table.number;
    }

    // Map venue names to venue IDs for pricing
    let venueId: string | null = null;
    let applyZeroFilter = false;

    if (venue === "bar" || venue.startsWith("bar-")) {
      applyZeroFilter = true;
      const barVenueMap: Record<string, string> = {
        bar: "venue-bar-ac-hall",
        "bar-ac-hall": "venue-bar-ac-hall",
        "bar-conference": "venue-bar-conference",
        "bar-pdr": "venue-bar-pdr",
        "bar-rooms": "venue-bar-rooms",
        "bar-parcel": "venue-bar-parcel",
      };
      venueId = barVenueMap[venue] || "venue-bar-ac-hall";
    } else if (["family-restaurant", "restaurant-parcel"].includes(venue)) {
      const restVenueMap: Record<string, string> = {
        "family-restaurant": "venue-family-restaurant",
        "restaurant-parcel": "venue-restaurant-parcel",
      };
      venueId = restVenueMap[venue] || null;
    }

    // Fetch menu items
    const items = await prisma.menuItem.findMany({
      where: {
        restaurantId,
        isAvailable: true,
        isDeleted: false,
        category: { isActive: true },
      },
      include: {
        variants: {
          where: { isDefault: true },
          select: { id: true, name: true, price: true, isDefault: true },
          take: 1,
        },
        category: {
          select: { id: true, name: true, sortOrder: true, printerTarget: true },
        },
      },
      orderBy: [
        { category: { sortOrder: "asc" } },
        { sortOrder: "asc" },
      ],
    });

    // Fetch venue prices if needed
    let venuePriceMap = new Map<string, number>();
    if (venueId) {
      const venuePrices = await prisma.venuePrice.findMany({
        where: { venueId, isActive: true },
      });
      venuePriceMap = new Map(
        venuePrices.map((vp: any) => [vp.menuItemId, Number(vp.price)])
      );
    }

    // Map items to unified format
    const mappedItems = items
      .map((item) => {
        const defaultVariant = item.variants[0];
        const basePrice = Number(defaultVariant?.price ?? 0);

        if (venueId && applyZeroFilter) {
          const venuePrice = venuePriceMap.get(item.id);
          if (venuePrice === undefined || venuePrice <= 0) return null;
        }

        let printerTarget = item.category.printerTarget;
        if (!printerTarget) {
          const categoryLower = item.category.name.toLowerCase();
          if (categoryLower.includes("liquor") || categoryLower.includes("beer") ||
              categoryLower.includes("beverages") || categoryLower.includes("soft drinks") ||
              categoryLower.includes("water") || categoryLower.includes("soda") ||
              categoryLower.includes("juice") || categoryLower.includes("drinks")) {
            printerTarget = "BAR_PRINTER";
          } else {
            printerTarget = "KOT_PRINTER";
          }
        }

        const finalPrice = venueId ? venuePriceMap.get(item.id)! : basePrice;

        return {
          id: item.id,
          name: item.name,
          description: item.description || "",
          image: item.imageUrl || null,
          price: finalPrice,
          basePrice,
          category: item.category.name,
          categoryId: item.category.id,
          categorySort: item.category.sortOrder,
          unit: item.menuType === "LIQUOR" ? "ml" : null,
          mlPerUnit: item.menuType === "LIQUOR" ? 30 : null,
          volume: null,
          printerTarget,
          isVeg: item.isVeg,
          menuType: item.menuType,
          isActive: item.isAvailable,
          variants: item.variants,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    // Group by category
    const grouped = new Map<string, any>();
    for (const item of mappedItems) {
      if (!grouped.has(item.category)) {
        grouped.set(item.category, {
          name: item.category,
          printerTarget: item.printerTarget,
          items: [],
        });
      }
      grouped.get(item.category)!.items.push(item);
    }

    const categories = Array.from(grouped.values()).sort((a, b) => {
      const aSort = a.items[0]?.categorySort ?? 999;
      const bSort = b.items[0]?.categorySort ?? 999;
      return aSort - bSort;
    });

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      venue,
      restaurantId,
      restaurantName: resolved.restaurant.name,
      tableNumber,
      categories,
    });
  } catch (error) {
    console.error("[menu/public]", error);
    res.status(500).json({ error: "Failed to fetch public menu" });
  }
});



/** GET /api/menu/unified?venue={venue} — Unified menu endpoint for all panels

 * Returns menu items grouped by category with venue-specific pricing

 * venue can be: 'bar', 'restaurant', 'bar-ac-hall', 'bar-conference', 'bar-pdr', 'bar-rooms', 'bar-parcel', 'family-restaurant', 'restaurant-parcel'

 */
router.get("/unified", cacheMiddleware("menu:unified", 10_000), async (req, res) => {
  try {

    const venue = (req.query.venue as string) || "restaurant";

    

    // Map venue names to restaurant IDs and venue IDs for pricing

    let restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string || "";

    let venueId = null;

    let applyZeroFilter = false;



    if (venue === "bar" || venue.startsWith("bar-")) {

      restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string || "";

      applyZeroFilter = true;

      const barVenueMap: Record<string, string> = {

        bar: "venue-bar-ac-hall", // default bar venue

        "bar-ac-hall": "venue-bar-ac-hall",

        "bar-conference": "venue-bar-conference",

        "bar-pdr": "venue-bar-pdr",

        "bar-rooms": "venue-bar-rooms",

        "bar-parcel": "venue-bar-parcel",

      };

      venueId = barVenueMap[venue] || "venue-bar-ac-hall";

    } else if (["family-restaurant", "restaurant-parcel"].includes(venue)) {

      restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string || "";

      applyZeroFilter = false;

      const restVenueMap: Record<string, string> = {

        "family-restaurant": "venue-family-restaurant",

        "restaurant-parcel": "venue-restaurant-parcel",

      };

      venueId = restVenueMap[venue] || null;

    } else if (venue === "restaurant") {

      restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string || "";

      venueId = null;

    }

    

    // Fetch menu items from the appropriate restaurant

    const items = await prisma.menuItem.findMany({

      where: {

        restaurantId,

        isAvailable: true,

        isDeleted: false,

        category: { isActive: true },

      },

      include: {

        variants: {

          where: { isDefault: true },

          select: { id: true, name: true, price: true, isDefault: true },

          take: 1,

        },

        category: {

          select: { id: true, name: true, sortOrder: true, printerTarget: true },

        },

      },

      orderBy: [

        { category: { sortOrder: "asc" } },

        { sortOrder: "asc" },

      ],

    });

    

    // If venue pricing is needed, fetch venue prices

    let venuePriceMap = new Map<string, number>();

    if (venueId) {

      const venuePrices = await prisma.venuePrice.findMany({

        where: { venueId, isActive: true },

      });

      venuePriceMap = new Map(

        venuePrices.map((vp: any) => [vp.menuItemId, Number(vp.price)])

      );

    }



    // Map items to unified format with venue-specific pricing

    const mappedItems = items

      .map((item) => {

        const defaultVariant = item.variants[0];

        const basePrice = Number(defaultVariant?.price ?? 0);



        // Strict filtering for bar venues: item MUST have explicit venue price > 0

        // Restaurant venues show all items (no zero filter)

        if (venueId && applyZeroFilter) {

          const venuePrice = venuePriceMap.get(item.id);

          if (venuePrice === undefined || venuePrice <= 0) {

            // No venue price or zero price - exclude this item

            return null;

          }

        }



        // Determine printer target based on category

        // 1. Explicit DB field takes priority

        let printerTarget = item.category.printerTarget;

        // 2. Fallback: category-name heuristic for backwards compat

        if (!printerTarget) {

          const categoryLower = item.category.name.toLowerCase();

          if (categoryLower.includes("liquor") ||

              categoryLower.includes("beer") ||

              categoryLower.includes("beverages") ||

              categoryLower.includes("soft drinks") ||

              categoryLower.includes("water") ||

              categoryLower.includes("soda") ||

              categoryLower.includes("juice") ||

              categoryLower.includes("drinks")) {

            printerTarget = "BAR_PRINTER";

          } else {

            printerTarget = "KOT_PRINTER";

          }

        }



        // ONLY use venue price when venueId is provided, never fall back to base price

        const finalPrice = venueId ? venuePriceMap.get(item.id)! : basePrice;



        return {

          id: item.id,

          name: item.name,

          description: item.description || "",

          image: item.imageUrl || null,

          price: finalPrice,

          basePrice,

          category: item.category.name,

          categoryId: item.category.id,

          categorySort: item.category.sortOrder,

          unit: item.menuType === "LIQUOR" ? "ml" : null,

          mlPerUnit: item.menuType === "LIQUOR" ? 30 : null,

          volume: null,

          printerTarget,

          isVeg: item.isVeg,

          menuType: item.menuType,

          isActive: item.isAvailable,

          variants: item.variants,

        };

      })

      .filter((item): item is NonNullable<typeof item> => item !== null);

    

    // Group by category

    const grouped = new Map<string, any>();

    for (const item of mappedItems) {

      if (!grouped.has(item.category)) {

        grouped.set(item.category, {

          name: item.category,

          printerTarget: item.printerTarget,

          items: [],

        });

      }

      grouped.get(item.category)!.items.push(item);

    }

    

    // Sort categories by sortOrder

    const categories = Array.from(grouped.values()).sort((a, b) => {

      const aSort = a.items[0]?.categorySort ?? 999;

      const bSort = b.items[0]?.categorySort ?? 999;

      return aSort - bSort;

    });

    

    res.set("Cache-Control", "no-store");

    res.json({

      success: true,

      venue,

      restaurantId,

      categories,

    });

  } catch (error) {

    console.error("[menu/unified]", error);

    res.status(500).json({ error: "Failed to fetch unified menu" });

  }

});



/** GET /api/menu/integrity-check — Verify category and printerTarget integrity */

router.get("/integrity-check", async (req, res) => {

  try {

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string ?? (req.query.restaurantId as string) ?? "";

    const items = await prisma.menuItem.findMany({

      where: { restaurantId, isDeleted: false },

      include: { category: true },

    });



    const issues = [];

    const uniqueCategories = new Set();

    const categoryStats: Record<string, number> = {};



    for (const item of items) {

      // Track unique categories

      if (item.category) {

        uniqueCategories.add(item.category.name);

        categoryStats[item.category.name] = (categoryStats[item.category.name] || 0) + 1;

      }



      // Check for null/empty category

      if (!item.category || !item.category.name) {

        issues.push({

          itemId: item.id,

          itemName: item.name,

          issue: "Missing or empty category",

          severity: "high",

        });

      }



      // Check printerTarget based on category

      if (item.category) {

        const catLower = item.category.name.toLowerCase();

        const expectedPrinter = catLower.includes("liquor") ||

          catLower.includes("beer") ||

          catLower.includes("beverages") ||

          catLower.includes("soft drinks") ||

          catLower.includes("water") ||

          catLower.includes("soda") ||

          catLower.includes("juice") ||

          catLower.includes("drinks")

          ? "BAR_PRINTER"

          : "KOT_PRINTER";



        // Note: MenuItem model may not have printerTarget field yet

        // This check is for future validation

      }

    }



    res.set("Cache-Control", "no-store");

    res.json({

      totalItems: items.length,

      uniqueCategories: Array.from(uniqueCategories).sort(),

      categoryStats,

      issues,

      issuesCount: issues.length,

    });

  } catch (error) {

    console.error("[menu/integrity-check]", error);

    res.status(500).json({ error: "Failed to check integrity" });

  }

});

/** POST /api/menu/invalidate-cache — Admin endpoint to force fresh menu fetches */
router.post("/invalidate-cache", (req, res) => {
  clearCache("menu:");
  clearCache("barMenu:");
  console.log("[Menu] Cache invalidated manually");
  res.json({ success: true, message: "Menu cache cleared" });
});

// ==========================================
// Menu Upload (Phase 3)
// ==========================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

function normalizeHeader(header: string): string {
  return header.toString().trim().toLowerCase().replace(/\s+/g, "");
}

function isPureNumber(v: any): boolean {
  return /^\d+(\.\d+)?$/.test(String(v || "").trim());
}

function parsePrice(v: any): number {
  const n = parseFloat(String(v || "").trim().replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}

function isHeaderKeyword(v: any): boolean {
  return /^(s\.?no|itemname|item|rate|price|amount|section|category)$/i.test(normalizeHeader(v));
}

function inferVeg(name: string): boolean {
  const lower = name.toLowerCase();
  const nonVeg = ["chicken", "mutton", "fish", "prawn", "egg", "beef", "pork", "crab", "biryani", "omlet", "kebab"];
  const veg = ["veg", "paneer", "mushroom", "aloo", "gobi", "dal", "corn", "cashew", "kofta", "palak", "kheema"];
  if (nonVeg.some((k) => lower.includes(k))) return false;
  if (veg.some((k) => lower.includes(k))) return true;
  return true;
}

function detectItemHeaderRow(rawMatrix: any[][]): number {
  const keywords = ["itemname", "item", "dish", "name"];
  for (let r = 0; r < Math.min(20, rawMatrix.length); r++) {
    const row = rawMatrix[r] || [];
    for (const cell of row) {
      if (keywords.includes(normalizeHeader(cell))) return r;
    }
  }
  return -1;
}

function parseMultiBlockLayout(
  rawMatrix: any[][],
  headerRowIndex: number,
  warnings: string[]
): { rows: any[]; warnings: string[]; confidence: string } {
  const rows: any[] = [];
  const headerRow = rawMatrix[headerRowIndex] || [];
  const categoryRow = rawMatrix[headerRowIndex - 1] || [];

  // Find item header columns
  const itemHeaderCols: number[] = [];
  for (let c = 0; c < headerRow.length; c++) {
    const n = normalizeHeader(headerRow[c]);
    if (["itemname", "item", "dish", "name"].includes(n)) itemHeaderCols.push(c);
  }

  if (itemHeaderCols.length === 0) {
    return { rows, warnings: [...warnings, "No item columns found in header row"], confidence: "LOW" };
  }

  // Determine block width from consecutive item header distances
  let blockWidth = 4;
  if (itemHeaderCols.length > 1) {
    const counts = new Map<number, number>();
    for (let i = 1; i < itemHeaderCols.length; i++) {
      const d = itemHeaderCols[i] - itemHeaderCols[i - 1];
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    blockWidth = sorted[0][0];
  }

  const maxCol = Math.max(...rawMatrix.map((r) => r?.length || 0));
  const blockStarts: number[] = [];
  for (let s = 0; s <= maxCol; s += blockWidth) blockStarts.push(s);

  // Initialise category for each block from the row above the header row
  const blockCategories: string[] = blockStarts.map((s) => {
    const cat = String(categoryRow[s] || "").trim();
    return cat || "Uncategorized";
  });

  // Process rows from the header row onwards
  for (let r = headerRowIndex; r < rawMatrix.length; r++) {
    const rawRow = rawMatrix[r] || [];
    for (let b = 0; b < blockStarts.length; b++) {
      const start = blockStarts[b];
      const cells = [start, start + 1, start + 2, start + 3].map((c) => String(rawRow[c] || "").trim());
      const isHeaderRow = r === headerRowIndex;

      // Find the first non-empty, non-numeric text cell in the block
      let firstText: string | null = null;
      let firstTextIdx = -1;
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i];
        if (!v) continue;
        if (isPureNumber(v)) continue;
        if (isHeaderRow && isHeaderKeyword(v)) continue;
        firstText = v;
        firstTextIdx = i;
        break;
      }
      if (!firstText) continue;

      // Find the first price after the text cell
      let price = 0;
      for (let i = firstTextIdx + 1; i < cells.length; i++) {
        const p = parsePrice(cells[i]);
        if (p > 0) { price = p; break; }
      }

      if (price === 0) {
        // No price => this is a category header for the block
        blockCategories[b] = firstText;
        continue;
      }

      rows.push({
        category: blockCategories[b],
        name: firstText,
        price,
        isVeg: inferVeg(firstText),
        description: "",
        menuType: inferMenuTypeFromCategory(blockCategories[b]),
      });
    }
  }

  return { rows, warnings, confidence: rows.length > 0 ? "HIGH" : "LOW" };
}

function parseExcelOrCsv(buffer: Buffer): { rows: any[]; warnings: string[]; confidence: string } {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // Get raw 2D array (header: false so we get raw cells)
  const rawMatrix: any[][] = xlsx.utils.sheet_to_json<any[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: true,
  });

  const warnings: string[] = [];

  // Detect multi-block layout: header row is preceded by a category row
  const headerRowIndex = detectItemHeaderRow(rawMatrix);
  if (headerRowIndex > 0) {
    return parseMultiBlockLayout(rawMatrix, headerRowIndex, warnings);
  }

  // ── Standard header-based parsing ──
  return parseStandardExcel(rawMatrix, warnings);
}

function parseStandardExcel(rawMatrix: any[][], warnings: string[]): { rows: any[]; warnings: string[]; confidence: string } {
  const headerMap: Record<string, string> = {
    category: "category", cat: "category", section: "category",
    name: "name", item: "name", itemname: "name", dish: "name",
    price: "price", rate: "price", amount: "price", mrp: "price",
    isveg: "isVeg", veg: "isVeg", vegetarian: "isVeg", type: "isVeg",
    description: "description", desc: "description", details: "description",
    menutype: "menuType", type2: "menuType",
  };

  const rows: any[] = [];
  if (rawMatrix.length < 2) {
    return { rows, warnings: ["Empty sheet"], confidence: "LOW" };
  }

  const headerRow = rawMatrix[0];
  const colMap: Record<number, string> = {};
  for (let c = 0; c < headerRow.length; c++) {
    const normalized = String(headerRow[c] || "").trim().toLowerCase().replace(/\s+/g, "");
    const mapped = headerMap[normalized];
    if (mapped) colMap[c] = mapped;
  }

  for (let i = 1; i < rawMatrix.length; i++) {
    const rawRow = rawMatrix[i];
    if (!rawRow) continue;

    const normalized: Record<string, any> = {};
    for (const [col, field] of Object.entries(colMap)) {
      normalized[field] = rawRow[parseInt(col)];
    }

    if (!normalized.name) {
      warnings.push(`Row ${i + 1}: skipped — no item name found`);
      continue;
    }

    const price = parseFloat(normalized.price);
    if (isNaN(price) || price < 0) {
      warnings.push(`Row ${i + 1}: skipped — invalid price for "${normalized.name}"`);
      continue;
    }

    let isVeg = true;
    if (normalized.isVeg !== undefined) {
      const v = String(normalized.isVeg).trim().toLowerCase();
      isVeg = v === "veg" || v === "true" || v === "1" || v === "yes" || v === "v";
    } else {
      isVeg = inferVeg(String(normalized.name));
    }

    let menuType = "FOOD";
    if (normalized.menuType) {
      const mt = String(normalized.menuType).trim().toUpperCase();
      if (mt === "LIQUOR" || mt === "BAR") menuType = "LIQUOR";
    }

    rows.push({
      category: String(normalized.category || "Uncategorized").trim(),
      name: String(normalized.name).trim(),
      price,
      isVeg,
      description: normalized.description ? String(normalized.description).trim() : "",
      menuType,
    });
  }

  return { rows, warnings, confidence: "HIGH" };
}

const LIQUOR_KEYWORDS = [
  "beer", "whisky", "whiskey", "vodka", "rum", "gin", "brandy",
  "wine", "shots", "cocktail", "mocktail", "liquor", "spirit",
  "draft", "draught",
];

const GARBAGE_KEYWORDS = ["page", "www.", "http", "@", ".com", "fssai", "gstin"];

function isCategoryHeader(line: string): boolean {
  // Has no price anywhere
  if (/\d{2,}/.test(line)) return false;

  const trimmed = line.trim();
  if (trimmed.length <= 2) return false;

  // ALL CAPS with length > 2
  if (trimmed === trimmed.toUpperCase() && trimmed.length > 2) return true;

  // Ends with colon
  if (trimmed.endsWith(":")) return true;

  // Title Case with length > 4 and not a known non-category keyword
  const knownNonCategory = new Set(["page", "menu", "restaurant", "order", "bill", "tax", "total", "subtotal", "date", "time"]);
  const words = trimmed.split(/\s+/);
  const isTitleCase = words.length > 0 && words.every((w) => w.length === 0 || w[0] === w[0].toUpperCase());
  if (isTitleCase && trimmed.length > 4 && !knownNonCategory.has(trimmed.toLowerCase())) return true;

  return false;
}

function inferMenuTypeFromCategory(category: string): string {
  const lower = category.toLowerCase();
  if (LIQUOR_KEYWORDS.some((k) => lower.includes(k))) return "LIQUOR";
  return "FOOD";
}

function extractPrices(line: string): number[] {
  const prices: number[] = [];
  // Match ₹ symbol or plain numbers that look like prices (>= 10 to avoid table numbers)
  const regex = /(?:₹\s*)?(\d{2,5})(?:\s*\/\s*(?:\d{2,5}))?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    prices.push(parseInt(m[1], 10));
  }
  return prices;
}

function extractItemName(line: string, price: number): string {
  // Remove the price occurrence, dotted leaders, and trailing separators
  let name = line
    .replace(/(?:₹\s*)?\d{2,5}(?:\s*\/\s*(?:\d{2,5}))?/g, "")
    .replace(/\.{3,}/g, " ")
    .replace(/[\-–—]+$/, "")
    .replace(/[\-–—]\s*$/, "")
    .trim();
  return name;
}

function isGarbageLine(line: string): boolean {
  if (line.length < 3) return true;
  if (/^[\d\s\W]+$/.test(line)) return true; // only numbers/symbols
  const lower = line.toLowerCase();
  if (GARBAGE_KEYWORDS.some((k) => lower.includes(k))) return true;
  return false;
}

async function parsePdf(buffer: Buffer): Promise<{ rows: any[]; warnings: string[]; confidence: string }> {
  const pdfParseModule: any = await import("pdf-parse");
  const PDFParseClass = pdfParseModule.PDFParse || pdfParseModule.default || pdfParseModule;
  const parser = new PDFParseClass({ data: buffer, verbosity: 0 });
  const result = await parser.getText();
  const text = result.text || "";
  const lines = text.split("\n").map((l: string) => l.trim()).filter(Boolean);

  const warnings: string[] = [];
  const rows: any[] = [];
  let currentCategory = "Uncategorized";

  for (const line of lines) {
    if (isGarbageLine(line)) continue;

    // Category header detection
    if (isCategoryHeader(line)) {
      currentCategory = line.replace(/:$/, "").trim();
      continue;
    }

    const prices = extractPrices(line);
    if (prices.length === 0) continue;

    if (prices.length > 1) {
      // Multi-price / multi-column edge case — split the line
      warnings.push(`Line "${line.slice(0, 80)}" contained multiple prices — please verify extracted items manually.`);

      // Try to split by price occurrences and create separate items
      const parts = line.split(/(?=\d{2,5})/).filter((p: string) => p.trim().length > 0);
      for (const part of parts) {
        const partPrices = extractPrices(part);
        if (partPrices.length === 0) continue;
        const price = partPrices[partPrices.length - 1]; // last price in part
        const name = extractItemName(part, price);
        if (name && name.length >= 2 && price > 0) {
          rows.push({
            category: currentCategory,
            name,
            price,
            isVeg: inferVeg(name),
            description: "",
            menuType: inferMenuTypeFromCategory(currentCategory),
          });
        }
      }
      continue;
    }

    const price = prices[0];
    const name = extractItemName(line, price);
    if (name && name.length >= 2 && price > 0) {
      rows.push({
        category: currentCategory,
        name,
        price,
        isVeg: inferVeg(name),
        description: "",
        menuType: inferMenuTypeFromCategory(currentCategory),
      });
    }
  }

  if (rows.length === 0) {
    warnings.push("No menu items detected in PDF. Please verify the file format.");
  }

  const confidence = rows.length >= 10 ? "HIGH" : rows.length >= 3 ? "MEDIUM" : "LOW";
  if (confidence === "LOW" && rows.length > 0) {
    warnings.push("Only a few items were detected — confidence is LOW. Please review the output.");
  }

  return { rows, warnings, confidence };
}

/** POST /api/menu/upload — parse uploaded file (xlsx, csv, pdf) and return rows */
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const ext = req.file.originalname.toLowerCase().split(".").pop();
    let result: { rows: any[]; warnings: string[]; confidence: string };

    if (ext === "xlsx" || ext === "xls" || ext === "csv") {
      result = parseExcelOrCsv(req.file.buffer);
    } else if (ext === "pdf") {
      result = await parsePdf(req.file.buffer);
    } else {
      return res.status(400).json({ error: `Unsupported file type: .${ext}. Use xlsx, csv, or pdf.` });
    }

    res.json(result);
  } catch (error: any) {
    console.error("[menu/upload]", error);
    res.status(500).json({ error: "Failed to parse file: " + error.message });
  }
});

/** POST /api/menu/bulk-import — create menu items from parsed rows */
router.post("/bulk-import", async (req, res) => {
  try {
    const { rows } = req.body;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array is required" });
    }

    const created: number[] = [];
    const skipped: string[] = [];

    // Group rows by category
    const categoryMap = new Map<string, any[]>();
    for (const row of rows) {
      if (!row.name || typeof row.price !== "number") {
        skipped.push(row.name || "Unknown item");
        continue;
      }
      const cat = row.category || "Uncategorized";
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat)!.push(row);
    }

    for (const [catName, catRows] of categoryMap.entries()) {
      // Upsert category
      let category = await prisma.category.findFirst({
        where: { restaurantId, name: { equals: catName, mode: "insensitive" } },
      });

      if (!category) {
        category = await prisma.category.create({
          data: { name: catName, restaurantId },
        });
      }

      for (const row of catRows) {
        try {
          // Check for duplicate name in same category
          const existing = await prisma.menuItem.findFirst({
            where: { restaurantId, name: { equals: row.name, mode: "insensitive" }, categoryId: category.id },
          });

          if (existing) {
            skipped.push(`${row.name} (duplicate)`);
            continue;
          }

          const menuItem = await prisma.menuItem.create({
            data: {
              name: row.name,
              description: row.description || "",
              basePrice: row.price,
              isVeg: row.isVeg ?? true,
              menuType: row.menuType || "FOOD",
              categoryId: category.id,
              restaurantId,
            },
          });

          // Create default variant
          await prisma.menuItemVariant.create({
            data: {
              name: "Regular",
              price: row.price,
              isDefault: true,
              menuItemId: menuItem.id,
            },
          });

          created.push(1);
        } catch (err: any) {
          skipped.push(`${row.name} (${err.message})`);
        }
      }
    }

    clearCache("menu:");
    clearCache("barMenu:");

    res.json({
      created: created.length,
      skipped,
    });
  } catch (error: any) {
    console.error("[menu/bulk-import]", error);
    res.status(500).json({ error: "Failed to import menu: " + error.message });
  }
});

/** GET /api/menu/recipes/:menuItemId — get recipe for a menu item */
router.get("/recipes/:menuItemId", async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const recipes = await prisma.menuItemRecipe.findMany({
      where: { menuItemId },
      include: { ingredient: true },
    });
    res.json(recipes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/menu/recipes/:menuItemId — set recipe for a menu item */
router.post("/recipes/:menuItemId", async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const { ingredients } = req.body as { ingredients: Array<{ ingredientId: string; quantity: number }> };

    if (!Array.isArray(ingredients)) {
      return res.status(400).json({ error: "ingredients array is required" });
    }

    const menuItem = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
    if (!menuItem) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    // Delete existing recipes and create new ones
    await prisma.menuItemRecipe.deleteMany({ where: { menuItemId } });

    if (ingredients.length > 0) {
      await prisma.menuItemRecipe.createMany({
        data: ingredients.map((ing) => ({
          menuItemId,
          ingredientId: ing.ingredientId,
          quantity: ing.quantity,
          restaurantId: menuItem.restaurantId,
        })),
      });
    }

    res.json({ success: true, count: ingredients.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

