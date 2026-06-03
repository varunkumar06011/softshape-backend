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

const router = Router();

export const VENUE_ID = "venue-001";

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
router.get("/sections", async (_req, res) => {
  try {
    // Ensure all expected sections exist and expose only these fixed sections.
    const EXPECTED = [
      { id: "section-family-restaurant", name: "Family Restaurant", tables: Array.from({ length: 40 }, (_, i) => ({ number: i + 1, capacity: 4 })) },
      { id: "section-parcel", name: "Parcel", tables: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, capacity: 1 })) },
    ];
    const expectedIds = EXPECTED.map((section) => section.id);

    for (const exp of EXPECTED) {
      const sec = await prisma.section.upsert({
        where: { id: exp.id },
        create: { id: exp.id, name: exp.name, restaurantId: VENUE_ID },
        update: { name: exp.name, restaurantId: VENUE_ID },
      });
      for (const tbl of exp.tables) {
        await prisma.table.upsert({
          where: { restaurantId_sectionId_number: { restaurantId: VENUE_ID, sectionId: sec.id, number: tbl.number } },
          create: { number: tbl.number, capacity: tbl.capacity, status: TableStatus.AVAILABLE, restaurantId: VENUE_ID, sectionId: sec.id },
          update: {},
        });
      }
    }

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

    res.set("Cache-Control", "no-store");
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
router.get("/menu", async (req, res) => {
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

    const venuePrices = await (prisma as any).venuePrice.findMany({
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

    res.set("Cache-Control", "no-store");
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
    const { tableId } = req.params;
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
router.put("/prices", async (req, res) => {
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
        (prisma as any).venuePrice.upsert({
          where: { venueId_menuItemId: { venueId, menuItemId: p.menuItemId } },
          create: { venueId, menuItemId: p.menuItemId, price: p.price },
          update: { price: p.price },
        })
      )
    );

    res.json({ updated: results.length });
  } catch (err) {
    console.error("[venue/prices PUT]", err);
    res.status(500).json({ error: "Failed to update venue prices" });
  }
});

// ──────────────── GET /api/venue/all-prices ──────────────────────────────────
// Returns a global map of all active venue prices: { venueId: { menuItemId: price } }
router.get("/all-prices", async (req, res) => {
  try {
    const venuePrices = await (prisma as any).venuePrice.findMany({
      where: { isActive: true }
    });

    const priceMap: Record<string, Record<string, number>> = {};
    for (const vp of venuePrices) {
      if (!priceMap[vp.venueId]) priceMap[vp.venueId] = {};
      priceMap[vp.venueId][vp.menuItemId] = Number(vp.price);
    }

    res.set("Cache-Control", "no-store");
    res.json(priceMap);
  } catch (err) {
    console.error("[venue/all-prices]", err);
    res.status(500).json({ error: "Failed to fetch all venue prices" });
  }
});

// ──────────────── Helpers ─────────────────────────────────────────────────────────────────

export function formatVenueTableLabel(sectionName: string, tableNumber: number): string {
  const name = sectionName.toLowerCase();
  if (name.includes("family restaurant")) return `T${tableNumber}`;
  if (name.includes("parcel")) return "P1";
  return `V${tableNumber}`;
}

export default router;

