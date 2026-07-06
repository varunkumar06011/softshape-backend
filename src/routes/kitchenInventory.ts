// ─────────────────────────────────────────────────────────────────────────────
// Kitchen Inventory Routes — Food inventory tracking with daily entries
// ─────────────────────────────────────────────────────────────────────────────
// Manages kitchen inventory items (ingredients, supplies) and their daily stock
// entries (opening, added, consumed, closing stock).
//
// Features:
//   - Item CRUD with current stock and reorder level
//   - Daily entries track opening/added/consumed/closing stock per day
//   - Low stock check emits real-time socket events to the restaurant room
//   - Stock auto-updates when daily entries are created or modified
//
// Endpoints:
//   GET    /api/kitchen-inventory           — list all items with today's entries
//   POST   /api/kitchen-inventory/items     — create or update an item
//   DELETE /api/kitchen-inventory/items/:id — delete an item
//   POST   /api/kitchen-inventory/entries   — create or update a daily stock entry
//
// Exported helper: checkLowStock() — called after order settlement to emit
// low-stock alerts via Socket.IO when items fall below their reorder level.
//
// All routes use authenticate + assertTenantScope + withTenantContext middleware.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import { Prisma } from "@prisma/client";
import prisma, { basePrisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { resolveKitchenRestaurantId, resolveTenantContext } from "../lib/tenantContext";
import { getKolkataDateString } from "../utils/date";

const router = Router();

// Apply auth + tenant scoping to all kitchen inventory routes.
// Note: authenticate, assertTenantScope, and withTenantContext are also applied
// at the mount point in index.ts, but we keep them here for safety when this
// router is used in test or other contexts.
router.use(authenticate, assertTenantScope, withTenantContext);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Convert a YYYY-MM-DD IST date range to UTC Date objects for querying DateTime fields.
function toISTRange(startDate: string, endDate: string) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startIST = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { startIST, endIST };
}

// ==========================================
// Kitchen Inventory Items CRUD
// ==========================================

