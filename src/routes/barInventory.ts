// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Routes — Liquor inventory tracking with bottle-level management
// ─────────────────────────────────────────────────────────────────────────────
// Manages bar liquor inventory: opening stock, additions, consumption tracking,
// and automatic stock deduction on order settlement. Supports both peg-based
// (30ml units) and bottle-based inventory management.
//
// Features:
//   - Inventory item CRUD linked to menu items
//   - Manual stock adjustments (wastage, adjustment) with transaction records
//   - Purchase recording with automatic cost and price updates
//   - Transaction history with date filtering
//   - Daily inventory reports with snapshots
//   - Low stock alerts via Socket.IO
//   - Beer vs liquor handling (beer uses different unit logic)
//   - Real-time socket events on stock changes
//
// Constants:
//   BAR_UNIT_ML = 30 (standard peg size)
//
// Endpoints:
//   GET    /api/bar/inventory/items           — list all inventory items
//   POST   /api/bar/inventory/items           — create an inventory item
//   GET    /api/bar/inventory/items/:id       — get a single inventory item
//   PATCH  /api/bar/inventory/items/:id       — update an inventory item
//   DELETE /api/bar/inventory/items/:id       — delete an inventory item
//   POST   /api/bar/inventory/adjust-stock    — manual stock adjustment
//   POST   /api/bar/inventory/record-purchase — record new stock purchase
//   GET    /api/bar/inventory/transactions    — transaction history
//   GET    /api/bar/inventory/daily-report    — daily inventory report
//   GET    /api/bar/inventory/low-stock       — items at or below reorder level
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import { Prisma } from "@prisma/client";
import { getIo } from "../socket";
import { isBeerItem } from "../utils/itemHelpers";
import prisma, { basePrisma } from "../lib/prisma";
import { resolveTenantContext } from "../lib/tenantContext";
import { authenticate } from "../middleware/auth";
import { getKolkataDateString } from "../utils/date";
import { autoUpdateVariantPrices } from "../utils/autoPricing";
import { BAR_UNIT_ML } from "../utils/barConstants";

const router = Router();

// Apply authentication to all routes (tenant scope + subscription already applied at mount point)
router.use(authenticate);

// Helper: resolve the bar restaurant ID from the authenticated user.
// Uses activeRestaurantId (the switched-to outlet) first, falling back to
// restaurantId (home outlet) — consistent with all other routes.
function resolveBarId(req: any): string {
  return (req.user?.activeRestaurantId ?? req.user?.restaurantId) as string || "";
}

const inventoryInclude = {
  menuItem: {
    include: {
      category: true,
      variants: true,
    },
  },
} as const;

// Helper function to emit socket events
function emitToBar(eventName: string, restaurantId: string, payload: Record<string, unknown>): void {
  getIo().to(restaurantId).emit(eventName, { restaurantId, ...payload });
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Convert a YYYY-MM-DD IST date to UTC Date range for querying DateTime fields.
function istDateToUTCStart(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
}

function istDateToUTCEnd(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS);
}

// Helper: format a milliliter quantity as "N bottles + M ml"
function formatBottlesPlusMl(totalMl: number, bottleSize: number): { bottles: number; remainingMl: number; display: string } {
  const safeBottleSize = bottleSize > 0 ? bottleSize : 750;
  const bottles = Math.floor(totalMl / safeBottleSize);
  const remainingMl = Math.round(totalMl % safeBottleSize);
  const display = remainingMl === 0
    ? `${bottles} bottles`
    : `${bottles} bottles + ${remainingMl} ml`;
  return { bottles, remainingMl, display };
}

// Items that have separate 180ml and 750ml inventory variants.
// When settled, deduct from 750ml inventory first, then 180ml.
const DUAL_VARIANT_ITEMS = ['mansion house xo', 'black dog reserve'];


