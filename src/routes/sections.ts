// ─────────────────────────────────────────────────────────────────────────────
// Sections Routes — Restaurant floor sections management
// ─────────────────────────────────────────────────────────────────────────────
// Sections are groupings of tables within a restaurant (e.g. "Rooftop", "Garden",
// "Bar Counter"). Each section can optionally belong to a Venue and/or Floor.
//
// Endpoints:
//   GET  /api/sections     — list all sections with their tables, venue, and floor
//   POST /api/sections     — create a new section (name, venueId?, floorId?)
//
// GET is cached for 2 minutes. POST invalidates the cache.
// All routes require authentication.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache } from "../lib/cache";
import { authenticate } from "../middleware/auth";
import { emitConfigChange } from "../lib/edgeEmit";
const router = Router();

// Prisma include clause for fetching sections with related tables, venue, and floor
const tableInclude = {
  tables: {
    orderBy: { number: "asc" },
  },
} as const;

// GET /api/sections — list all sections for the authenticated user's restaurant.
// Returns sections with nested tables (sorted by number), venue info, and floor info.
// Cached for 2 minutes (120 seconds) to reduce DB load on dashboard polling.
router.get("/", authenticate, cacheMiddleware("sections:list", 120_000), async (req: any, res) => {
  try {
    const userRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!userRestaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const sections = await prisma.section.findMany({
      where: { restaurantId: userRestaurantId },
      orderBy: { sortOrder: "asc" },
      include: {
        venue: { select: { id: true, name: true, venueType: true, kotEnabled: true } },
        floor: { select: { id: true, name: true } },
        tables: {
          where: { restaurantId: userRestaurantId },
          orderBy: { number: "asc" },
        },
      },
    });

    res.json(sections);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch sections" });
  }
});

// POST /api/sections — create a new section.
// Body: { name: string, venueId?: string, floorId?: string }
// Invalidates the sections cache so the next GET fetches fresh data.
router.post("/", authenticate, invalidateCache(["sections:*"]), async (req: any, res) => {
  try {
    const { name, venueId, floorId } = req.body as { name?: string; venueId?: string; floorId?: string };

    const userRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!userRestaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const restaurantId = userRestaurantId;

    if (!name?.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const section = await prisma.section.create({
      data: {
        name: name.trim(),
        restaurantId,
        venueId: venueId || null,
        floorId: floorId || null,
      },
    });

    emitConfigChange(restaurantId, "section", "upsert", section);
    res.status(201).json(section);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create section" });
  }
});

// PATCH /api/sections/:id — update a section's name, venueId, or sortOrder.
// Body: { name?: string, venueId?: string | null, sortOrder?: number }
router.patch("/:id", authenticate, invalidateCache(["sections:*", "tables:*"]), async (req: any, res) => {
  try {
    const { id } = req.params;
    const { name, venueId, sortOrder } = req.body as { name?: string; venueId?: string | null; sortOrder?: number };

    const userRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!userRestaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (venueId !== undefined) updateData.venueId = venueId || null;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const section = await prisma.section.update({
      where: { id, restaurantId: userRestaurantId },
      data: updateData,
    });

    emitConfigChange(userRestaurantId, "section", "upsert", section);
    res.json(section);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update section" });
  }
});

// DELETE /api/sections/:id — delete a section.
// Guard: returns 409 if the section has tables. Delete or move tables first.
router.delete("/:id", authenticate, invalidateCache(["sections:*", "tables:*"]), async (req: any, res) => {
  try {
    const { id } = req.params;

    const userRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!userRestaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const tableCount = await prisma.table.count({ where: { sectionId: id, restaurantId: userRestaurantId } });
    if (tableCount > 0) {
      res.status(409).json({ error: `Cannot delete section with ${tableCount} table(s). Move or delete tables first.` });
      return;
    }

    await prisma.section.delete({ where: { id, restaurantId: userRestaurantId } });
    emitConfigChange(userRestaurantId, "section", "delete", { id });
    res.json({ success: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to delete section" });
  }
});

export default router;
