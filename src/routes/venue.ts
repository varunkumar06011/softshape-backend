// ─────────────────────────────────────────────────────────────────────────────
// Venue Routes — Family Restaurant and Parcel sections
// ─────────────────────────────────────────────────────────────────────────────
// Handles venue-specific endpoints for family restaurants and parcel/takeaway.
// All sections live under the current authenticated restaurant.
//
// Endpoints:
//   GET /api/venue/sections         — all sections + tables (same shape as /api/tables)
//   GET /api/venue/menu?venueId=X   — menu with venue-specific price overrides
//   GET /api/venue/table-label/:id  — formatted label for a venue table (for KOT printing)
//
// Orders, billing, settlement all go through the existing /api/orders and /api/tables
// endpoints using the authenticated user's restaurantId and the correct tableId.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Venue Routes — /api/venue/*
 *
 * Handles Family Restaurant and Parcel.
 * All sections live under the current authenticated restaurant.
 *
 * GET /api/venue/sections         — all sections + tables (same shape as /api/tables)
 * GET /api/venue/menu?venueId=X   — menu with venue-specific price overrides
 * GET /api/venue/table-label/:id  — returns the formatted label for a venue table (for KOT printing)
 *
 * Orders, billing, settlement all go through the existing /api/orders and /api/tables
 * endpoints using the authenticated user's restaurantId and the correct tableId.
 */

import { OrderStatus, TableStatus } from "@prisma/client";
import logger from "../lib/logger";
import { Router } from "express";
import { getIo } from "../socket";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache, cacheClear } from "../lib/cache";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { resolveTenantContext } from "../lib/tenantContext";
import { buildVenuePriceMap, buildAllVenuePriceMaps } from "../lib/priceResolver";

const router = Router();

// Helper: extract the effective restaurantId from the authenticated user
function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}


// LEGACY: Helper function to map section name/id to sectionTag.
// sectionId takes priority for disambiguation (e.g. 'section-parcel' → restaurant parcel).
// This is only called for legacy tenants where Section.venueId is null.
function getSectionTagLegacy(sectionName: string, sectionId?: string): string {
  // ID-based overrides (most specific — must come first)
  if (sectionId === 'section-parcel') return 'venue-restaurant-parcel';
  if (sectionId === 'section-bar-parcel' || sectionId === 'section-venue-gobox') return 'venue-bar-gobox';
  if (sectionId === 'section-family-restaurant') return 'venue-family-restaurant';
  if (sectionId === 'section-conference') return 'venue-bar-conference';
  if (sectionId === 'section-pdr') return 'venue-bar-pdr';
  if (sectionId === 'section-rooms') return 'venue-bar-rooms';
  // Name-based fallback
  const n = sectionName.trim().toLowerCase();
  if (n.includes('bar ac') || n === 'bar hall' || n === 'main hall') return 'venue-bar-ac-hall';
  if (n.includes('conference')) return 'venue-bar-conference';
  if (n.includes('pdr')) return 'venue-bar-pdr';
  if (n.includes('rooms') || n.includes('room')) return 'venue-bar-rooms';
  if (n.includes('parcel') && n.includes('restaurant')) return 'venue-restaurant-parcel';
  if (n.includes('gobox') || n.includes('go box') || (n.includes('bar') && n.includes('parcel'))) return 'venue-bar-gobox';
  if (n.includes('family restaurant')) return 'venue-family-restaurant';
  return 'venue-unknown';
}

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.BILLING_REQUESTED,
];

const tableInclude = {
  section: {
    select: { id: true, name: true, restaurantId: true },
  },
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: { updatedAt: "desc" } as const,
    take: 1,
    include: { items: true },
  },
} as const;