// ==========================================
// GET /api/bar/inventory/items
// List all inventory items
// ==========================================
router.get("/items", async (req: any, res) => {
  try {
    const requestedDate = req.query.date as string;
    const today = getKolkataDateString();
    const targetDate = requestedDate || today;
    const isToday = targetDate === today;

    const items = await prisma.inventoryItem.findMany({
      where: { restaurantId: resolveBarId(req) },
      include: {
        ...inventoryInclude,
        dailySnapshots: {
          where: { snapshotDate: targetDate },
          take: 1,
        },
      },
      orderBy: [
        { menuItem: { category: { name: "asc" } } },
        { menuItem: { name: "asc" } },
      ],
    });

    const result = items.map((item) => {
      const currentStockNum = Number(item.currentStock);
      const price = Number(item.menuItem?.basePrice || 0);
      const bottleSize = item.bottleSize || 750;
      const displayStock = formatBottlesPlusMl(currentStockNum, bottleSize);

      let todayEntry = null;
      if (item.dailySnapshots && item.dailySnapshots.length > 0) {
        const snapshot = item.dailySnapshots[0];
        const openingStockNum = Number(snapshot.openingStock);
        const addedStockNum = Number(snapshot.purchased);
        const consumedStockNum = Number(snapshot.sold) + Number(snapshot.wastage) + (Number(snapshot.adjusted) < 0 ? Math.abs(Number(snapshot.adjusted)) : 0);
        const closingStockNum = Number(snapshot.closingStock);
        todayEntry = {
          openingStock: openingStockNum,
          addedStock: addedStockNum,
          consumedStock: consumedStockNum,
          closingStock: closingStockNum,
          displayOpening: formatBottlesPlusMl(openingStockNum, bottleSize),
          displayAdded: formatBottlesPlusMl(addedStockNum, bottleSize),
          displayConsumed: formatBottlesPlusMl(consumedStockNum, bottleSize),
          displayClosing: formatBottlesPlusMl(closingStockNum, bottleSize),
          isCarryOver: false,
        };
      } else if (isToday && currentStockNum > 0) {
        // No snapshot yet today, meaning no transactions occurred today.
        // Therefore today's opening == current closing == currentStock
        todayEntry = {
          openingStock: currentStockNum,
          addedStock: 0,
          consumedStock: 0,
          closingStock: currentStockNum,
          displayOpening: formatBottlesPlusMl(currentStockNum, bottleSize),
          displayAdded: formatBottlesPlusMl(0, bottleSize),
          displayConsumed: formatBottlesPlusMl(0, bottleSize),
          displayClosing: formatBottlesPlusMl(currentStockNum, bottleSize),
          isCarryOver: true,
        };
      }

      // Remove dailySnapshots from payload to keep it clean, but attach todayEntry
      const { dailySnapshots, ...rest } = item;
      return {
        ...rest,
        todayEntry,
        displayStock,
      };
    });

    res.json(result);
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to fetch items:");
    res.status(500).json({ error: "Failed to fetch inventory items" });
  }
});

// ==========================================
// GET /api/bar/inventory/items/:id
// Get single item details
// ==========================================
router.get("/items/:id", async (req: any, res) => {
  try {
    const id = req.params.id as string;

    const item = await prisma.inventoryItem.findFirst({
      where: { id, restaurantId: resolveBarId(req) },
      include: {
        ...inventoryInclude,
        transactions: {
          orderBy: { transactionDate: "desc" },
          take: 20,
        },
      },
    });

    if (!item) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    const bottleSize = item.bottleSize || 750;
    const displayStock = formatBottlesPlusMl(Number(item.currentStock), bottleSize);

    res.json({ ...item, displayStock });
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to fetch item:");
    res.status(500).json({ error: "Failed to fetch inventory item" });
  }
});

// ==========================================
// POST /api/bar/inventory/items
// Create new inventory entry
// ==========================================
router.post("/items", async (req: any, res) => {
  try {
    const {
      menuItemId,
      unitOfMeasure,
      bottleSize,
      currentStock,
      openingStockBottles,
      reorderLevel,
      costPerBottle,
    } = req.body as {
      menuItemId?: string;
      unitOfMeasure?: string;
      bottleSize?: number;
      currentStock?: number;
      openingStockBottles?: number;
      reorderLevel?: number;
      costPerBottle?: number;
    };

    // Validation — accept either currentStock (ml) or openingStockBottles
    if (!menuItemId || !unitOfMeasure || bottleSize === undefined || reorderLevel === undefined) {
      res.status(400).json({
        error: "menuItemId, unitOfMeasure, bottleSize, and reorderLevel are required",
      });
      return;
    }

    if (currentStock === undefined && openingStockBottles === undefined) {
      res.status(400).json({
        error: "Either currentStock (in ml) or openingStockBottles (in bottles) is required",
      });
      return;
    }

    if (Number(bottleSize) <= 0) {
      res.status(400).json({ error: "bottleSize must be greater than 0" });
      return;
    }

    if (currentStock !== undefined && Number(currentStock) < 0) {
      res.status(400).json({ error: "currentStock must be non-negative" });
      return;
    }

    if (openingStockBottles !== undefined && Number(openingStockBottles) < 0) {
      res.status(400).json({ error: "openingStockBottles must be non-negative" });
      return;
    }

    if (Number(reorderLevel) < 0) {
      res.status(400).json({ error: "reorderLevel must be non-negative" });
      return;
    }

    // Check if menuItem exists and is a bar item
    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, restaurantId: resolveBarId(req) },
    });

    if (!menuItem) {
      res.status(404).json({ error: "Menu item not found in bar menu" });
      return;
    }

    // Check if inventory already exists for this menu item
    const existing = await prisma.inventoryItem.findUnique({
      where: { menuItemId },
    });

    if (existing) {
      res.status(409).json({ error: "Inventory item already exists for this menu item" });
      return;
    }

    // Convert openingStockBottles to ml if provided, otherwise use currentStock directly
    const effectiveStock = openingStockBottles !== undefined
      ? Number(openingStockBottles) * Number(bottleSize)
      : Number(currentStock);
    const openingStock = new Prisma.Decimal(effectiveStock);

    // Create inventory item
    const item = await prisma.inventoryItem.create({
      data: {
        menuItemId,
        restaurantId: resolveBarId(req),
        unitOfMeasure,
        bottleSize: Number(bottleSize),
        openingStock,
        currentStock: openingStock,
        reorderLevel: new Prisma.Decimal(reorderLevel),
        costPerBottle: costPerBottle ? new Prisma.Decimal(costPerBottle) : null,
        lastRestocked: new Date(),
      },
      include: inventoryInclude,
    });

    // Create initial transaction record
    await prisma.inventoryTransaction.create({
      data: {
        restaurantId: resolveBarId(req),
        itemId: item.id,
        type: "ADJUSTMENT",
        quantityChange: openingStock,
        stockBefore: new Prisma.Decimal(0),
        stockAfter: openingStock,
        notes: "Initial inventory creation",
        createdBy: "System",
      },
    });

    emitToBar("inventory:updated", resolveBarId(req), { item });

    res.status(201).json(item);
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to create item:");
    res.status(500).json({ error: "Failed to create inventory item" });
  }
});

