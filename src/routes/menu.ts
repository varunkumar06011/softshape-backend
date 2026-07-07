// ─────────────────────────────────────────────────────────────────────────────
// Menu Routes — Full menu management for restaurants (food + liquor)
// ─────────────────────────────────────────────────────────────────────────────
// The largest route file — manages the complete menu lifecycle:
//   - Category CRUD (food and liquor categories)
//   - Menu item CRUD with variants, images, availability toggles
//   - Bulk import from Excel/CSV files
//   - AI-powered menu parsing from images via Groq API
//   - Section-based menu filtering
//   - Price profile management for venue-specific pricing
//   - Tax profile management
//   - Real-time socket updates on menu changes
//   - Cache invalidation on all mutations
//
// File uploads handled via multer (stored in memory for processing).
// Excel parsing via xlsx library. AI menu parsing via Groq service.
//
// Endpoints (partial list — 40+ endpoints):
//   GET    /api/menu                    — list all menu items (optionally by category/section)
//   POST   /api/menu                    — create a menu item
//   PATCH  /api/menu/:id                — update a menu item
//   DELETE /api/menu/:id                — soft-delete a menu item
//   GET    /api/menu/categories         — list categories
//   POST   /api/menu/categories         — create a category
//   PATCH  /api/menu/categories/:id     — update a category
//   DELETE /api/menu/categories/:id     — delete a category
//   POST   /api/menu/import             — bulk import from Excel/CSV
//   POST   /api/menu/ai-parse           — AI parse menu from image (Groq)
//   GET    /api/menu/price-profiles     — list price profiles
//   POST   /api/menu/price-profiles     — create a price profile
//   GET    /api/menu/tax-profiles       — list tax profiles
//   POST   /api/menu/tax-profiles       — create a tax profile
//   ...and more
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import multer from "multer";
import xlsx from "xlsx";

import prisma from "../lib/prisma";

import { getIo } from "../socket";

import { cacheMiddleware, clearCache, invalidateCache } from "../lib/cache";

import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { parseMenuWithGroq, type ParseResult } from "../services/groqMenuParser";
import { FOOD_CATEGORIES, LIQUOR_CATEGORIES } from "../lib/predefinedCategories";
import { runAutoGenerate } from "../services/recipeEngine";
import { buildVenuePriceMap, buildAllVenuePriceMaps } from "../lib/priceResolver";
import rateLimit from "express-rate-limit";


const router = Router();

// Rate limiter for upload routes — 5 req/min per IP to prevent Groq API bill abuse.
// The sessionId check is not cryptographically meaningful (client-generated UUID);
// the rate limiter is the primary protection. sessionId filters malformed requests.
const menuUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req: any) => req.ip || 'unknown',
  message: { error: 'Too many upload attempts, please wait a minute' },
});

// Enforce authentication + tenant scope on any mutating menu route. Read routes
// remain optional so unauthenticated customer-facing menus still work. The /upload
// endpoints are parse-only (no DB writes) but now have per-route rate limiting.
router.use((req, res, next) => {
  if (req.method === "GET") {
    next();
  } else if (req.path === '/upload' || req.path === '/upload-ai') {
    next();
  } else {
    authenticate(req, res, (err?: any) => {
      if (err) return next(err);
      assertTenantScope(req, res, (err2?: any) => {
        if (err2) return next(err2);
        withTenantContext(req, res, next);
      });
    });
  }
});

function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}

async function getOrganizationOutlets(restaurantId: string): Promise<string[]> {
  try {
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!outlet?.organizationId) return [];
    const outlets = await prisma.outlet.findMany({
      where: { organizationId: outlet.organizationId },
      select: { id: true },
    });
    return outlets.map(o => o.id);
  } catch (err) {
    logger.warn({ err }, '[menu] Failed to resolve organization outlets');
    return [];
  }
}

/**
 * Short-lived in-memory cache for resolveVenueForMenuRead.
 * Keyed by `${restaurantId}:${venueParam}`. 60s TTL — short enough to pick up
 * venue renames/additions quickly, long enough to avoid DB queries on every
 * /unified or /public/:slug call if the HTTP cacheMiddleware is removed.
 */
const venueResolutionCache = new Map<string, { value: { venueId: string | null; applyZeroFilter: boolean }; expiresAt: number }>();
const VENUE_CACHE_TTL_MS = 60_000;

/** Clear the venue resolution cache (call on bulk import, venue edits, etc.) */
function invalidateVenueResolutionCache() {
  venueResolutionCache.clear();
}

/**
 * Resolve a venue query param (e.g. "bar-ac-hall", "bar", "conference") to a
 * venueId string for PriceProfile lookup.
 *
 * Strategy (in order):
 * 1. DB lookup: find a Venue for this restaurant whose name matches the param.
 *    This handles new tenants whose Venue.priceProfileId links to PriceProfileItem.
 * 2. Legacy fallback: hardcoded tag map for existing tenants whose VenuePrice
 *    rows still use "venue-bar-ac-hall" style strings.
 *
 * Returns { venueId, applyZeroFilter } or { venueId: null, applyZeroFilter: false }.
 */
async function resolveVenueForMenuRead(
  venueParam: string,
  restaurantId: string
): Promise<{ venueId: string | null; applyZeroFilter: boolean }> {
  if (!venueParam || venueParam === "restaurant") {
    return { venueId: null, applyZeroFilter: false };
  }

  // Check in-memory cache first
  const cacheKey = `${restaurantId}:${venueParam}`;
  const cached = venueResolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // Determine if this is a bar-type venue (apply zero-price filter)
  const isBarVenue = venueParam === "bar" || venueParam.startsWith("bar-");
  const applyZeroFilter = isBarVenue;

  // 1. Try DB lookup: match Venue.name to the query param
  //    Normalize both sides for comparison
  const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedParam = normalizeForMatch(venueParam);

  const venues = await prisma.venue.findMany({
    where: { restaurantId, isDeleted: false },
    select: { id: true, name: true },
  });

  let result: { venueId: string | null; applyZeroFilter: boolean } = { venueId: null, applyZeroFilter };

  // Try exact normalized match first
  for (const v of venues) {
    if (normalizeForMatch(v.name) === normalizedParam) {
      result = { venueId: v.id, applyZeroFilter };
      break;
    }
  }
  // Try partial match (param contains venue name or vice versa)
  if (result.venueId === null) {
    for (const v of venues) {
      const normVenue = normalizeForMatch(v.name);
      if (normVenue.includes(normalizedParam) || normalizedParam.includes(normVenue)) {
        result = { venueId: v.id, applyZeroFilter };
        break;
      }
    }
  }

  // Also check Section names → sectionTag (legacy path via tables)
  if (result.venueId === null) {
    const sections = await prisma.section.findMany({
      where: { restaurantId },
      select: { id: true, name: true },
    });
    const tables = await prisma.table.findMany({
      where: { restaurantId },
      select: { sectionId: true, sectionTag: true },
      distinct: ["sectionId", "sectionTag"],
    });
    const sectionTagMap = new Map<string, string>();
    for (const t of tables) {
      if (t.sectionTag && !sectionTagMap.has(t.sectionId)) {
        sectionTagMap.set(t.sectionId, t.sectionTag);
      }
    }
    for (const s of sections) {
      const tag = sectionTagMap.get(s.id);
      if (tag) {
        const normTag = normalizeForMatch(tag);
        const normName = normalizeForMatch(s.name);
        if (normTag === normalizedParam || normName === normalizedParam) {
          result = { venueId: tag, applyZeroFilter };
          break;
        }
        if (normTag.includes(normalizedParam) || normalizedParam.includes(normTag) ||
            normName.includes(normalizedParam) || normalizedParam.includes(normName)) {
          result = { venueId: tag, applyZeroFilter };
          break;
        }
      }
    }
  }

  // Legacy fallback: hardcoded tag map for existing tenants
  if (result.venueId === null) {
    const legacyMap: Record<string, string> = {
      bar: "venue-bar-ac-hall",
      "bar-ac-hall": "venue-bar-ac-hall",
      "bar-conference": "venue-bar-conference",
      "bar-pdr": "venue-bar-pdr",
      "bar-rooms": "venue-bar-rooms",
      "bar-parcel": "venue-bar-parcel",
      "family-restaurant": "venue-family-restaurant",
      "restaurant-parcel": "venue-restaurant-parcel",
    };
    const legacyId = legacyMap[venueParam];
    if (legacyId) {
      result = { venueId: legacyId, applyZeroFilter };
    }
  }

  // Cache the result
  venueResolutionCache.set(cacheKey, { value: result, expiresAt: Date.now() + VENUE_CACHE_TTL_MS });

  return result;
}

async function upsertVenuePrices(menuItemId: string, restaurantId: string, venuePrices?: Record<string, number>) {
  if (!venuePrices || typeof venuePrices !== "object") return;

  const updates = Object.entries(venuePrices)
    .map(([venueId, rawPrice]) => ({
      venueId,
      menuItemId,
      price: Number(rawPrice) || 0,
    }))
    .filter(u => u.price > 0);

  if (updates.length === 0) return;

  // Fetch priceProfileId for each venue
  const venueIds = updates.map(u => u.venueId);
  const venues = await prisma.venue.findMany({
    where: { id: { in: venueIds }, isDeleted: false },
    select: { id: true, priceProfileId: true, name: true },
  });

  for (const u of updates) {
    const venue = venues.find(v => v.id === u.venueId);
    if (!venue) continue;

    let priceProfileId = venue.priceProfileId;
    if (!priceProfileId) {
      // Auto-create a profile for this venue
      const pp = await prisma.priceProfile.create({
        data: { restaurantId, name: venue.name || u.venueId },
      });
      await prisma.venue.update({
        where: { id: u.venueId },
        data: { priceProfileId: pp.id },
      });
      priceProfileId = pp.id;
    }

    await prisma.priceProfileItem.upsert({
      where: {
        priceProfileId_menuItemId: {
          priceProfileId,
          menuItemId: u.menuItemId,
        },
      },
      create: {
        priceProfileId,
        menuItemId: u.menuItemId,
        price: u.price,
        restaurantId,
      },
      update: { price: u.price },
    });
  }
}

async function resolveOrCreateCategory(restaurantId: string, categoryName: string, printerTarget?: string | null) {
  let cat = await prisma.category.findFirst({
    where: {
      restaurantId,
      name: { equals: categoryName, mode: "insensitive" },
    },
  });
  if (!cat) {
    cat = await prisma.category.create({
      data: { name: categoryName, restaurantId, printerTarget: printerTarget || null },
    });
  } else if (printerTarget !== undefined) {
    await prisma.category.update({
      where: { id: cat.id },
      data: { printerTarget: printerTarget || null },
    });
  }
  return cat;
}

async function createMenuItemInOutlet(
  restaurantId: string,
  payload: {
    name: string;
    category: string;
    isVeg: boolean;
    price: number;
    menuType?: string;
    imageUrl?: string;
    unit?: string;
    gstEnabled?: boolean;
    isSpecial?: boolean;
    specialChannel?: string;
    specialActive?: boolean;
    specialExpiresAt?: string;
    categoryPrinterTarget?: string | null;
    printerTarget?: string | null;
    printerName?: string | null;
  }
) {
  const cat = await resolveOrCreateCategory(restaurantId, payload.category, payload.categoryPrinterTarget);
  const item = await prisma.menuItem.create({
    data: {
      name: payload.name,
      basePrice: payload.price,
      isVeg: payload.isVeg ?? true,
      gstEnabled: payload.gstEnabled !== false,
      menuType: (payload.menuType as any) ?? "FOOD",
      restaurantId,
      imageUrl: payload.imageUrl ?? null,
      unit: payload.unit ?? null,
      printerTarget: payload.printerTarget ?? null,
      printerName: payload.printerName ?? null,
      isSpecial: payload.isSpecial ?? false,
      specialChannel: (payload.specialChannel && ["CASHIER", "CAPTAIN", "BOTH"].includes(payload.specialChannel.toUpperCase())) ? payload.specialChannel.toUpperCase() : "BOTH",
      specialActive: payload.specialActive !== false,
      specialExpiresAt: payload.specialExpiresAt ? new Date(payload.specialExpiresAt) : null,
      isDeleted: false,
      categoryId: cat.id,
      variants: {
        create: [{ name: "Regular", price: payload.price, isDefault: true, restaurantId }],
      },
    },
    include: { variants: true, category: true },
  });
  return item;
}

