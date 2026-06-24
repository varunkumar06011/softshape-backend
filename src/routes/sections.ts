import { Router } from "express";
import prisma from "../lib/prisma";
import { cacheMiddleware, invalidateCache } from "../lib/cache";
import { authenticate } from "../middleware/auth";
import { resolveTenantContext } from "../lib/tenantContext";

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

    const ctx = await resolveTenantContext(userRestaurantId);

    // Use query restaurantId if it belongs to the tenant, otherwise default to user's restaurantId
    const requestedId = typeof req.query.restaurantId === "string" ? req.query.restaurantId.trim() : "";
    const restaurantId = requestedId && ctx.allIds.includes(requestedId) ? requestedId : userRestaurantId;

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

router.post("/", authenticate, invalidateCache(["sections:*"]), async (req: any, res) => {
  try {
    const { name } = req.body as { name?: string };

    const userRestaurantId = req.user?.restaurantId;
    if (!userRestaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const ctx = await resolveTenantContext(userRestaurantId);

    // Use body restaurantId if it belongs to the tenant, otherwise default to user's restaurantId
    const requestedId = typeof req.body.restaurantId === "string" ? req.body.restaurantId.trim() : "";
    const restaurantId = requestedId && ctx.allIds.includes(requestedId) ? requestedId : userRestaurantId;

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