// ==========================================
// PATCH /api/bar/inventory/items/:id
// Update inventory item details
// ==========================================
router.patch("/items/:id", async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const {
      unitOfMeasure,
      bottleSize,
      reorderLevel,
      costPerBottle,
      skipPriceUpdate,
      name,
      category,
      price,
      openingStock,
      openingStockBottles,
      purchased,
      purchaseBottles,
      consumed
    } = req.body as {
      unitOfMeasure?: string;
      bottleSize?: number;
      reorderLevel?: number;
      costPerBottle?: number;
      skipPriceUpdate?: boolean;
      name?: string;
      category?: string;
      price?: number;
      openingStock?: number;
      openingStockBottles?: number;
      purchased?: number;
      purchaseBottles?: number;
      consumed?: number;
    };

    const existing = await prisma.inventoryItem.findFirst({
      where: { id, restaurantId: resolveBarId(req) },
      include: { menuItem: true }
    });

    if (!existing) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Update MenuItem properties if provided
    if (name !== undefined || category !== undefined || price !== undefined) {
      const menuUpdateData: any = {};
      if (name !== undefined) menuUpdateData.name = name;
      if (price !== undefined) menuUpdateData.basePrice = new Prisma.Decimal(Number(price));

      if (category !== undefined) {
        const categoryName = String(category).trim();
        if (categoryName) {
          let cat = await prisma.category.findFirst({
            where: {
              restaurantId: resolveBarId(req),
              name: { equals: categoryName, mode: 'insensitive' }
            }
          });
          if (!cat) {
            cat = await prisma.category.create({
              data: {
                name: categoryName,
                restaurantId: resolveBarId(req)
              }
            });
          }
          menuUpdateData.categoryId = cat.id;
        }
      }

      if (Object.keys(menuUpdateData).length > 0) {
        await prisma.menuItem.update({
          where: { id: existing!.menuItemId },
          data: menuUpdateData
        });
      }
    }

    // Build update payload for InventoryItem
    const updateData: Record<string, unknown> = {};
    if (unitOfMeasure !== undefined) updateData.unitOfMeasure = unitOfMeasure;
    if (bottleSize !== undefined) {
      const numBottleSize = Number(bottleSize);
      if (numBottleSize <= 0) {
        res.status(400).json({ error: "bottleSize must be greater than 0" });
        return;
      }
      updateData.bottleSize = numBottleSize;
    }
    if (reorderLevel !== undefined) updateData.reorderLevel = new Prisma.Decimal(Number(reorderLevel));
    if (costPerBottle !== undefined) updateData.costPerBottle = new Prisma.Decimal(Number(costPerBottle));

    if (Object.keys(updateData).length > 0) {
      await prisma.inventoryItem.update({
        where: { id },
        data: updateData,
      });
    }

    // Re-fetch fresh to ensure the response includes the latest menuItem name
    let updated = await prisma.inventoryItem.findFirst({
      where: { id, restaurantId: resolveBarId(req) },
      include: inventoryInclude,
    });
    if (!updated) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Update Daily Ledger if provided
    // Convert bottle-based inputs to ml using the item's bottleSize
    const effectiveBottleSize = bottleSize !== undefined ? Number(bottleSize) : (existing!.bottleSize || 750);
    const effectiveOpeningMl = openingStockBottles !== undefined
      ? Number(openingStockBottles) * effectiveBottleSize
      : openingStock !== undefined ? Number(openingStock) : undefined;
    const effectivePurchasedMl = purchaseBottles !== undefined
      ? Number(purchaseBottles) * effectiveBottleSize
      : purchased !== undefined ? Number(purchased) : undefined;

    if (effectiveOpeningMl !== undefined || effectivePurchasedMl !== undefined || consumed !== undefined) {
      const today = getKolkataDateString();
      const existingSnapshot = await prisma.dailyInventorySnapshot.findUnique({
        where: {
          restaurantId_snapshotDate_itemId: { restaurantId: resolveBarId(req), snapshotDate: today, itemId: id },
        },
      });
      const dataToUpdate: any = {};
      if (effectiveOpeningMl !== undefined) dataToUpdate.openingStock = new Prisma.Decimal(effectiveOpeningMl);
      if (effectivePurchasedMl !== undefined) dataToUpdate.purchased = new Prisma.Decimal(effectivePurchasedMl);
      if (consumed !== undefined) {
        dataToUpdate.sold = new Prisma.Decimal(Number(consumed));
        dataToUpdate.wastage = new Prisma.Decimal(0);
        dataToUpdate.adjusted = new Prisma.Decimal(0);
      }
      
      const newOpening = effectiveOpeningMl !== undefined ? effectiveOpeningMl : Number(existingSnapshot?.openingStock || existing!.currentStock);
      const newPurchased = effectivePurchasedMl !== undefined ? effectivePurchasedMl : Number(existingSnapshot?.purchased || 0);
      const newConsumed = consumed !== undefined ? Number(consumed) : (Number(existingSnapshot?.sold || 0) + Number(existingSnapshot?.wastage || 0) + (Number(existingSnapshot?.adjusted || 0) < 0 ? Math.abs(Number(existingSnapshot?.adjusted || 0)) : 0));
      
      const newClosing = newOpening + newPurchased - newConsumed;
      dataToUpdate.closingStock = new Prisma.Decimal(newClosing);

      await prisma.dailyInventorySnapshot.upsert({
        where: {
          restaurantId_snapshotDate_itemId: { restaurantId: resolveBarId(req), snapshotDate: today, itemId: id },
        },
        create: {
          restaurantId: resolveBarId(req),
          itemId: id,
          snapshotDate: today,
          itemName: existing!.menuItem?.name || "Unknown",
          openingStock: new Prisma.Decimal(newOpening),
          purchased: new Prisma.Decimal(newPurchased),
          sold: new Prisma.Decimal(newConsumed),
          wastage: new Prisma.Decimal(0),
          adjusted: new Prisma.Decimal(0),
          closingStock: new Prisma.Decimal(newClosing)
        },
        update: dataToUpdate
      });

      // Update currentStock to match the new closingStock
      updated = await prisma.inventoryItem.update({
        where: { id },
        data: { currentStock: new Prisma.Decimal(newClosing) },
        include: inventoryInclude,
      });
    }

    // AUTO-UPDATE MENU ITEM VARIANT PRICES when cost changes
    if (costPerBottle !== undefined && updated.menuItem) {
      const newBottleSize = bottleSize !== undefined ? Number(bottleSize) : updated.bottleSize;
      await autoUpdateVariantPrices(prisma, updated.menuItemId, newBottleSize, Number(costPerBottle), skipPriceUpdate);
    }

    emitToBar("inventory:updated", resolveBarId(req), { item: updated });

    res.json(updated);
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to update item:");
    res.status(500).json({ error: "Failed to update inventory item" });
  }
});