async function updateMenuItemByNameInOutlet(
  restaurantId: string,
  itemName: string,
  updateData: any,
  price?: number,
  category?: string
) {
  const sibling = await prisma.menuItem.findFirst({
    where: {
      restaurantId,
      name: { equals: itemName, mode: "insensitive" },
      isDeleted: false,
    },
  });
  if (!sibling) return null;

  const dataToApply = { ...updateData };
  if (category) {
    const cat = await resolveOrCreateCategory(restaurantId, category);
    dataToApply.categoryId = cat.id;
  }

  if (Object.keys(dataToApply).length > 0) {
    await prisma.menuItem.update({ where: { id: sibling.id }, data: dataToApply });
  }

  if (price !== undefined) {
    await prisma.menuItem.update({ where: { id: sibling.id }, data: { basePrice: price } });
    const defaultVariant = await prisma.menuItemVariant.findFirst({
      where: { menuItemId: sibling.id, restaurantId, isDefault: true },
    });
    const fallbackVariant = defaultVariant ?? await prisma.menuItemVariant.findFirst({
      where: { menuItemId: sibling.id, restaurantId },
      orderBy: { price: "asc" },
    });
    if (fallbackVariant) {
      await prisma.menuItemVariant.update({ where: { id: fallbackVariant.id }, data: { price } });
    }
  }

  return sibling;
}

async function upsertSpecialItemInOutlet(
  restaurantId: string,
  payload: {
    name: string;
    category: string;
    isVeg: boolean;
    price: number;
    menuType?: string;
    imageUrl?: string;
    specialChannel?: string;
    specialExpiresAt?: string;
    unit?: string;
  }
) {
  const existing = await prisma.menuItem.findFirst({
    where: {
      restaurantId,
      name: { equals: payload.name, mode: "insensitive" },
      isDeleted: false,
    },
  });

  if (existing) {
    const updateData: any = {
      isSpecial: true,
      specialActive: true,
      isVeg: payload.isVeg ?? true,
      menuType: (payload.menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD') as any,
      imageUrl: payload.imageUrl ?? existing.imageUrl ?? null,
      unit: payload.unit ?? existing.unit ?? null,
    };

    if (payload.specialChannel) {
      const channel = payload.specialChannel.toUpperCase();
      updateData.specialChannel = ["CASHIER", "CAPTAIN", "BOTH"].includes(channel) ? channel : "BOTH";
    }
    if (payload.specialExpiresAt) {
      updateData.specialExpiresAt = new Date(payload.specialExpiresAt);
    } else {
      updateData.specialExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    await prisma.menuItem.update({ where: { id: existing.id }, data: updateData });
    await prisma.menuItem.update({ where: { id: existing.id }, data: { basePrice: payload.price } });

    const defaultVariant = await prisma.menuItemVariant.findFirst({
      where: { menuItemId: existing.id, restaurantId, isDefault: true },
    });
    const fallbackVariant = defaultVariant ?? (await prisma.menuItemVariant.findFirst({
      where: { menuItemId: existing.id, restaurantId },
      orderBy: { price: "asc" },
    }));
    if (fallbackVariant) {
      await prisma.menuItemVariant.update({ where: { id: fallbackVariant.id }, data: { price: payload.price } });
    }

    if (payload.category) {
      const cat = await resolveOrCreateCategory(restaurantId, payload.category);
      await prisma.menuItem.update({ where: { id: existing.id }, data: { categoryId: cat.id } });
    }

    const updated = await prisma.menuItem.findFirst({
      where: { id: existing.id },
      include: { variants: true, category: true },
    });
    if (!updated) throw new Error('Existing item not found after update');
    return updated;
  }

  return createMenuItemInOutlet(restaurantId, {
    ...payload,
    menuType: payload.menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD',
    isSpecial: true,
    specialActive: true,
    specialChannel: payload.specialChannel,
    specialExpiresAt: payload.specialExpiresAt,
  });
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

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) ?? (req.query.restaurantId as string) ?? "";

    const categories = await prisma.category.findMany({

      where: { restaurantId, isActive: true },

      orderBy: { sortOrder: "asc" },

      select: { id: true, name: true, printerTarget: true, sortOrder: true, isActive: true },

    });

    res.json(categories);

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to fetch categories" });

  }

});



/** POST /api/menu/categories — create a new category */
router.post("/categories", authenticate, async (req, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { name, printerTarget } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const trimmedName = name.trim();

    // Check for duplicate (case-insensitive) in same restaurant
    const existing = await prisma.category.findFirst({
      where: {
        restaurantId,
        name: { equals: trimmedName, mode: "insensitive" },
        isActive: true,
      },
    });
    if (existing) {
      return res.status(409).json({ error: "Category with this name already exists" });
    }

    const category = await prisma.category.create({
      data: {
        name: trimmedName,
        printerTarget: printerTarget || null,
        restaurantId,
      },
    });

    clearCache("menu:categories");
    clearCache("menu:");

    res.status(201).json(category);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create category" });
  }
});

/** PATCH /api/menu/categories/:id — rename and/or reorder */
router.patch("/categories/:id", authenticate, async (req, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const { name, sortOrder } = req.body;

    // Verify ownership
    const category = await prisma.category.findFirst({
      where: { id, restaurantId },
    });
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const data: Record<string, any> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Category name cannot be empty" });
      }
      data.name = name.trim();
    }
    if (sortOrder !== undefined) {
      data.sortOrder = Number(sortOrder);
    }

    const updated = await prisma.category.update({
      where: { id },
      data,
    });

    clearCache("menu:categories");
    clearCache("menu:");

    res.json(updated);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update category" });
  }
});

/** DELETE /api/menu/categories/:id — soft delete (block if items attached) */
router.delete("/categories/:id", authenticate, async (req, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;

    // Verify ownership
    const category = await prisma.category.findFirst({
      where: { id, restaurantId },
    });
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    // Count items under this category
    const itemCount = await prisma.menuItem.count({
      where: { categoryId: id, isDeleted: false },
    });

    if (itemCount > 0) {
      return res.status(400).json({
        error: `Category has ${itemCount} item${itemCount !== 1 ? "s" : ""}. Move or delete them first.`,
        itemCount,
      });
    }

    // Soft delete
    await prisma.category.update({
      where: { id },
      data: { isActive: false },
    });

    clearCache("menu:categories");
    clearCache("menu:");

    res.json({ success: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to delete category" });
  }
});



/** Admin list — all non-deleted items including unavailable, for the admin menu table */

router.get("/items/admin", authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {

  try {

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) ?? (req.query.restaurantId as string) ?? "";

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

        gstEnabled: true,

        menuType: true,

        isSpecial: true,

        specialChannel: true,

        specialActive: true,

        specialExpiresAt: true,

        unit: true,

        category: { select: { name: true, printerTarget: true } },

        variants: {
          where: { isDefault: true },
          select: { price: true },
          take: 1,
        },

      },

    });



    const allVenuePrices = await buildAllVenuePriceMaps(getUserRestaurantId(req) ?? '');



    const venuePricesByItem: Record<string, Record<string, number>> = {};

    for (const [venueId, priceMap] of allVenuePrices) {
      for (const [menuItemId, price] of priceMap) {
        if (!venuePricesByItem[menuItemId]) venuePricesByItem[menuItemId] = {};
        venuePricesByItem[menuItemId][venueId] = price;
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



    res.json(

      items.map((item) => ({

        id: item.id,

        name: item.name,

        description: item.description,

        imageUrl: item.imageUrl,

        isVeg: item.isVeg,

        isAvailable: item.isAvailable,

        gstEnabled: item.gstEnabled,

        menuType: item.menuType,

        category: item.category.name,

        categoryPrinterTarget: item.category.printerTarget,

        price: item.variants[0]?.price ?? 0,

        isSpecial: item.isSpecial,

        specialChannel: item.specialChannel,

        specialActive: item.specialActive,

        specialExpiresAt: item.specialExpiresAt,

        unit: (item as any).unit ?? null,

        venuePrices: venuePricesByItem[item.id] ?? {},

        venueAvailabilities: venueAvailByItem[item.id] ?? {},

      }))

    );

  } catch (error) {

    logger.error(error);

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

        gstEnabled: true,

        menuType: true,

        isSpecial: true,

        specialChannel: true,

        specialActive: true,

        specialExpiresAt: true,

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

      const venuePriceMapResult = await buildVenuePriceMap(venueId, getUserRestaurantId(req));

      for (const [menuItemId, price] of venuePriceMapResult) {
        venuePriceMap[menuItemId] = { price, isActive: true };
      }

    }

    // Always fetch all venue price maps so the frontend can resolve prices client-side

    let allVenuePricesByItem: Record<string, Record<string, number>> = {};

    if (!venueId) {

      const allVenuePriceMaps = await buildAllVenuePriceMaps(restaurantId);

      for (const [vid, itemPriceMap] of allVenuePriceMaps) {
        for (const [menuItemId, price] of itemPriceMap) {
          if (!allVenuePricesByItem[menuItemId]) allVenuePricesByItem[menuItemId] = {};
          allVenuePricesByItem[menuItemId][vid] = price;
        }
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

          // Also check venue-specific availability override
          const venueAvail = venueAvailByItem[item.id]?.[venueId];
          if (venueAvail === false) {
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

          gstEnabled: item.gstEnabled,

          menuType: item.menuType,

          category: item.category.name,

          price: price,

          isSpecial: item.isSpecial,

          specialChannel: item.specialChannel,

          specialActive: item.specialActive,

          specialExpiresAt: item.specialExpiresAt,

          unit: (item as any).unit ?? null,

          venuePrices: venueId ? (venuePriceMap[item.id] ? { [venueId]: venuePriceMap[item.id].price } : {}) : (allVenuePricesByItem[item.id] ?? {}),

          venueAvailabilities: venueAvailByItem[item.id] ?? {},

        };

      })

      .filter((item): item is NonNullable<typeof item> => item !== null);



    res.json(filteredItems);

  } catch (error) {

    logger.error(error);

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

    logger.error(error);

    res.status(500).json({ error: "Failed to fetch menu" });

  }

});



router.patch("/items/:id/availability", authenticate, invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;

    const restaurantId = getUserRestaurantId(req);

    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId, isDeleted: false },
    });

    if (!existing) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }



    const updated = await prisma.menuItem.update({

      where: { id },

      data: { isAvailable: !existing.isAvailable },

    });



    // Emit socket event for real-time sync

    try {

      const io = getIo();

      if (restaurantId) {

        io.to(restaurantId).emit("menu-item-updated", {

          itemId: id,

          action: "updated",

          updatedItem: updated,

          restaurantId,

        });

        io.to(`public:${restaurantId}`).emit("menu-item-updated", {

          itemId: id,

          action: "updated",

          updatedItem: updated,

          restaurantId,

        });

      }

    } catch (e) {

      logger.warn({ err: e }, "[menu] Failed to emit availability socket event:");

    }



    res.json(updated);

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to update availability" });

  }

});



/* ─── PATCH /items/:id/venue-availability — toggle per-venue availability ─── */
router.patch("/items/:id/venue-availability", authenticate, invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const { venueId } = req.body as { venueId?: string };
    const restaurantId = getUserRestaurantId(req);

    if (!venueId) {
      res.status(400).json({ error: "venueId is required" });
      return;
    }

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId, isDeleted: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Menu item not found" });
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
      if (restaurantId) {
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
      }
    } catch (e) {
      logger.warn({ err: e }, "[menu] Failed to emit venue availability socket event:");
    }

    res.json({ id: updated.menuItemId, venueId: updated.venueId, isAvailable: updated.isAvailable });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update venue availability" });
  }
});

