// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Menu Routes â€” Full menu management for restaurants (food + liquor)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The largest route file â€” manages the complete menu lifecycle:
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
// Endpoints (partial list â€” 40+ endpoints):
//   GET    /api/menu                    â€” list all menu items (optionally by category/section)
//   POST   /api/menu                    â€” create a menu item
//   PATCH  /api/menu/:id                â€” update a menu item
//   DELETE /api/menu/:id                â€” soft-delete a menu item
//   GET    /api/menu/categories         â€” list categories
//   POST   /api/menu/categories         â€” create a category
//   PATCH  /api/menu/categories/:id     â€” update a category
//   DELETE /api/menu/categories/:id     â€” delete a category
//   POST   /api/menu/import             â€” bulk import from Excel/CSV
//   POST   /api/menu/ai-parse           â€” AI parse menu from image (Groq)
//   GET    /api/menu/price-profiles     â€” list price profiles
//   POST   /api/menu/price-profiles     â€” create a price profile
//   GET    /api/menu/tax-profiles       â€” list tax profiles
//   POST   /api/menu/tax-profiles       â€” create a tax profile
//   ...and more
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { Router } from "express";
import logger from "../lib/logger";
import multer from "multer";
import xlsx from "xlsx";

import prisma, { tenantStorage } from "../lib/prisma";

import { getIo } from "../socket";
import { emitConfigChange, emitConfigBatch } from "../lib/edgeEmit";

import { cacheMiddleware, clearCache, invalidateCache } from "../lib/cache";

import { authenticate, requireRole, hasPermission } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { parseMenuWithGroq, type ParseResult } from "../services/groqMenuParser";
import { FOOD_CATEGORIES, LIQUOR_CATEGORIES } from "../lib/predefinedCategories";
import { runAutoGenerate } from "../services/recipeEngine";
import { buildVenuePriceMap, buildAllVenuePriceMaps } from "../lib/priceResolver";
import { createAuditLog } from "../lib/auditLog";
import rateLimit from "express-rate-limit";

// Import pipeline (Parser â†’ Normalizer â†’ Validator â†’ Importer)
import { initAIProviders } from "../services/ai";
import {
  applyMappingAndValidate,
  detectFileType,
  parseFile,
  toUploadResult,
  userMappingToColumnMappings,
  validateNormalized,
} from "../services/import/importPipeline";
import type { RestaurantValidationContext } from "../services/import/validator";
import { CanonicalField, isCanonicalField } from "../lib/import/CanonicalField";
import { MappingSource } from "../lib/import/MappingSource";
import type { ColumnMapping, RawImportData } from "../lib/import/RawImportData";
import type { UploadResult } from "../lib/import/UploadResult";

// Initialize AI providers once at module load (registers Groq if GROQ_API_KEY is set)
initAIProviders();

// Re-export helpers extracted to menuHelpers.ts so existing call sites in this file keep working.
import {
  detectItemHeaderRow,
  detectRateCardLayout,
  extractItemName,
  extractPrices,
  extractVariantPrices,
  inferCategoryFromName,
  inferMenuTypeFromCategory,
  inferVeg,
  isCategoryHeader,
  isGarbageLine,
  isHeaderKeyword,
  isPureNumber,
  keywordMatches,
  LIQUOR_KEYWORDS,
  GARBAGE_KEYWORDS,
  normalizeHeader,
  normalizeVenueName,
  parseMultiBlockLayout,
  parsePrice,
  parseRateCardMatrix,
  VENUE_ALIASES,
  VENUE_KEYWORDS,
} from "../services/import/menuHelpers";


const router = Router();

// Rate limiter for upload routes â€” 5 req/min per IP to prevent Groq API bill abuse.
// The sessionId check is not cryptographically meaningful (client-generated UUID);
// the rate limiter is the primary protection. sessionId filters malformed requests.
const menuUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req: any) => req.ip || 'unknown',
  message: { error: 'Too many upload attempts, please wait a minute' },
});

const bulkCategoryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => req.user?.userId || req.ip || 'unknown',
  message: { error: 'Too many bulk category changes, please wait a minute' },
});

// Guard: ensures write routes only execute when tenant context is active.
// When mounted under /api/menu (public, optionalAuth), tenantStorage is not set,
// so this guard returns 500 â€” fail-closed. When mounted under /api/menu/admin
// (with authenticate + assertTenantScope + withTenantContext), tenantStorage is
// set and the guard passes.
function requireTenantScope(req: any, res: any, next: any) {
  if (!tenantStorage.getStore()) {
    return res.status(500).json({ error: "Route misconfigured â€” tenant context missing" });
  }
  next();
}

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

const BAR_OUTLET_TYPES = new Set(['BAR_LOUNGE', 'BAR_WITH_DINING']);

async function isBarOutlet(restaurantId: string): Promise<boolean> {
  try {
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { restaurantType: true },
    });
    return !!outlet && BAR_OUTLET_TYPES.has(outlet.restaurantType ?? '');
  } catch {
    return false;
  }
}

async function getOrganizationOutletsWithTypes(restaurantId: string): Promise<{ id: string; restaurantType: string | null }[]> {
  try {
    const outlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!outlet?.organizationId) return [];
    const outlets = await prisma.outlet.findMany({
      where: { organizationId: outlet.organizationId },
      select: { id: true, restaurantType: true },
    });
    return outlets;
  } catch (err) {
    logger.warn({ err }, '[menu] Failed to resolve organization outlets with types');
    return [];
  }
}

/**
 * Short-lived in-memory cache for resolveVenueForMenuRead.
 * Keyed by `${restaurantId}:${venueParam}`. 60s TTL â€” short enough to pick up
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

  // Also check Section names â†’ sectionTag (legacy path via tables)
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

// Resolve an existing category by name or id without creating one.
// Returns the category or null. Used for cashier add-only requests where
// category creation is not permitted.
async function resolveExistingCategory(restaurantId: string, category: string) {
  return prisma.category.findFirst({
    where: {
      restaurantId,
      OR: [
        { id: category },
        { name: { equals: category, mode: "insensitive" } },
      ],
    },
  });
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
    showInMenu?: boolean;
  }
) {
  const cat = await resolveOrCreateCategory(restaurantId, payload.category, payload.categoryPrinterTarget);
  const item = await prisma.menuItem.create({
    data: {
      name: payload.name,
      basePrice: payload.price,
      isVeg: ["LIQUOR", "BAR"].includes(String(payload.menuType || "FOOD").toUpperCase()) ? false : (payload.isVeg ?? true),
      // Liquor/bar items never have GST
      gstEnabled: (payload.menuType === "LIQUOR" || payload.menuType === "BAR")
        ? false
        : payload.gstEnabled !== false,
      menuType: (payload.menuType as any) ?? "FOOD",
      restaurantId,
      imageUrl: payload.imageUrl ?? null,
      unit: payload.unit ?? null,
      printerTarget: payload.printerTarget ?? null,
      printerName: payload.printerName ?? null,
      isSpecial: payload.isSpecial ?? false,
      specialChannel: (payload.specialChannel && ["CASHIER", "CAPTAIN", "BOTH"].includes(payload.specialChannel.toUpperCase())) ? payload.specialChannel.toUpperCase() : "BOTH",
      specialActive: payload.specialActive !== false,
      specialExpiresAt: payload.specialExpiresAt ? new Date(payload.specialExpiresAt) : (payload.isSpecial ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null),
      isDeleted: false,
      showInMenu: payload.showInMenu !== false,
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
      gstEnabled: payload.menuType === 'LIQUOR' ? false : undefined,
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



/** GET / â€” structured menu for admin price profiles and other owner-authenticated UIs.
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

/** GET /categories â€” all active categories for admin dropdowns */

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



/** POST /api/menu/categories â€” create a new category */
router.post("/categories", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
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
    clearCache("menu:*");

    res.status(201).json(category);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create category" });
  }
});