// ==========================================
// DELETE /api/bar/inventory/items/:id
// Delete inventory item
// ==========================================
router.delete("/items/:id", async (req: any, res) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.inventoryItem.findFirst({
      where: { id, restaurantId: resolveBarId(req) },
    });

    if (!existing) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Delete related transactions and snapshots via cascade
    await prisma.inventoryItem.delete({
      where: { id },
    });

    emitToBar("inventory:deleted", resolveBarId(req), { itemId: id });

    res.json({ ok: true, id });
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to delete item:");
    res.status(500).json({ error: "Failed to delete inventory item" });
  }
});

// ==========================================
// POST /api/bar/inventory/adjust-stock
// Manual stock adjustment
// ==========================================
router.post("/adjust-stock", async (req: any, res) => {
  try {
    const {
      itemId,
      quantityChange,
      type,
      notes,
      createdBy,
    } = req.body as {
      itemId?: string;
      quantityChange?: number;
      type?: string;
      notes?: string;
      createdBy?: string;
    };

    // Validation
    if (!itemId || quantityChange === undefined || !type) {
      res.status(400).json({
        error: "itemId, quantityChange, and type are required",
      });
      return;
    }

    const validTypes = ["WASTAGE", "ADJUSTMENT"];
    if (!validTypes.includes(type)) {
      res.status(400).json({
        error: `Invalid type. Must be one of: ${validTypes.join(", ")}`,
      });
      return;
    }

    // Pre-check item exists (for 404 response before entering transaction)
    const exists = await prisma.inventoryItem.findFirst({
      where: { id: itemId, restaurantId: resolveBarId(req) },
      select: { id: true },
    });

    if (!exists) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    const change = new Prisma.Decimal(quantityChange);

    // Use transaction with row-level locking to ensure atomicity
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the row for update to prevent concurrent modifications
        const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; reorderLevel: Prisma.Decimal; bottleSize: number; menuItemId: string }>>`
          SELECT "id", "currentStock", "reorderLevel", "bottleSize", "menuItemId"
          FROM "inventory_items"
          WHERE "id" = ${itemId}
          FOR UPDATE
        `;
        const lockedItem = lockedRows[0];
        if (!lockedItem) {
          throw Object.assign(new Error("Inventory item not found"), { statusCode: 404 });
        }

        const stockBefore = lockedItem.currentStock;
        const stockAfter = stockBefore.add(change);

        // Prevent negative stock
        if (stockAfter.lessThan(0)) {
          throw Object.assign(
            new Error("Adjustment would result in negative stock"),
            { statusCode: 400, currentStock: stockBefore.toString(), requestedChange: change.toString() }
          );
        }

        // Update inventory item
        const updatedItem = await tx.inventoryItem.update({
          where: { id: itemId },
          data: {
            currentStock: stockAfter,
            updatedAt: new Date(),
          },
          include: inventoryInclude,
        });

        // Create transaction record
        const transaction = await tx.inventoryTransaction.create({
          data: {
            restaurantId: resolveBarId(req),
            itemId,
            type,
            quantityChange: change,
            stockBefore,
            stockAfter,
            notes: notes || null,
            createdBy: createdBy || "Unknown",
          },
        });

        // Update daily inventory snapshot
        const snapshotDate = getKolkataDateString();
        const menuItem = updatedItem.menuItem;
        const snapshotFieldName = type === "WASTAGE" ? "wastage" : "adjusted";
        await tx.dailyInventorySnapshot.upsert({
          where: {
            restaurantId_snapshotDate_itemId: {
              restaurantId: resolveBarId(req),
              snapshotDate,
              itemId,
            },
          },
          create: {
            restaurantId: resolveBarId(req),
            itemId,
            snapshotDate,
            itemName: menuItem?.name ?? "Unknown",
            openingStock: stockBefore,
            purchased: new Prisma.Decimal(0),
            sold: new Prisma.Decimal(0),
            wastage: type === "WASTAGE" ? change.abs() : new Prisma.Decimal(0),
            adjusted: type === "ADJUSTMENT" ? change : new Prisma.Decimal(0),
            closingStock: stockAfter,
          },
          update: {
            [snapshotFieldName]: { increment: change.abs() },
            closingStock: stockAfter,
          },
        });

        return { item: updatedItem, transaction };
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // Emit socket event
    emitToBar("inventory:updated", resolveBarId(req), { item: result.item });

    // Check if stock is low
    if (result.item.currentStock.lessThanOrEqualTo(result.item.reorderLevel)) {
      emitToBar("inventory:low_stock", resolveBarId(req), {
        item: result.item,
        currentStock: result.item.currentStock.toString(),
        reorderLevel: result.item.reorderLevel.toString(),
      });
    }

    res.json(result);
  } catch (error: any) {
    const statusCode = error?.statusCode || 500;
    if (statusCode === 400) {
      res.status(400).json({
        error: error.message,
        currentStock: error.currentStock,
        requestedChange: error.requestedChange,
      });
      return;
    }
    if (statusCode === 404) {
      res.status(404).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, "[BarInventory] Failed to adjust stock:");
    res.status(500).json({ error: "Failed to adjust stock" });
  }
});