/* ─── PATCH /items/:id/menu-type — toggle menuType between FOOD and LIQUOR ─── */
// Multi-tenant safe: verifies item belongs to the authenticated user's restaurant.
// Emits menu-item-updated to restaurant room so captain/cashier sync instantly.
router.patch("/items/:id/menu-type", authenticate, invalidateCache(["menu:*", "barMenu:*"]), async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const restaurantId = getUserRestaurantId(req);

    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Tenant scope: item must belong to this restaurant
    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId, isDeleted: false },
      include: { variants: true, category: true },
    });

    if (!existing) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }

    const newMenuType = existing.menuType === "LIQUOR" ? "FOOD" : "LIQUOR";
    const { printerTarget } = req.body;

    const updateData: any = { menuType: newMenuType };
    if (printerTarget !== undefined) updateData.printerTarget = printerTarget || null;

    const updated = await prisma.menuItem.update({
      where: { id },
      data: updateData,
      include: { variants: true, category: true },
    });

    res.json({ id: updated.id, menuType: updated.menuType, updatedItem: updated });

    // Real-time push to all panels for this restaurant
    try {
      const io = getIo();
      const payload = { itemId: id, action: "updated", restaurantId, updatedItem: updated };
      io.to(restaurantId).emit("menu-item-updated", payload);
      io.to(`public:${restaurantId}`).emit("menu-item-updated", payload);
    } catch (e) {
      logger.warn({ err: e }, "[menu] Failed to emit menu-type-changed socket event");
    }
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update menu type" });
  }
});



/** POST /items — create a new menu item */

router.post("/items", authenticate, invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const { name, category, isVeg, price, menuType, imageUrl, unit, venuePrices, categoryPrinterTarget, printerTarget, printerName, gstEnabled, isSpecial, specialChannel, specialActive, specialExpiresAt, syncToAllOutlets } = req.body as {

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

      gstEnabled?: boolean;

      isSpecial?: boolean;

      specialChannel?: string;

      specialActive?: boolean;

      specialExpiresAt?: string;

      syncToAllOutlets?: boolean;

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



    const restaurantId = getUserRestaurantId(req) ?? '';

    const payload = {
      name,
      category,
      isVeg,
      price,
      menuType,
      imageUrl,
      unit,
      gstEnabled,
      isSpecial,
      specialChannel,
      specialActive,
      specialExpiresAt,
      categoryPrinterTarget,
      printerTarget,
      printerName,
    };

    const item = await createMenuItemInOutlet(restaurantId, payload);

    await upsertVenuePrices(item.id, restaurantId, venuePrices);

    // Sync to other outlets in the same organization if requested (e.g., Today Specials across all branches/outlets)
    const syncedItems = [item];
    if (syncToAllOutlets && isSpecial) {
      const otherOutlets = (await getOrganizationOutlets(restaurantId)).filter(id => id !== restaurantId);
      for (const targetId of otherOutlets) {
        try {
          const sibling = await upsertSpecialItemInOutlet(targetId, payload);
          syncedItems.push(sibling);
        } catch (err) {
          logger.warn({ err, targetId, name }, '[menu] Failed to sync special item to outlet');
        }
      }
    }



    // Emit socket event for real-time sync across all synced outlets

    try {

      const io = getIo();

      for (const synced of syncedItems) {
        const rid = synced.restaurantId;
        io.to(rid).emit("menu-item-updated", {
          itemId: synced.id,
          action: "created",
          updatedItem: synced,
          restaurantId: rid,
        });
        io.to(`public:${rid}`).emit("menu-item-updated", {
          itemId: synced.id,
          action: "created",
          updatedItem: synced,
          restaurantId: rid,
        });
      }

    } catch (e) {

      logger.warn({ err: e }, "[menu] Failed to emit socket event:");

    }



    // Clear cache to ensure fresh data on next fetch

    clearCache("menu:");



    res.status(201).json(item);

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to create item" });

  }

});



/** POST /items/bulk-specials — bulk upsert today specials by name, no duplicates */

router.post("/items/bulk-specials", authenticate, invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const { items, syncToAllOutlets } = req.body as {

      items: Array<{

        name: string;

        category: string;

        price: number;

        isVeg?: boolean;

        menuType?: string;

        specialChannel?: string;

      }>;

      syncToAllOutlets?: boolean;

    };

    if (!Array.isArray(items) || items.length === 0) {

      res.status(400).json({ error: "items array is required" });

      return;

    }



    const restaurantId = getUserRestaurantId(req) ?? '';

    const results = [];

    const otherOutlets = syncToAllOutlets

      ? (await getOrganizationOutlets(restaurantId)).filter(id => id !== restaurantId)

      : [];



    for (const item of items) {

      if (!item.name || item.price == null) continue;



      const payload = {

        name: item.name,

        category: item.category || 'Main Course',

        isVeg: item.isVeg !== false,

        price: Number(item.price),

        menuType: item.menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD',

        specialChannel: item.specialChannel || 'BOTH',

      };



      const upserted = await upsertSpecialItemInOutlet(restaurantId, payload);

      results.push(upserted);



      for (const targetId of otherOutlets) {

        try {

          await upsertSpecialItemInOutlet(targetId, payload);

        } catch (err) {

          logger.warn({ err, targetId, name: item.name }, '[menu] Failed to sync bulk special to outlet');

        }

      }

    }



    clearCache("menu:");

    res.status(201).json({ count: results.length, items: results });

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to bulk import specials" });

  }

});



/** PATCH /items/:id — update name, isVeg, price, imageUrl, unit */

router.patch("/items/:id", authenticate, invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;

    const { name, category, isVeg, price, imageUrl, menuType, unit, venuePrices, categoryPrinterTarget, printerTarget, printerName, gstEnabled, isSpecial, specialChannel, specialActive, specialExpiresAt, syncToAllOutlets } = req.body as {

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

      gstEnabled?: boolean;

      isSpecial?: boolean;

      specialChannel?: string;

      specialActive?: boolean;

      specialExpiresAt?: string;

      syncToAllOutlets?: boolean;

    };



    const restaurantId = getUserRestaurantId(req);

    if (!restaurantId) {

      res.status(401).json({ error: "Authentication required" });

      return;

    }



    const existing = await prisma.menuItem.findFirst({

      where: { id, restaurantId, isDeleted: false },

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
    if (gstEnabled !== undefined) updateData.gstEnabled = gstEnabled;

    if (isSpecial !== undefined) updateData.isSpecial = isSpecial;
    if (specialChannel !== undefined) {
      const channel = specialChannel.toUpperCase();
      updateData.specialChannel = ["CASHIER", "CAPTAIN", "BOTH"].includes(channel) ? channel : "BOTH";
    }
    if (specialActive !== undefined) updateData.specialActive = specialActive;
    if (specialExpiresAt !== undefined) updateData.specialExpiresAt = specialExpiresAt ? new Date(specialExpiresAt) : null;



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

      await prisma.menuItem.update({ where: { id }, data: { basePrice: price } });

      const defaultVariant = await prisma.menuItemVariant.findFirst({

        where: { menuItemId: id, restaurantId, isDefault: true },

      });

      const fallbackVariant =

        defaultVariant ??

        (await prisma.menuItemVariant.findFirst({

          where: { menuItemId: id, restaurantId },

          orderBy: { price: "asc" },

        }));

      if (fallbackVariant) {

        await prisma.menuItemVariant.update({

          where: { id: fallbackVariant.id },

          data: { price },

        });

      }

    }



    await upsertVenuePrices(id, restaurantId, venuePrices);

    // Sync update to other outlets in the same organization if requested (special items only)
    if (syncToAllOutlets && (isSpecial || existing.isSpecial)) {
      const otherOutlets = (await getOrganizationOutlets(restaurantId)).filter(id => id !== restaurantId);
      for (const targetId of otherOutlets) {
        try {
          await updateMenuItemByNameInOutlet(targetId, existing.name, updateData, price, category);
        } catch (err) {
          logger.warn({ err, targetId, name: existing.name }, '[menu] Failed to sync special update to outlet');
        }
      }
    }



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

      logger.warn({ err: e }, "[menu] Failed to emit socket event:");

    }



    // Clear cache to ensure fresh data on next fetch

    clearCache("menu:");



    res.json(updatedItem ?? { ok: true });

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to update item" });

  }

});



/** DELETE /items/:id — soft delete */

router.delete("/items/:id", authenticate, invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;

    const restaurantId = getUserRestaurantId(req);

    if (!restaurantId) {

      res.status(401).json({ error: "Authentication required" });

      return;

    }



    const existing = await prisma.menuItem.findFirst({

      where: { id, restaurantId, isDeleted: false },

    });

    if (!existing) {

      res.status(404).json({ error: "Item not found" });

      return;

    }



    await prisma.menuItem.update({

      where: { id },

      data: { isDeleted: true, deletedAt: new Date() },

    });



    // Emit socket event for real-time sync

    try {

      const io = getIo();

      const restaurantId = getUserRestaurantId(req);

      if (restaurantId) {

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

      }

    } catch (e) {

      logger.warn({ err: e }, "[menu] Failed to emit delete socket event:");

    }



    res.json({ ok: true });

  } catch (error) {

    logger.error(error);

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
      logger.info('Cloudinary payload fields:');
      for (const [key, value] of formData.entries()) {
        logger.info(`  ${key}: ${String(value).substring(0, 100)}`);
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
      logger.info(`Cloudinary status: ${response.status}`);
      logger.info(`Cloudinary response: ${JSON.stringify(cloudData)}`);
    }



    if (!response.ok) {

      res.status(502).json({ error: "Cloudinary upload failed", detail: cloudData });

      return;

    }



    res.json({ url: cloudData.secure_url });

  } catch (error) {

    logger.error({ err: error }, "[Cloudinary] Upload error:");

    res.status(500).json({ error: "Upload failed" });

  }

});



/** GET /api/menu/public/:slug — Public menu endpoint for customer-facing menus
 *
 * No auth required. Resolves restaurant by slug, returns unified menu.
 * Optionally accepts ?venue= for venue-specific pricing.
 * Also accepts ?tableId= and ?sig= for HMAC verification (returns tableNumber if valid).
 */
