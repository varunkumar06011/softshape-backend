import { Router } from "express";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache } from "../lib/cache";

const router = Router();

const tableInclude = {
  tables: {
    orderBy: { number: "asc" },
  },
} as const;

router.get("/", cacheMiddleware("sections:list", 120_000), async (req, res) => {
  try {
    const restaurantId = typeof req.query.restaurantId === "string" ? req.query.restaurantId.trim() : "";
    if (!restaurantId) {
      res.status(400).json({ error: "restaurantId is required" });
      return;
    }

    const sections = await prisma.section.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
      include: tableInclude,
    });

    res.json(sections);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch sections" });
  }
});

router.post("/", invalidateCache(["sections:*"]), async (req, res) => {
  try {
    const { name, restaurantId } = req.body as {
      name?: string;
      restaurantId?: string;
    };

    if (!name?.trim() || !restaurantId?.trim()) {
      res.status(400).json({ error: "name and restaurantId are required" });
      return;
    }

    const section = await prisma.section.create({
      data: {
        name: name.trim(),
        restaurantId: restaurantId.trim(),
      },
    });

    res.status(201).json(section);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create section" });
  }
});

export default router;
