import { Router } from "express";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache } from "../lib/cache";
import { authenticate } from "../middleware/auth";
const router = Router();

const tableInclude = {
  tables: {
    orderBy: { number: "asc" },
  },
} as const;

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
        venue: { select: { id: true, name: true, venueType: true } },
        floor: { select: { id: true, name: true } },
        tables: {
          where: { restaurantId: userRestaurantId },
          orderBy: { number: "asc" },
        },
      },
    });

    res.json(sections);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch sections" });
  }
});

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

    res.status(201).json(section);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create section" });
  }
});

export default router;