router.get("/public/:slug", cacheMiddleware("menu:public", 60_000), async (req, res) => {
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
        select: {
          number: true,
          section: {
            select: {
              id: true,
              name: true,
              venueId: true,
              venue: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (table) tableNumber = table.number;

      // If the table's section has a real venue, use that for pricing (takes priority over query param)
      if (table?.section?.venue?.id) {
        const tableVenueId = table.section.venue.id;
        const isBarVenue = table.section.venue.name?.toLowerCase().includes("bar") ?? false;
        const resolvedVenueId = tableVenueId;
        const resolvedApplyZeroFilter = isBarVenue;

        // Fetch venue prices using the table's actual venue
        const tableVenuePriceMap = await buildVenuePriceMap(resolvedVenueId, restaurantId);

        // Fetch menu items
        const tableItems = await prisma.menuItem.findMany({
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

        const tableMappedItems = tableItems
          .map((item) => {
            const defaultVariant = item.variants[0];
            const basePrice = Number(defaultVariant?.price ?? 0);

            if (resolvedApplyZeroFilter) {
              const venuePrice = tableVenuePriceMap.get(item.id);
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

            const finalPrice = tableVenuePriceMap.get(item.id) ?? basePrice;

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
        const tableGrouped = new Map<string, any>();
        for (const item of tableMappedItems) {
          if (!tableGrouped.has(item.category)) {
            tableGrouped.set(item.category, {
              name: item.category,
              printerTarget: item.printerTarget,
              items: [],
            });
          }
          tableGrouped.get(item.category)!.items.push(item);
        }

        const tableCategories = Array.from(tableGrouped.values()).sort((a, b) => {
          const aSort = a.items[0]?.categorySort ?? 999;
          const bSort = b.items[0]?.categorySort ?? 999;
          return aSort - bSort;
        });

        res.set("Cache-Control", "no-store");
        return res.json({
          success: true,
          venue: table.section.venue.name || venue,
          restaurantId,
          restaurantName: resolved.restaurant.name,
          tableNumber,
          categories: tableCategories,
        });
      }
    }

    // Map venue names to venue IDs for pricing (DB-driven, with legacy fallback)
    const { venueId, applyZeroFilter } = await resolveVenueForMenuRead(venue, restaurantId);

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
      venuePriceMap = await buildVenuePriceMap(venueId, restaurantId);
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

        const finalPrice = venueId ? (venuePriceMap.get(item.id) ?? basePrice) : basePrice;

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
    logger.error({ err: error }, "[menu/public]");
    res.status(500).json({ error: "Failed to fetch public menu" });
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
    let restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string || "";

    // DB-driven venue resolution (replaces hardcoded barVenueMap)
    const { venueId, applyZeroFilter } = await resolveVenueForMenuRead(venue, restaurantId);

    

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

      venuePriceMap = await buildVenuePriceMap(venueId, restaurantId);

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



        // ONLY use venue price when venueId is provided, fall back to basePrice if no venue price exists

        const finalPrice = venueId ? (venuePriceMap.get(item.id) ?? basePrice) : basePrice;



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

    logger.error({ err: error }, "[menu/unified]");

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

    logger.error({ err: error }, "[menu/integrity-check]");

    res.status(500).json({ error: "Failed to check integrity" });

  }

});

/** POST /api/menu/invalidate-cache — Admin endpoint to force fresh menu fetches */
router.post("/invalidate-cache", authenticate, (req, res) => {
  clearCache("menu:");
  clearCache("barMenu:");
  logger.info("[Menu] Cache invalidated manually");
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

function computeConfidence(rows: any[], warnings: string[]): "HIGH" | "MEDIUM" | "LOW" {
  if (rows.length === 0) return "LOW";
  if (rows.length >= 10 && warnings.length <= 2) return "HIGH";
  if (rows.length >= 3 && warnings.length <= 5) return "MEDIUM";
  return "LOW";
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
  // Liquor items are not food veg/non-veg; treat as non-veg to avoid food classification
  const liquor = ["whisky", "whiskey", "vodka", "rum", "gin", "brandy", "beer", "wine", "absolut", "ballantine", "teacher", "legacy", "chivas", "royal stag", "imperial blue", "old monk", "mcdowell", "kingfisher", "budweiser", "heineken", "corona", "tuborg", "antiquity", "smirnoff", "seagram", "officer"];
  if (liquor.some((k) => keywordMatches(lower, k))) return false;
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

  return { rows, warnings, confidence: computeConfidence(rows, warnings) };
}

// ==========================================
// Rate Card Parser (items × venue price matrix)
// ==========================================

const VENUE_KEYWORDS = [
  "bar", "conference", "pdr", "room", "parcel", "banquet",
  "hall", "ac", "takeaway", "delivery", "gobox", "go box",
  "special", "vedika", "restaurant", "garden", "terrace",
  "rooftop", "family",
];

const VENUE_ALIASES: Record<string, string> = {
  "pdr": "private dining room",
  "gobox": "go box",
  "barac": "bar ac",
  "barachall": "bar ac hall",
  "baracc": "bar ac",
  "parcel": "takeaway",
  "vedika": "vedika banquet hall",
  "specials": "specials",
};

function normalizeVenueName(name: string): string {
  let n = name.toLowerCase().trim();
  n = n.replace(/[^a-z0-9]/g, "");
  // Apply alias if the entire normalized string matches
  if (VENUE_ALIASES[n]) n = VENUE_ALIASES[n].replace(/[^a-z0-9]/g, "");
  // Remove common prefixes
  n = n.replace(/^(venue|bar|restaurant)/g, "");
  return n;
}

function detectRateCardLayout(rawMatrix: any[][]): { isRateCard: boolean; venueHeaderRow: number; venueCols: number[]; itemNameCol: number; itemCodeCol: number; unitCol: number; categoryCol: number; subcategoryCol: number; typeCol: number } {
  const maxScanRows = Math.min(10, rawMatrix.length);
  const maxScanCols = Math.max(...rawMatrix.slice(0, maxScanRows).map(r => r?.length || 0));

  for (let r = 0; r < maxScanRows; r++) {
    const row = rawMatrix[r] || [];
    const venueCols: number[] = [];
    let itemNameCol = -1;
    let itemCodeCol = -1;
    let unitCol = -1;
    let categoryCol = -1;
    let subcategoryCol = -1;
    let typeCol = -1;

    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || "").trim().toLowerCase().replace(/\s+/g, "");
      if (!cell) continue;

      // Check for item name column
      if (["itemname", "item", "dish", "name", "itemnames"].includes(cell)) {
        itemNameCol = c;
        continue;
      }
      // Check for code/sno column
      if (["code", "sno", "s.no", "slno", "slno"].includes(cell) || /^s\.?no$/.test(cell)) {
        itemCodeCol = c;
        continue;
      }
      // Check for unit column
      if (["unit", "qty", "quantity", "pack", "size"].includes(cell)) {
        unitCol = c;
        continue;
      }
      // Check for category/subcategory/type columns (Format B)
      if (cell === "category") { categoryCol = c; continue; }
      if (cell === "subcategory") { subcategoryCol = c; continue; }
      if (cell === "type" || cell === "menutype") { typeCol = c; continue; }

      // Check if this cell looks like a venue name
      const normalized = normalizeVenueName(cell);
      const hasVenueKeyword = VENUE_KEYWORDS.some(kw => cell.includes(kw) || normalized.includes(kw.replace(/[^a-z0-9]/g, "")));
      if (hasVenueKeyword) {
        venueCols.push(c);
      }
    }

    // Also detect venue columns by checking if the column has numeric values in subsequent rows
    // but the header cell is non-numeric text
    if (venueCols.length === 0) {
      // Try detecting by looking at data rows: find columns where header is text but data is numeric
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] || "").trim();
        if (!cell || isPureNumber(cell)) continue;
        // Already identified?
        if (c === itemNameCol || c === itemCodeCol || c === unitCol || c === categoryCol || c === subcategoryCol || c === typeCol) continue;

        // Check if next 3 rows have numeric values in this column
        let numericCount = 0;
        for (let dr = r + 1; dr < Math.min(r + 5, rawMatrix.length); dr++) {
          const val = rawMatrix[dr]?.[c];
          if (val !== undefined && val !== null && String(val).trim() !== "" && isPureNumber(val)) {
            numericCount++;
          }
        }
        if (numericCount >= 2) {
          // This might be a venue column — check if the name has venue-like characteristics
          const cellLower = cell.toLowerCase();
          const hasVenueWord = VENUE_KEYWORDS.some(kw => cellLower.includes(kw));
          if (hasVenueWord || numericCount >= 3) {
            venueCols.push(c);
          }
        }
      }
    }

    // It's a rate card if we found at least 2 venue columns and an item name column
    // (or at least 2 venue columns and text in the first non-numeric column of data rows)
    if (venueCols.length >= 2) {
      // If no explicit item name column, find the first text column that isn't a venue/code/unit
      if (itemNameCol === -1) {
        for (let c = 0; c < row.length; c++) {
          if (venueCols.includes(c) || c === itemCodeCol || c === unitCol || c === categoryCol || c === subcategoryCol || c === typeCol) continue;
          const cell = String(row[c] || "").trim();
          if (cell && !isPureNumber(cell)) {
            itemNameCol = c;
            break;
          }
        }
        // If still not found, look at data rows for the first text column
        if (itemNameCol === -1 && r + 1 < rawMatrix.length) {
          const dataRow = rawMatrix[r + 1] || [];
          for (let c = 0; c < dataRow.length; c++) {
            if (venueCols.includes(c) || c === itemCodeCol || c === unitCol) continue;
            const cell = String(dataRow[c] || "").trim();
            if (cell && !isPureNumber(cell)) {
              itemNameCol = c;
              break;
            }
          }
        }
      }

      if (itemNameCol >= 0) {
        return { isRateCard: true, venueHeaderRow: r, venueCols, itemNameCol, itemCodeCol, unitCol, categoryCol, subcategoryCol, typeCol };
      }
    }
  }

  return { isRateCard: false, venueHeaderRow: -1, venueCols: [], itemNameCol: -1, itemCodeCol: -1, unitCol: -1, categoryCol: -1, subcategoryCol: -1, typeCol: -1 };
}

function parseRateCardMatrix(
  rawMatrix: any[][],
  layout: { venueHeaderRow: number; venueCols: number[]; itemNameCol: number; itemCodeCol: number; unitCol: number; categoryCol: number; subcategoryCol: number; typeCol: number },
  warnings: string[],
  restaurantType?: string
): { rows: any[]; warnings: string[]; confidence: string; mode: string; venueHeaders: string[] } {
  const rows: any[] = [];
  const venueHeaders = layout.venueCols.map(c => String(rawMatrix[layout.venueHeaderRow][c] || "").trim());
  const seenNames = new Set<string>();

  for (let r = layout.venueHeaderRow + 1; r < rawMatrix.length; r++) {
    const rawRow = rawMatrix[r] || [];
    const name = String(rawRow[layout.itemNameCol] || "").trim();

    // Skip empty rows
    if (!name || isPureNumber(name)) {
      // If it's a pure number and the item code col exists, this might be a data row with code in wrong place
      if (layout.itemCodeCol >= 0 && name && isPureNumber(name)) {
        // The "name" is actually a code; check if the next column has text
        const possibleName = String(rawRow[layout.itemNameCol + 1] || "").trim();
        if (possibleName && !isPureNumber(possibleName)) {
          // Adjust: the real item name is one column over
          // This happens in Format A where Code | Name | Unit | ... | venue1 | venue2
          continue; // Skip — we'll handle this with the code col detection below
        }
      }
      continue;
    }

    // Skip garbage lines
    if (isGarbageLine(name)) continue;

    // Skip header-like rows that have prices but aren't real items (e.g. "Item", "Rate", "S.No")
    if (isHeaderKeyword(name)) continue;

    // Skip lines that look like totals/footers
    if (/^(total|subtotal|grand total|sum)/i.test(name)) continue;

    // Detect item name when code column exists and itemNameCol was pointing at code
    let actualName = name;
    let actualUnit = "";

    // If we have a code column, the name column might actually be the code
    // In Format A: col0=code, col1=name, col2=unit, col3=blank, col4+=venues
    // The detector should have found col1 as itemNameCol, but if it found col0, adjust
    if (layout.itemCodeCol >= 0 && layout.itemCodeCol === layout.itemNameCol) {
      // Look for the next text column after the code
      for (let c = layout.itemNameCol + 1; c < rawRow.length; c++) {
        if (layout.venueCols.includes(c)) break;
        const cell = String(rawRow[c] || "").trim();
        if (cell && !isPureNumber(cell)) {
          actualName = cell;
          break;
        }
      }
    }

    if (!actualName || isPureNumber(actualName)) continue;

    // Get unit if available
    if (layout.unitCol >= 0) {
      actualUnit = String(rawRow[layout.unitCol] || "").trim();
    }

    // Get category/subcategory
    let category = "Uncategorized";
    let subcategory = "";
    if (layout.subcategoryCol >= 0) {
      subcategory = String(rawRow[layout.subcategoryCol] || "").trim();
    }
    if (layout.categoryCol >= 0) {
      const cat = String(rawRow[layout.categoryCol] || "").trim();
      category = cat || subcategory || "Uncategorized";
    } else if (subcategory) {
      category = subcategory;
    } else {
      // No category column in sheet — infer from item name
      category = inferCategoryFromName(actualName, restaurantType);
    }

    // Get menu type
    let menuType = "FOOD";
    if (layout.typeCol >= 0) {
      const t = String(rawRow[layout.typeCol] || "").trim().toUpperCase();
      if (t === "LIQUOR" || t === "BAR") menuType = "LIQUOR";
    }
    if (menuType === "FOOD" && category !== "Uncategorized") {
      menuType = inferMenuTypeFromCategory(category);
    }

    // If the item name strongly indicates liquor (brand / volume), override
    if (inferMenuTypeFromCategory(actualName) === "LIQUOR" && !category.toLowerCase().includes("liquor") && !category.toLowerCase().includes("spirit")) {
      category = "Liquor";
      menuType = "LIQUOR";
    }

    // Extract venue prices
    const venuePrices: Record<string, number> = {};
    let allZero = true;
    let minPrice = Infinity;

    for (let i = 0; i < layout.venueCols.length; i++) {
      const col = layout.venueCols[i];
      const venueName = venueHeaders[i];
      const rawPrice = rawRow[col];
      const price = parsePrice(rawPrice);

      if (price > 0) {
        venuePrices[venueName] = price;
        allZero = false;
        if (price < minPrice) minPrice = price;
      }
      // If price is 0 or empty, don't add to venuePrices — this hides the item in that venue
    }

    if (allZero) {
      warnings.push(`Row ${r + 1}: "${actualName}" has all zero/empty prices — will be created but hidden`);
    }

    if (minPrice === Infinity) minPrice = 0;

    // Truncate unit to 20 chars (schema limit: VARCHAR(20))
    if (actualUnit.length > 20) {
      const truncated = actualUnit.substring(0, 20);
      warnings.push(`Row ${r + 1} [${actualName}]: unit truncated from '${actualUnit}' to '${truncated}'`);
      actualUnit = truncated;
    }

    // Check for duplicate names
    const nameLower = actualName.toLowerCase();
    if (seenNames.has(nameLower)) {
      warnings.push(`Row ${r + 1}: duplicate item "${actualName}" — will update existing on import`);
    }
    seenNames.add(nameLower);

    rows.push({
      category: category || "Uncategorized",
      name: actualName,
      price: minPrice,
      isVeg: inferVeg(actualName),
      description: "",
      menuType,
      unit: actualUnit || undefined,
      venuePrices,
      isAvailable: !allZero,
    });
  }

  // Category inference for uncategorized items
  for (const row of rows) {
    if (row.category === "Uncategorized" || !row.category) {
      row.category = inferCategoryFromName(row.name, undefined);
      row.categoryInferred = true;
    }
  }

  return {
    rows,
    warnings,
    confidence: rows.length > 0 ? "HIGH" : "LOW",
    mode: "rate-card",
    venueHeaders,
  };
}

// ==========================================
// Venue Name Resolver
// ==========================================

async function resolveVenueMap(
  headerNames: string[],
  restaurantId: string
): Promise<{ nameToVenueId: Record<string, string>; unmatched: string[] }> {
  // Load all sections (which have sectionTag for legacy mapping) and venues for this restaurant
  const [sections, venues] = await Promise.all([
    prisma.section.findMany({
      where: { restaurantId },
      select: { id: true, name: true, venueId: true },
    }),
    prisma.venue.findMany({
      where: { restaurantId, isDeleted: false },
      select: { id: true, name: true },
    }),
  ]);

  // Build lookup from section names → sectionTag (legacy venueId)
  // We need to get sectionTags from tables since Section doesn't have sectionTag directly
  const tables = await prisma.table.findMany({
    where: { restaurantId },
    select: { sectionId: true, sectionTag: true },
    distinct: ["sectionId", "sectionTag"],
  });

  const sectionTagMap = new Map<string, string>(); // sectionId → sectionTag
  for (const t of tables) {
    if (t.sectionTag && !sectionTagMap.has(t.sectionId)) {
      sectionTagMap.set(t.sectionId, t.sectionTag);
    }
  }

  // Build normalized lookup: normalizedVenueName → venueId (legacy tag or Venue.id)
  // CRITICAL: Legacy tags must be added FIRST so they take priority over Venue.id CUIDs.
  // The /unified and /public/:slug endpoints resolve venueId via PriceProfile (buildVenuePriceMap).
  // Legacy tags are kept for backward compatibility with old-style onboarding data.
  const lookup = new Map<string, string>();

  // 1. Add hardcoded legacy fallbacks first (highest priority for backward compat)
  const legacyFallbacks: Record<string, string> = {
    "barachall": "venue-bar-ac-hall",
    "barac": "venue-bar-ac-hall",
    "bar": "venue-bar-ac-hall",
    "achall": "venue-bar-ac-hall",
    "ac": "venue-bar-ac-hall",
    "conference": "venue-bar-conference",
    "conferencehall": "venue-bar-conference",
    "barconference": "venue-bar-conference",
    "conference2": "venue-bar-conference",
    "pdr": "venue-bar-pdr",
    "barpdr": "venue-bar-pdr",
    "privatediningroom": "venue-bar-pdr",
    "rooms": "venue-bar-rooms",
    "room": "venue-bar-rooms",
    "barrooms": "venue-bar-rooms",
    "parcel": "venue-bar-parcel",
    "barparcel": "venue-bar-parcel",
    "takeaway": "venue-bar-parcel",
    "specials": "venue-bar-conference",
    "special": "venue-bar-conference",
    "vedikabanquethall": "venue-bar-conference",
    "vedika": "venue-bar-conference",
    "banquethall": "venue-bar-conference",
    "familyrestaurant": "venue-family-restaurant",
    "restaurantparcel": "venue-restaurant-parcel",
  };
  for (const [key, tag] of Object.entries(legacyFallbacks)) {
    lookup.set(key, tag);
  }

  // 2. Add legacy section tags from DB (for venues not in the hardcoded fallbacks)
  for (const section of sections) {
    const tag = sectionTagMap.get(section.id);
    if (tag) {
      const normTag = normalizeVenueName(tag);
      const normName = normalizeVenueName(section.name);
      if (!lookup.has(normTag)) lookup.set(normTag, tag);
      if (!lookup.has(normName)) lookup.set(normName, tag);
    }
  }

  // 3. Add modern venue names only if no legacy tag covers them
  for (const venue of venues) {
    const normName = normalizeVenueName(venue.name);
    if (!lookup.has(normName)) {
      lookup.set(normName, venue.id);
    }
    const withoutPrefix = venue.name.toLowerCase().replace(/^(bar|restaurant|venue)\s*/g, "");
    const normNoPrefix = normalizeVenueName(withoutPrefix);
    if (!lookup.has(normNoPrefix)) {
      lookup.set(normNoPrefix, venue.id);
    }
  }

  const nameToVenueId: Record<string, string> = {};
  const unmatched: string[] = [];

  for (const header of headerNames) {
    const normalized = normalizeVenueName(header);
    const match = lookup.get(normalized);

    if (match) {
      nameToVenueId[header] = match;
    } else {
      // Try partial matching: check if any lookup key contains the normalized header or vice versa
      let partialMatch: string | null = null;
      for (const [key, value] of lookup.entries()) {
        if (key.includes(normalized) || normalized.includes(key)) {
          partialMatch = value;
          break;
        }
      }
      if (partialMatch) {
        nameToVenueId[header] = partialMatch;
      } else {
        unmatched.push(header);
      }
    }
  }

  return { nameToVenueId, unmatched };
}

function parseExcelOrCsv(buffer: Buffer, restaurantType?: string): { rows: any[]; warnings: string[]; confidence: string; mode?: string; venueHeaders?: string[] } {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // Get raw 2D array (header: false so we get raw cells)
  const rawMatrix: any[][] = xlsx.utils.sheet_to_json<any[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: true,
  });

  const warnings: string[] = [];

  // First: detect rate card layout (items × venue price matrix)
  const rateCardLayout = detectRateCardLayout(rawMatrix);
  if (rateCardLayout.isRateCard) {
    const result = parseRateCardMatrix(rawMatrix, rateCardLayout, warnings, restaurantType);
    return result;
  }

  // Detect multi-block layout: header row is preceded by a category row
  const headerRowIndex = detectItemHeaderRow(rawMatrix);
  let result: { rows: any[]; warnings: string[]; confidence: string };
  if (headerRowIndex > 0) {
    result = parseMultiBlockLayout(rawMatrix, headerRowIndex, warnings);
  } else {
    // ── Standard header-based parsing ──
    result = parseStandardExcel(rawMatrix, warnings);
  }

  // Shared category inference pass: replace Uncategorized/empty with inferred category
  for (const row of result.rows) {
    if (row.category === "Uncategorized" || !row.category) {
      row.category = inferCategoryFromName(row.name, restaurantType);
      row.categoryInferred = true;
    }
  }

  return { ...result, mode: "standard" };
}

function parseStandardExcel(rawMatrix: any[][], warnings: string[]): { rows: any[]; warnings: string[]; confidence: string } {
  const headerMap: Record<string, string> = {
    category: "category", cat: "category", section: "category",
    name: "name", item: "name", itemname: "name", dish: "name",
    price: "price", rate: "price", amount: "price", mrp: "price",
    halfprice: "halfPrice", fullprice: "fullPrice", half: "halfPrice", full: "fullPrice",
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
    if (mapped) {
      colMap[c] = mapped;
    } else {
      // Fuzzy match: check if header contains price-related keywords
      if (/price|rate|amount|mrp|cost|₹|rs\.?|rupee/i.test(String(headerRow[c] || ""))) {
        colMap[c] = "price";
      }
    }
  }

  // Auto-detect price column if none mapped: find first numeric column after name column
  if (!Object.values(colMap).includes("price") && !Object.values(colMap).includes("halfPrice")) {
    const nameCol = Object.entries(colMap).find(([, v]) => v === "name")?.[0];
    const startCol = nameCol !== undefined ? parseInt(nameCol) + 1 : 0;
    for (let c = startCol; c < (headerRow?.length || 0); c++) {
      if (colMap[c]) continue; // skip already-mapped columns
      let numericCount = 0;
      let sampleCount = 0;
      for (let r = 1; r < Math.min(15, rawMatrix.length); r++) {
        const val = rawMatrix[r]?.[c];
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          sampleCount++;
          if (isPureNumber(String(val).trim()) || parsePrice(val) > 0) numericCount++;
        }
      }
      if (sampleCount >= 3 && numericCount / sampleCount >= 0.8) {
        colMap[c] = "price";
        break;
      }
    }
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

    // Detect half/full variant pricing from dedicated columns or X/Y format in price cell
    let variants: any[] | undefined;
    let price: number;

    const halfPrice = normalized.halfPrice !== undefined ? parsePrice(normalized.halfPrice) : NaN;
    const fullPrice = normalized.fullPrice !== undefined ? parsePrice(normalized.fullPrice) : NaN;

    if (!isNaN(halfPrice) && !isNaN(fullPrice) && halfPrice > 0 && fullPrice > 0) {
      price = Math.min(halfPrice, fullPrice);
      variants = [
        { name: "Half", price: Math.min(halfPrice, fullPrice), isDefault: true },
        { name: "Full", price: Math.max(halfPrice, fullPrice), isDefault: false },
      ];
    } else {
      // Check for X/Y format in the price cell
      const priceStr = String(normalized.price || "").trim();
      const slashMatch = priceStr.match(/^\s*₹?\s*(\d{2,5})\s*\/\s*(\d{2,5})\s*$/);
      if (slashMatch) {
        const p1 = parseInt(slashMatch[1], 10);
        const p2 = parseInt(slashMatch[2], 10);
        price = Math.min(p1, p2);
        variants = [
          { name: "Half", price: Math.min(p1, p2), isDefault: true },
          { name: "Full", price: Math.max(p1, p2), isDefault: false },
        ];
      } else {
        price = parsePrice(normalized.price);
      }
    }

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
      ...(variants ? { variants } : {}),
    });
  }

  // Post-processing: merge rows that differ only by Half/Full suffix
  const halfSuffix = /\s+half$/i;
  const fullSuffix = /\s+full$/i;
  const merged: any[] = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < rows.length; i++) {
    if (usedIndices.has(i)) continue;
    const row = rows[i];
    const nameLower = row.name.toLowerCase();

    if (halfSuffix.test(nameLower)) {
      const baseName = row.name.replace(/\s+half$/i, "").trim();
      // Find matching Full row in same category
      let fullIdx = -1;
      for (let j = 0; j < rows.length; j++) {
        if (j === i || usedIndices.has(j)) continue;
        const other = rows[j];
        if (other.category !== row.category) continue;
        const otherLower = other.name.toLowerCase();
        if (fullSuffix.test(otherLower) && other.name.replace(/\s+full$/i, "").trim().toLowerCase() === baseName.toLowerCase()) {
          fullIdx = j;
          break;
        }
      }
      if (fullIdx >= 0) {
        usedIndices.add(i);
        usedIndices.add(fullIdx);
        const fullRow = rows[fullIdx];
        merged.push({
          ...row,
          name: baseName,
          price: Math.min(row.price, fullRow.price),
          variants: [
            { name: "Half", price: row.price, isDefault: true },
            { name: "Full", price: fullRow.price, isDefault: false },
          ],
        });
        continue;
      }
    }

    if (fullSuffix.test(nameLower)) {
      const baseName = row.name.replace(/\s+full$/i, "").trim();
      // Check if a matching Half row already consumed this Full row
      let halfIdx = -1;
      for (let j = 0; j < rows.length; j++) {
        if (j === i || usedIndices.has(j)) continue;
        const other = rows[j];
        if (other.category !== row.category) continue;
        const otherLower = other.name.toLowerCase();
        if (halfSuffix.test(otherLower) && other.name.replace(/\s+half$/i, "").trim().toLowerCase() === baseName.toLowerCase()) {
          halfIdx = j;
          break;
        }
      }
      if (halfIdx >= 0) {
        // The Half row will handle the merge — skip this Full row
        usedIndices.add(i);
        continue;
      }
    }

    merged.push(row);
  }

  return { rows: merged, warnings, confidence: computeConfidence(merged, warnings) };
}