// ─── GET /api/venue/sections ─────────────────────────────────────────────────
// Returns all venue sections with their tables (same shape as GET /api/tables).
// Pure read — no side effects, no auto-creation of legacy sections.
router.get("/sections", cacheMiddleware("venue:sections", 30_000), async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) ?? '';

    const sections = await prisma.section.findMany({
      where: { restaurantId },
      orderBy: { id: "asc" },
      include: {
        venue: { select: { id: true, name: true, venueType: true } },
        tables: {
          where: { restaurantId },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });
    res.json(sections);
  } catch (err) {
    logger.error({ err }, "[venue/sections]");
    res.status(500).json({ error: "Failed to fetch venue sections" });
  }
});
// ─── GET /api/venue/menu?venueId=venue-family-restaurant ────────────────────────────
// Returns menu items with venue-specific price overrides for the given venue.
// For bar venues, filters out items with price = 0.
// For restaurant venues, shows all items.
router.get("/menu", authenticate, cacheMiddleware("menu:venue", 60_000), async (req: any, res) => {
  try {
    const venueId = (req.query.venueId as string) || "";
    const authRestaurantId = (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string;
    if (!authRestaurantId) {
      return res.status(400).json({ error: "Authentication required" });
    }
    const restaurantId = authRestaurantId;

    // Detect bar venue for zero-price filtering
    let isBarVenue = false;
    if (venueId) {
      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { name: true, venueType: true },
      });
      isBarVenue = (venue?.name?.toLowerCase().includes("bar") ?? false) || venue?.venueType === "BAR";
    }

    const items = await prisma.menuItem.findMany({
      where: {
        restaurantId,
        isAvailable: true,
        isDeleted: false,
      },
      include: {
        variants: { orderBy: { isDefault: "desc" } },
        category: { select: { id: true, name: true, sortOrder: true } },
      },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
    });

    let priceMap = new Map<string, number>();
    if (venueId) {
      priceMap = await buildVenuePriceMap(venueId, restaurantId);
    }

    const result = items
      .map((item) => {
        const defaultVariant = item.variants.find((v) => v.isDefault) ?? item.variants[0];
        const basePrice = Number(defaultVariant?.price ?? item.basePrice ?? 0);
        const venuePrice = priceMap.get(item.id);
        const price = venuePrice !== undefined ? venuePrice : (isBarVenue ? 0 : basePrice);

        return {
          id: item.id,
          name: item.name,
          description: item.description,
          imageUrl: item.imageUrl,
          isVeg: item.isVeg,
          isAvailable: item.isAvailable,
          menuType: item.menuType,
          category: item.category.name,
          categoryId: item.category.id,
          categorySort: item.category.sortOrder,
          price,
          basePrice,
          hasVenuePrice: venuePrice !== undefined,
          variants: item.variants.map((v) => ({
            id: v.id,
            name: v.name,
            price: Number(v.price),
            isDefault: v.isDefault,
          })),
        };
      })
      .filter((item) => isBarVenue ? item.price > 0 : true);

    res.json(result);
  } catch (err) {
    logger.error({ err }, "[venue/menu]");
    res.status(500).json({ error: "Failed to fetch venue menu" });
  }
});

// ─── GET /api/venue/table-label/:tableId ─────────────────────────────────────
// Returns the formatted label for a venue table, used by the print service.
// e.g. Conference Hall → "C1", PDR → "C2", Rooms table 3 → "R3", Parcel → "PARCEL"
router.get("/table-label/:tableId", async (req, res) => {
  try {
    const tableId = req.params.tableId as string;
    const table = await prisma.table.findFirst({
      where: { id: tableId, restaurantId: getUserRestaurantId(req) ?? '' },
      include: { section: { select: { name: true } } },
    });

    if (!table) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const label = formatVenueTableLabel(table.section.name, table.number);
    res.json({ label });
  } catch (err) {
    logger.error({ err }, "[venue/table-label]");
    res.status(500).json({ error: "Failed to get table label" });
  }
});

// ─── PUT /api/venue/prices ────────────────────────────────────────────────────
// Bulk upsert venue prices. Body: { venueId, prices: [{menuItemId, price}] }
router.put("/prices", authenticate, assertTenantScope, withTenantContext, invalidateCache(["menu:*", "barMenu:*", "venue:all-prices:*"]), async (req: any, res) => {
  try {
    const { venueId, prices } = req.body as {
      venueId?: string;
      prices?: Array<{ menuItemId: string; price: number }>;
    };

    if (!venueId || !Array.isArray(prices)) {
      res.status(400).json({ error: "venueId and prices array required" });
      return;
    }
    if (!req.user?.activeRestaurantId && !req.user?.restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const ownerId = req.user.activeRestaurantId ?? req.user.restaurantId;
    const ctx = await resolveTenantContext(ownerId);

    // Look up the venue's priceProfileId, auto-create if missing
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true, priceProfileId: true },
    });

    if (!venue) {
      res.status(404).json({ error: "Venue not found" });
      return;
    }

    let priceProfileId = venue.priceProfileId;
    if (!priceProfileId) {
      const pp = await prisma.priceProfile.create({
        data: { restaurantId: ownerId, name: venue.name || venueId },
      });
      await prisma.venue.update({
        where: { id: venueId },
        data: { priceProfileId: pp.id },
      });
      priceProfileId = pp.id;
    }

    const results = await Promise.all(
      prices.map((p) =>
        prisma.priceProfileItem.upsert({
          where: {
            priceProfileId_menuItemId: {
              priceProfileId: priceProfileId!,
              menuItemId: p.menuItemId,
            },
          },
          create: {
            priceProfileId: priceProfileId!,
            menuItemId: p.menuItemId,
            price: p.price,
            restaurantId: ownerId,
          },
          update: { price: p.price },
        })
      )
    );

    res.json({ updated: results.length });

    // Notify all connected clients to refresh venue prices
    try {
      getIo().emit("venuePrices:updated");
    } catch (e) {
      logger.error({ err: e }, "[venue/prices PUT] Socket emit failed:");
    }
  } catch (err) {
    logger.error({ err }, "[venue/prices PUT]");
    res.status(500).json({ error: "Failed to update venue prices" });
  }
});

