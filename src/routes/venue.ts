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
import { Router } from "express";
import { getIo } from "../socket";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache, cacheClear } from "../lib/cache";
import { authenticate } from "../middleware/auth";
import { resolveTenantContext } from "../lib/tenantContext";

const router = Router();

function getUserRestaurantId(req: any): string | undefined {
  return req.user?.restaurantId;
}


// Helper function to map section name/id to sectionTag.
// sectionId takes priority for disambiguation (e.g. 'section-parcel' → restaurant parcel).
function getSectionTag(sectionName: string, sectionId?: string): string {
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
router.get("/sections", cacheMiddleware("venue:sections", 30_000), async (req: any, res) => {
  try {
    const venueId = getUserRestaurantId(req) ?? '';

    // Check if this is the legacy default tenant (RESTAURANT-001)
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: venueId },
      select: { restaurantCode: true }
    });
    const isDefaultTenant = restaurant?.restaurantCode === 'RESTAURANT-001';

    if (isDefaultTenant) {
      // Legacy default tenant: ensure all expected sections exist and expose only these fixed sections.
      const EXPECTED = [
      { id: "section-family-restaurant", name: "Family Restaurant", tables: Array.from({ length: 40 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
      { id: "section-parcel", name: "Parcel", tables: [{ number: 1, capacity: 1 }] },
      { id: "section-conference", name: "Conference Hall", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
      { id: "section-pdr", name: "PDR", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
      { id: "section-rooms", name: "Rooms", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 2 })) },
      { id: "section-venue-gobox", name: "GoBox", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
    ];
    const expectedIds = EXPECTED.map((section) => section.id);

    // Fast-path: check if all expected sections already exist in DB
    // Only run the heavy upsert loop if any section is missing (first boot / migration)
    const existingSections = await prisma.section.findMany({
      where: { restaurantId: getUserRestaurantId(req) ?? '', id: { in: expectedIds } },
      select: { id: true },
    });
    const existingIds = new Set(existingSections.map(s => s.id));
    const missingSections = EXPECTED.filter(exp => !existingIds.has(exp.id));

    if (missingSections.length > 0) {
      // Cold path: run upserts only for missing sections
      for (const exp of missingSections) {
        const sec = await prisma.section.upsert({
          where: { id: exp.id },
          create: { id: exp.id, name: exp.name, restaurantId: getUserRestaurantId(req) ?? '' },
          update: { name: exp.name, restaurantId: getUserRestaurantId(req) ?? '' },
        });
        const venueSubId = getSectionTag(exp.name, exp.id);
        for (const tbl of exp.tables) {
          await prisma.table.upsert({
            where: { restaurantId_sectionId_number: { restaurantId: getUserRestaurantId(req) ?? '', sectionId: sec.id, number: tbl.number } },
            create: { number: tbl.number, capacity: tbl.capacity, status: TableStatus.AVAILABLE, restaurantId: getUserRestaurantId(req) ?? '', sectionId: sec.id, sectionTag: venueSubId } as any,
            update: { sectionTag: venueSubId } as any,
          });
        }
        // Backfill missing sectionTag on existing tables in this section
        await prisma.table.updateMany({
          where: { restaurantId: getUserRestaurantId(req) ?? '', sectionId: sec.id, sectionTag: null },
          data: { sectionTag: venueSubId } as any,
        });
      }
    }

    // Cleanup stale/unknown tables (run only if we did any upserts, i.e., cold path)
    if (missingSections.length > 0) {
      await prisma.table.updateMany({
        where: {
          restaurantId: getUserRestaurantId(req) ?? '',
          sectionId: { notIn: expectedIds },
          sectionTag: null,
        },
        data: { sectionTag: 'venue-unknown' } as any,
      });

      // Remove extra parcel tables (keep only table number 1)
      const parcelSection = await prisma.section.findFirst({
        where: { id: "section-parcel", restaurantId: getUserRestaurantId(req) ?? '' }
      });
      if (parcelSection) {
        await prisma.table.deleteMany({
          where: {
            restaurantId: getUserRestaurantId(req) ?? '',
            sectionId: parcelSection.id,
            number: { gt: 1 }
          }
        });
      }

      // Clean up legacy section-bar-parcel tables and section
      const legacyBarParcelTables = await prisma.table.findMany({
        where: { restaurantId: getUserRestaurantId(req) ?? '', sectionId: 'section-bar-parcel' },
        include: {
          orders: {
            where: { status: { in: ACTIVE_ORDER_STATUSES } },
            take: 1,
            select: { id: true }
          }
        }
      });

      const hasActiveOrders = legacyBarParcelTables.some(t => t.orders.length > 0);
      if (!hasActiveOrders) {
        const tableIdsToDelete = legacyBarParcelTables.map(t => t.id);
        if (tableIdsToDelete.length > 0) {
          await prisma.table.deleteMany({
            where: { id: { in: tableIdsToDelete } }
          });
        }
        await prisma.section.deleteMany({
          where: { restaurantId: getUserRestaurantId(req) ?? '', id: 'section-bar-parcel' }
        });
      } else {
        const occupiedCount = legacyBarParcelTables.filter(t => t.orders.length > 0).length;
        console.warn(`[venue/sections] Skipping legacy section-bar-parcel cleanup — ${occupiedCount} table(s) still have active orders.`);
      }
    }

    const freshSections = await prisma.section.findMany({
      where: { restaurantId: getUserRestaurantId(req) ?? '', id: { in: expectedIds } },
      orderBy: { id: "asc" },
      include: {
        tables: {
          where: { restaurantId: getUserRestaurantId(req) ?? '' },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.json(freshSections);
    } else {
      // New restaurants: return only sections that exist in DB (no auto-creation of legacy sections)
      const sections = await prisma.section.findMany({
        where: { restaurantId: venueId },
        orderBy: { createdAt: "asc" },
        include: {
          tables: {
            where: { restaurantId: venueId },
            orderBy: { number: "asc" },
            include: tableInclude,
          },
        },
      });
      res.json(sections);
    }
  } catch (err) {
    console.error("[venue/sections]", err);
    res.status(500).json({ error: "Failed to fetch venue sections" });
  }
});
// ─── GET /api/venue/menu?venueId=venue-family-restaurant ────────────────────────────
// Returns menu items with venue-specific price overrides for the given venue.
// For bar venues, filters out items with price = 0.
// For restaurant venues, shows all items.
router.get("/menu", cacheMiddleware("menu:venue", 60_000), async (req, res) => {
  try {
    const venueId = (req.query.venueId as string) || "venue-family-restaurant";
    const isBarVenue = venueId.startsWith("venue-bar-");
    const authRestaurantId = (req.user?.restaurantId as string) || undefined;
    const restaurantId = authRestaurantId || "";

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

    const venuePrices = await prisma.venuePrice.findMany({
      where: { venueId, isActive: true },
    });

    // Fallback: if GoBox has no custom prices, use the old Bar Parcel prices
    // so existing menu configuration works immediately after the rename.
    let fallbackPrices: any[] = [];
    if (venueId === 'venue-bar-gobox' && venuePrices.length === 0) {
      fallbackPrices = await prisma.venuePrice.findMany({
        where: { venueId: 'venue-bar-parcel', isActive: true },
      });
    }

    const effectivePrices = venuePrices.length > 0 ? venuePrices : fallbackPrices;
    const priceMap = new Map<string, number>(
      effectivePrices.map((vp: any) => [vp.menuItemId, Number(vp.price)])
    );

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
    console.error("[venue/menu]", err);
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
    console.error("[venue/table-label]", err);
    res.status(500).json({ error: "Failed to get table label" });
  }
});

// ─── PUT /api/venue/prices ────────────────────────────────────────────────────
// Bulk upsert venue prices. Body: { venueId, prices: [{menuItemId, price}] }
router.put("/prices", authenticate, invalidateCache(["menu:*", "barMenu:*", "venue:all-prices:*"]), async (req: any, res) => {
  try {
    const { venueId, prices, restaurantId } = req.body as {
      venueId?: string;
      prices?: Array<{ menuItemId: string; price: number }>;
      restaurantId?: string;
    };

    if (!venueId || !Array.isArray(prices)) {
      res.status(400).json({ error: "venueId and prices array required" });
      return;
    }
    if (!req.user?.restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const ownerId = restaurantId || req.user.restaurantId;
    const ctx = await resolveTenantContext(req.user.restaurantId);
    if (!ctx.allIds.includes(ownerId)) {
      res.status(403).json({ error: "Cross-tenant access denied" });
      return;
    }

    const results = await Promise.all(
      prices.map((p) =>
        prisma.venuePrice.upsert({
          where: { venueId_menuItemId: { venueId, menuItemId: p.menuItemId } },
          create: { venueId, menuItemId: p.menuItemId, price: p.price, restaurantId: ownerId },
          update: { price: p.price, restaurantId: ownerId },
        })
      )
    );

    res.json({ updated: results.length });

    // Notify all connected clients to refresh venue prices
    try {
      getIo().emit("venuePrices:updated");
    } catch (e) {
      console.error("[venue/prices PUT] Socket emit failed:", e);
    }
  } catch (err) {
    console.error("[venue/prices PUT]", err);
    res.status(500).json({ error: "Failed to update venue prices" });
  }
});

// ──────────────── GET /api/venue/all-prices ──────────────────────────────────
// Returns a global map of all active venue prices: { venueId: { menuItemId: price } }
router.get("/all-prices", authenticate, cacheMiddleware("venue:all-prices", 5 * 60_000), async (req: any, res) => {
  try {
    if (!req.user?.restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const ctx = await resolveTenantContext(req.user.restaurantId);

    const venuePrices = await prisma.venuePrice.findMany({
      where: {
        isActive: true,
        restaurantId: { in: ctx.allIds },
      },
      select: { venueId: true, menuItemId: true, price: true },
    });

    const priceMap: Record<string, Record<string, number>> = {};
    for (const vp of venuePrices) {
      if (!priceMap[vp.venueId]) priceMap[vp.venueId] = {};
      priceMap[vp.venueId][vp.menuItemId] = Number(vp.price);
    }

    res.json(priceMap);
  } catch (err) {
    console.error("[venue/all-prices]", err);
    res.status(500).json({ error: "Failed to fetch all venue prices" });
  }
});

// ──────────────── POST /api/venue/clear-cache ─────────────────────────────────────
// Clears the venue:all-prices cache (for debugging after seed)
router.post("/clear-cache", (_req, res) => {
  const { cacheClear } = require("../lib/cache");
  cacheClear("venue:all-prices");
  res.json({ message: "venue:all-prices cache cleared" });
});

// ──────────────── Helpers ─────────────────────────────────────────────────────────────────

export function formatVenueTableLabel(sectionName: string, tableNumber: number): string {
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
router.post('/backfill-section-tags', async (req, res) => {
  try {
    const tables = await prisma.table.findMany({
      where: { restaurantId: getUserRestaurantId(req) ?? '' },
      include: { section: true },
    });
    let updated = 0;
    for (const table of tables) {
      const tag = getSectionTag(table.section?.name || '', table.section?.id || undefined);
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
router.post('/cache-clear', (_req, res) => {
  cacheClear('sections:list*');
  cacheClear('menu:venue*');
  res.json({ ok: true, message: 'Venue cache cleared. Next GET /api/venue/sections will re-populate from DB.' });
});

export default router;

