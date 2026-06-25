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
    const userRestaurantId = req.user?.restaurantId;
    if (!userRestaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const sections = await prisma.section.findMany({
      where: { restaurantId: userRestaurantId },
      orderBy: { name: "asc" },
      include: {
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
    const { name } = req.body as { name?: string };

    const userRestaurantId = req.user?.restaurantId;
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
      },
    });

    res.status(201).json(section);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create section" });
  }
});

export default router;