// ==========================================
// POST /api/bar/inventory/record-purchase
// Record new stock purchase
// ==========================================
router.post("/record-purchase", async (req: any, res) => {
  try {
    const {
      itemId,
      quantity,
      purchaseBottles,
      costPerBottle,
      notes,
      createdBy,
      skipPriceUpdate,
    } = req.body as {
      itemId?: string;
      quantity?: number;
      purchaseBottles?: number;
      costPerBottle?: number;
      notes?: string;
      createdBy?: string;
      skipPriceUpdate?: boolean;
    };

    // Validation — accept either quantity (ml) or purchaseBottles
    if (!itemId) {
      res.status(400).json({
        error: "itemId is required",
      });
      return;
    }

    if (quantity === undefined && purchaseBottles === undefined) {
      res.status(400).json({
        error: "Either quantity (in ml) or purchaseBottles (in bottles) is required",
      });
      return;
    }

    // Pre-check item exists (for 404 response before entering transaction)
    const exists = await prisma.inventoryItem.findFirst({
      where: { id: itemId, restaurantId: resolveBarId(req) },
      select: { id: true, bottleSize: true },
    });

    if (!exists) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Convert purchaseBottles to ml if provided, otherwise use quantity directly
    const effectiveQty = purchaseBottles !== undefined
      ? Number(purchaseBottles) * (exists.bottleSize || 750)
      : Number(quantity);

    if (effectiveQty <= 0) {
      res.status(400).json({
        error: "Purchase quantity must be greater than 0",
      });
      return;
    }

    const purchaseQty = new Prisma.Decimal(effectiveQty);

    // Use transaction with row-level locking to ensure atomicity
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the row for update to prevent concurrent modifications
        const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; bottleSize: number; menuItemId: string }>>`
          SELECT "id", "currentStock", "bottleSize", "menuItemId"
          FROM "inventory_items"
          WHERE "id" = ${itemId}
          FOR UPDATE
        `;
        const lockedItem = lockedRows[0];
        if (!lockedItem) {
          throw Object.assign(new Error("Inventory item not found"), { statusCode: 404 });
        }

        const stockBefore = lockedItem.currentStock;
        const stockAfter = stockBefore.add(purchaseQty);

        // Update inventory item
        const updateData: Record<string, unknown> = {
          currentStock: stockAfter,
          lastRestocked: new Date(),
          updatedAt: new Date(),
        };

        // Update cost per bottle if provided
        if (costPerBottle !== undefined) {
          updateData.costPerBottle = new Prisma.Decimal(costPerBottle);
        }

        const updatedItem = await tx.inventoryItem.update({
          where: { id: itemId },
          data: updateData,
          include: inventoryInclude,
        });

        // AUTO-UPDATE MENU ITEM VARIANT PRICES when cost changes
        if (costPerBottle !== undefined && updatedItem.menuItem) {
          await autoUpdateVariantPrices(tx, updatedItem.menuItemId, Number(updatedItem.bottleSize), Number(costPerBottle), skipPriceUpdate);
        }

        // Create transaction record
        const transaction = await tx.inventoryTransaction.create({
          data: {
            restaurantId: resolveBarId(req),
            itemId,
            type: "PURCHASE",
            quantityChange: purchaseQty,
            stockBefore,
            stockAfter,
            notes: notes || null,
            createdBy: createdBy || "Unknown",
          },
        });

        // Update daily inventory snapshot
        const snapshotDate = getKolkataDateString();
        const menuItem = updatedItem.menuItem;
        await tx.dailyInventorySnapshot.upsert({
          where: {
            restaurantId_snapshotDate_itemId: {
              restaurantId: resolveBarId(req),
              snapshotDate,
              itemId,
            },
          },
          create: {
            restaurantId: resolveBarId(req),
            itemId,
            snapshotDate,
            itemName: menuItem?.name ?? "Unknown",
            openingStock: stockBefore,
            purchased: purchaseQty,
            sold: new Prisma.Decimal(0),
            wastage: new Prisma.Decimal(0),
            adjusted: new Prisma.Decimal(0),
            closingStock: stockAfter,
          },
          update: {
            purchased: { increment: purchaseQty },
            closingStock: stockAfter,
          },
        });

        return { item: updatedItem, transaction };
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // Emit socket event
    emitToBar("inventory:updated", resolveBarId(req), { item: result.item });

    res.json(result);
  } catch (error: any) {
    const statusCode = error?.statusCode || 500;
    if (statusCode === 404) {
      res.status(404).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, "[BarInventory] Failed to record purchase:");
    res.status(500).json({ error: "Failed to record purchase" });
  }
});

