import { Router } from "express";
import prisma from "../lib/prisma";
import { getIo } from "../socket";
import { cacheMiddleware, invalidateCache } from "../lib/cache";

const router = Router();

const RESTAURANT_ID = "restaurant-001";
const ADMIN_VENUE_IDS = [
  // Bar venues
  "venue-bar-ac-hall",
  "venue-bar-conference",
  "venue-bar-pdr",
  "venue-bar-rooms",
  "venue-bar-parcel",
  // Restaurant venues
  "venue-family-restaurant",
  "venue-restaurant-parcel",
];

async function upsertVenuePrices(menuItemId: string, venuePrices?: Record<string, number>) {
  if (!venuePrices || typeof venuePrices !== "object") return;

  const updates = Object.entries(venuePrices)
    .filter(([venueId]) => ADMIN_VENUE_IDS.includes(venueId))
    .map(([venueId, rawPrice]) => ({
      venueId,
      menuItemId,
      price: Number(rawPrice) || 0,
    }));

  if (updates.length === 0) return;

  await Promise.all(
    updates.map((p) =>
      prisma.venuePrice.upsert({
        where: { venueId_menuItemId: { venueId: p.venueId, menuItemId: p.menuItemId } },
        create: { venueId: p.venueId, menuItemId: p.menuItemId, price: p.price, isActive: true },
        update: { price: p.price, isActive: true },
      })
    )
  );
}

/** GET /categories — all active categories for admin dropdowns */
router.get("/categories", cacheMiddleware("menu:categories", 120_000), async (req, res) => {
  try {
    const restaurantId = (req.query.restaurantId as string) || RESTAURANT_ID;
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
    const restaurantId = (req.query.restaurantId as string) || RESTAURANT_ID;

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
        venueId: { in: ADMIN_VENUE_IDS },
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
    const restaurantId = (req.query.restaurantId as string) || RESTAURANT_ID;
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

router.patch("/items/:id/availability", invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;

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
router.post("/items", invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
  try {
    const { name, category, isVeg, price, menuType, imageUrl, unit, venuePrices, categoryPrinterTarget } = req.body as {
      name: string;
      category: string;
      isVeg: boolean;
      price: number;
      menuType?: string;
      imageUrl?: string;
      unit?: string;
      venuePrices?: Record<string, number>;
      categoryPrinterTarget?: string | null;
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
    let cat = await prisma.category.findFirst({
      where: {
        restaurantId: RESTAURANT_ID,
        name: { equals: category, mode: "insensitive" },
      },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: { name: category, restaurantId: RESTAURANT_ID, printerTarget: categoryPrinterTarget || null },
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
        restaurantId: RESTAURANT_ID,
        imageUrl: imageUrl ?? null,
        unit: unit ?? null,
        isDeleted: false,
        categoryId: cat.id,
        variants: {
          create: [{ name: "Regular", price, isDefault: true }],
        },
      },
      include: { variants: true, category: true },
    });

    await upsertVenuePrices(item.id, venuePrices);

    // Emit socket event for real-time sync
    try {
      const io = getIo();
      io.emit("menu-item-updated", { 
        itemId: item.id, 
        action: "created",
        updatedItem: item 
      });
    } catch (e) {
      console.warn("[menu] Failed to emit socket event:", e);
    }

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
    const { name, category, isVeg, price, imageUrl, menuType, unit, venuePrices, categoryPrinterTarget } = req.body as {
      name?: string;
      category?: string;
      isVeg?: boolean;
      price?: number;
      imageUrl?: string;
      menuType?: string;
      unit?: string;
      venuePrices?: Record<string, number>;
      categoryPrinterTarget?: string | null;
    };

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId: RESTAURANT_ID, isDeleted: false },
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

    if (category !== undefined) {
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

    await upsertVenuePrices(id, venuePrices);

    // Return the full updated item so the frontend can update state optimistically
    const updatedItem = await prisma.menuItem.findFirst({
      where: { id },
      include: { variants: true, category: true },
    });

    // Emit socket event for real-time sync
    try {
      const io = getIo();
      io.emit("menu-item-updated", { 
        itemId: id, 
        action: "updated",
        updatedItem 
      });
    } catch (e) {
      console.warn("[menu] Failed to emit socket event:", e);
    }

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

    const formData = new FormData();
    formData.append("file", base64);
    formData.append("upload_preset", uploadPreset);

    console.log('Cloudinary payload fields:');
    for (const [key, value] of formData.entries()) {
      console.log(`  ${key}: ${String(value).substring(0, 100)}`);
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

/** GET /api/menu/unified?venue={venue} — Unified menu endpoint for all panels
 * Returns menu items grouped by category with venue-specific pricing
 * venue can be: 'bar', 'restaurant', 'bar-ac-hall', 'bar-conference', 'bar-pdr', 'bar-rooms', 'bar-parcel', 'family-restaurant', 'restaurant-parcel'
 */
router.get("/unified", cacheMiddleware("menu:unified", 60_000), async (req, res) => {
  try {
    const venue = (req.query.venue as string) || "restaurant";
    
    // Map venue names to restaurant IDs and venue IDs for pricing
    let restaurantId = "restaurant-001";
    let venueId = null;
    let applyZeroFilter = false;

    if (venue === "bar" || venue.startsWith("bar-")) {
      restaurantId = "bar-001";
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
      restaurantId = "restaurant-001";
      applyZeroFilter = false;
      const restVenueMap: Record<string, string> = {
        "family-restaurant": "venue-family-restaurant",
        "restaurant-parcel": "venue-restaurant-parcel",
      };
      venueId = restVenueMap[venue] || null;
    } else if (venue === "restaurant") {
      restaurantId = "restaurant-001";
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
      const venuePrices = await (prisma as any).venuePrice.findMany({
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
    const items = await prisma.menuItem.findMany({
      where: { isDeleted: false },
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

export default router;