/** POST /api/menu/items/bulk-category â€” move selected items within one outlet */
router.post("/items/bulk-category", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), bulkCategoryLimiter, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });

    const { itemIds, targetCategoryId } = req.body ?? {};
    const uniqueItemIds = Array.isArray(itemIds)
      ? [...new Set(itemIds.filter((id: unknown): id is string => typeof id === "string" && Boolean(id.trim())))]
      : [];
    if (uniqueItemIds.length === 0) return res.status(400).json({ error: "Select at least one menu item" });
    if (uniqueItemIds.length > 100) return res.status(400).json({ error: "You can move at most 100 items at a time" });
    if (typeof targetCategoryId !== "string" || !targetCategoryId.trim()) {
      return res.status(400).json({ error: "A destination category is required" });
    }

    const targetCategory = await prisma.category.findFirst({
      where: { id: targetCategoryId, restaurantId, isActive: true },
      select: { id: true, name: true, printerTarget: true },
    });
    if (!targetCategory) return res.status(404).json({ error: "Destination category not found" });

    const items = await prisma.menuItem.findMany({
      where: { id: { in: uniqueItemIds }, restaurantId, isDeleted: false },
      select: {
        id: true, name: true, categoryId: true, printerName: true, printerTarget: true,
        category: { select: { id: true, name: true, printerTarget: true } },
      },
    });
    const foundIds = new Set(items.map(item => item.id));
    const rejectedIds = uniqueItemIds.filter(id => !foundIds.has(id));
    if (rejectedIds.length > 0) {
      return res.status(400).json({ error: "One or more items do not belong to this outlet or were deleted", rejectedIds });
    }

    const routingConflicts = items
      .filter(item => item.categoryId !== targetCategory.id)
      .filter(item => !item.printerName && !item.printerTarget && !item.category.printerTarget && targetCategory.printerTarget)
      .map(item => item.id);
    if (routingConflicts.length > 0) {
      return res.status(409).json({
        error: "Some items would inherit a different printer destination. Configure an item or source category printer before moving them.",
        routingConflicts,
      });
    }

    const updates = items
      .filter(item => item.categoryId !== targetCategory.id)
      .map(item => {
        const sourceTarget = item.category.printerTarget;
        const targetChanged = sourceTarget !== targetCategory.printerTarget;
        const preserveCategoryTarget = Boolean(!item.printerName && !item.printerTarget && sourceTarget && targetChanged);
        return {
          item,
          data: {
            categoryId: targetCategory.id,
            ...(preserveCategoryTarget ? { printerTarget: sourceTarget } : {}),
          },
        };
      });

    await prisma.$transaction(async (tx) => {
      for (const update of updates) {
        await tx.menuItem.update({ where: { id: update.item.id }, data: update.data });
      }
    }, { isolationLevel: "Serializable" });

    const updatedItems = await prisma.menuItem.findMany({
      where: { id: { in: updates.map(({ item }) => item.id) }, restaurantId },
      include: { category: true, variants: true },
    });

    clearCache("menu:categories");
    clearCache("menu:*");
    clearCache("barMenu:*");

    for (const updatedItem of updatedItems) {
      emitConfigChange(restaurantId, "menu_item", "upsert", {
        id: updatedItem.id,
        name: updatedItem.name,
        description: updatedItem.description,
        imageUrl: updatedItem.imageUrl,
        isVeg: updatedItem.isVeg,
        isAvailable: updatedItem.isAvailable,
        sortOrder: updatedItem.sortOrder,
        categoryId: updatedItem.categoryId,
        restaurantId: updatedItem.restaurantId,
        basePrice: updatedItem.basePrice,
        unit: updatedItem.unit,
        isDeleted: updatedItem.isDeleted,
        deletedAt: updatedItem.deletedAt,
        printerTarget: updatedItem.printerTarget,
        printerName: updatedItem.printerName,
        menuType: updatedItem.menuType,
        gstEnabled: updatedItem.gstEnabled,
        isSpecial: updatedItem.isSpecial,
        specialChannel: updatedItem.specialChannel,
        specialActive: updatedItem.specialActive,
        specialExpiresAt: updatedItem.specialExpiresAt,
        variants: updatedItem.variants,
      });
    }

    try {
      const io = getIo();
      for (const updatedItem of updatedItems) {
        io.to(restaurantId).emit("menu-item-updated", {
          itemId: updatedItem.id,
          action: "updated",
          updatedItem: { ...updatedItem, category: updatedItem.category },
          restaurantId,
        });
        io.to(`public:${restaurantId}`).emit("menu-item-updated", {
          itemId: updatedItem.id,
          action: "updated",
          updatedItem: { ...updatedItem, category: updatedItem.category },
          restaurantId,
        });
      }
    } catch (error) {
      logger.warn({ err: error }, "[menu] Failed to emit bulk category socket events");
    }

    createAuditLog({
      userId: req.user?.userId,
      restaurantId,
      action: "MENU_ITEMS_BULK_CATEGORY_CHANGE",
      entityType: "MenuItem",
      entityId: targetCategory.id,
      metadata: {
        targetCategory: { id: targetCategory.id, name: targetCategory.name },
        changes: updates.map(({ item, data }) => ({
          itemId: item.id,
          itemName: item.name,
          fromCategoryId: item.categoryId,
          fromCategoryName: item.category.name,
          toCategoryId: targetCategory.id,
          preservedPrinterTarget: (data as any).printerTarget ?? item.printerTarget ?? item.category.printerTarget ?? null,
        })),
      },
    });

    res.json({
      updatedCount: updates.length,
      skippedIds: items.filter(item => item.categoryId === targetCategory.id).map(item => item.id),
      rejectedIds: [],
    });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update menu item categories" });
  }
});

/** PATCH /api/menu/categories/:id â€” rename and/or reorder */
router.patch("/categories/:id", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = String(req.params.id);
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
    clearCache("menu:*");

    res.json(updated);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update category" });
  }
});

/** DELETE /api/menu/categories/:id â€” soft delete (block if items attached) */
router.delete("/categories/:id", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = String(req.params.id);

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
    clearCache("menu:*");

    res.json({ success: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to delete category" });
  }
});



/** Fetch admin menu items for a single restaurant, mapped to the admin payload shape */
async function fetchAdminMenuItemsForRestaurant(restaurantId: string) {
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
      printerTarget: true,
      printerName: true,
      category: { select: { name: true, printerTarget: true } },
      variants: {
        where: { isDefault: true },
        select: { price: true },
        take: 1,
      },
    },
  });

  const allVenuePrices = await buildAllVenuePriceMaps(restaurantId);
  const venuePricesByItem: Record<string, Record<string, number>> = {};
  for (const [venueId, priceMap] of allVenuePrices) {
    for (const [menuItemId, price] of priceMap) {
      if (!venuePricesByItem[menuItemId]) venuePricesByItem[menuItemId] = {};
      venuePricesByItem[menuItemId][venueId] = price;
    }
  }

  const venueAvailRecords = await prisma.venueMenuItemAvailability.findMany({
    where: { restaurantId },
    select: { venueId: true, menuItemId: true, isAvailable: true },
  });
  const venueAvailByItem: Record<string, Record<string, boolean>> = {};
  for (const rec of venueAvailRecords) {
    if (!venueAvailByItem[rec.menuItemId]) venueAvailByItem[rec.menuItemId] = {};
    venueAvailByItem[rec.menuItemId][rec.venueId] = rec.isAvailable;
  }

  return items.map((item) => ({
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
    printerTarget: (item as any).printerTarget ?? null,
    printerName: (item as any).printerName ?? null,
    venuePrices: venuePricesByItem[item.id] ?? {},
    venueAvailabilities: venueAvailByItem[item.id] ?? {},
  }));
}

/** Admin list â€” all non-deleted items including unavailable, for the admin menu table */

router.get("/items/admin", authenticate, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {

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

        printerTarget: true,

        printerName: true,

        isCombo: true,

        showInMenu: true,

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

        printerTarget: (item as any).printerTarget ?? null,

        printerName: (item as any).printerName ?? null,

        isCombo: item.isCombo,

        showInMenu: item.showInMenu,

        venuePrices: venuePricesByItem[item.id] ?? {},

        venueAvailabilities: venueAvailByItem[item.id] ?? {},

      }))

    );

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to fetch admin menu items" });

  }

});



/** Admin list across all organization outlets â€” includes outletId on each item */
router.get("/items/admin/all-outlets", authenticate, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) ?? '';
    const outletIds = await getOrganizationOutlets(restaurantId);
    if (outletIds.length === 0) {
      res.json([]);
      return;
    }

    const allItems: any[] = [];
    for (const rid of outletIds) {
      try {
        const items = await fetchAdminMenuItemsForRestaurant(rid);
        for (const item of items) {
          allItems.push({ ...item, outletId: rid });
        }
      } catch (err) {
        logger.warn({ err, rid }, '[menu] Failed to fetch admin items for outlet');
      }
    }

    res.json(allItems);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch admin menu items" });
  }
});



/** Image index â€” minimal data for bar/liquor image matching. Authenticated only. */
router.get("/image-index", authenticate, async (req, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) ?? (req.query.restaurantId as string) ?? "";
    const items = await prisma.menuItem.findMany({
      where: { restaurantId, isDeleted: false },
      select: { id: true, name: true, imageUrl: true },
    });
    res.json(items);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch menu image index" });
  }
});