// ==========================================
// GET /api/bar/inventory/transactions
// Get transaction history with optional filters
// ==========================================
router.get("/transactions", async (req: any, res) => {
  try {
    const {
      itemId,
      type,
      startDate,
      endDate,
      limit = 100,
    } = req.query as {
      itemId?: string;
      type?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
    };

    // Build where clause
    const where: Record<string, unknown> = {
      restaurantId: resolveBarId(req),
    };

    if (itemId) {
      where.itemId = itemId;
    }

    if (type) {
      where.type = type;
    }

    if (startDate || endDate) {
      where.transactionDate = {};
      if (startDate) {
        (where.transactionDate as Record<string, unknown>).gte = istDateToUTCStart(startDate);
      }
      if (endDate) {
        (where.transactionDate as Record<string, unknown>).lte = istDateToUTCEnd(endDate);
      }
    }

    const transactions = await prisma.inventoryTransaction.findMany({
      where,
      include: {
        item: {
          include: {
            menuItem: {
              select: { name: true, id: true },
            },
          },
        },
      },
      orderBy: { transactionDate: "desc" },
      take: Math.min(Number(limit), 500),
    });

    res.json(transactions);
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to fetch transactions:");
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ==========================================
// GET /api/bar/inventory/daily-report
// Get daily inventory report for a specific date
// ==========================================
router.get("/daily-report", async (req: any, res) => {
  try {
    const { date } = req.query as { date?: string };

    // Use IST date if not provided
    const reportDate = date || getKolkataDateString();

    // Parse date to get start and end of day in IST
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const dateObj = new Date(reportDate + "T00:00:00Z");
    const startOfDayUTC = new Date(dateObj.getTime() - IST_OFFSET_MS);
    const endOfDayUTC = new Date(startOfDayUTC.getTime() + 24 * 60 * 60 * 1000 - 1);

    // Get all inventory items
    const items = await prisma.inventoryItem.findMany({
      where: { restaurantId: resolveBarId(req) },
      include: {
        menuItem: {
          include: { variants: true },
        },
      },
    });

    // Get all transactions for the day
    const transactions = await prisma.inventoryTransaction.findMany({
      where: {
        restaurantId: resolveBarId(req),
        transactionDate: {
          gte: startOfDayUTC,
          lte: endOfDayUTC,
        },
      },
      orderBy: { transactionDate: "asc" },
    });

    // Get daily snapshots for today
    const snapshots = await prisma.dailyInventorySnapshot.findMany({
      where: {
        restaurantId: resolveBarId(req),
        snapshotDate: reportDate
      }
    });
    const snapshotMap = new Map(snapshots.map(s => [s.itemId, s]));

    // Build report for each item
    const report = items.map((item) => {
      const itemTransactions = transactions.filter((t) => t.itemId === item.id);
      const snapshot = snapshotMap.get(item.id);

      // Calculate aggregates
      const purchased = itemTransactions
        .filter((t) => t.type === "PURCHASE")
        .reduce((sum, t) => sum.add(t.quantityChange), new Prisma.Decimal(0));

      const wastage = itemTransactions
        .filter((t) => t.type === "WASTAGE")
        .reduce((sum, t) => sum.add(t.quantityChange.abs()), new Prisma.Decimal(0));

      const adjustments = itemTransactions
        .filter((t) => t.type === "ADJUSTMENT")
        .reduce((sum, t) => sum.add(t.quantityChange), new Prisma.Decimal(0));

      // Prioritize snapshot for opening/closing stock, fallback to transactions/currentStock
      const openingStock = snapshot?.openingStock ?? (
        itemTransactions.length > 0
          ? Number(itemTransactions[0].stockBefore)
          : Number(item.currentStock)
      );

      const closingStock = snapshot?.closingStock ?? (
        itemTransactions.length > 0
          ? Number(itemTransactions[itemTransactions.length - 1].stockAfter)
          : Number(item.currentStock)
      );

      // For "sold", try snapshot first. If no snapshot, calculate from transactions
      const soldMl = snapshot?.sold 
        ? Number(snapshot.sold)
        : Number(
            itemTransactions
              .filter((t) => t.type === "SALE")
              .reduce((sum, t) => sum.add(t.quantityChange.abs()), new Prisma.Decimal(0))
          );

      const isBeer = isBeerItem(item.menuItem);
      const isSpirit = !isBeer && item.menuItem.variants?.some((v: any) => v.name.trim().toLowerCase() === "30ml");
      const bottleSize = item.bottleSize ? Number(item.bottleSize) : 750;
      const unitMl = isBeer ? 650 : isSpirit ? BAR_UNIT_ML : bottleSize;
      const unitsSold = soldMl / unitMl;

      const displaySold = isBeer
        ? `${Math.floor(unitsSold)} bottles (${soldMl}ml)`
        : isSpirit
        ? `${Math.floor(unitsSold)} pours (${soldMl}ml)`
        : `Bottle × ${unitsSold}`;

      const totalStockNum = Number(openingStock) + Number(purchased);

      return {
        itemId: item.id,
        itemName: item.menuItem.name,
        unitOfMeasure: item.unitOfMeasure,
        bottleSize: item.bottleSize,
        openingStock: openingStock.toString(),
        purchased: purchased.toString(),
        sold: soldMl.toString(),
        unitsSold,
        displaySold,
        wastage: wastage.toString(),
        adjusted: adjustments.toString(),
        closingStock: closingStock.toString(),
        reorderLevel: item.reorderLevel.toString(),
        isLowStock: Number(closingStock) <= Number(item.reorderLevel),
        transactionCount: itemTransactions.length,
        displayOpening: formatBottlesPlusMl(Number(openingStock), bottleSize),
        displayPurchased: formatBottlesPlusMl(Number(purchased), bottleSize),
        displayTotalStock: formatBottlesPlusMl(totalStockNum, bottleSize),
        displaySoldBottles: formatBottlesPlusMl(soldMl, bottleSize),
        displayClosing: formatBottlesPlusMl(Number(closingStock), bottleSize),
      };
    });

    res.json({
      date: reportDate,
      restaurantId: resolveBarId(req),
      items: report,
      summary: {
        totalItems: items.length,
        lowStockItems: report.filter((r) => r.isLowStock).length,
        totalTransactions: transactions.length,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to generate daily report:");
    res.status(500).json({ error: "Failed to generate daily report" });
  }
});

// ==========================================
// GET /api/bar/inventory/low-stock
// Get items with stock at or below reorder level
// ==========================================
router.get("/low-stock", async (req: any, res) => {
  try {
    // Single optimized query instead of raw SQL + N+1 loop
    const items = await prisma.inventoryItem.findMany({
      where: {
        restaurantId: resolveBarId(req),
        currentStock: { lte: prisma.inventoryItem.fields.reorderLevel }
      },
      include: inventoryInclude,
      orderBy: {
        currentStock: 'asc'  // Approximate sorting by urgency
      }
    });

    // Calculate urgency percentage
    const itemsWithUrgency = items.map((item) => {
      const urgencyPercent = item.reorderLevel.greaterThan(0)
        ? item.currentStock.div(item.reorderLevel).mul(100).toNumber()
        : 100;

      const bottleSize = item.bottleSize || 750;
      const displayStock = formatBottlesPlusMl(Number(item.currentStock), bottleSize);

      return {
        ...item,
        urgencyPercent: Math.round(urgencyPercent),
        stockDeficit: item.reorderLevel.sub(item.currentStock).toString(),
        displayStock,
      };
    });

    // Sort by urgency percent (most urgent first)
    itemsWithUrgency.sort((a, b) => a.urgencyPercent - b.urgencyPercent);

    // Emit low stock alert if there are items
    if (itemsWithUrgency.length > 0) {
      emitToBar("inventory:low_stock_alert", resolveBarId(req), {
        count: itemsWithUrgency.length,
        items: itemsWithUrgency.slice(0, 5), // Send top 5 most urgent
      });
    }

    res.json(itemsWithUrgency);
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to fetch low stock items:");
    res.status(500).json({ error: "Failed to fetch low stock items" });
  }
});

// ==========================================
// GET /api/bar/inventory/combined
// Combined bar inventory across all outlets in the org
// ==========================================
router.get("/combined", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const ctx = await resolveTenantContext(restaurantId);
    const allOutletIds = ctx.allIds;

    const items = await basePrisma.inventoryItem.findMany({
      where: { restaurantId: { in: allOutletIds } },
      include: { menuItem: { include: { category: true } } },
      orderBy: [
        { menuItem: { category: { name: "asc" } } },
        { menuItem: { name: "asc" } },
      ],
    });

    const itemMap = new Map<string, any>();
    for (const item of items) {
      const existing = itemMap.get(item.menuItemId) || {
        menuItemId: item.menuItemId,
        name: item.menuItem?.name,
        totalStock: 0,
        reorderLevel: Number(item.reorderLevel) || 0,
        bottleSize: Number(item.bottleSize) || 750,
        unitOfMeasure: item.unitOfMeasure,
        perOutlet: [] as Array<{ restaurantId: string; currentStock: number; outletName?: string }>,
      };
      existing.totalStock += Number(item.currentStock);
      existing.perOutlet.push({ restaurantId: item.restaurantId, currentStock: Number(item.currentStock) });
      itemMap.set(item.menuItemId, existing);
    }

    // Add displayStock for each combined item
    const result = Array.from(itemMap.values()).map((entry: any) => ({
      ...entry,
      displayStock: formatBottlesPlusMl(entry.totalStock, entry.bottleSize),
    }));

    res.json(result);
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Combined fetch failed:");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /api/bar/inventory/top-selling
// Top 3 selling menu items (LIQUOR only)
// ==========================================
router.get("/top-selling", async (req: any, res) => {
  try {
    const restaurantId = req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const today = getKolkataDateString();
    const startDate = (req.query.startDate as string) || today;
    const endDate = (req.query.endDate as string) || today;

    const startIST = istDateToUTCStart(startDate);
    const endIST = istDateToUTCEnd(endDate);

    const grouped = await prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        menuType: "LIQUOR",
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
    logger.error({ err: error }, "[BarInventory] Top selling fetch failed:");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /api/bar/inventory/deduction-check
// Deduction diagnostic endpoint
// ==========================================
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

    const liquorItems = order.items.filter((i) => i.menuItem.menuType === "LIQUOR");
    const liquorMenuItemIds = liquorItems.map((i) => i.menuItemId);

    // Fetch ALL inventory items for this restaurant and match by name
    // (bar inventory items are linked to hidden menu items, not the visible ordered ones)
    const allInventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId },
      include: { menuItem: { include: { variants: true } } },
    });
    const inventoryByName = new Map<string, any>();
    for (const inv of allInventoryItems) {
      const name = (inv.menuItem?.name || '').toLowerCase().trim();
      if (name) inventoryByName.set(name, inv);
    }

    const DUAL_VARIANT_BASE_NAMES = ['mansion house xo', 'black dog reserve'];

    function findInventoryByOrderedName(orderedName: string): any[] {
      const normalized = orderedName.toLowerCase().trim();
      const direct = inventoryByName.get(normalized);
      if (direct) return [direct];

      for (const baseName of DUAL_VARIANT_BASE_NAMES) {
        if (normalized === baseName || normalized.startsWith(baseName)) {
          const inv750 = inventoryByName.get(`${baseName} 750ml`);
          const inv180 = inventoryByName.get(`${baseName} 180ml`);
          const results = [inv750, inv180].filter(Boolean);
          if (results.length > 0) return results;
        }
      }

      const stripped = normalized.replace(/\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i, '').trim();
      if (stripped !== normalized) {
        const partialMatch = inventoryByName.get(stripped);
        if (partialMatch) return [partialMatch];
      }

      return [];
    }

    const invItemIds = allInventoryItems.map((i: any) => i.id);

    // Fetch InventoryTransaction rows for this order
    const transactions = await prisma.inventoryTransaction.findMany({
      where: { itemId: { in: invItemIds }, orderId, type: "SALE" },
    });
    const txByInvId = new Map(transactions.map((t: any) => [t.itemId, t]));

    const liquorItemBreakdown = liquorItems.map((item) => {
      const matchedInvItems = findInventoryByOrderedName(item.menuItem.name);
      const hasInventoryLink = matchedInvItems.length > 0;

      // For dual-variant items, show breakdown of both deductions
      const deductionDetails = matchedInvItems.map((invItem: any) => {
        const tx = txByInvId.get(invItem.id);
        return {
          inventoryItemId: invItem.id,
          inventoryName: invItem.menuItem?.name,
          bottleSize: invItem.bottleSize,
          deductedQty: tx ? Number(tx.quantityChange) : null,
          stockBefore: tx ? Number(tx.stockBefore) : null,
          stockAfter: tx ? Number(tx.stockAfter) : null,
        };
      });

      const totalDeducted = deductionDetails.reduce((sum: number, d: any) => sum + (d.deductedQty ? Math.abs(d.deductedQty) : 0), 0);

      return {
        menuItemId: item.menuItemId,
        name: item.menuItem.name,
        orderedQty: item.quantity,
        hasInventoryLink,
        matchedByName: hasInventoryLink,
        deductedQty: totalDeducted > 0 ? -totalDeducted : null,
        deductionDetails,
      };
    });

    const missingLinks = liquorItemBreakdown
      .filter((i) => !i.hasInventoryLink)
      .map((i) => i.name);

    const deductionSummary = {
      totalLiquorItems: liquorItems.length,
      itemsWithNoLink: liquorItemBreakdown.filter((i) => !i.hasInventoryLink).length,
      itemsWithNoTransaction: liquorItemBreakdown.filter((i) => i.hasInventoryLink && i.deductedQty === null).length,
    };

    res.json({
      orderId: order.id,
      status: order.status,
      summary: deductionSummary,
      missingInventoryLinks: missingLinks,
      liquorItems: liquorItemBreakdown,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Deduction check failed:");
    res.status(500).json({ error: error.message });
  }
});

export default router;