const LIQUOR_KEYWORDS = [
  "beer", "whisky", "whiskey", "vodka", "rum", "gin", "brandy",
  "wine", "shots", "cocktail", "mocktail", "liquor", "spirit",
  "draft", "draught",
  // Volume / bottle-size indicators
  "30ml", "60ml", "90ml", "120ml", "180ml", "375ml", "750ml", "1ltr", "1 ltr",
  "pint", "quart", "nip", "miniature", "peg", "full", "half", "bottle", "ml", "ltr",
  // Common Indian/international liquor brands
  "absolut", "ballantine", "ballantines", "teacher", "teachers", "legacy",
  "black & white", "black and white", "johnnie walker", "jack daniel", "jack daniels",
  "chivas", "chivas regal", "royal stag", "imperial blue", "old monk",
  "mcdowell", "mcdowells", "kingfisher", "budweiser", "heineken", "corona", "tuborg",
  "haywards", "hayward", "foster", "fosters", "carlsberg", "antiquity", "blenders",
  "blenders pride", "directors", "directors special", "signature", "bagpiper",
  "smirnoff", "magic moment", "magic moments", "white mischief", "officer",
  "officers", "officer choice", "seagram", "seagrams", "100 pipers", " VAT 69",
  "bombay sapphire", "tanqueray", "harpers", "cutty sark", "j&b", "remy martin",
  "hennessy", "martell", "courvoisier", "bacardi", "captain morgan", "malibu",
  "jim beam", "maker mark", "wild turkey", "glenfiddich", "glenlivet", "macallan",
  "laphroaig", "ardbeg", "lagavulin", "glenmorangie", "singleton",
];