/** Lean flat list for POS â€” only fields the UI needs */
router.get("/items", cacheMiddleware("menu:items", 60_000), async (req, res) => {
  try {

    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string ?? (req.query.restaurantId as string) ?? "";

    const venueId = req.query.venueId as string | undefined;



    const includeExpiredSpecials = req.query.includeExpiredSpecials === '1';

    const specialFilter = includeExpiredSpecials
      ? {}
      : {
          OR: [
            { isSpecial: false },
            { isSpecial: true, specialActive: true, specialExpiresAt: null },
            { isSpecial: true, specialActive: true, specialExpiresAt: { gte: new Date() } },
          ],
        };

    const items = await prisma.menuItem.findMany({

      where: {

        restaurantId,

        isAvailable: true,

        isDeleted: false,

        showInMenu: true,

        category: { isActive: true },

        ...specialFilter,

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

        isCombo: true,

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

          isCombo: item.isCombo,

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



    // Diagnostic: log filter chain results to help identify why food items disappear
    const totalCount = items.length;
    const sentCount = filteredItems.length;
    if (totalCount !== sentCount) {
      logger.info(`[menu/items] restaurant=${restaurantId} venue=${venueId || 'none'}: ${totalCount} from DB â†’ ${sentCount} sent (filtered ${totalCount - sentCount})`);
    }

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

          where: { isAvailable: true, isDeleted: false, showInMenu: true },

          orderBy: { sortOrder: "asc" },

          select: {

            id: true,

            name: true,

            description: true,

            imageUrl: true,

            isVeg: true,

            menuType: true,

            isCombo: true,

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



router.patch("/items/:id/availability", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER', 'CASHIER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

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

    // Guard: warn when deactivating an item that is a component of an active combo.
    // Proceeds anyway (deactivation is reversible) but surfaces the affected combos
    // so the admin knows KOT/inventory for those combos will skip this component.
    if (existing.isAvailable) {
      const referencingCombos = await prisma.comboComponent.findMany({
        where: { componentMenuItemId: id, restaurantId },
        include: { comboMenuItem: { select: { id: true, name: true, isDeleted: true, isCombo: true } } },
      });
      const activeComboRefs = referencingCombos.filter((r) => r.comboMenuItem && !r.comboMenuItem.isDeleted && r.comboMenuItem.isCombo);
      if (activeComboRefs.length > 0) {
        logger.warn({ itemId: id, combos: activeComboRefs.map((r) => r.comboMenuItem.id) }, '[menu] Deactivating item used by active combo(s)');
      }
    }
    // Cashier authorization: requires menuEdit permission.
    const requesterRole = ((req as any).user?.role || '').toUpperCase();
    if (requesterRole === 'CASHIER') {
      const allowed = await hasPermission(req as any, 'menuEdit');
      if (!allowed) {
        res.status(403).json({ error: "Cashier does not have permission to edit menu items" });
        return;
      }
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

    // Notify edge servers so they update local SQLite
    emitConfigChange(restaurantId, "menu_item", "upsert", updated);

    res.json(updated);

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to update availability" });

  }

});



/* â”€â”€â”€ PATCH /items/:id/venue-availability â€” toggle per-venue availability â”€â”€â”€ */
router.patch("/items/:id/venue-availability", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
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

/* â”€â”€â”€ PATCH /items/:id/menu-type â€” toggle menuType between FOOD and LIQUOR â”€â”€â”€ */
// Multi-tenant safe: verifies item belongs to the authenticated user's restaurant.
// Emits menu-item-updated to restaurant room so captain/cashier sync instantly.
router.patch("/items/:id/menu-type", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), invalidateCache(["menu:*", "barMenu:*"]), async (req: any, res) => {
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
    // Switching to liquor always clears GST
    if (newMenuType === "LIQUOR") updateData.gstEnabled = false;
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



/** POST /items â€” create a new menu item */

router.post("/items", authenticate, requireTenantScope, invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const { name, category, isVeg, price, menuType, imageUrl, unit, venuePrices, categoryPrinterTarget, printerTarget, printerName, gstEnabled, isSpecial, specialChannel, specialActive, specialExpiresAt, syncToAllOutlets, showInMenu } = req.body as {

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

      showInMenu?: boolean;

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
    const targetOutletId = (req.body as any).targetOutletId as string | undefined;
    const effectiveRestaurantId = targetOutletId || restaurantId;

    // Cashier add-only authorization: CASHIER role requires the menuAdd permission.
    // OWNER/ADMIN/MANAGER retain full access. CAPTAIN and other roles are blocked.
    const requesterRole = ((req as any).user?.role || '').toUpperCase();
    const isCashier = requesterRole === 'CASHIER';
    if (isCashier) {
      const allowed = await hasPermission(req as any, 'menuAdd');
      if (!allowed) {
        res.status(403).json({ error: "Cashier does not have permission to add menu items" });
        return;
      }
      // Cashier cannot target a different outlet or sync across outlets.
      if (targetOutletId && targetOutletId !== restaurantId) {
        res.status(403).json({ error: "Cashier can only create items in the active outlet" });
        return;
      }
      if (syncToAllOutlets) {
        res.status(403).json({ error: "Cashier cannot sync items to all outlets" });
        return;
      }
      // Cashier cannot upload images or manage specials.
      if (imageUrl) {
        res.status(400).json({ error: "Cashier cannot set an image URL" });
        return;
      }
      if (isSpecial || specialChannel || specialActive || specialExpiresAt) {
        res.status(400).json({ error: "Cashier cannot manage Today Specials" });
        return;
      }
      // Cashier cannot mutate categories (no category printer target override).
      if (categoryPrinterTarget !== undefined && categoryPrinterTarget !== null) {
        res.status(400).json({ error: "Cashier cannot modify category printer targets" });
        return;
      }
      // Validate name length.
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
        res.status(400).json({ error: "name must be 1-200 characters" });
        return;
      }
      // Validate price is a positive finite number.
      if (typeof price !== 'number' || !isFinite(price) || price <= 0) {
        res.status(400).json({ error: "price must be a positive finite number" });
        return;
      }
      // Validate menu type against outlet type.
      const upperMenuType = String(menuType || "FOOD").toUpperCase();
      if (!["FOOD", "LIQUOR", "BAR"].includes(upperMenuType)) {
        res.status(400).json({ error: "menuType must be FOOD, LIQUOR, or BAR" });
        return;
      }
      if (upperMenuType === 'LIQUOR' || upperMenuType === 'BAR') {
        const targetIsBar = await isBarOutlet(effectiveRestaurantId);
        if (!targetIsBar) {
          res.status(400).json({ error: "LIQUOR/BAR items can only be created in bar-type outlets" });
          return;
        }
      }
      // Require an existing category â€” no auto-create for cashiers.
      if (!category || typeof category !== 'string' || category.trim().length === 0) {
        res.status(400).json({ error: "category is required" });
        return;
      }
      const existingCat = await resolveExistingCategory(effectiveRestaurantId, category.trim());
      if (!existingCat) {
        res.status(400).json({ error: "Category does not exist. Cashier can only use existing categories." });
        return;
      }
    }

    // Guard: LIQUOR items cannot be created in non-bar outlets
    if (menuType === 'LIQUOR') {
      const targetIsBar = await isBarOutlet(effectiveRestaurantId);
      if (!targetIsBar) {
        res.status(400).json({ error: "LIQUOR items can only be created in bar-type outlets (BAR_LOUNGE or BAR_WITH_DINING)" });
        return;
      }
      if (isSpecial) {
        res.status(400).json({ error: "LIQUOR items cannot be set as Today Specials" });
        return;
      }
    }

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
      showInMenu,
    };

    const item = await createMenuItemInOutlet(effectiveRestaurantId, payload);

    await upsertVenuePrices(item.id, effectiveRestaurantId, venuePrices);

    // Sync to other outlets in the same organization if requested (e.g., Today Specials across all branches/outlets)
    const syncedItems = [item];
    if (syncToAllOutlets && isSpecial) {
      const allOutlets = await getOrganizationOutletsWithTypes(effectiveRestaurantId);
      const otherOutlets = allOutlets
        .filter(o => o.id !== effectiveRestaurantId)
        // Don't sync LIQUOR specials to non-bar outlets
        .filter(o => menuType !== 'LIQUOR' || BAR_OUTLET_TYPES.has(o.restaurantType ?? ''))
        .map(o => o.id);
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

    clearCache("menu:*");

    // Notify edge servers so they update local SQLite
    if (item.restaurantId) {
      emitConfigChange(item.restaurantId, "menu_item", "upsert", item);
      // Also emit variant changes so edge server syncs variants
      if (item.variants) {
        for (const v of item.variants) {
          emitConfigChange(item.restaurantId, "menu_item_variant", "upsert", {
            id: v.id, name: v.name, price: v.price, isDefault: v.isDefault,
            menuItemId: item.id, isAvailable: v.isAvailable ?? true,
            restaurantId: item.restaurantId,
          });
        }
      }
    }

    res.status(201).json(item);

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to create item" });

  }

});



/** POST /items/bulk-specials â€” bulk upsert today specials by name, no duplicates */

router.post("/items/bulk-specials", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'CASHIER', 'MANAGER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

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

    const liquorItems = items.filter(item => item.menuType === 'LIQUOR');
    if (liquorItems.length > 0) {
      res.status(400).json({
        error: "LIQUOR items cannot be set as Today Specials",
        invalidItems: liquorItems.map(i => i.name)
      });
      return;
    }

    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Restaurant context required" });
      return;
    }

    // Cashier authorization: requires menuSpecials permission.
    const requesterRole = ((req as any).user?.role || '').toUpperCase();
    if (requesterRole === 'CASHIER') {
      const allowed = await hasPermission(req as any, 'menuSpecials');
      if (!allowed) {
        res.status(403).json({ error: "Cashier does not have permission to manage Today Specials" });
        return;
      }
    }

    // Batch size guard
    const MAX_BULK_SPECIALS = 50;
    if (items.length > MAX_BULK_SPECIALS) {
      res.status(400).json({ error: `Cannot import more than ${MAX_BULK_SPECIALS} specials at once` });
      return;
    }

    // Validate every item strictly
    const invalidItems: string[] = [];
    for (const item of items) {
      if (!item.name || typeof item.name !== 'string' || item.name.trim().length === 0) {
        invalidItems.push(item.name || '<missing>');
      } else if (item.price == null || Number.isNaN(Number(item.price)) || Number(item.price) <= 0) {
        invalidItems.push(item.name);
      }
    }
    if (invalidItems.length > 0) {
      res.status(400).json({
        error: "Each special must have a non-empty name and a positive price",
        invalidItems: [...new Set(invalidItems)]
      });
      return;
    }

    // Check duplicate names within the request
    const seenNames = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of items) {
      const normalized = item.name.trim().toLowerCase();
      if (seenNames.has(normalized)) duplicates.add(item.name.trim());
      seenNames.add(normalized);
    }
    if (duplicates.size > 0) {
      res.status(400).json({
        error: "Duplicate names found in request",
        invalidItems: [...duplicates]
      });
      return;
    }

    const results = [];

    const otherOutlets = syncToAllOutlets

      ? (await getOrganizationOutlets(restaurantId)).filter(id => id !== restaurantId)

      : [];



    for (const item of items) {

      const payload = {

        name: item.name.trim(),

        category: (item.category && typeof item.category === 'string' && item.category.trim()) || 'Main Course',

        isVeg: item.isVeg !== false,

        price: Number(item.price),

        menuType: 'FOOD',

        specialChannel: ['CASHIER', 'CAPTAIN', 'BOTH'].includes(item.specialChannel || '') ? (item.specialChannel as string) : 'BOTH',

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



    clearCache("menu:*");

    res.status(201).json({ count: results.length, items: results });

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to bulk import specials" });

  }

});



/** PATCH /items/:id â€” update name, isVeg, price, imageUrl, unit */

router.patch("/items/:id", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER', 'CASHIER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;

    const { name, category, isVeg, price, imageUrl, menuType, unit, venuePrices, categoryPrinterTarget, printerTarget, printerName, gstEnabled, isAvailable, isSpecial, specialChannel, specialActive, specialExpiresAt, syncToAllOutlets, showInMenu } = req.body as {

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

      isAvailable?: boolean;

      isSpecial?: boolean;

      specialChannel?: string;

      specialActive?: boolean;

      specialExpiresAt?: string;

      syncToAllOutlets?: boolean;

      showInMenu?: boolean;

    };



    const userRestaurantId = getUserRestaurantId(req);

    if (!userRestaurantId) {

      res.status(401).json({ error: "Authentication required" });

      return;

    }



    const outletIds = await getOrganizationOutlets(userRestaurantId);

    let existing = await prisma.menuItem.findFirst({

      where: { id, restaurantId: userRestaurantId, isDeleted: false },

      include: { category: true },

    });

    if (!existing) {

      // Cross-outlet: item may belong to another outlet in the same organization

      const orgOutlets = await getOrganizationOutlets(userRestaurantId);

      const itemById = await prisma.menuItem.findFirst({

        where: { id, isDeleted: false },

        include: { category: true },

      });

      if (itemById && orgOutlets.includes(itemById.restaurantId)) {

        existing = itemById;

      }

    }

    if (!existing) {

      res.status(404).json({ error: "Item not found" });

      return;

    }

    const itemRestaurantId = existing.restaurantId;



    // Cashier authorization: CASHIER role is granted scoped edit/specials access.
    // OWNER/ADMIN/MANAGER retain full access. Cashier edits are restricted to the
    // active outlet and to a whitelist of fields.
    const requesterRole = ((req as any).user?.role || '').toUpperCase();
    const isCashier = requesterRole === 'CASHIER';
    if (isCashier) {
      // Cashier can only edit items in their own active outlet (no cross-outlet edits).
      if (itemRestaurantId !== userRestaurantId) {
        res.status(403).json({ error: "Cashier can only edit items in the active outlet" });
        return;
      }
      // Cashier cannot move items between categories.
      if (category !== undefined) {
        res.status(403).json({ error: "Cashier cannot change item category" });
        return;
      }
      // Cashier cannot upload/replace images.
      if (imageUrl !== undefined) {
        res.status(400).json({ error: "Cashier cannot set an image URL" });
        return;
      }
      // Cashier cannot sync edits across outlets.
      if (syncToAllOutlets) {
        res.status(403).json({ error: "Cashier cannot sync items to all outlets" });
        return;
      }
      // Cashier cannot override category printer target.
      if (categoryPrinterTarget !== undefined && categoryPrinterTarget !== null) {
        res.status(403).json({ error: "Cashier cannot set category printer target" });
        return;
      }
      // Cashier cannot soft-delete via PATCH.
      if ((req.body as any).isDeleted !== undefined) {
        res.status(403).json({ error: "Cashier cannot delete items" });
        return;
      }
      // Determine whether this update touches regular fields, special fields, or both.
      const hasRegularFields =
        name !== undefined ||
        isVeg !== undefined ||
        price !== undefined ||
        menuType !== undefined ||
        unit !== undefined ||
        printerTarget !== undefined ||
        printerName !== undefined ||
        gstEnabled !== undefined ||
        isAvailable !== undefined;
      const hasSpecialFields =
        isSpecial !== undefined ||
        specialChannel !== undefined ||
        specialActive !== undefined ||
        specialExpiresAt !== undefined;
      if (hasRegularFields) {
        const allowedEdit = await hasPermission(req as any, 'menuEdit');
        if (!allowedEdit) {
          res.status(403).json({ error: "Cashier does not have permission to edit menu items" });
          return;
        }
      }
      if (hasSpecialFields) {
        const allowedSpecials = await hasPermission(req as any, 'menuSpecials');
        if (!allowedSpecials) {
          res.status(403).json({ error: "Cashier does not have permission to manage Today Specials" });
          return;
        }
      }
      if (!hasRegularFields && !hasSpecialFields) {
        res.status(400).json({ error: "No updatable fields provided" });
        return;
      }
    }



    // Validate unit field length (max 20 characters)

    if (unit && unit.length > 20) {

      res.status(400).json({ error: "unit field must be 20 characters or less" });

      return;

    }

    // Guard: cannot change menuType to LIQUOR in non-bar outlets
    if (menuType === 'LIQUOR') {
      const targetIsBar = await isBarOutlet(itemRestaurantId);
      if (!targetIsBar) {
        res.status(400).json({ error: "LIQUOR items can only exist in bar-type outlets (BAR_LOUNGE or BAR_WITH_DINING)" });
        return;
      }
    }



    const updateData: any = {};

    if (name !== undefined) updateData.name = name;

    if (isVeg !== undefined) updateData.isVeg = isVeg;

    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;

    if (menuType !== undefined) updateData.menuType = menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD';

    if (unit !== undefined) (updateData as any).unit = unit;

    if (printerTarget !== undefined) updateData.printerTarget = printerTarget || null;
    if (printerName !== undefined) updateData.printerName = printerName || null;
    // Liquor never has GST; food respects explicit gstEnabled from admin (including false)
    const effectiveMenuType = String(
      menuType !== undefined
        ? (menuType === 'LIQUOR' ? 'LIQUOR' : 'FOOD')
        : existing.menuType
    );
    if (effectiveMenuType === 'LIQUOR' || effectiveMenuType === 'BAR') {
      updateData.gstEnabled = false;
      updateData.isVeg = false;
    } else if (gstEnabled !== undefined) {
      updateData.gstEnabled = !!gstEnabled;
    }

    if (isSpecial !== undefined) updateData.isSpecial = isSpecial;
    if (specialChannel !== undefined) {
      const channel = specialChannel.toUpperCase();
      updateData.specialChannel = ["CASHIER", "CAPTAIN", "BOTH"].includes(channel) ? channel : "BOTH";
    }
    if (specialActive !== undefined) updateData.specialActive = specialActive;
    if (specialExpiresAt !== undefined) updateData.specialExpiresAt = specialExpiresAt ? new Date(specialExpiresAt) : null;
    if (isAvailable !== undefined) updateData.isAvailable = isAvailable;
    if (showInMenu !== undefined) updateData.showInMenu = !!showInMenu;



    if (category !== undefined) {

      let cat = await prisma.category.findFirst({

        where: {
          restaurantId: itemRestaurantId,
          name: { equals: category, mode: "insensitive" },
        },

      });

      if (!cat) {

        cat = await prisma.category.create({
          data: { name: category, restaurantId: itemRestaurantId },
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

        where: { menuItemId: id, restaurantId: itemRestaurantId, isDefault: true },

      });

      const fallbackVariant =

        defaultVariant ??

        (await prisma.menuItemVariant.findFirst({

          where: { menuItemId: id, restaurantId: itemRestaurantId },

          orderBy: { price: "asc" },

        }));

      if (fallbackVariant) {

        await prisma.menuItemVariant.update({

          where: { id: fallbackVariant.id },

          data: { price },

        });

      }

    }



    await upsertVenuePrices(id, itemRestaurantId, venuePrices);

    // Sync update to other outlets in the same organization if requested (special items only)
    if (syncToAllOutlets && (isSpecial || existing.isSpecial)) {
      const effectiveMenuType = updateData.menuType ?? existing.menuType;
      const allOutletsWithType = await getOrganizationOutletsWithTypes(itemRestaurantId);
      const otherOutlets = allOutletsWithType
        .filter(o => o.id !== itemRestaurantId)
        .filter(o => effectiveMenuType !== 'LIQUOR' || BAR_OUTLET_TYPES.has(o.restaurantType ?? ''))
        .map(o => o.id);
      for (const targetId of otherOutlets) {
        try {
          const sibling = await updateMenuItemByNameInOutlet(targetId, existing.name, updateData, price, category);
          if (!sibling) {
            await createMenuItemInOutlet(targetId, {
              name: existing.name,
              category: existing.category?.name || 'Main Course',
              isVeg: updateData.isVeg ?? existing.isVeg,
              price: Number(price ?? existing.basePrice),
              menuType: updateData.menuType ?? existing.menuType,
              imageUrl: updateData.imageUrl ?? existing.imageUrl,
              unit: updateData.unit ?? existing.unit,
              gstEnabled: updateData.gstEnabled ?? existing.gstEnabled,
              isSpecial: true,
              specialChannel: updateData.specialChannel ?? existing.specialChannel,
              specialActive: updateData.specialActive !== undefined ? updateData.specialActive : existing.specialActive,
              specialExpiresAt: updateData.specialExpiresAt
                ? updateData.specialExpiresAt.toISOString()
                : existing.specialExpiresAt?.toISOString(),
              categoryPrinterTarget: existing.category?.printerTarget,
              printerTarget: updateData.printerTarget ?? existing.printerTarget,
              printerName: updateData.printerName ?? existing.printerName,
            });
          }
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

      if (itemRestaurantId) {
        io.to(itemRestaurantId).emit("menu-item-updated", {

          itemId: id,

          action: "updated",

          updatedItem,

          restaurantId: itemRestaurantId,

        });
        io.to(`public:${itemRestaurantId}`).emit("menu-item-updated", {

          itemId: id,

          action: "updated",

          updatedItem,

          restaurantId: itemRestaurantId,

        });
      }

      // Also notify the admin's current outlet so their UI updates
      if (userRestaurantId && userRestaurantId !== itemRestaurantId) {
        io.to(userRestaurantId).emit("menu-item-updated", {
          itemId: id,
          action: "updated",
          updatedItem,
          restaurantId: userRestaurantId,
        });
      }

    } catch (e) {

      logger.warn({ err: e }, "[menu] Failed to emit socket event:");

    }



    // Clear cache to ensure fresh data on next fetch

    clearCache("menu:*");

    // Notify edge servers so they update local SQLite
    if (updatedItem && itemRestaurantId) {
      emitConfigChange(itemRestaurantId, "menu_item", "upsert", updatedItem);
      // Also emit variant changes so edge server syncs variant prices
      if (updatedItem.variants) {
        for (const v of updatedItem.variants) {
          emitConfigChange(itemRestaurantId, "menu_item_variant", "upsert", {
            id: v.id, name: v.name, price: v.price, isDefault: v.isDefault,
            menuItemId: v.menuItemId ?? id, isAvailable: v.isAvailable ?? true,
            restaurantId: itemRestaurantId,
          });
        }
      }
      if (userRestaurantId && userRestaurantId !== itemRestaurantId) {
        emitConfigChange(userRestaurantId, "menu_item", "upsert", updatedItem);
        if (updatedItem.variants) {
          for (const v of updatedItem.variants) {
            emitConfigChange(userRestaurantId, "menu_item_variant", "upsert", {
              id: v.id, name: v.name, price: v.price, isDefault: v.isDefault,
              menuItemId: v.menuItemId ?? id, isAvailable: v.isAvailable ?? true,
              restaurantId: userRestaurantId,
            });
          }
        }
      }
    }

    res.json(updatedItem ?? { ok: true });

  } catch (error) {

    logger.error(error);

    res.status(500).json({ error: "Failed to update item" });

  }

});



/** DELETE /items/:id â€” soft delete */

router.delete("/items/:id", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {

  try {

    const id = req.params.id as string;

    const restaurantId = getUserRestaurantId(req);

    if (!restaurantId) {

      res.status(401).json({ error: "Authentication required" });

      return;

    }



    const outletIds = await getOrganizationOutlets(restaurantId);

    const existing = await prisma.menuItem.findFirst({

      where: { id, restaurantId: { in: outletIds }, isDeleted: false },

    });

    if (!existing) {

      res.status(404).json({ error: "Item not found" });

      return;

    }

    const itemRestaurantId = existing.restaurantId;



    // Guard: warn when deleting an item that is a component of an active combo.
    // The caller may pass force=true to proceed anyway (the combo's
    // integrity-check will then flag the missing component).
    const force = (req.body as any)?.force === true || (req.query as any)?.force === '1';
    if (!force) {
      const referencingCombos = await prisma.comboComponent.findMany({
        where: { componentMenuItemId: id, restaurantId: itemRestaurantId },
        include: {
          comboMenuItem: { select: { id: true, name: true, isDeleted: true, isCombo: true } },
        },
      });
      const activeComboRefs = referencingCombos.filter((r) => r.comboMenuItem && !r.comboMenuItem.isDeleted && r.comboMenuItem.isCombo);
      if (activeComboRefs.length > 0) {
        res.status(409).json({
          error: "Item is used by one or more active combos",
          combos: activeComboRefs.map((r) => ({ id: r.comboMenuItem.id, name: r.comboMenuItem.name })),
          hint: "Remove it from those combos first, or re-issue the request with force=true to proceed (the combos will be flagged by integrity-check).",
        });
        return;
      }
    }

    await prisma.menuItem.update({

      where: { id },

      data: { isDeleted: true, deletedAt: new Date() },

    });



    // Notify edge servers of the deletion (soft-delete â†’ upsert with isDeleted=true)
    if (itemRestaurantId) {
      const deletedItem = await prisma.menuItem.findFirst({ where: { id } });
      if (deletedItem) emitConfigChange(itemRestaurantId, "menu_item", "upsert", deletedItem);
    }

    // Sync delete to other outlets for special items
    if (existing.isSpecial) {
      const allOutletsWithType = await getOrganizationOutletsWithTypes(itemRestaurantId);
      const otherOutlets = allOutletsWithType
        .filter(o => o.id !== itemRestaurantId)
        .filter(o => existing.menuType !== 'LIQUOR' || BAR_OUTLET_TYPES.has(o.restaurantType ?? ''))
        .map(o => o.id);
      for (const targetId of otherOutlets) {
        try {
          await prisma.menuItem.updateMany({
            where: {
              restaurantId: targetId,
              name: { equals: existing.name, mode: "insensitive" },
              isDeleted: false,
            },
            data: { isDeleted: true, deletedAt: new Date() },
          });
        } catch (err) {
          logger.warn({ err, targetId, name: existing.name }, '[menu] Failed to sync delete to outlet');
        }
      }
    }



    // Emit socket event for real-time sync

    try {

      const io = getIo();

      if (itemRestaurantId) {

        io.to(itemRestaurantId).emit("menu-item-updated", {

          itemId: id,

          action: "deleted",

          restaurantId: itemRestaurantId,

        });

        io.to(`public:${itemRestaurantId}`).emit("menu-item-updated", {

          itemId: id,

          action: "deleted",

          restaurantId: itemRestaurantId,

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



/** POST /upload-image â€” Cloudinary proxy */

router.post("/upload-image", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), menuUploadLimiter, async (req, res) => {

  try {

    const { base64 } = req.body as { base64: string };

    if (!base64) {

      res.status(400).json({ error: "base64 required" });

      return;

    }

    // Reject obviously-not-an-image payloads before doing any work
    const match = /^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/.exec(base64);
    if (!match) {
      return res.status(400).json({ error: "Only PNG/JPEG/WebP images are accepted" });
    }

    // Enforce a real size cap on the decoded bytes (base64 inflates ~33%)
    const decodedSize = Buffer.byteLength(match[3], "base64");
    const MAX_BYTES = 5 * 1024 * 1024; // 5MB, matches multer limit elsewhere
    if (decodedSize > MAX_BYTES) {
      return res.status(413).json({ error: "Image exceeds 5MB limit" });
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

      { method: "POST", body: formData, signal: AbortSignal.timeout(60000) }

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



/** GET /api/menu/public/:slug â€” Public menu endpoint for customer-facing menus
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

    const { resolvePublicRestaurant } = await import("../lib/resolvePublicRestaurant.js");
    const resolved = await resolvePublicRestaurant(tableId, slug);
    if (!resolved) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const restaurantId = resolved.restaurantId;

    // If tableId + sig provided, verify HMAC signature
    let tableNumber: number | undefined;
    if (tableId && sig) {
      const { verifyTableSignature } = await import("../lib/tableSignature.js");
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
            showInMenu: true,
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
        showInMenu: true,
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



/** GET /api/menu/unified?venue={venue} â€” Unified menu endpoint for all panels

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

        showInMenu: true,

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

          isCombo: item.isCombo,

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



/** GET /api/menu/integrity-check â€” Verify category and printerTarget integrity */

// ==========================================
// Combos — dedicated CRUD (Phase 2)
// ==========================================
// A Combo is a MenuItem row with isCombo=true that lives in a per-restaurant
// system "Combos" category. Its components are stored in the ComboComponent join
// table and are used ONLY for KOT ticket splitting and inventory deduction —
// they never participate in billing (the combo is billed as a single line at
// its own manually-entered price).

const COMBOS_CATEGORY_NAME = "Combos";

/** Resolve (create once, reuse after) the per-restaurant "Combos" system category. */
async function resolveOrCreateCombosCategory(restaurantId: string) {
  return resolveOrCreateCategory(restaurantId, COMBOS_CATEGORY_NAME);
}

/** GET /combos — list combos for the tenant (admin view, includes inactive). */
router.get("/combos", authenticate, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) ?? (req.query.restaurantId as string) ?? "";
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const combos = await prisma.menuItem.findMany({
      where: { restaurantId, isCombo: true, isDeleted: false },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      include: {
        category: { select: { name: true } },
        variants: { where: { isDefault: true }, select: { price: true }, take: 1 },
        comboOf: {
          include: {
            componentMenuItem: {
              select: {
                id: true,
                name: true,
                isVeg: true,
                menuType: true,
                isAvailable: true,
                isDeleted: true,
                category: { select: { name: true } },
                variants: { where: { isDefault: true }, select: { price: true }, take: 1 },
              },
            },
          },
        },
      },
    });

    const result = combos.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      imageUrl: c.imageUrl,
      isVeg: c.isVeg,
      isAvailable: c.isAvailable,
      gstEnabled: c.gstEnabled,
      menuType: c.menuType,
      printerTarget: c.printerTarget,
      printerName: c.printerName,
      price: c.variants[0]?.price ?? Number(c.basePrice),
      category: c.category?.name ?? COMBOS_CATEGORY_NAME,
      components: c.comboOf.map((cc) => ({
        id: cc.id,
        menuItemId: cc.componentMenuItemId,
        quantity: cc.quantity,
        name: cc.componentMenuItem?.name ?? "Unknown",
        isVeg: cc.componentMenuItem?.isVeg ?? true,
        menuType: cc.componentMenuItem?.menuType,
        category: cc.componentMenuItem?.category?.name,
        price: cc.componentMenuItem?.variants?.[0]?.price ?? 0,
        available: !!cc.componentMenuItem && !cc.componentMenuItem.isDeleted && cc.componentMenuItem.isAvailable,
      })),
    }));

    res.json(result);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch combos" });
  }
});

/** POST /combos — create a combo. */
router.post("/combos", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const { name, price, imageUrl, isVeg, gstEnabled, printerTarget, printerName, components } = req.body as {
      name: string;
      price: number;
      imageUrl?: string;
      isVeg: boolean;
      gstEnabled?: boolean;
      printerTarget?: string | null;
      printerName?: string | null;
      components: Array<{ menuItemId: string; quantity: number }>;
    };

    if (!name || price == null) {
      res.status(400).json({ error: "name and price are required" });
      return;
    }
    if (!Array.isArray(components) || components.length === 0) {
      res.status(400).json({ error: "A combo must have at least one component" });
      return;
    }

    // Validate component ids + reject nested combos
    const componentIds = Array.from(new Set(components.map((c) => c.menuItemId)));
    const componentItems = await prisma.menuItem.findMany({
      where: { id: { in: componentIds }, restaurantId, isDeleted: false },
      select: { id: true, isCombo: true },
    });
    const componentById = new Map(componentItems.map((m) => [m.id, m]));
    const missing = componentIds.filter((id) => !componentById.has(id));
    if (missing.length) {
      res.status(400).json({ error: "Invalid component menuItemIds", missing });
      return;
    }
    const nestedCombos = componentIds.filter((id) => componentById.get(id)?.isCombo);
    if (nestedCombos.length) {
      res.status(400).json({ error: "A combo cannot contain another combo as a component", nestedCombos });
      return;
    }

    const cat = await resolveOrCreateCombosCategory(restaurantId);

    const combo = await prisma.$transaction(async (tx) => {
      const item = await tx.menuItem.create({
        data: {
          name,
          basePrice: price,
          isVeg: isVeg ?? true,
          gstEnabled: gstEnabled !== false,
          menuType: "FOOD",
          restaurantId,
          imageUrl: imageUrl ?? null,
          printerTarget: printerTarget ?? null,
          printerName: printerName ?? null,
          isCombo: true,
          showInMenu: true,
          isDeleted: false,
          categoryId: cat.id,
          variants: {
            create: [{ name: "Regular", price, isDefault: true, restaurantId }],
          },
          comboOf: {
            create: components.map((c) => ({
              componentMenuItemId: c.menuItemId,
              quantity: Number(c.quantity) || 1,
              restaurantId,
            })),
          },
        },
        include: {
          variants: true,
          category: true,
          comboOf: { include: { componentMenuItem: { select: { id: true, name: true, menuType: true, isAvailable: true, isDeleted: true } } } },
        },
      });
      return item;
    });

    clearCache("menu:");

    // Notify edge servers
    emitConfigChange(restaurantId, "menu_item", "upsert", combo);
    for (const cc of combo.comboOf) {
      emitConfigChange(restaurantId, "combo_component", "upsert", {
        id: cc.id,
        comboMenuItemId: combo.id,
        componentMenuItemId: cc.componentMenuItemId,
        quantity: cc.quantity,
        restaurantId,
      });
    }

    // Socket event for real-time sync
    try {
      const io = getIo();
      io.to(restaurantId).emit("menu-item-updated", { itemId: combo.id, action: "created", updatedItem: combo, restaurantId });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", { itemId: combo.id, action: "created", updatedItem: combo, restaurantId });
    } catch (e) {
      logger.warn({ err: e }, "[menu] Failed to emit combo create socket event:");
    }

    res.status(201).json(combo);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create combo" });
  }
});

/** PATCH /combos/:id — update combo fields and fully replace its components. */
router.patch("/combos/:id", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const { name, price, imageUrl, isVeg, gstEnabled, printerTarget, printerName, isAvailable, components } = req.body as {
      name?: string;
      price?: number;
      imageUrl?: string;
      isVeg?: boolean;
      gstEnabled?: boolean;
      printerTarget?: string | null;
      printerName?: string | null;
      isAvailable?: boolean;
      components?: Array<{ menuItemId: string; quantity: number }>;
    };

    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId, isCombo: true, isDeleted: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Combo not found" });
      return;
    }

    // Validate new component set if provided
    let validatedComponents: Array<{ menuItemId: string; quantity: number }> | undefined;
    if (Array.isArray(components)) {
      if (components.length === 0) {
        res.status(400).json({ error: "A combo must have at least one component" });
        return;
      }
      const componentIds = Array.from(new Set(components.map((c) => c.menuItemId)));
      const componentItems = await prisma.menuItem.findMany({
        where: { id: { in: componentIds }, restaurantId, isDeleted: false },
        select: { id: true, isCombo: true },
      });
      const componentById = new Map(componentItems.map((m) => [m.id, m]));
      const missing = componentIds.filter((cid) => !componentById.has(cid));
      if (missing.length) {
        res.status(400).json({ error: "Invalid component menuItemIds", missing });
        return;
      }
      const nestedCombos = componentIds.filter((cid) => componentById.get(cid)?.isCombo);
      if (nestedCombos.length) {
        res.status(400).json({ error: "A combo cannot contain another combo as a component", nestedCombos });
        return;
      }
      validatedComponents = components.map((c) => ({ menuItemId: c.menuItemId, quantity: Number(c.quantity) || 1 }));
    }

    const cat = await resolveOrCreateCombosCategory(restaurantId);

    const updated = await prisma.$transaction(async (tx) => {
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (isVeg !== undefined) updateData.isVeg = isVeg;
      if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
      if (printerTarget !== undefined) updateData.printerTarget = printerTarget || null;
      if (printerName !== undefined) updateData.printerName = printerName || null;
      if (gstEnabled !== undefined) updateData.gstEnabled = !!gstEnabled;
      if (isAvailable !== undefined) updateData.isAvailable = isAvailable;
      updateData.categoryId = cat.id;

      if (price !== undefined) {
        updateData.basePrice = price;
      }

      if (Object.keys(updateData).length > 0) {
        await tx.menuItem.update({ where: { id }, data: updateData });
      }

      if (price !== undefined) {
        const defaultVariant = await tx.menuItemVariant.findFirst({
          where: { menuItemId: id, restaurantId, isDefault: true },
        });
        const fallbackVariant = defaultVariant ?? (await tx.menuItemVariant.findFirst({
          where: { menuItemId: id, restaurantId },
          orderBy: { price: "asc" },
        }));
        if (fallbackVariant) {
          await tx.menuItemVariant.update({ where: { id: fallbackVariant.id }, data: { price } });
        }
      }

      // Fully replace the component set (delete + recreate)
      if (validatedComponents) {
        await tx.comboComponent.deleteMany({ where: { comboMenuItemId: id } });
        await tx.comboComponent.createMany({
          data: validatedComponents.map((c) => ({
            comboMenuItemId: id,
            componentMenuItemId: c.menuItemId,
            quantity: c.quantity,
            restaurantId,
          })),
        });
      }

      return tx.menuItem.findFirst({
        where: { id },
        include: {
          variants: true,
          category: true,
          comboOf: { include: { componentMenuItem: { select: { id: true, name: true, menuType: true, isAvailable: true, isDeleted: true } } } },
        },
      });
    });

    clearCache("menu:");

    if (updated) {
      emitConfigChange(restaurantId, "menu_item", "upsert", updated);
      for (const cc of updated.comboOf) {
        emitConfigChange(restaurantId, "combo_component", "upsert", {
          id: cc.id,
          comboMenuItemId: updated.id,
          componentMenuItemId: cc.componentMenuItemId,
          quantity: cc.quantity,
          restaurantId,
        });
      }
    }

    try {
      const io = getIo();
      io.to(restaurantId).emit("menu-item-updated", { itemId: id, action: "updated", updatedItem: updated, restaurantId });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", { itemId: id, action: "updated", updatedItem: updated, restaurantId });
    } catch (e) {
      logger.warn({ err: e }, "[menu] Failed to emit combo update socket event:");
    }

    res.json(updated ?? { ok: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update combo" });
  }
});

/** DELETE /combos/:id — soft-delete a combo and remove its component rows. */
router.delete("/combos/:id", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const existing = await prisma.menuItem.findFirst({
      where: { id, restaurantId, isCombo: true, isDeleted: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Combo not found" });
      return;
    }

    await prisma.$transaction(async (tx) => {
      // Cascade-remove component rows (the schema also has onDelete: Cascade on
      // comboMenuItem, but we do it explicitly to emit edge deletes cleanly).
      await tx.comboComponent.deleteMany({ where: { comboMenuItemId: id } });
      await tx.menuItem.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() },
      });
    });

    clearCache("menu:");

    const deletedItem = await prisma.menuItem.findFirst({ where: { id } });
    if (deletedItem) emitConfigChange(restaurantId, "menu_item", "upsert", deletedItem);

    try {
      const io = getIo();
      io.to(restaurantId).emit("menu-item-updated", { itemId: id, action: "deleted", restaurantId });
      io.to(`public:${restaurantId}`).emit("menu-item-updated", { itemId: id, action: "deleted", restaurantId });
    } catch (e) {
      logger.warn({ err: e }, "[menu] Failed to emit combo delete socket event:");
    }

    res.json({ ok: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to delete combo" });
  }
});

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



    // ── Combo integrity: flag combos whose components were deleted/deactivated ──
    const comboItems = items.filter((i: any) => i.isCombo);
    if (comboItems.length > 0) {
      const comboIds = comboItems.map((c) => c.id);
      const comboComponents = await prisma.comboComponent.findMany({
        where: { comboMenuItemId: { in: comboIds }, restaurantId },
        include: {
          componentMenuItem: { select: { id: true, name: true, isAvailable: true, isDeleted: true } },
        },
      });
      const componentsByCombo = new Map<string, typeof comboComponents>();
      for (const cc of comboComponents) {
        const arr = componentsByCombo.get(cc.comboMenuItemId) ?? [];
        arr.push(cc);
        componentsByCombo.set(cc.comboMenuItemId, arr);
      }
      for (const combo of comboItems) {
        const comps = componentsByCombo.get(combo.id) ?? [];
        if (comps.length === 0) {
          issues.push({
            itemId: combo.id,
            itemName: combo.name,
            issue: "Combo has no components",
            severity: "high",
          });
          continue;
        }
        for (const cc of comps) {
          const cm = cc.componentMenuItem;
          if (!cm || cm.isDeleted) {
            issues.push({
              itemId: combo.id,
              itemName: combo.name,
              issue: `Combo component "${cc.componentMenuItemId}" was deleted`,
              severity: "high",
              componentMenuItemId: cc.componentMenuItemId,
            });
          } else if (!cm.isAvailable) {
            issues.push({
              itemId: combo.id,
              itemName: combo.name,
              issue: `Combo component "${cm.name}" is unavailable`,
              severity: "medium",
              componentMenuItemId: cm.id,
            });
          }
        }
      }
    }

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

/** POST /api/menu/invalidate-cache â€” Admin endpoint to force fresh menu fetches */
router.post("/invalidate-cache", authenticate, requireTenantScope, (req, res) => {
  clearCache("menu:*");
  clearCache("barMenu:*");
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

function computeConfidence(rows: any[], warnings: string[]): "HIGH" | "MEDIUM" | "LOW" {
  if (rows.length === 0) return "LOW";
  if (rows.length >= 10 && warnings.length <= 2) return "HIGH";
  if (rows.length >= 3 && warnings.length <= 5) return "MEDIUM";
  return "LOW";
}

// detectItemHeaderRow, parseMultiBlockLayout, detectRateCardLayout, parseRateCardMatrix,
// normalizeHeader, isPureNumber, parsePrice, isHeaderKeyword, inferVeg, normalizeVenueName,
// VENUE_KEYWORDS, VENUE_ALIASES â€” extracted to services/import/menuHelpers.ts and imported above.
// The following duplicate function bodies (detectItemHeaderRow, parseMultiBlockLayout,
// detectRateCardLayout, parseRateCardMatrix, normalizeVenueName, VENUE_KEYWORDS, VENUE_ALIASES)
// have been removed â€” they are imported from menuHelpers.ts at the top of this file.

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

  // Build lookup from section names â†’ sectionTag (legacy venueId)
  // We need to get sectionTags from tables since Section doesn't have sectionTag directly
  const tables = await prisma.table.findMany({
    where: { restaurantId },
    select: { sectionId: true, sectionTag: true },
    distinct: ["sectionId", "sectionTag"],
  });

  const sectionTagMap = new Map<string, string>(); // sectionId â†’ sectionTag
  for (const t of tables) {
    if (t.sectionTag && !sectionTagMap.has(t.sectionId)) {
      sectionTagMap.set(t.sectionId, t.sectionTag);
    }
  }

  // Build normalized lookup: normalizedVenueName â†’ venueId (legacy tag or Venue.id)
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

// parseExcelOrCsv and parseStandardExcel have been replaced by the import pipeline
// (services/import/parsers/excelParser.ts + services/import/normalizer.ts).
// The old implementations are removed â€” the new pipeline is called from the
// /upload endpoint below.
// parseStandardExcel, LIQUOR_KEYWORDS, GARBAGE_KEYWORDS, isCategoryHeader, keywordMatches,
// inferMenuTypeFromCategory, extractVariantPrices, extractPrices, extractItemName, isGarbageLine,
// inferCategoryFromName, and parsePdf have been removed â€” they are replaced by the import pipeline
// (services/import/parsers/* + services/import/normalizer.ts + services/import/menuHelpers.ts).

/** POST /api/menu/upload â€” parse uploaded file (xlsx, csv, pdf, image) and return UploadResult */
router.post("/upload", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), menuUploadLimiter, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const sessionId = req.body?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 8) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    const restaurantType = (req.body?.restaurantType as string) || undefined;
    const restaurantId = (req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId;

    // Detect file type from extension
    const fileType = detectFileType(req.file.originalname);
    if (!fileType) {
      return res.status(400).json({ error: `Unsupported file type: ${req.file.originalname}. Use xlsx, xls, csv, pdf, jpg, jpeg, or png.` });
    }

    // Load saved column mappings for this restaurant (excel/csv only â€” applies to suggestedMapping)
    let savedMappings: Record<string, CanonicalField> | undefined;
    if ((fileType === 'excel' || fileType === 'csv') && restaurantId) {
      const saved = await prisma.menuColumnMapping.findMany({
        where: { restaurantId },
        select: { originalHeader: true, canonicalField: true },
      });
      if (saved.length > 0) {
        // canonicalField is a plain String column, so rows written by an older
        // build (or edited by hand) may hold values that are no longer valid.
        // Skip those instead of casting so auto-detection is used for that column.
        savedMappings = {};
        for (const s of saved) {
          if (isCanonicalField(s.canonicalField)) {
            savedMappings[s.originalHeader] = s.canonicalField;
          } else {
            logger.warn(
              { restaurantId, originalHeader: s.originalHeader, canonicalField: s.canonicalField },
              '[menu/upload] Ignoring saved column mapping with unknown canonical field',
            );
          }
        }
      }
    }

    // Parse via the import pipeline
    const rawData: RawImportData = await parseFile(
      req.file.buffer,
      fileType,
      req.file.originalname,
      restaurantType,
      savedMappings,
    );

    // For rate-card mode, resolve venue names if restaurantId is available
    if (rawData.isRateCard && rawData.venueHeaders && rawData.venueHeaders.length > 0 && restaurantId) {
      const { nameToVenueId, unmatched } = await resolveVenueMap(rawData.venueHeaders, restaurantId);
      (rawData as any).venueMap = nameToVenueId;
      (rawData as any).unmatchedVenues = unmatched;
      if (unmatched.length > 0) {
        rawData.warnings.push(`Could not match venue column(s): ${unmatched.join(", ")}. These prices will be ignored on import.`);
      }
    }

    // Convert to UploadResult
    const result = toUploadResult(rawData);

    // For pdf/image (requiresMapping=false), validate immediately so errors are shown in preview
    if (!result.requiresMapping && result.normalizedRows.length > 0) {
      let ctx: RestaurantValidationContext | undefined;
      if (restaurantId) {
        const targetIsBar = await isBarOutlet(restaurantId);
        const existingItems = await prisma.menuItem.findMany({
          where: { restaurantId, isDeleted: false },
          select: { name: true },
        });
        ctx = {
          isBarOutlet: targetIsBar,
          existingItemNames: new Set(existingItems.map(i => i.name.toLowerCase().trim())),
        };
      }
      const { errors } = validateNormalized(result.normalizedRows, ctx);
      result.errors = errors;
    }

    res.json(result);
  } catch (error: any) {
    logger.error({ err: error }, "[menu/upload]");
    res.status(500).json({ error: "Failed to parse file: " + error.message });
  }
});

/** POST /api/menu/admin/apply-mapping â€” apply confirmed column mapping, normalize, validate */
router.post("/apply-mapping", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const { columns, mapping, rows, restaurantType } = req.body as {
      columns: string[];
      mapping: Record<number, string | null>;
      rows: Array<{ index: number; cells: any[] }>;
      restaurantType?: string;
    };

    if (!Array.isArray(columns) || !Array.isArray(rows)) {
      return res.status(400).json({ error: "columns and rows arrays are required" });
    }
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: "mapping object is required" });
    }

    const restaurantId = (req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId;

    // Save the confirmed mapping for this restaurant (upsert)
    if (restaurantId) {
      // Only persist recognised canonical fields — unknown values are dropped
      // here so they cannot be read back as a bad mapping on the next upload.
      const mappingEntries: Array<{ originalHeader: string; canonicalField: CanonicalField }> = [];
      for (let i = 0; i < columns.length; i++) {
        const field = mapping[i];
        if (isCanonicalField(field)) {
          mappingEntries.push({ originalHeader: columns[i], canonicalField: field });
        }
      }
      if (mappingEntries.length > 0) {
        await prisma.$transaction(
          mappingEntries.map(entry =>
            prisma.menuColumnMapping.upsert({
              where: {
                restaurantId_originalHeader: {
                  restaurantId,
                  originalHeader: entry.originalHeader,
                },
              },
              create: {
                restaurantId,
                originalHeader: entry.originalHeader,
                canonicalField: entry.canonicalField,
              },
              update: {
                canonicalField: entry.canonicalField,
              },
            })
          )
        );
      }
    }

    // Build ColumnMapping[] from the user's mapping object
    const columnMappings: ColumnMapping[] = userMappingToColumnMappings(mapping, columns.length);

    // Reconstruct RawImportData from the request (the frontend sends back what /upload returned)
    const rawData: RawImportData = {
      fileType: 'excel',
      columns,
      suggestedMapping: columnMappings,
      rows: rows.map(r => ({ index: r.index, cells: r.cells })),
      requiresMapping: true,
      warnings: [],
    };

    // Build restaurant validation context
    let ctx: RestaurantValidationContext | undefined;
    if (restaurantId) {
      const targetIsBar = await isBarOutlet(restaurantId);
      const existingItems = await prisma.menuItem.findMany({
        where: { restaurantId, isDeleted: false },
        select: { name: true },
      });
      ctx = {
        isBarOutlet: targetIsBar,
        existingItemNames: new Set(existingItems.map(i => i.name.toLowerCase().trim())),
      };
    }

    // Normalize + validate
    const { normalizedRows, errors } = applyMappingAndValidate(rawData, columnMappings, restaurantType, ctx);

    const result: UploadResult = {
      fileType: 'excel',
      columns,
      suggestedMapping: columnMappings,
      rows: rawData.rows,
      normalizedRows,
      requiresMapping: false,
      warnings: [],
      errors,
    };

    res.json(result);
  } catch (error: any) {
    logger.error({ err: error }, "[menu/apply-mapping]");
    res.status(500).json({ error: "Failed to apply mapping: " + error.message });
  }
});

