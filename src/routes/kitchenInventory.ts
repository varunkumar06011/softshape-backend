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
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { getIo } from "../socket";

const router = Router();

// Apply auth + tenant scoping to all kitchen inventory routes
router.use(authenticate, assertTenantScope, withTenantContext);

// Returns the current IST date as a YYYY-MM-DD string.
// Used for daily inventory entries keyed by date.
function getKolkataDateString(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().slice(0, 10);
}

// ==========================================
// Kitchen Inventory Items CRUD
// ==========================================

router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    const date = (req.query.date as string) || getKolkataDateString();

    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const items = await prisma.kitchenInventoryItem.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
    });

    // Fetch today's entries for each item
    const entries = await prisma.inventoryDailyEntry.findMany({
      where: { restaurantId, entryDate: date },
    });

    const entryMap = new Map(entries.map((e) => [e.itemId, e]));

    const result = items.map((item) => {
      const entry = entryMap.get(item.id);
      return {
        ...item,
        currentStock: Number(item.currentStock),
        reorderLevel: Number(item.reorderLevel),
        todayEntry: entry ? {
          openingStock: Number(entry.openingStock),
          addedStock: Number(entry.addedStock),
          consumedStock: Number(entry.consumedStock),
          closingStock: Number(entry.closingStock),
        } : null,
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
    const { id, name, unit, currentStock, reorderLevel } = req.body;

    if (!restaurantId || !name || !unit) {
      return res.status(400).json({ error: "restaurantId, name, unit are required" });
    }

    if (id) {
      const updated = await prisma.kitchenInventoryItem.update({
        where: { id },
        data: {
          name,
          unit,
          currentStock: new Prisma.Decimal(currentStock || 0),
          reorderLevel: new Prisma.Decimal(reorderLevel || 0),
        },
      });
      return res.json(updated);
    }

    const item = await prisma.kitchenInventoryItem.create({
      data: {
        name,
        unit,
        currentStock: new Prisma.Decimal(currentStock || 0),
        reorderLevel: new Prisma.Decimal(reorderLevel || 0),
        restaurantId,
      },
    });

    // Create today's entry if opening stock > 0
    if (currentStock && currentStock > 0) {
      const today = getKolkataDateString();
      await prisma.inventoryDailyEntry.create({
        data: {
          restaurantId,
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

router.delete("/items/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    await prisma.kitchenInventoryItem.delete({ where: { id } });
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
    const { itemId, openingStock, addStock } = req.body;

    if (!restaurantId || !itemId) {
      return res.status(400).json({ error: "restaurantId, itemId are required" });
    }

    const today = getKolkataDateString();

    const existing = await prisma.inventoryDailyEntry.findUnique({
      where: {
        restaurantId_itemId_entryDate: { restaurantId, itemId, entryDate: today },
      },
    });

    if (existing) {
      // Add stock to existing entry
      const added = Number(existing.addedStock) + (addStock || 0);
      const closing = Number(existing.openingStock) + added - Number(existing.consumedStock);

      const updated = await prisma.inventoryDailyEntry.update({
        where: { id: existing.id },
        data: {
          addedStock: new Prisma.Decimal(added),
          closingStock: new Prisma.Decimal(closing),
        },
      });

      // Update item's current stock
      await prisma.kitchenInventoryItem.update({
        where: { id: itemId },
        data: {
          currentStock: new Prisma.Decimal(closing),
        },
      });

      return res.json(updated);
    }

    // Create new entry
    const opening = openingStock || 0;
    const entry = await prisma.inventoryDailyEntry.create({
      data: {
        restaurantId,
        itemId,
        entryDate: today,
        openingStock: new Prisma.Decimal(opening),
        addedStock: new Prisma.Decimal(addStock || 0),
        closingStock: new Prisma.Decimal(opening + (addStock || 0)),
      },
    });

    // Update item's current stock
    await prisma.kitchenInventoryItem.update({
      where: { id: itemId },
      data: {
        currentStock: new Prisma.Decimal(opening + (addStock || 0)),
      },
    });

    res.json(entry);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Low stock check helper (called from settle hook)
// ==========================================

export async function checkLowStock(restaurantId: string, io?: any): Promise<void> {
  try {
    const items = await prisma.kitchenInventoryItem.findMany({
      where: { restaurantId },
    });
    const lowStockItems = items.filter(
      (item) => Number(item.currentStock) <= Number(item.reorderLevel)
    );

    if (lowStockItems.length > 0 && io) {
      io.to(`restaurant:${restaurantId}`).emit("kitchen:low-stock", {
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