router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    const date = (req.query.date as string) || getKolkataDateString();

    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    const items = await basePrisma.kitchenInventoryItem.findMany({
      where: { restaurantId: kitchenRestaurantId },
      orderBy: { name: "asc" },
    });

    // Fetch today's entries for each item
    const entries = await basePrisma.inventoryDailyEntry.findMany({
      where: { restaurantId: kitchenRestaurantId, entryDate: date },
    });

    const entryMap = new Map(entries.map((e) => [e.itemId, e]));
    const isToday = date === getKolkataDateString();

    const result = items.map((item) => {
      const entry = entryMap.get(item.id);
      const price = Number(item.price);
      const currentStockNum = Number(item.currentStock);

      let todayEntry: {
        openingStock: number; addedStock: number;
        consumedStock: number; closingStock: number;
        isCarryOver?: boolean;
      } | null = null;

      if (entry) {
        todayEntry = {
          openingStock:  Number(entry.openingStock),
          addedStock:    Number(entry.addedStock),
          consumedStock: Number(entry.consumedStock),
          closingStock:  Number(entry.closingStock),
        };
      } else if (isToday && currentStockNum > 0) {
        // No entry yet today — carry forward last known closing stock as opening
        todayEntry = {
          openingStock:  currentStockNum,
          addedStock:    0,
          consumedStock: 0,
          closingStock:  currentStockNum,
          isCarryOver:   true,
        };
      }

      return {
        ...item,
        currentStock: currentStockNum,
        reorderLevel: Number(item.reorderLevel),
        price,
        todayEntry,
      };
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/items", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    const { id, name, unit, category, currentStock, reorderLevel, price, prize, image } = req.body;
    const priceValue = price ?? prize ?? 0; // accept both field names

    if (!restaurantId || !name) {
      return res.status(400).json({ error: "restaurantId and name are required" });
    }

    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    if (id) {
      const stockVal = Number(currentStock || 0);
      if (stockVal < 0) {
        return res.status(400).json({ error: "currentStock must be non-negative" });
      }

      const updated = await basePrisma.kitchenInventoryItem.update({
        where: { id },
        data: {
          name,
          unit: unit || '',
          category: category ?? '',
          currentStock: new Prisma.Decimal(stockVal),
          reorderLevel: new Prisma.Decimal(reorderLevel || 0),
          price: new Prisma.Decimal(priceValue),
          ...(image !== undefined ? { image } : {}),
        },
      });

      // Sync today's daily entry with the new currentStock
      if (stockVal >= 0) {
        const today = getKolkataDateString();
        const existingEntry = await basePrisma.inventoryDailyEntry.findUnique({
          where: {
            restaurantId_itemId_entryDate: { restaurantId: kitchenRestaurantId, itemId: id, entryDate: today },
          },
        });
        if (existingEntry) {
          const newClosing = stockVal;
          await basePrisma.inventoryDailyEntry.update({
            where: { id: existingEntry.id },
            data: {
              closingStock: new Prisma.Decimal(newClosing),
              openingStock: new Prisma.Decimal(Number(existingEntry.openingStock)),
              addedStock: new Prisma.Decimal(newClosing - Number(existingEntry.openingStock) + Number(existingEntry.consumedStock)),
            },
          });
        } else {
          await basePrisma.inventoryDailyEntry.create({
            data: {
              restaurantId: kitchenRestaurantId,
              itemId: id,
              entryDate: today,
              openingStock: new Prisma.Decimal(stockVal),
              closingStock: new Prisma.Decimal(stockVal),
            },
          });
        }
      }

      return res.json({ ...updated, price: Number(updated.price) });
    }

    // Reject duplicate names — existing items are never overwritten by manual add or CSV import.
    const existing = await basePrisma.kitchenInventoryItem.findUnique({
      where: { restaurantId_name: { restaurantId: kitchenRestaurantId, name } },
    });
    if (existing) {
      return res.status(409).json({
        error: `Ingredient "${name}" already exists`,
        existingId: existing.id,
      });
    }

    const item = await basePrisma.kitchenInventoryItem.create({
      data: {
        name,
        unit: unit || '',
        category: category ?? '',
        currentStock: new Prisma.Decimal(currentStock || 0),
        reorderLevel: new Prisma.Decimal(reorderLevel || 0),
        price: new Prisma.Decimal(priceValue),
        restaurantId: kitchenRestaurantId,
        ...(image ? { image } : {}),
      },
    });

    // Create today's entry if opening stock > 0
    if (currentStock && currentStock > 0) {
      const today = getKolkataDateString();
      await basePrisma.inventoryDailyEntry.create({
        data: {
          restaurantId: kitchenRestaurantId,
          itemId: item.id,
          entryDate: today,
          openingStock: new Prisma.Decimal(currentStock),
          closingStock: new Prisma.Decimal(currentStock),
        },
      });
    }

    res.json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/items/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    const { name, unit, category, price, reorderLevel, image, currentStock } = req.body;
    const data: Record<string, any> = {};
    if (name        !== undefined) data.name         = name;
    if (unit        !== undefined) data.unit         = unit;
    if (category    !== undefined) data.category     = category;
    if (price       !== undefined) data.price        = new Prisma.Decimal(price);
    if (reorderLevel !== undefined) data.reorderLevel = new Prisma.Decimal(reorderLevel);
    if (image       !== undefined) data.image        = image;

    if (currentStock !== undefined) {
      const stockVal = Number(currentStock);
      if (isNaN(stockVal) || stockVal < 0) {
        return res.status(400).json({ error: "currentStock must be a non-negative number" });
      }
      data.currentStock = new Prisma.Decimal(stockVal);
    }

    const updated = await basePrisma.kitchenInventoryItem.update({ where: { id }, data });

    // If currentStock was updated, sync today's daily entry to match.
    if (currentStock !== undefined) {
      const restaurantId = req.user!.restaurantId;
      const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
      const stockVal = Number(currentStock);
      const today = getKolkataDateString();
      const existingEntry = await basePrisma.inventoryDailyEntry.findUnique({
        where: {
          restaurantId_itemId_entryDate: { restaurantId: kitchenRestaurantId, itemId: id, entryDate: today },
        },
      });
      if (existingEntry) {
        await basePrisma.inventoryDailyEntry.update({
          where: { id: existingEntry.id },
          data: {
            closingStock: new Prisma.Decimal(stockVal),
            addedStock: new Prisma.Decimal(Math.max(0, stockVal - Number(existingEntry.openingStock) + Number(existingEntry.consumedStock))),
          },
        });
      } else {
        await basePrisma.inventoryDailyEntry.create({
          data: {
            restaurantId: kitchenRestaurantId,
            itemId: id,
            entryDate: today,
            openingStock: new Prisma.Decimal(stockVal),
            closingStock: new Prisma.Decimal(stockVal),
          },
        });
      }
    }

    return res.json({ ...updated, price: Number(updated.price) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/items/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    await basePrisma.kitchenInventoryItem.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Daily Entries (opening stock, add stock)
// ==========================================

router.post("/entries", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    const { itemId, openingStock, addStock, consumedStock, date, replace } = req.body;

    if (!restaurantId || !itemId) {
      return res.status(400).json({ error: "restaurantId, itemId are required" });
    }

    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    const today = getKolkataDateString();
    const targetDate = (typeof date === "string" && date) ? date : today;
    const isToday = targetDate === today;

    const manualConsumed =
      consumedStock !== undefined && consumedStock !== null && consumedStock !== ""
        ? Number(consumedStock)
        : undefined;
    if (manualConsumed !== undefined && (isNaN(manualConsumed) || manualConsumed < 0)) {
      return res.status(400).json({ error: "consumedStock must be a non-negative number" });
    }
    const hasManualConsumed = manualConsumed !== undefined && manualConsumed >= 0;

    if (openingStock !== undefined && (isNaN(Number(openingStock)) || Number(openingStock) < 0)) {
      return res.status(400).json({ error: "openingStock must be a non-negative number" });
    }

    if (addStock !== undefined && (isNaN(Number(addStock)) || Number(addStock) < 0)) {
      return res.status(400).json({ error: "addStock must be a non-negative number" });
    }

    // 10.3: Wrap the read-then-write in a transaction with FOR UPDATE to prevent
    // concurrent settlement deductions from being overwritten by manual edits.
    const result = await basePrisma.$transaction(async (tx) => {
      // Lock the existing entry row if present.
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "InventoryDailyEntry"
        WHERE "restaurantId" = ${kitchenRestaurantId} AND "itemId" = ${itemId} AND "entryDate" = ${targetDate}
        FOR UPDATE
      `;
      const existing = lockedRows.length > 0
        ? await tx.inventoryDailyEntry.findUnique({ where: { id: lockedRows[0].id } })
        : null;

      if (existing) {
        let newOpening: number;
        let newAdded: number;
        let newConsumed: number;

        if (replace) {
          newOpening = openingStock !== undefined ? Number(openingStock) : Number(existing.openingStock);
          newAdded = addStock !== undefined ? Number(addStock) : Number(existing.addedStock);
          newConsumed = manualConsumed !== undefined ? manualConsumed : Number(existing.consumedStock);
        } else {
          newOpening = Number(existing.openingStock);
          newAdded = Number(existing.addedStock) + (addStock || 0);
          newConsumed = Number(existing.consumedStock) + (hasManualConsumed ? manualConsumed! : 0);
        }

        const closing = newOpening + newAdded - newConsumed;

        if (closing < 0) {
          throw Object.assign(new Error("This entry would result in negative closing stock"), { statusCode: 400, closingStock: closing });
        }

        const updated = await tx.inventoryDailyEntry.update({
          where: { id: existing.id },
          data: {
            openingStock: new Prisma.Decimal(newOpening),
            addedStock: new Prisma.Decimal(newAdded),
            consumedStock: new Prisma.Decimal(newConsumed),
            closingStock: new Prisma.Decimal(closing),
          },
        });

        if (isToday) {
          await tx.kitchenInventoryItem.update({
            where: { id: itemId },
            data: { currentStock: new Prisma.Decimal(closing) },
          });
        }

        return updated;
      }

      // No existing entry. For non-replace historical consumed entries, block to prevent negative stock.
      if (!replace && !isToday && hasManualConsumed && manualConsumed! > 0 && !openingStock && !addStock) {
        throw Object.assign(new Error("No stock entry exists for this date — add opening stock first"), { statusCode: 400 });
      }

      // New entry creation — carry-over: use prior day's closingStock as opening when not explicitly supplied.
      const priorEntry = await tx.inventoryDailyEntry.findFirst({
        where: { restaurantId: kitchenRestaurantId, itemId, entryDate: { lt: targetDate } },
        orderBy: { entryDate: 'desc' },
      });
      const opening = openingStock !== undefined
        ? Number(openingStock)
        : (priorEntry ? Number(priorEntry.closingStock) : 0);
      const entryAddStock = addStock !== undefined ? Number(addStock) : 0;
      const entryConsumed = hasManualConsumed ? manualConsumed! : 0;
      const closing = opening + entryAddStock - entryConsumed;

      if (closing < 0) {
        throw Object.assign(new Error("This entry would result in negative closing stock"), { statusCode: 400, closingStock: closing });
      }

      const entry = await tx.inventoryDailyEntry.create({
        data: {
          restaurantId: kitchenRestaurantId,
          itemId,
          entryDate: targetDate,
          openingStock: new Prisma.Decimal(opening),
          addedStock: new Prisma.Decimal(entryAddStock),
          consumedStock: new Prisma.Decimal(entryConsumed),
          closingStock: new Prisma.Decimal(closing),
        },
      });

      if (isToday) {
        await tx.kitchenInventoryItem.update({
          where: { id: itemId },
          data: { currentStock: new Prisma.Decimal(closing) },
        });
      }

      return entry;
    });

    res.json(result);
  } catch (error: any) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message, ...(error.closingStock !== undefined ? { closingStock: error.closingStock } : {}) });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Top 3 selling menu items (FOOD only)
// ==========================================

router.get("/top-selling", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const today = getKolkataDateString();
    const startDate = (req.query.startDate as string) || today;
    const endDate = (req.query.endDate as string) || today;

    const { startIST, endIST } = toISTRange(startDate, endDate);

    const grouped = await prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        menuType: "FOOD",
        order: {
          restaurantId,
          status: "PAID",
          paidAt: {
            not: null,
            gte: startIST,
            lte: endIST,
          },
        },
      },
      _sum: {
        quantity: true,
        cancelledQuantity: true,
      },
      orderBy: {
        _sum: {
          quantity: "desc",
        },
      },
      take: 3,
    });

    const menuItemIds = grouped.map((g) => g.menuItemId);
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: menuItemIds } },
      select: { id: true, name: true },
    });
    const menuItemMap = new Map(menuItems.map((m) => [m.id, m.name]));

    const result = grouped.map((g) => ({
      menuItemId: g.menuItemId,
      name: menuItemMap.get(g.menuItemId) || "Unknown",
      totalSold: Math.max(0, (g._sum.quantity || 0) - (g._sum.cancelledQuantity || 0)),
    }));

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Combined inventory across all outlets in the org
// ==========================================

router.get("/combined", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const ctx = await resolveTenantContext(restaurantId);
    const allOutletIds = ctx.allIds;

    // Sum bar inventory across all outlets
    const barItems = await basePrisma.inventoryItem.findMany({
      where: { restaurantId: { in: allOutletIds } },
      include: { menuItem: { include: { category: true } } },
    });

    const barMap = new Map<string, any>();
    for (const item of barItems) {
      const existing = barMap.get(item.menuItemId) || {
        menuItemId: item.menuItemId,
        name: item.menuItem?.name,
        totalStock: 0,
        perOutlet: [] as Array<{ restaurantId: string; currentStock: number }>,
      };
      existing.totalStock += Number(item.currentStock);
      existing.perOutlet.push({ restaurantId: item.restaurantId, currentStock: Number(item.currentStock) });
      barMap.set(item.menuItemId, existing);
    }

    // Kitchen inventory — use shared kitchen ID (single set, not summed)
    const kitchenRestaurantId = ctx.sharedKitchenOutletId ?? restaurantId;
    const kitchenItems = await basePrisma.kitchenInventoryItem.findMany({
      where: { restaurantId: kitchenRestaurantId },
      orderBy: { name: "asc" },
    });

    res.json({
      bar: Array.from(barMap.values()),
      kitchen: kitchenItems.map(i => ({
        ...i,
        currentStock: Number(i.currentStock),
        reorderLevel: Number(i.reorderLevel),
        price: Number(i.price),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Deduction diagnostic endpoint
// ==========================================

/**
 * GET /api/inventory/kitchen/deduction-check?orderId=xxx
 * Returns a breakdown of which food items in the order have recipes and what
 * would be (or was) deducted from kitchen inventory. Useful for debugging
 * cases where auto-deduction appears not to be working.
 */
router.get("/deduction-check", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    const orderId = req.query.orderId as string | undefined;

    if (!orderId) {
      return res.status(400).json({ error: "orderId query param is required" });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: true },
        },
      },
    });

    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.restaurantId !== restaurantId) return res.status(403).json({ error: "Forbidden" });

    const foodItems = order.items.filter((i) => i.menuItem.menuType === "FOOD");
    const foodMenuItemIds = foodItems.map((i) => i.menuItemId);

    // 10.2: Fetch historical deduction logs as the primary source of truth.
    const deductionLogs = await basePrisma.orderDeductionLog.findMany({
      where: { orderId },
      include: { ingredient: true },
    });
    const logByIngredientId = new Map(deductionLogs.map(l => [l.ingredientId, l]));

    // Also fetch current recipes for context (what the recipe looks like now vs what was used).
    const recipes = await prisma.menuItemRecipe.findMany({
      where: { menuItemId: { in: foodMenuItemIds }, restaurantId },
      include: { ingredient: true },
    });

    const recipesByMenuItemId = new Map<string, typeof recipes>();
    for (const r of recipes) {
      if (!recipesByMenuItemId.has(r.menuItemId)) recipesByMenuItemId.set(r.menuItemId, []);
      recipesByMenuItemId.get(r.menuItemId)!.push(r);
    }

    const foodItemBreakdown = foodItems.map((item) => {
      const itemRecipes = recipesByMenuItemId.get(item.menuItemId) || [];
      return {
        menuItemId: item.menuItemId,
        name: item.menuItem.name,
        orderedQty: item.quantity,
        hasRecipe: itemRecipes.length > 0,
        ingredients: itemRecipes.map((r) => {
          const log = logByIngredientId.get(r.ingredientId);
          return {
            ingredientId: r.ingredientId,
            name: r.ingredient.name,
            unit: r.ingredient.unit,
            perItemQty: Number(r.quantity),
            totalDeductQty: Number(r.quantity) * item.quantity,
            currentStock: Number(r.ingredient.currentStock),
            // Historical deduction status from the settlement attempt.
            deductionStatus: log?.status || null,
            deductionError: log?.error || null,
            deductedQty: log ? Number(log.quantity) : null,
          };
        }),
      };
    });

    const missingRecipes = foodItemBreakdown
      .filter((i) => !i.hasRecipe)
      .map((i) => i.name);

    // Summary of deduction log statuses.
    const deductionSummary = {
      totalLogged: deductionLogs.length,
      successCount: deductionLogs.filter(l => l.status === 'SUCCESS').length,
      failedCount: deductionLogs.filter(l => l.status === 'FAILED').length,
      failedIngredients: deductionLogs
        .filter(l => l.status === 'FAILED')
        .map(l => ({
          ingredientId: l.ingredientId,
          name: l.ingredient?.name || 'Unknown',
          error: l.error,
          quantity: Number(l.quantity),
        })),
    };

    res.json({
      orderId,
      status: order.status,
      inventoryDeducted: order.inventoryDeducted,
      totalFoodItems: foodItems.length,
      foodItems: foodItemBreakdown,
      missingRecipes,
      deductionSummary,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Low stock check helper (called from settle hook)
// ==========================================

export async function checkLowStock(restaurantId: string, io?: any): Promise<void> {
  try {
    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
    const items = await basePrisma.kitchenInventoryItem.findMany({
      where: { restaurantId: kitchenRestaurantId },
    });
    const lowStockItems = items.filter(
      (item) => Number(item.currentStock) <= Number(item.reorderLevel)
    );

    if (lowStockItems.length > 0 && io) {
      io.to(`kitchen:${kitchenRestaurantId}`).emit("kitchen:low-stock", {
        items: lowStockItems.map((item) => ({
          id: item.id,
          name: item.name,
          currentStock: Number(item.currentStock),
          reorderLevel: Number(item.reorderLevel),
          unit: item.unit,
        })),
      });
    }
  } catch (err) {
    logger.error({ err }, "[KitchenInventory] Low stock check failed:");
  }
}

export default router;