/** GET /api/menu/admin/column-mappings â€” get saved column mappings for this restaurant */
router.get("/column-mappings", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const restaurantId = (req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const mappings = await prisma.menuColumnMapping.findMany({
      where: { restaurantId },
      select: { originalHeader: true, canonicalField: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ mappings });
  } catch (error: any) {
    logger.error({ err: error }, "[menu/column-mappings GET]");
    res.status(500).json({ error: error.message });
  }
});

/** PUT /api/menu/admin/column-mappings â€” save/update column mappings for this restaurant */
router.put("/column-mappings", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const restaurantId = (req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { mappings } = req.body as {
      mappings: Array<{ originalHeader: string; canonicalField: string }>;
    };

    if (!Array.isArray(mappings)) {
      return res.status(400).json({ error: "mappings array is required" });
    }

    // Reject unknown canonical fields so the table never stores a value the
    // importer cannot interpret on the next upload.
    const invalidFields = mappings.filter(m => !isCanonicalField(m?.canonicalField));
    if (invalidFields.length > 0) {
      return res.status(400).json({
        error: "Invalid canonicalField value",
        invalidFields: invalidFields.map(m => m?.canonicalField),
      });
    }
    if (mappings.some(m => typeof m.originalHeader !== 'string' || m.originalHeader.trim() === '')) {
      return res.status(400).json({ error: "originalHeader must be a non-empty string" });
    }

    await prisma.$transaction(
      mappings.map(m =>
        prisma.menuColumnMapping.upsert({
          where: {
            restaurantId_originalHeader: {
              restaurantId,
              originalHeader: m.originalHeader,
            },
          },
          create: {
            restaurantId,
            originalHeader: m.originalHeader,
            canonicalField: m.canonicalField,
          },
          update: {
            canonicalField: m.canonicalField,
          },
        })
      )
    );

    res.json({ saved: mappings.length });
  } catch (error: any) {
    logger.error({ err: error }, "[menu/column-mappings PUT]");
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€ Legacy upload endpoints removed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The old /upload and /upload-ai endpoints (which called parseExcelOrCsv / parsePdf /
// parseMenuWithGroq directly) have been replaced by the new /upload endpoint above
// which routes through the import pipeline. The old implementations are removed.

/** POST /api/menu/bulk-import â€” create menu items from normalized rows */
// The old parseStandardExcel, LIQUOR_KEYWORDS, GARBAGE_KEYWORDS, isCategoryHeader,
// keywordMatches, inferMenuTypeFromCategory, extractVariantPrices, extractPrices,
// extractItemName, isGarbageLine, inferCategoryFromName, parsePdf, and the old
// /upload + /upload-ai endpoints have been removed and replaced by the import
// pipeline above. The bulk-import endpoint below is retained as-is.


/** POST /api/menu/bulk-import â€” create menu items from parsed rows */
router.post("/bulk-import", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const { rows, mode, venueMap, targetVenueId, replaceExisting } = req.body;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized â€” no restaurantId found in auth token or request body" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array is required" });
    }

    // Guard: LIQUOR items cannot be imported into non-bar outlets
    const targetIsBar = await isBarOutlet(restaurantId);
    let effectiveRows = rows;
    if (!targetIsBar) {
      const liquorRows = rows.filter((r: any) => r.menuType === 'LIQUOR');
      if (liquorRows.length > 0) {
        effectiveRows = rows.filter((r: any) => r.menuType !== 'LIQUOR');
        logger.info({ restaurantId, liquorCount: liquorRows.length }, "[menu/bulk-import] Skipped LIQUOR items for non-bar outlet");
      }
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

    // â”€â”€ Rate Card Mode â”€â”€
    if (mode === "rate-card") {
      // Resolve venue names to venue IDs if not already provided
      let resolvedVenueMap: Record<string, string> = venueMap || {};
      if (Object.keys(resolvedVenueMap).length === 0) {
        // Extract all unique venue names from effectiveRows
        const allVenueNames = new Set<string>();
        for (const row of effectiveRows) {
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

      // Group effectiveRows by category for category upsert
      const categoryMap = new Map<string, any[]>();
      for (const row of effectiveRows) {
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

      // Build venueId â†’ priceProfileId map, auto-creating profiles for venues without one
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
      const profileToVenues = new Map<string, string[]>(); // profileId â†’ [venueId, ...]
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
                  gstEnabled: (row.menuType || "FOOD") === "LIQUOR" ? false : undefined,
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
                  gstEnabled: (row.menuType || "FOOD") === "LIQUOR" ? false : true,
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

      clearCache("menu:*");
      clearCache("barMenu:*");
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

    // â”€â”€ Standard Mode (existing logic) â”€â”€
    // Group effectiveRows by category
    const standardCategoryMap = new Map<string, any[]>();
    for (const row of effectiveRows) {
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
            gstEnabled: (row.menuType || existing.menuType || "FOOD") === "LIQUOR" ? false : undefined,
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
              gstEnabled: (row.menuType || "FOOD") === "LIQUOR" ? false : true,
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

    clearCache("menu:*");
    clearCache("barMenu:*");
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

/** GET /api/menu/recipes/:menuItemId â€” get recipe for a menu item */
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

/** POST /api/menu/recipes/auto-generate â€” generate/overwrite recipes for all FOOD items */
router.post("/recipes/auto-generate", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req: any, res) => {
  try {
    const restaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });

    // Rate-limit log-flag: warn if called more than once within 60s
    const lastCalled = autoGenerateLastCalled.get(restaurantId);
    const now = Date.now();
    if (lastCalled && now - lastCalled < 60_000) {
      logger.warn(
        `[menu/auto-generate] Restaurant ${restaurantId} called auto-generate again within ${Math.round((now - lastCalled) / 1000)}s â€” destructive overwrite.`,
      );
    }
    autoGenerateLastCalled.set(restaurantId, now);

    // Log warning for very large menus (don't block)
    const foodCount = await prisma.menuItem.count({
      where: { restaurantId, isDeleted: false, menuType: "FOOD" },
    });
    if (foodCount > 300) {
      logger.warn(
        `[menu/auto-generate] Restaurant ${restaurantId} has ${foodCount} FOOD items â€” this may take several seconds.`,
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

/** POST /api/menu/recipes/:menuItemId â€” set recipe for a menu item */
router.post("/recipes/:menuItemId", authenticate, requireTenantScope, requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const menuItemId = String(req.params.menuItemId);
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