// ──────────────── GET /api/venue/all-prices ──────────────────────────────────
// Returns a global map of all active venue prices: { venueId: { menuItemId: price } }
router.get("/all-prices", authenticate, cacheMiddleware("venue:all-prices", 5 * 60_000), async (req: any, res) => {
  try {
    if (!req.user?.activeRestaurantId && !req.user?.restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const ctx = await resolveTenantContext(req.user.activeRestaurantId ?? req.user.restaurantId);

    // Build price maps for all outlets in the tenant group
    const priceMap: Record<string, Record<string, number>> = {};
    for (const rid of ctx.allIds) {
      const allVenuePrices = await buildAllVenuePriceMaps(rid);
      for (const [venueId, itemMap] of allVenuePrices) {
        if (!priceMap[venueId]) priceMap[venueId] = {};
        for (const [menuItemId, price] of itemMap) {
          priceMap[venueId][menuItemId] = price;
        }
      }
    }

    res.json(priceMap);
  } catch (err) {
    logger.error({ err }, "[venue/all-prices]");
    res.status(500).json({ error: "Failed to fetch all venue prices" });
  }
});

// ──────────────── POST /api/venue/clear-cache ─────────────────────────────────────
// Clears the venue:all-prices cache (for debugging after seed)
router.post("/clear-cache", authenticate, (_req, res) => {
  cacheClear("venue:all-prices");
  res.json({ message: "venue:all-prices cache cleared" });
});

// ──────────────── Helpers ─────────────────────────────────────────────────────────────────

export function formatVenueTableLabel(sectionName: string, tableNumber: number, venueType?: string | null): string {
  // New-tenant path: derive from venueType when available
  if (venueType) {
    const vt = venueType.toUpperCase();
    if (vt === 'CONFERENCE') return `C${tableNumber}`;
    if (vt === 'PDR') return `PDR${tableNumber}`;
    if (vt === 'ROOM_SERVICE') return `R${tableNumber}`;
    if (vt === 'BAR') return `B${tableNumber}`;
    if (vt === 'TAKEAWAY' || vt === 'DELIVERY') return 'P1';
    if (vt === 'BANQUET') return `B${tableNumber}`;
    if (vt === 'DINE_IN' || vt === 'CAFE') return `T${tableNumber}`;
  }
  // Legacy fallback: derive from sectionName
  const name = sectionName.toLowerCase();
  if (name.includes("conference")) return `C${tableNumber}`;
  if (name.includes("pdr")) return `PDR${tableNumber}`;
  if (name.includes("room")) return `R${tableNumber}`;
  if (name.includes("bar") || name.includes("main hall")) return `B${tableNumber}`;
  if (name.includes("family restaurant")) return `F${tableNumber}`;
  if (name.includes("gobox") || name.includes("go box")) return `GB${tableNumber}`;
  if (name.includes("parcel")) return "P1";
  return `V${tableNumber}`;
}

// POST /api/venue/backfill-section-tags — one-time backfill, safe to call repeatedly
router.post('/backfill-section-tags', authenticate, assertTenantScope, withTenantContext, async (req, res) => {
  try {
    const tables = await prisma.table.findMany({
      where: { restaurantId: getUserRestaurantId(req) ?? '' },
      include: { section: true },
    });
    let updated = 0;
    for (const table of tables) {
      const tag = getSectionTagLegacy(table.section?.name || '', table.section?.id || undefined);
      if (tag !== 'venue-unknown' && (table as any).sectionTag !== tag) {
        await prisma.table.update({ where: { id: table.id }, data: { sectionTag: tag } as any });
        updated++;
      }
    }
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/venue/cache-clear — flush the sections cache immediately (no restart needed)
router.post('/cache-clear', authenticate, (_req, res) => {
  cacheClear('sections:list*');
  cacheClear('menu:venue*');
  res.json({ ok: true, message: 'Venue cache cleared. Next GET /api/venue/sections will re-populate from DB.' });
});

export default router;