const GARBAGE_KEYWORDS = ["page", "www.", "http", "@", ".com", "fssai", "gstin"];

function isCategoryHeader(line: string): boolean {
  // Long lines are not category headers
  if (line.length > 45) return false;

  // Contains a realistic price (3+ digit number) → it's an item, not a category
  if (/₹?\s*\d{3,}/.test(line)) return false;

  const trimmed = line.trim();
  if (trimmed.length <= 2) return false;

  const wordCount = trimmed.split(/\s+/).length;

  // ALL CAPS with length > 2 and word count <= 5
  if (trimmed === trimmed.toUpperCase() && trimmed.length > 2 && wordCount <= 5) return true;

  // Ends with colon
  if (trimmed.endsWith(":")) return true;

  // Title Case with word count <= 3, length > 4, and not a known non-category keyword
  const knownNonCategory = new Set([
    "page", "menu", "restaurant", "order", "bill", "tax", "total", "subtotal",
    "date", "time", "special", "served", "contains", "choice", "please",
    "available", "note", "price", "item", "name", "qty", "quantity", "rate", "amount",
  ]);
  const words = trimmed.split(/\s+/);
  const isTitleCase = words.length > 0 && words.every((w) => w.length === 0 || w[0] === w[0].toUpperCase());
  if (isTitleCase && wordCount <= 3 && trimmed.length > 4 && !knownNonCategory.has(trimmed.toLowerCase())) return true;

  return false;
}

function keywordMatches(name: string, keyword: string): boolean {
  const lower = name.toLowerCase();
  const k = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Treat keyword as a token: it must be preceded/followed by start/end or a non-alphanumeric char.
  const re = new RegExp(`(?:^|[^a-z0-9])${k}(?:[^a-z0-9]|$)`, "i");
  return re.test(lower);
}

function inferMenuTypeFromCategory(category: string): string {
  const lower = category.toLowerCase();
  if (LIQUOR_KEYWORDS.some((k) => keywordMatches(lower, k))) return "LIQUOR";
  return "FOOD";
}

function extractVariantPrices(line: string): { half: number; full: number } | null {
  const m = line.match(/₹?\s*(\d{2,5})\s*\/\s*(\d{2,5})/);
  if (!m) return null;
  const p1 = parseInt(m[1], 10);
  const p2 = parseInt(m[2], 10);
  if (isNaN(p1) || isNaN(p2) || p1 <= 0 || p2 <= 0) return null;
  return { half: Math.min(p1, p2), full: Math.max(p1, p2) };
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

function inferCategoryFromName(name: string, restaurantType?: string): string {
  const lower = name.toLowerCase();

  const categoryKeywordMap: { category: string; keywords: string[] }[] = [
    // Liquor / spirits detection first: volume sizes and known brands
    { category: "Liquor", keywords: [
      "30ml", "60ml", "90ml", "120ml", "180ml", "375ml", "750ml", "1ltr",
      "pint", "quart", "nip", "miniature", "peg", "bottle",
      "whisky", "whiskey", "vodka", "rum", "gin", "brandy", "beer", "wine",
      "absolut", "ballantine", "ballantines", "teacher", "teachers", "legacy",
      "black & white", "black and white", "johnnie walker", "jack daniel", "jack daniels",
      "chivas", "chivas regal", "royal stag", "imperial blue", "old monk",
      "mcdowell", "mcdowells", "kingfisher", "budweiser", "heineken", "corona", "tuborg",
      "haywards", "hayward", "foster", "fosters", "carlsberg", "antiquity", "blenders",
      "blenders pride", "directors", "directors special", "signature", "bagpiper",
      "smirnoff", "magic moment", "magic moments", "white mischief", "officer",
      "officers", "officer choice", "seagram", "seagrams", "100 pipers", "vat 69",
      "bombay sapphire", "tanqueray", "harpers", "cutty sark", "j&b", "remy martin",
      "hennessy", "martell", "courvoisier", "bacardi", "captain morgan", "malibu",
      "jim beam", "maker mark", "wild turkey", "glenfiddich", "glenlivet", "macallan",
      "laphroaig", "ardbeg", "lagavulin", "glenmorangie", "singleton",
    ]},
    { category: "Soups", keywords: ["soup", "rasam", "shorba"] },
    { category: "Salads", keywords: ["salad", "kachumber"] },
    { category: "Starters (Veg)", keywords: ["paneer tikka", "veg tikka", "gobi", "aloo 65", "veg 65", "mushroom 65", "corn 65", "paneer 65", "veg manchurian", "gobi manchurian", "mushroom manchurian", "veg spring roll", "crispy corn", "french fries", "golden fries", "baby corn 65", "cashewnut roast", "veg shangrilla", "chilli gobi", "masala papad", "spring rolls"] },
    { category: "Starters (Non-Veg)", keywords: ["chicken 65", "chicken manchurian", "chilli chicken", "crispy chicken", "pepper chicken", "chicken wings", "chicken lollipop", "chicken drumstick", "fish 65", "fish manchurian", "chilli fish", "prawn", "dragon chicken", "chicken majestic", "star chicken", "apollo fish", "velvet fish", "chicken shangrilla", "chicken alpha", "chicken 85", "kebab", "tikka", "pakora", "fry", "fingers", "chaat", "bhel", "cutlet", "roll", "starter", "appetizer", "bruschetta", "nachos"] },
    { category: "Tandoori", keywords: ["tandoori", "tikka", "kebab", "grill", "barbecue", "bbq"] },
    { category: "Breads", keywords: ["naan", "roti", "paratha", "kulcha", "puri", "bhatura", "chapati", "phulka"] },
    { category: "Biryani & Rice", keywords: ["biryani", "fried rice", "pulao", "rice", "khichdi", "curd rice", "sambar rice"] },
    { category: "Fried Rice & Noodles", keywords: ["noodles", "chowmein", "manchurian", "hakka", "schezwan", "momos", "dimsum"] },
    { category: "Seafood", keywords: ["fish", "prawn", "crab", "lobster", "squid", "pomfret", "tuna", "salmon"] },
    { category: "Curries (Veg)", keywords: ["paneer", "dal", "kofta", "korma", "kadai", "curry", "masala", "gravy", "sabzi", "keema", "palak", "methi", "kheema"] },
    { category: "Curries (Non-Veg)", keywords: ["butter chicken", "chicken curry", "mutton curry", "egg curry", "chicken masala", "mutton masala", "chilli chicken", "kadai chicken", "moghlai chicken"] },
    { category: "Main Course (Veg)", keywords: ["malai kofta", "shahi kurma", "veg jaipuri", "cashewnut curry", "paneer butter masala", "paneer tikka masala"] },
    { category: "Main Course (Non-Veg)", keywords: ["chicken afghani", "chicken priya pasand", "mutton", "beef", "pork"] },
    { category: "Desserts", keywords: ["gulab", "halwa", "kheer", "ice cream", "brownie", "cake", "rasmalai", "payasam", "ladoo", "barfi", "mithai", "pudding"] },
    { category: "Beverages", keywords: ["tea", "coffee", "juice", "lassi", "buttermilk", "soda", "shake", "smoothie", "water", "lime", "lemonade", "mojito", "cooler", "soft drink", "cola", "sprite", "fanta", "limca", "thumsup", "orange"] },
    { category: "Accompaniments", keywords: ["raita", "pappad", "papad", "chutney", "pickle", "onion ritha", "plain curd", "gravy"] },
  ];

  // Add detailed liquor categories for bar restaurant types
  if (restaurantType === "BAR_LOUNGE" || restaurantType === "BAR_WITH_DINING") {
    categoryKeywordMap.push(
      { category: "Beer", keywords: ["beer", "kingfisher", "budweiser", "corona", "heineken", "carlsberg", "tiger", "bira", "pint", "draught", "draft"] },
      { category: "Whisky", keywords: ["whisky", "whiskey", "royal challenge", "blenders pride", "officer's choice", "jack daniel", "jameson", "chivas", "johnnie walker", "ballantine", "100 pipers", "imperial blue", "mc dowell", "black & white", "black and white", "teacher", "teachers", "legacy"] },
      { category: "Vodka", keywords: ["vodka", "smirnoff", "absolut", "magic moments", "romanov", "white mischief", "grey goose"] },
      { category: "Rum", keywords: ["rum", "old monk", "bacardi", "captain morgan", "malibu"] },
      { category: "Gin", keywords: ["gin", "bombay sapphire", "tanqueray", "blue moon"] },
      { category: "Brandy", keywords: ["brandy", "mc dowell", "old tavern", "honey bee"] },
      { category: "Wine", keywords: ["wine", "sula", "grover", "red wine", "white wine", "rose wine"] },
      { category: "Cocktails & Mocktails", keywords: ["cocktail", "mocktail", "mojito", "margarita", "martini", "pina colada", "cosmopolitan", "moctail"] },
      { category: "Shots", keywords: ["shot", "shooter", "tequila"] },
      { category: "Spirits", keywords: ["liquor", "spirit", "liqueur"] },
    );
  }

  // Scoring-based matching: pick the category with the highest score
  let bestCategory = "Main Course (Veg)";
  let bestScore = 0;

  for (const { category, keywords } of categoryKeywordMap) {
    let score = 0;
    for (const k of keywords) {
      if (lower === k) {
        score += 10; // exact match
      } else if (keywordMatches(lower, k)) {
        score += 5; // token boundary match
      } else if (lower.includes(k)) {
        score += 2; // substring match
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

async function parsePdf(buffer: Buffer, restaurantType?: string): Promise<{ rows: any[]; warnings: string[]; confidence: string }> {
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

    // Check for half/full variant pricing (e.g. 120/140) before normal price extraction
    const variantPrices = extractVariantPrices(line);
    if (variantPrices) {
      const name = extractItemName(line, variantPrices.half);
      if (name && name.length >= 2) {
        rows.push({
          category: currentCategory,
          name,
          price: variantPrices.half,
          isVeg: inferVeg(name),
          description: "",
          menuType: inferMenuTypeFromCategory(currentCategory),
          variants: [
            { name: "Half", price: variantPrices.half, isDefault: true },
            { name: "Full", price: variantPrices.full, isDefault: false },
          ],
        });
      }
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

  // Category inference: replace Uncategorized with inferred category
  for (const row of rows) {
    if (row.category === "Uncategorized" || !row.category) {
      row.category = inferCategoryFromName(row.name, restaurantType);
      row.categoryInferred = true;
    }
  }

  // Post-parse validation: flag categories with only 1 item as potential false-positives
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    const cat = row.category || "Uncategorized";
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
  }
  for (const [catName, count] of categoryCounts.entries()) {
    if (count === 1) {
      warnings.push(`Warning: "${catName}" was detected as a category but only has 1 item — please verify it is not an item name.`);
    }
  }

  if (rows.length === 0) {
    warnings.push("No menu items detected in PDF. Please verify the file format.");
  }

  const confidence = computeConfidence(rows, warnings);
  if (confidence === "LOW" && rows.length > 0) {
    warnings.push("Only a few items were detected — confidence is LOW. Please review the output.");
  }

  return { rows, warnings, confidence };
}

/** POST /api/menu/upload — parse uploaded file (xlsx, csv, pdf) and return rows */
router.post("/upload", authenticate, menuUploadLimiter, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const sessionId = req.body?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 8) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    const ext = req.file.originalname.toLowerCase().split(".").pop();
    let result: any;

    const restaurantType = (req.body?.restaurantType as string) || undefined;

    if (ext === "xlsx" || ext === "xls" || ext === "csv") {
      result = parseExcelOrCsv(req.file.buffer, restaurantType);
    } else if (ext === "pdf") {
      const textResult = await parsePdf(req.file.buffer, restaurantType);

      // If text parsing got enough items with high confidence, return it
      if (textResult.confidence === "HIGH" && textResult.rows.length >= 10) {
        result = textResult;
      } else if (process.env.GROQ_API_KEY) {
        // Try AI parsing for better results on complex PDFs
        try {
          logger.info("[menu/upload] Text parsing low confidence, trying Groq AI");
          const aiResult = await parseMenuWithGroq(req.file.buffer, restaurantType);
          // Use AI result if it found more items
          result = aiResult.rows.length > textResult.rows.length ? aiResult : textResult;
        } catch (aiErr: any) {
          logger.warn({ err: aiErr }, "[menu/upload] Groq AI parsing failed, using text result");
          result = textResult;
        }
      } else {
        result = textResult;
      }
    } else {
      return res.status(400).json({ error: `Unsupported file type: .${ext}. Use xlsx, csv, or pdf.` });
    }

    // If rate-card mode, try to resolve venue names if restaurantId is available
    if (result.mode === "rate-card" && result.venueHeaders && result.venueHeaders.length > 0) {
      const restaurantId = (req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId;
      if (restaurantId) {
        const { nameToVenueId, unmatched } = await resolveVenueMap(result.venueHeaders, restaurantId);
        result.venueMap = nameToVenueId;
        result.unmatchedVenues = unmatched;
        if (unmatched.length > 0) {
          result.warnings.push(`Could not match venue column(s): ${unmatched.join(", ")}. These prices will be ignored on import.`);
        }
      }
    }

    res.json(result);
  } catch (error: any) {
    logger.error({ err: error }, "[menu/upload]");
    res.status(500).json({ error: "Failed to parse file: " + error.message });
  }
});

/** POST /api/menu/upload-ai — force AI parsing (Groq vision) for PDF files */
router.post("/upload-ai", authenticate, menuUploadLimiter, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const sessionId = req.body?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 8) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(400).json({ error: "GROQ_API_KEY is not configured on the server" });
    }

    const restaurantType = (req.body?.restaurantType as string) || undefined;
    const result = await parseMenuWithGroq(req.file.buffer, restaurantType);

    res.json(result);
  } catch (error: any) {
    logger.error({ err: error }, "[menu/upload-ai]");
    res.status(500).json({ error: "Failed to parse file with AI: " + error.message });
  }
});

