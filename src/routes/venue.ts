/**
 * Venue Routes — /api/venue/*
 *
 * Handles Conference Hall 1, Conference Hall 2, PDR (4 rooms), and Parcel.
 * All sections live under restaurantId = "venue-001".
 *
 * GET /api/venue/sections         — all sections + tables (same shape as /api/tables)
 * GET /api/venue/menu?venueId=X   — restaurant-001 menu with venue-specific price overrides
 * GET /api/venue/table-label/:id  — returns the formatted label for a venue table (for KOT printing)
 *
 * Orders, billing, settlement all go through the existing /api/orders and /api/tables
 * endpoints — just pass restaurantId: "venue-001" and the correct tableId.
 */

import { OrderStatus, PrismaClient, TableStatus } from "@prisma/client";
import { Router } from "express";
import { getIo } from "../socket";

const router = Router();
const prisma = new PrismaClient();

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
    const sections = await prisma.section.findMany({
      where: { restaurantId: VENUE_ID },
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId: VENUE_ID },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    // Ensure all expected sections exist — seed them lazily if missing
    const sectionNames = sections.map((s) => s.name);
    const EXPECTED = [
      { id: "section-venue-conf1", name: "Conference Hall 1", tables: [{ number: 1, capacity: 100 }] },
      { id: "section-venue-conf2", name: "Conference Hall 2", tables: [{ number: 1, capacity: 100 }] },
      { id: "section-venue-pdr",   name: "PDR",               tables: [1,2,3,4].map(n => ({ number: n, capacity: 10 })) },
      { id: "section-venue-parcel", name: "Parcel",           tables: [{ number: 1, capacity: 1 }] },
    ];

    for (const exp of EXPECTED) {
      if (!sectionNames.includes(exp.name)) {
        const sec = await prisma.section.upsert({
          where: { id: exp.id },
          create: { id: exp.id, name: exp.name, restaurantId: VENUE_ID },
          update: { name: exp.name },
        });
        for (const tbl of exp.tables) {
          await prisma.table.upsert({
            where: { restaurantId_sectionId_number: { restaurantId: VENUE_ID, sectionId: sec.id, number: tbl.number } },
            create: { number: tbl.number, capacity: tbl.capacity, status: TableStatus.AVAILABLE, restaurantId: VENUE_ID, sectionId: sec.id },
            update: {},
          });
        }
      }
    }

    // Re-fetch after lazy seed
    const freshSections = await prisma.section.findMany({
      where: { restaurantId: VENUE_ID },
      orderBy: { name: "asc" },
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

// ─── GET /api/venue/menu?venueId=venue-conference1 ────────────────────────────
// Returns restaurant-001 FOOD menu items with venue-specific price overrides.
// Falls back to base price if no VenuePrice record exists.
// Filters out items where venue price = 0 (not available at this venue).
router.get("/menu", async (req, res) => {
  try {
    const venueId = (req.query.venueId as string) || "venue-conference1";

    // Fetch all active FOOD menu items from restaurant-001 (the master menu)
    const items = await prisma.menuItem.findMany({
      where: {
        restaurantId: "restaurant-001",
        isAvailable: true,
        isDeleted: false,
        menuType: "FOOD",
      },
      include: {
        variants: { orderBy: { isDefault: "desc" } },
        category: { select: { id: true, name: true, sortOrder: true } },
      },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
    });

    // Get venue-specific price overrides
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
        // If venue price explicitly set use it; else use base price
        const price = venuePrice !== undefined ? venuePrice : basePrice;

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
      .filter((item) => item.price > 0); // Hide items with price = 0

    res.set("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[venue/menu]", err);
    res.status(500).json({ error: "Failed to fetch venue menu" });
  }
});

// ─── GET /api/venue/table-label/:tableId ─────────────────────────────────────
// Returns the formatted label for a venue table, used by the print service.
// e.g. Conference Hall 1 → "CONF-1", PDR table 3 → "PDR-3", Parcel → "PARCEL"
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

    const allItems = await prisma.menuItem.findMany({
      select: { id: true, name: true }
    });
    
    // Group IDs by name (case-insensitive) to bridge Restaurant vs Bar IDs
    const nameToIds: Record<string, string[]> = {};
    const idToName: Record<string, string> = {};
    for (const item of allItems) {
      if (!item.name) continue;
      const n = item.name.toLowerCase().trim();
      if (!nameToIds[n]) nameToIds[n] = [];
      nameToIds[n].push(item.id);
      idToName[item.id] = n;
    }

    const priceMap: Record<string, Record<string, number>> = {};
    for (const vp of venuePrices) {
      if (!priceMap[vp.venueId]) priceMap[vp.venueId] = {};
      
      const itemName = idToName[vp.menuItemId];
      if (itemName && nameToIds[itemName]) {
        if (itemName === 'tomato soup') console.log('Mapping tomato soup to IDs:', nameToIds[itemName]);
        // Map price to ALL item IDs with this same name
        for (const id of nameToIds[itemName]) {
          priceMap[vp.venueId][id] = Number(vp.price);
        }
      } else {
        priceMap[vp.venueId][vp.menuItemId] = Number(vp.price);
      }
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
  if (name.includes("conference hall 1") || name.includes("conf1")) return "CONF-1";
  if (name.includes("conference hall 2") || name.includes("conf2")) return "CONF-2";
  if (name.includes("pdr")) return `PDR-${tableNumber}`;
  if (name.includes("parcel")) return "PARCEL";
  return `V${tableNumber}`;
}

export default router;
