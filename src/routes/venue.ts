/**
 * Venue Routes — /api/venue/*
 *
 * Handles Family Restaurant and Parcel.
 * All sections live under restaurantId = "venue-001".
 *
 * GET /api/venue/sections         — all sections + tables (same shape as /api/tables)
 * GET /api/venue/menu?venueId=X   — menu with venue-specific price overrides
 * GET /api/venue/table-label/:id  — returns the formatted label for a venue table (for KOT printing)
 *
 * Orders, billing, settlement all go through the existing /api/orders and /api/tables
 * endpoints — just pass restaurantId: "venue-001" and the correct tableId.
 */

import { OrderStatus, TableStatus } from "@prisma/client";
import { Router } from "express";
import { getIo } from "../socket";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache, cacheClear } from "../lib/cache";

const router = Router();

export const VENUE_ID = "venue-001";


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
router.get("/sections", cacheMiddleware("venue:sections", 5_000), async (_req, res) => {
  try {

    // Ensure all expected sections exist and expose only these fixed sections.
    const EXPECTED = [
      { id: "section-family-restaurant", name: "Family Restaurant", tables: Array.from({ length: 40 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
      { id: "section-parcel", name: "Parcel", tables: [{ number: 1, capacity: 1 }] },
      { id: "section-conference", name: "Conference Hall", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
      { id: "section-pdr", name: "PDR", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
      { id: "section-rooms", name: "Rooms", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 2 })) },
      { id: "section-venue-gobox", name: "GoBox", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
    ];
    const expectedIds = EXPECTED.map((section) => section.id);

    // Ensure all expected sections and tables exist (idempotent, no heavy
    // transaction to avoid monopolising a connection for 30+s under load).
    for (const exp of EXPECTED) {
      const sec = await prisma.section.upsert({
        where: { id: exp.id },
        create: { id: exp.id, name: exp.name, restaurantId: VENUE_ID },
        update: { name: exp.name, restaurantId: VENUE_ID },
      });
      // Use both section ID and name for accurate disambiguation
      const venueSubId = getSectionTag(exp.name, exp.id);
      for (const tbl of exp.tables) {
        await prisma.table.upsert({
          where: { restaurantId_sectionId_number: { restaurantId: VENUE_ID, sectionId: sec.id, number: tbl.number } },
          create: { number: tbl.number, capacity: tbl.capacity, status: TableStatus.AVAILABLE, restaurantId: VENUE_ID, sectionId: sec.id, sectionTag: venueSubId } as any,
          update: { sectionTag: venueSubId } as any,
        });
      }
      // Backfill any existing tables in this section that are missing sectionTag
      await prisma.table.updateMany({
        where: { restaurantId: VENUE_ID, sectionId: sec.id, sectionTag: null },
        data: { sectionTag: venueSubId } as any,
      });
    }

    // Clean up stale tables that don't belong to any known section (orphan rows with sectionTag=null
    // or with sectionIds not in our EXPECTED list — these are duplicates from old migrations).
    await prisma.table.updateMany({
      where: {
        restaurantId: VENUE_ID,
        sectionId: { notIn: expectedIds },
        sectionTag: null,
      },
      data: { sectionTag: 'venue-unknown' } as any,
    });

    // Remove extra parcel tables (keep only table number 1) - outside transaction
    const parcelSection = await prisma.section.findFirst({
      where: { id: "section-parcel", restaurantId: VENUE_ID }
    });
    if (parcelSection) {
      await prisma.table.deleteMany({
        where: {
          restaurantId: VENUE_ID,
          sectionId: parcelSection.id,
          number: { gt: 1 }
        }
      });
    }

    // Clean up legacy section-bar-parcel tables and section
    await prisma.table.deleteMany({
      where: {
        restaurantId: VENUE_ID,
        sectionId: 'section-bar-parcel'
      }
    });
    await prisma.section.deleteMany({
      where: {
        restaurantId: VENUE_ID,
        id: 'section-bar-parcel'
      }
    });

    const freshSections = await prisma.section.findMany({
      where: { restaurantId: VENUE_ID, id: { in: expectedIds } },
      orderBy: { id: "asc" },
      include: {
        tables: {
          where: { restaurantId: VENUE_ID },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.json(freshSections);
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
    const restaurantId = isBarVenue ? "bar-001" : "restaurant-001";

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
    const priceMap = new Map<string, number>(
      venuePrices.map((vp: any) => [vp.menuItemId, Number(vp.price)])
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
      where: { id: tableId, restaurantId: VENUE_ID },
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
router.put("/prices", invalidateCache(["menu:*", "barMenu:*"]), async (req, res) => {
  try {
    const { venueId, prices } = req.body as {
      venueId?: string;
      prices?: Array<{ menuItemId: string; price: number }>;
    };

    if (!venueId || !Array.isArray(prices)) {
      res.status(400).json({ error: "venueId and prices array required" });
      return;
    }

    const results = await Promise.all(
      prices.map((p) =>
        prisma.venuePrice.upsert({
          where: { venueId_menuItemId: { venueId, menuItemId: p.menuItemId } },
          create: { venueId, menuItemId: p.menuItemId, price: p.price },
          update: { price: p.price },
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
router.get("/all-prices", cacheMiddleware("venue:all-prices", 5 * 60_000), async (req, res) => {
  try {
    const venuePrices = await prisma.venuePrice.findMany({
      where: { isActive: true },
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
  if (name.includes("family restaurant")) return `T${tableNumber}`;
  if (name.includes("parcel")) return "P1";
  return `V${tableNumber}`;
}

// POST /api/venue/backfill-section-tags — one-time backfill, safe to call repeatedly
router.post('/backfill-section-tags', async (req, res) => {
  try {
    const tables = await prisma.table.findMany({
      where: { restaurantId: VENUE_ID },
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