/** POST /api/menu/bulk-import — create menu items from parsed rows */
router.post("/bulk-import", authenticate, async (req, res) => {
  try {
    const { rows, mode, venueMap, targetVenueId, replaceExisting } = req.body;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized — no restaurantId found in auth token or request body" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array is required" });
    }

    // If replaceExisting is true, soft-delete all existing items first
    let deletedCount = 0;
    if (replaceExisting === true) {
      const deleted = await prisma.menuItem.updateMany({
        where: { restaurantId, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date() },
      });
      deletedCount = deleted.count;
      logger.info({ restaurantId, deletedCount }, "[menu/bulk-import] replaceExisting: soft-deleted existing menu items");
    }

    const created: number[] = [];
    const updated: number[] = [];
    const skipped: string[] = [];

    // ── Rate Card Mode ──
    if (mode === "rate-card") {
      // Resolve venue names to venue IDs if not already provided
      let resolvedVenueMap: Record<string, string> = venueMap || {};
      if (Object.keys(resolvedVenueMap).length === 0) {
        // Extract all unique venue names from rows
        const allVenueNames = new Set<string>();
        for (const row of rows) {
          if (row.venuePrices) {
            for (const vn of Object.keys(row.venuePrices)) allVenueNames.add(vn);
          }
        }
        if (allVenueNames.size > 0) {
          const { nameToVenueId, unmatched } = await resolveVenueMap(Array.from(allVenueNames), restaurantId);
          resolvedVenueMap = nameToVenueId;
          if (unmatched.length > 0) {
            skipped.push(`Unmatched venue columns (prices ignored): ${unmatched.join(", ")}`);
          }
        }
      }

      // Group rows by category for category upsert
      const categoryMap = new Map<string, any[]>();
      for (const row of rows) {
        if (!row.name) {
          skipped.push("Unknown item (no name)");
          continue;
        }
        const cat = row.category || "Uncategorized";
        if (!categoryMap.has(cat)) categoryMap.set(cat, []);
        categoryMap.get(cat)!.push(row);
      }

      // Pre-fetch all existing categories for this restaurant to avoid N+1
      const existingCategories = await prisma.category.findMany({
        where: { restaurantId },
        select: { id: true, name: true },
      });
      const catLookup = new Map<string, string>();
      for (const c of existingCategories) {
        catLookup.set(c.name.toLowerCase(), c.id);
      }

      // Pre-fetch all existing menu items for this restaurant to avoid N+1
      const existingItemsMap = new Map<string, any>();
      const allExistingItems = await prisma.menuItem.findMany({
        where: { restaurantId, isDeleted: false },
        select: { id: true, name: true, categoryId: true, basePrice: true, isAvailable: true, variants: { where: { isDefault: true }, take: 1 } },
      });
      for (const item of allExistingItems) {
        existingItemsMap.set(item.name.toLowerCase(), item);
      }

      // Fetch all venues with their priceProfileId for this restaurant
      const venueRecords = await prisma.venue.findMany({
        where: { restaurantId, isDeleted: false },
        select: { id: true, name: true, priceProfileId: true },
      });
      const venueById = new Map(venueRecords.map(v => [v.id, v]));

      // Build venueId → priceProfileId map, auto-creating profiles for venues without one
      const venueToProfileId = new Map<string, string>();
      for (const [venueName, venueId] of Object.entries(resolvedVenueMap)) {
        const venue = venueById.get(venueId);
        if (!venue) continue;

        if (venue.priceProfileId) {
          venueToProfileId.set(venueId, venue.priceProfileId);
        } else {
          // Auto-create a profile for this venue
          const pp = await prisma.priceProfile.create({
            data: { restaurantId, name: venue.name || venueName },
          });
          await prisma.venue.update({
            where: { id: venueId },
            data: { priceProfileId: pp.id },
          });
          venueToProfileId.set(venueId, pp.id);
        }
      }

      // Detect shared profiles: if 2+ venues share the same priceProfileId AND
      // the incoming per-venue prices differ for any item, split into per-venue profiles.
      const profileToVenues = new Map<string, string[]>(); // profileId → [venueId, ...]
      for (const [venueId, ppId] of venueToProfileId) {
        if (!profileToVenues.has(ppId)) profileToVenues.set(ppId, []);
        profileToVenues.get(ppId)!.push(venueId);
      }

      // Check each shared profile for price conflicts
      for (const [ppId, venueIds] of profileToVenues) {
        if (venueIds.length < 2) continue;

        // Check if any row has different prices across these venues
        let hasConflict = false;
        for (const row of rows) {
          if (!row.venuePrices) continue;
          const pricesForThisGroup = venueIds.map(vid => {
            const venueName = Object.entries(resolvedVenueMap).find(([_, id]) => id === vid)?.[0];
            return venueName ? row.venuePrices[venueName] : undefined;
          });
          const definedPrices = pricesForThisGroup.filter(p => p !== undefined && Number(p) > 0);
          if (definedPrices.length > 1) {
            const uniquePrices = new Set(definedPrices.map(p => Number(p)));
            if (uniquePrices.size > 1) {
              hasConflict = true;
              break;
            }
          }
        }

        if (hasConflict) {
          // Split: create a new profile for each venue except the first (which keeps the original)
          for (let i = 1; i < venueIds.length; i++) {
            const venueId = venueIds[i];
            const venue = venueById.get(venueId);
            const newPp = await prisma.priceProfile.create({
              data: { restaurantId, name: venue?.name || `Profile ${i + 1}` },
            });
            await prisma.venue.update({
              where: { id: venueId },
              data: { priceProfileId: newPp.id },
            });
            venueToProfileId.set(venueId, newPp.id);
          }
          logger.info(`[bulk-import] Split shared profile ${ppId} into per-venue profiles due to price conflicts`);
        }
      }

      // Collect PriceProfileItem upsert operations
      const profileItemOps: { priceProfileId: string; menuItemId: string; price: number }[] = [];

      for (const [catName, catRows] of categoryMap.entries()) {
        // Upsert category
        let categoryId = catLookup.get(catName.toLowerCase());
        if (!categoryId) {
          const newCat = await prisma.category.create({
            data: { name: catName, restaurantId },
          });
          categoryId = newCat.id;
          catLookup.set(catName.toLowerCase(), categoryId);
        }

        for (const row of catRows) {
          try {
            const existing = existingItemsMap.get(row.name.toLowerCase());

            let menuItemId: string;

            if (existing) {
              // Update existing item
              await prisma.menuItem.update({
                where: { id: existing.id },
                data: {
                  basePrice: row.price,
                  isAvailable: row.isAvailable !== false,
                  menuType: row.menuType || "FOOD",
                  categoryId,
                  ...(row.unit ? { unit: row.unit } : {}),
                },
              });

              // Update default variant price to stay in sync with basePrice
              if (existing.variants && existing.variants.length > 0) {
                await prisma.menuItemVariant.update({
                  where: { id: existing.variants[0].id },
                  data: { price: row.price },
                });
              } else {
                // Create default variant if none exists
                await prisma.menuItemVariant.create({
                  data: {
                    name: "Regular",
                    price: row.price,
                    isDefault: true,
                    menuItemId: existing.id,
                    restaurantId,
                  },
                });
              }

              menuItemId = existing.id;
              updated.push(1);
            } else {
              // Create new item
              const menuItem = await prisma.menuItem.create({
                data: {
                  name: row.name,
                  description: row.description || "",
                  basePrice: row.price,
                  isVeg: row.isVeg ?? true,
                  isAvailable: row.isAvailable !== false,
                  menuType: row.menuType || "FOOD",
                  categoryId,
                  restaurantId,
                  ...(row.unit ? { unit: row.unit } : {}),
                },
              });

              // Create default variant in sync with basePrice
              await prisma.menuItemVariant.create({
                data: {
                  name: "Regular",
                  price: row.price,
                  isDefault: true,
                  menuItemId: menuItem.id,
                  restaurantId,
                },
              });

              menuItemId = menuItem.id;
              created.push(1);
            }

            // Queue PriceProfileItem upserts for each venue's profile
            if (row.venuePrices) {
              for (const [venueName, price] of Object.entries(row.venuePrices)) {
                const venueId = resolvedVenueMap[venueName];
                const numPrice = Number(price);
                const ppId = venueId ? venueToProfileId.get(venueId) : undefined;
                if (ppId && numPrice > 0) {
                  profileItemOps.push({ priceProfileId: ppId, menuItemId, price: numPrice });
                }
              }
            }
          } catch (err: any) {
            skipped.push(`${row.name} (${err.message})`);
          }
        }
      }

      // Batch upsert PriceProfileItems
      if (profileItemOps.length > 0) {
        await prisma.$transaction(
          profileItemOps.map(op =>
            prisma.priceProfileItem.upsert({
              where: {
                priceProfileId_menuItemId: {
                  priceProfileId: op.priceProfileId,
                  menuItemId: op.menuItemId,
                },
              },
              create: {
                priceProfileId: op.priceProfileId,
                menuItemId: op.menuItemId,
                price: op.price,
                restaurantId,
              },
              update: { price: op.price },
            })
          )
        );
      }

      clearCache("menu:");
      clearCache("barMenu:");
      invalidateVenueResolutionCache();
      try {
        const io = getIo();
        const payload = { action: "bulk-import", restaurantId };
        io.to(restaurantId).emit("menu-item-updated", payload);
        io.to(`public:${restaurantId}`).emit("menu-item-updated", payload);
        io.to(restaurantId).emit("venuePrices:updated");
        io.to(`public:${restaurantId}`).emit("venuePrices:updated");
      } catch (e) {
        logger.error({ err: e }, "[menu/bulk-import rate-card] Socket emit failed:");
      }

      res.json({
        created: created.length,
        updated: updated.length,
        skipped,
        ...(deletedCount > 0 ? { deleted: deletedCount } : {}),
        mode: "rate-card",
        resolvedVenueMap,
      });
      return;
    }

    // ── Standard Mode (existing logic) ──
    // Group rows by category
    const standardCategoryMap = new Map<string, any[]>();
    for (const row of rows) {
      if (!row.name || typeof row.price !== "number") {
        skipped.push(row.name || "Unknown item");
        continue;
      }
      const cat = row.category || "Uncategorized";
      if (!standardCategoryMap.has(cat)) standardCategoryMap.set(cat, []);
      standardCategoryMap.get(cat)!.push(row);
    }

    // If targetVenueId is specified, resolve the venue's priceProfileId
    let targetPriceProfileId: string | null = null;
    if (targetVenueId && targetVenueId !== "all") {
      const venue = await prisma.venue.findFirst({
        where: { id: targetVenueId, restaurantId, isDeleted: false },
        select: { id: true, name: true, priceProfileId: true },
      });
      if (venue) {
        if (venue.priceProfileId) {
          targetPriceProfileId = venue.priceProfileId;
        } else {
          // Auto-create a price profile for this venue
          const pp = await prisma.priceProfile.create({
            data: { restaurantId, name: venue.name || targetVenueId },
          });
          await prisma.venue.update({
            where: { id: venue.id },
            data: { priceProfileId: pp.id },
          });
          targetPriceProfileId = pp.id;
        }
      }
    }

    // Collect PriceProfileItem upserts for target venue
    const standardProfileItemOps: { priceProfileId: string; menuItemId: string; price: number }[] = [];

    // 1. Pre-resolve all categories
    const categoryMap = new Map<string, any>();
    for (const catName of standardCategoryMap.keys()) {
      let cat = await prisma.category.findFirst({
        where: { restaurantId, name: { equals: catName, mode: "insensitive" } },
      });
      if (!cat) cat = await prisma.category.create({ data: { name: catName, restaurantId } });
      categoryMap.set(catName, cat);
    }

    // 2. Pre-fetch ALL existing items + variants (eliminates N findFirst calls)
    const allExisting = await prisma.menuItem.findMany({
      where: { restaurantId, isDeleted: false },
      include: { variants: true },
    });
    const existingMap = new Map<string, typeof allExisting[0]>();
    for (const item of allExisting) {
      existingMap.set(`${item.name.toLowerCase().trim()}|${item.categoryId}`, item);
    }

    // 3. Flatten rows with resolved category IDs
    const flatRows: any[] = [];
    for (const [catName, catRows] of standardCategoryMap.entries()) {
      const cat = categoryMap.get(catName)!;
      for (const row of catRows) flatRows.push({ ...row, categoryId: cat.id });
    }

    // 4. Batch all UPDATES concurrently
    const updateOps: any[] = [];
    const variantUpdateOps: any[] = [];
    for (const row of flatRows) {
      const key = `${row.name.toLowerCase().trim()}|${row.categoryId}`;
      const existing = existingMap.get(key);
      if (!existing) continue;
      updateOps.push(
        prisma.menuItem.update({
          where: { id: existing.id },
          data: {
            basePrice: row.price,
            description: row.description || existing.description || "",
            isVeg: row.isVeg ?? existing.isVeg ?? true,
            menuType: row.menuType || existing.menuType || "FOOD",
          },
        })
      );
      const dv = existing.variants.find((v: any) => v.isDefault) || existing.variants[0];
      if (dv) variantUpdateOps.push(prisma.menuItemVariant.update({ where: { id: dv.id }, data: { price: row.price } }));
      if (targetPriceProfileId) standardProfileItemOps.push({ priceProfileId: targetPriceProfileId, menuItemId: existing.id, price: row.price });
      updated.push(1);
    }
    if (updateOps.length) await prisma.$transaction(updateOps);
    if (variantUpdateOps.length) await prisma.$transaction(variantUpdateOps);

    // 5. Batch CREATES in chunks (item + variants are dependent, so chunk to avoid timeout)
    const createRows = flatRows.filter(row => !existingMap.has(`${row.name.toLowerCase().trim()}|${row.categoryId}`));
    const CHUNK_SIZE = 30;
    for (let i = 0; i < createRows.length; i += CHUNK_SIZE) {
      const chunk = createRows.slice(i, i + CHUNK_SIZE);
      await prisma.$transaction(async (tx) => {
        for (const row of chunk) {
          const menuItem = await tx.menuItem.create({
            data: {
              name: row.name,
              description: row.description || "",
              basePrice: row.price,
              isVeg: row.isVeg ?? true,
              menuType: row.menuType || "FOOD",
              categoryId: row.categoryId,
              restaurantId,
            },
          });
          const variants = row.variants && Array.isArray(row.variants) && row.variants.length > 0
            ? row.variants
            : [{ name: "Regular", price: row.price, isDefault: true }];
          for (let vi = 0; vi < variants.length; vi++) {
            const v = variants[vi];
            await tx.menuItemVariant.create({
              data: { name: v.name, price: v.price, isDefault: vi === 0, menuItemId: menuItem.id, restaurantId },
            });
          }
          if (targetPriceProfileId) standardProfileItemOps.push({ priceProfileId: targetPriceProfileId, menuItemId: menuItem.id, price: row.price });
          created.push(1);
        }
      });
    }

    // Batch upsert PriceProfileItems for target venue
    if (standardProfileItemOps.length > 0) {
      await prisma.$transaction(
        standardProfileItemOps.map(op =>
          prisma.priceProfileItem.upsert({
            where: {
              priceProfileId_menuItemId: {
                priceProfileId: op.priceProfileId,
                menuItemId: op.menuItemId,
              },
            },
            create: {
              priceProfileId: op.priceProfileId,
              menuItemId: op.menuItemId,
              price: op.price,
              restaurantId,
            },
            update: { price: op.price },
          })
        )
      );
    }

    clearCache("menu:");
    clearCache("barMenu:");
    invalidateVenueResolutionCache();
    try {
      const io = getIo();
      const payload = { action: "bulk-import", restaurantId };
      io.to(restaurantId).emit("menu-item-updated", payload);
      io.to(`public:${restaurantId}`).emit("menu-item-updated", payload);
      if (targetPriceProfileId) {
        io.to(restaurantId).emit("venuePrices:updated");
        io.to(`public:${restaurantId}`).emit("venuePrices:updated");
      }
    } catch (e) {
      logger.error({ err: e }, "[menu/bulk-import standard] Socket emit failed:");
    }

    res.json({
      created: created.length,
      updated: updated.length,
      skipped,
      ...(deletedCount > 0 ? { deleted: deletedCount } : {}),
      ...(targetVenueId && targetVenueId !== "all" ? { targetVenueId } : {}),
    });
  } catch (error: any) {
    logger.error({ err: error }, "[menu/bulk-import]");
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

// In-memory rate-limit tracking for auto-generate (per restaurant, simple log-flag).
const autoGenerateLastCalled = new Map<string, number>();

/** POST /api/menu/recipes/auto-generate — generate/overwrite recipes for all FOOD items */
router.post("/recipes/auto-generate", authenticate, async (req: any, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });

    // Rate-limit log-flag: warn if called more than once within 60s
    const lastCalled = autoGenerateLastCalled.get(restaurantId);
    const now = Date.now();
    if (lastCalled && now - lastCalled < 60_000) {
      logger.warn(
        `[menu/auto-generate] Restaurant ${restaurantId} called auto-generate again within ${Math.round((now - lastCalled) / 1000)}s — destructive overwrite.`,
      );
    }
    autoGenerateLastCalled.set(restaurantId, now);

    // Log warning for very large menus (don't block)
    const foodCount = await prisma.menuItem.count({
      where: { restaurantId, isDeleted: false, menuType: "FOOD" },
    });
    if (foodCount > 300) {
      logger.warn(
        `[menu/auto-generate] Restaurant ${restaurantId} has ${foodCount} FOOD items — this may take several seconds.`,
      );
    }

    const result = await runAutoGenerate(prisma, restaurantId);

    res.json({
      ingredientsCreated: result.ingredientsCreated,
      recipesGenerated: result.recipesGenerated,
      itemsSkippedExistingRecipe: result.itemsSkippedExistingRecipe,
      warnings: result.warnings,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[menu/auto-generate] Failed:");
    res.status(500).json({ error: error.message || "Auto-generate failed" });
  }
});

/** POST /api/menu/recipes/:menuItemId — set recipe for a menu item */
router.post("/recipes/:menuItemId", authenticate, async (req, res) => {
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

    // Verify the menu item belongs to the authenticated user's restaurant
    const authRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!authRestaurantId || menuItem.restaurantId !== authRestaurantId) {
      return res.status(403).json({ error: "Forbidden" });
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

