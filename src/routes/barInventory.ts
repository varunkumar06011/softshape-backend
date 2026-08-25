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
//   POST   /api/bar/inventory/retry-deduction/:orderId — retry failed bar stock deductions
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import { Prisma } from "@prisma/client";
import { getIo } from "../socket";
import { isBeerItem } from "../utils/itemHelpers";
import prisma, { basePrisma } from "../lib/prisma";
import { resolveTenantContext } from "../lib/tenantContext";
import { authenticate, requireRole } from "../middleware/auth";
import { getKolkataDateString } from "../utils/date";
import { autoUpdateVariantPrices } from "../utils/autoPricing";
import { BAR_UNIT_ML } from "../utils/barConstants";
import {
  buildInventoryByName,
  buildDualVariantMap,
  findInventoryForOrderedItem,
  computeMlPerUnit,
} from "../utils/barMatching";

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

// Helper: determine the representative sale price for a bar inventory item.
// Spirits use the 30ml (peg) price; beer uses the bottle price; otherwise basePrice.
function getBarUnitPrice(menuItem: any, isBeer: boolean, isSpirit: boolean): number {
  if (!menuItem) return 0;
  const variants = menuItem.variants || [];
  if (isSpirit) {
    const variant =
      variants.find((v: any) => v.name.trim().toLowerCase() === "30ml") ||
      variants.find((v: any) => v.name.trim().toLowerCase() === "60ml") ||
      variants.find((v: any) => v.name.trim().toLowerCase() === "90ml");
    if (variant) return Number(variant.price);
  }
  if (isBeer) {
    const variant =
      variants.find((v: any) => v.name.trim().toLowerCase() === "bottle") ||
      variants.find((v: any) => v.name.trim().toLowerCase() === "650ml");
    if (variant) return Number(variant.price);
  }
  return Number(menuItem.basePrice || 0);
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
const DUAL_VARIANT_ITEMS = ['mansion house', 'black dog'];

// Parse a menu/inventory item name into a base brand name and volume suffix.
function parseVolumeSuffix(name: string): { base: string; suffix: string | null } {
  const match = name.match(/^(.+?)\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i);
  if (match) {
    return { base: match[1].trim(), suffix: match[2].toLowerCase() };
  }
  return { base: name.trim(), suffix: null };
}

function isPegSuffix(suffix: string | null): boolean {
  return suffix === '30ml' || suffix === '60ml' || suffix === '90ml';
}

function computeInventoryDisplayName(
  name: string,
  baseMap: Map<string, number[]>
): string {
  const { base, suffix } = parseVolumeSuffix(name);
  if (!suffix) return name;
  // Peg sizes (30/60/90ml) are always displayed without suffix in inventory
  if (isPegSuffix(suffix)) return base;
  // Bottle sizes (180/375/750ml) keep suffix only if the base has multiple bottle-size variants
  const bottleSizes = baseMap.get(base.toLowerCase()) || [];
  const uniqueSizes = new Set(bottleSizes);
  return uniqueSizes.size > 1 ? name : base;
}


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
      where: { restaurantId: resolveBarId(req), isActive: true },
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

    // Build base-name -> bottleSize map for display-name suffix handling
    const baseMap = new Map<string, number[]>();
    for (const inv of items) {
      if (!inv.menuItem) continue;
      const { base } = parseVolumeSuffix(inv.menuItem.name);
      const key = base.toLowerCase();
      const arr = baseMap.get(key) || [];
      arr.push(Number(inv.bottleSize) || 0);
      baseMap.set(key, arr);
    }

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

      const displayName = item.menuItem
        ? computeInventoryDisplayName(item.menuItem.name, baseMap)
        : '';

      // Remove dailySnapshots from payload to keep it clean, but attach todayEntry
      const { dailySnapshots, ...rest } = item;
      return {
        ...rest,
        todayEntry,
        displayStock,
        displayName,
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

    // Create today's daily snapshot so the item shows its opening stock properly
    // instead of appearing as "carried over" from the previous day.
    const today = getKolkataDateString();
    await prisma.dailyInventorySnapshot.create({
      data: {
        restaurantId: resolveBarId(req),
        itemId: item.id,
        snapshotDate: today,
        itemName: menuItem.name,
        openingStock: new Prisma.Decimal(0),
        purchased: 0,
        sold: 0,
        wastage: 0,
        adjusted: openingStock,
        closingStock: openingStock,
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

    // Validate all stock-related inputs for negative values and NaN before
    // computing derived values. Without this, a negative openingStock or
    // consumed could produce a negative closingStock silently.
    if (openingStock !== undefined) {
      const v = Number(openingStock);
      if (Number.isNaN(v) || v < 0) {
        res.status(400).json({ error: "openingStock must be a non-negative number" });
        return;
      }
    }
    if (openingStockBottles !== undefined) {
      const v = Number(openingStockBottles);
      if (Number.isNaN(v) || v < 0) {
        res.status(400).json({ error: "openingStockBottles must be a non-negative number" });
        return;
      }
    }
    if (purchased !== undefined) {
      const v = Number(purchased);
      if (Number.isNaN(v) || v < 0) {
        res.status(400).json({ error: "purchased must be a non-negative number" });
        return;
      }
    }
    if (purchaseBottles !== undefined) {
      const v = Number(purchaseBottles);
      if (Number.isNaN(v) || v < 0) {
        res.status(400).json({ error: "purchaseBottles must be a non-negative number" });
        return;
      }
    }
    if (consumed !== undefined) {
      const v = Number(consumed);
      if (Number.isNaN(v) || v < 0) {
        res.status(400).json({ error: "consumed must be a non-negative number" });
        return;
      }
    }

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

      // Prevent negative closing stock — would corrupt inventory and allow
      // selling more than available. Reject the request instead.
      if (newClosing < 0) {
        res.status(400).json({
          error: `Resulting closing stock would be negative (${newClosing}ml). Check opening + purchased vs consumed values.`,
          openingStock: newOpening,
          purchased: newPurchased,
          consumed: newConsumed,
          closingStock: newClosing,
        });
        return;
      }

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
// Delete inventory item (archive — never hard-delete to preserve audit history)
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

    // Archive instead of hard-delete: preserve all transactions, snapshots,
    // deduction logs, and mappings for audit. Set isActive=false + archivedAt.
    await prisma.inventoryItem.update({
      where: { id },
      data: {
        isActive: false,
        archivedAt: new Date(),
      },
    });

    emitToBar("inventory:deleted", resolveBarId(req), { itemId: id });

    res.json({ ok: true, id, archived: true });
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to archive item:");
    res.status(500).json({ error: "Failed to archive inventory item" });
  }
});

// ==========================================
// POST /api/bar/inventory/adjust-stock
// Manual stock adjustment
// ==========================================
router.post("/adjust-stock", async (req: any, res) => {
  // Declare outside try so the catch handler can access them for idempotency
  // duplicate re-read after transaction rollback.
  const barId = resolveBarId(req);
  const requestId = req.body?.requestId as string | undefined;
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
      requestId?: string;
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

    // Idempotency check: if requestId is provided, check ProcessedRequest
    // to prevent duplicate stock changes from double-clicks or network retries.
    if (requestId) {
      const existing = await prisma.processedRequest.findUnique({
        where: {
          requestId_actionType_restaurantId: {
            requestId,
            actionType: "bar-adjust",
            restaurantId: barId,
          },
        },
        select: { result: true },
      });
      if (existing?.result) {
        // Return the cached result from the first successful call
        res.status(200).json(existing.result);
        return;
      }
    }

    // Pre-check item exists (for 404 response before entering transaction)
    const exists = await prisma.inventoryItem.findFirst({
      where: { id: itemId, restaurantId: barId },
      select: { id: true },
    });

    if (!exists) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Validate quantityChange is a finite number (not NaN/Infinity)
    const changeNum = Number(quantityChange);
    if (Number.isNaN(changeNum) || !Number.isFinite(changeNum)) {
      res.status(400).json({ error: "quantityChange must be a valid number" });
      return;
    }

    const change = new Prisma.Decimal(changeNum);

    // Use transaction with row-level locking to ensure atomicity
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the row for update to prevent concurrent modifications.
        // Tenant-scoped (High #5): include restaurantId in the lock query to
        // prevent TOCTOU cross-tenant access via ID enumeration.
        const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; reorderLevel: Prisma.Decimal; bottleSize: number; menuItemId: string }>>`
          SELECT "id", "currentStock", "reorderLevel", "bottleSize", "menuItemId"
          FROM "inventory_items"
          WHERE "id" = ${itemId} AND "restaurantId" = ${barId}
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

        // Update inventory item — tenant-scoped (High #5): use updateMany with
        // restaurantId filter to enforce ownership inside the transaction, then
        // re-fetch with relations to preserve the response shape.
        const updateResult = await tx.inventoryItem.updateMany({
          where: { id: itemId, restaurantId: barId },
          data: {
            currentStock: stockAfter,
            updatedAt: new Date(),
          },
        });
        if (updateResult.count === 0) {
          throw Object.assign(new Error("Inventory item not found in this tenant"), { statusCode: 404 });
        }
        const updatedItem = await tx.inventoryItem.findFirst({
          where: { id: itemId, restaurantId: barId },
          include: inventoryInclude,
        });
        if (!updatedItem) {
          throw Object.assign(new Error("Inventory item not found after update"), { statusCode: 404 });
        }

        // Create transaction record
        const transaction = await tx.inventoryTransaction.create({
          data: {
            restaurantId: barId,
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
              restaurantId: barId,
              snapshotDate,
              itemId,
            },
          },
          create: {
            restaurantId: barId,
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

        // Write idempotency marker inside the transaction so it only persists on success.
        // If a concurrent request with the same requestId already wrote the marker,
        // P2002 is thrown. We MUST throw (not return) so the transaction rolls back
        // — otherwise our updateMany already modified stock and would double-count.
        // The outer catch handler re-reads the cached result and returns it.
        const txResult = { item: updatedItem, transaction };
        if (requestId) {
          try {
            await tx.processedRequest.create({
              data: {
                requestId,
                actionType: "bar-adjust",
                restaurantId: barId,
                result: txResult as any,
              },
            });
          } catch (err: any) {
            if (err?.code === 'P2002') {
              // Mark for outer catch to handle — must throw to rollback this tx
              throw Object.assign(new Error("IDEMPOTENCY_DUPLICATE"), { isIdempotencyDuplicate: true });
            }
            throw err;
          }
        }

        return txResult;
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // Emit socket event
    emitToBar("inventory:updated", barId, { item: result.item });

    // Check if stock is low
    if (result.item.currentStock.lessThanOrEqualTo(result.item.reorderLevel)) {
      emitToBar("inventory:low_stock", barId, {
        item: result.item,
        currentStock: result.item.currentStock.toString(),
        reorderLevel: result.item.reorderLevel.toString(),
      });
    }

    res.json(result);
  } catch (error: any) {
    // Handle idempotency duplicate: the transaction was rolled back, re-read
    // the cached result from the winner and return it as 200.
    if (error?.isIdempotencyDuplicate && requestId) {
      const cached = await prisma.processedRequest.findUnique({
        where: {
          requestId_actionType_restaurantId: {
            requestId,
            actionType: "bar-adjust",
            restaurantId: barId,
          },
        },
        select: { result: true },
      });
      if (cached?.result) {
        res.status(200).json(cached.result);
        return;
      }
    }
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
  // Declare outside try so the catch handler can access them for idempotency
  // duplicate re-read after transaction rollback.
  const barId = resolveBarId(req);
  const requestId = req.body?.requestId as string | undefined;
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
      requestId?: string;
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

    // Idempotency check: if requestId is provided, check ProcessedRequest
    // to prevent duplicate stock changes from double-clicks or network retries.
    if (requestId) {
      const existing = await prisma.processedRequest.findUnique({
        where: {
          requestId_actionType_restaurantId: {
            requestId,
            actionType: "bar-purchase",
            restaurantId: barId,
          },
        },
        select: { result: true },
      });
      if (existing?.result) {
        // Return the cached result from the first successful call
        res.status(200).json(existing.result);
        return;
      }
    }

    // Pre-check item exists (for 404 response before entering transaction)
    const exists = await prisma.inventoryItem.findFirst({
      where: { id: itemId, restaurantId: barId },
      select: { id: true, bottleSize: true },
    });

    if (!exists) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Convert purchaseBottles to ml if provided, otherwise use quantity directly.
    // Validate individual inputs for negative values and NaN before combining.
    // Without this, a negative purchaseBottles could bypass the effectiveQty > 0
    // check and corrupt stock.
    if (quantity !== undefined) {
      const q = Number(quantity);
      if (Number.isNaN(q) || q < 0) {
        res.status(400).json({ error: "quantity must be a non-negative number" });
        return;
      }
    }
    if (purchaseBottles !== undefined) {
      const pb = Number(purchaseBottles);
      if (Number.isNaN(pb) || pb < 0) {
        res.status(400).json({ error: "purchaseBottles must be a non-negative number" });
        return;
      }
    }
    if (costPerBottle !== undefined) {
      const cpc = Number(costPerBottle);
      if (Number.isNaN(cpc) || cpc < 0) {
        res.status(400).json({ error: "costPerBottle must be a non-negative number" });
        return;
      }
    }

    const effectiveQty = purchaseBottles !== undefined
      ? Number(purchaseBottles) * (exists.bottleSize || 750)
      : Number(quantity);

    if (Number.isNaN(effectiveQty) || effectiveQty <= 0) {
      res.status(400).json({
        error: "Purchase quantity must be greater than 0",
      });
      return;
    }

    const purchaseQty = new Prisma.Decimal(effectiveQty);

    // Use transaction with row-level locking to ensure atomicity
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the row for update — tenant-scoped (High #5)
        const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; bottleSize: number; menuItemId: string }>>`
          SELECT "id", "currentStock", "bottleSize", "menuItemId"
          FROM "inventory_items"
          WHERE "id" = ${itemId} AND "restaurantId" = ${barId}
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

        // Update inventory item — tenant-scoped (High #5): use updateMany with
        // restaurantId filter, then re-fetch with relations for the response.
        const updateResult = await tx.inventoryItem.updateMany({
          where: { id: itemId, restaurantId: barId },
          data: updateData,
        });
        if (updateResult.count === 0) {
          throw Object.assign(new Error("Inventory item not found in this tenant"), { statusCode: 404 });
        }
        const updatedItem = await tx.inventoryItem.findFirst({
          where: { id: itemId, restaurantId: barId },
          include: inventoryInclude,
        });
        if (!updatedItem) {
          throw Object.assign(new Error("Inventory item not found after update"), { statusCode: 404 });
        }

        // AUTO-UPDATE MENU ITEM VARIANT PRICES when cost changes
        if (costPerBottle !== undefined && updatedItem.menuItem) {
          await autoUpdateVariantPrices(tx, updatedItem.menuItemId, Number(updatedItem.bottleSize), Number(costPerBottle), skipPriceUpdate);
        }

        // Create transaction record
        const transaction = await tx.inventoryTransaction.create({
          data: {
            restaurantId: barId,
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
              restaurantId: barId,
              snapshotDate,
              itemId,
            },
          },
          create: {
            restaurantId: barId,
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

        // Write idempotency marker inside the transaction so it only persists on success.
        // P2002 means a concurrent request won — throw to rollback this tx (which
        // already modified stock via updateMany) and let the outer catch return
        // the cached result. Without the throw, the transaction would commit and
        // double-count the stock.
        const txResult = { item: updatedItem, transaction };
        if (requestId) {
          try {
            await tx.processedRequest.create({
              data: {
                requestId,
                actionType: "bar-purchase",
                restaurantId: barId,
                result: txResult as any,
              },
            });
          } catch (err: any) {
            if (err?.code === 'P2002') {
              throw Object.assign(new Error("IDEMPOTENCY_DUPLICATE"), { isIdempotencyDuplicate: true });
            }
            throw err;
          }
        }

        return txResult;
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // Emit socket event
    emitToBar("inventory:updated", barId, { item: result.item });

    res.json(result);
  } catch (error: any) {
    // Handle idempotency duplicate: transaction rolled back, re-read cached result
    if (error?.isIdempotencyDuplicate && requestId) {
      const cached = await prisma.processedRequest.findUnique({
        where: {
          requestId_actionType_restaurantId: {
            requestId,
            actionType: "bar-purchase",
            restaurantId: barId,
          },
        },
        select: { result: true },
      });
      if (cached?.result) {
        res.status(200).json(cached.result);
        return;
      }
    }
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

    // Get all inventory items (exclude archived)
    const items = await prisma.inventoryItem.findMany({
      where: { restaurantId: resolveBarId(req), isActive: true },
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
        isActive: true,
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
// GET /api/bar/inventory/range-summary
// Range summary for bar inventory items
// ==========================================

router.get("/range-summary", async (req: any, res) => {
  try {
    const barRestaurantId = resolveBarId(req);
    if (!barRestaurantId) {
      return res.status(400).json({ error: "restaurantId required" });
    }

    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const itemId = req.query.itemId as string | undefined;
    const search = req.query.search as string | undefined;
    const detailed = req.query.detailed === "true";

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }
    if (endDate < startDate) {
      return res.status(400).json({ error: "endDate must be on or after startDate" });
    }

    // Lightweight item list for the search dropdown (only when no itemId/search/detailed flag).
    if (!itemId && !search && !detailed) {
      const items = await prisma.inventoryItem.findMany({
        where: { restaurantId: barRestaurantId },
        orderBy: { menuItem: { name: "asc" } },
        select: { id: true, menuItem: { select: { name: true } } },
      });
      return res.json(
        items.map((i) => ({ id: i.id, name: i.menuItem?.name || "Unknown" }))
      );
    }

    const itemWhere: any = { restaurantId: barRestaurantId };
    if (itemId) {
      itemWhere.id = itemId;
    } else if (search) {
      itemWhere.menuItem = { name: { contains: search, mode: "insensitive" } };
    }

    const items = await prisma.inventoryItem.findMany({
      where: itemWhere,
      include: {
        menuItem: {
          include: { variants: true },
        },
      },
      orderBy: { menuItem: { name: "asc" } },
    });

    if (itemId && items.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }

    const startUTC = istDateToUTCStart(startDate);
    const endUTC = istDateToUTCEnd(endDate);

    // Batch fetch all inventory transactions for all items in a single query
    const itemIds = items.map((i) => i.id);
    const allTransactions = await prisma.inventoryTransaction.findMany({
      where: {
        restaurantId: barRestaurantId,
        itemId: { in: itemIds },
        transactionDate: { gte: startUTC, lte: endUTC },
      },
    });

    // Group transactions by itemId in memory
    const txnsByItem = new Map<string, typeof allTransactions>();
    for (const tx of allTransactions) {
      const arr = txnsByItem.get(tx.itemId) || [];
      arr.push(tx);
      txnsByItem.set(tx.itemId, arr);
    }

    const summaries = items.map((item) => {
        const transactions = txnsByItem.get(item.id) || [];

        const totalPurchaseQty = transactions
          .filter((t) => t.type === "PURCHASE")
          .reduce((sum, t) => sum + Number(t.quantityChange), 0);
        const totalSoldQty = transactions
          .filter((t) => t.type === "SALE")
          .reduce((sum, t) => sum + Math.abs(Number(t.quantityChange)), 0);
        const totalWastageQty = transactions
          .filter((t) => t.type === "WASTAGE")
          .reduce((sum, t) => sum + Number(t.quantityChange), 0);

        const bottleSize = item.bottleSize || 750;
        const costPerBottle = Number(item.costPerBottle || 0);
        const purchaseBottles = bottleSize > 0 ? totalPurchaseQty / bottleSize : 0;
        const totalPurchaseAmount = purchaseBottles * costPerBottle;

        const isBeer = isBeerItem(item.menuItem);
        const isSpirit =
          !isBeer &&
          item.menuItem?.variants?.some((v: any) => v.name.trim().toLowerCase() === "30ml");
        const unitMl = isBeer ? 650 : isSpirit ? BAR_UNIT_ML : bottleSize;
        const unitsSold = unitMl > 0 ? totalSoldQty / unitMl : 0;
        const unitPrice = getBarUnitPrice(item.menuItem, isBeer, isSpirit);
        const revenue = unitsSold * unitPrice;

        const net = revenue - totalPurchaseAmount;
        // InventoryTransaction does not currently snapshot cost per purchase,
        // so we fall back to the item's current costPerBottle.
        const avgPrice = costPerBottle;

        return {
          id: item.id,
          itemId: item.id,
          name: item.menuItem?.name || "Unknown",
          unit: item.unitOfMeasure || "ml",
          startDate,
          endDate,
          avgPrice: Math.round(avgPrice * 100) / 100,
          totalPurchaseQty: Math.round(totalPurchaseQty * 100) / 100,
          totalPurchaseAmount: Math.round(totalPurchaseAmount * 100) / 100,
          totalSoldQty: Math.round(totalSoldQty * 100) / 100,
          revenue: Math.round(revenue * 100) / 100,
          totalWastageQty: Math.round(totalWastageQty * 100) / 100,
          net: Math.round(net * 100) / 100,
          status: net >= 0 ? "profit" : "loss",
          purchasePriceBasis: "current" as const,
        };
      });

    res.json(itemId ? summaries[0] : summaries);
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Range summary failed:");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GET /api/bar/inventory/combined
// Combined bar inventory across all outlets in the org
// ==========================================
router.get("/combined", async (req: any, res) => {
  try {
    const restaurantId = resolveBarId(req);
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
    const restaurantId = resolveBarId(req);
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
    const restaurantId = resolveBarId(req);
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

    const liquorItems = order.items.filter((i) => { const mt = i.menuItem.menuType as string; return mt === "LIQUOR" || mt === "BAR"; });
    const liquorMenuItemIds = liquorItems.map((i) => i.menuItemId);

    // Fetch ALL inventory items for this restaurant and match by name
    // (bar inventory items are linked to hidden menu items, not the visible ordered ones)
    const allInventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId },
      include: { menuItem: { include: { variants: true } } },
    });
    const inventoryByName = buildInventoryByName(allInventoryItems);
    const dualVariantMap = buildDualVariantMap(inventoryByName);

    function findInventoryByOrderedName(orderedName: string): any[] {
      const normalized = orderedName.toLowerCase().trim();
      const direct = inventoryByName.get(normalized);
      if (direct) return [direct];

      for (const [baseName, { inv750, inv180 }] of dualVariantMap.entries()) {
        if (normalized === baseName || normalized.startsWith(baseName)) {
          const results = [inv750, inv180].filter(Boolean);
          if (results.length > 0) return results;
        }
      }

      const stripped = normalized.replace(/\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i, '').trim();
      if (stripped !== normalized) {
        const partialMatch = inventoryByName.get(stripped);
        if (partialMatch) return [partialMatch];
      }

      // Fuzzy fallback: prefix match only — prevents wrong matches like "Royal Stag" → "Royal Stag Special"
      for (const [invName, inv] of inventoryByName.entries()) {
        if (invName === normalized) continue;
        if (invName.startsWith(normalized + ' ') || normalized.startsWith(invName + ' ')) {
          return [inv];
        }
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
      barInventoryDeducted: (order as any).barInventoryDeducted ?? true,
      summary: deductionSummary,
      missingInventoryLinks: missingLinks,
      liquorItems: liquorItemBreakdown,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Deduction check failed:");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /api/bar/inventory/retry-deduction/:orderId
// Retries failed bar inventory deductions for an already-paid order.
// Re-attempts stock deduction for liquor items that had no matching inventory
// or failed due to insufficient stock, and updates the order.barInventoryDeducted flag.
// ==========================================
router.post("/retry-deduction/:orderId", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user!.restaurantId;
    const orderId = req.params.orderId as string;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: { include: { variants: true } } },
        },
      },
    });

    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.restaurantId !== restaurantId) return res.status(403).json({ error: "Forbidden" });
    if (order.status !== "PAID") return res.status(400).json({ error: "Order must be paid before retrying deductions" });

    const liquorItems = order.items.filter((i) => {
      const mt = i.menuItem.menuType as string;
      return mt === "LIQUOR" || mt === "BAR";
    });

    if (liquorItems.length === 0) {
      return res.json({ message: "No liquor items in order", retried: 0, succeeded: 0, failed: 0, errors: [] });
    }

    // Fetch all inventory items for this restaurant (matched by name, not menuItemId)
    const allInventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId },
      include: { menuItem: { include: { variants: true } } },
    });

    const inventoryByName = buildInventoryByName(allInventoryItems);
    const dualVariantMap = buildDualVariantMap(inventoryByName);

    const barMappingFallback = process.env.BAR_MAPPING_FALLBACK === "true";

    // Aggregate liquor items by menuItemId + price (same as settleOrderService)
    const aggregatedLiquorItems = new Map<string, { menuItemId: string; menuItemName: string; quantity: number; price: number }>();
    for (const item of liquorItems) {
      const key = `${item.menuItemId}:${Number(item.price)}`;
      const existing = aggregatedLiquorItems.get(key);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        aggregatedLiquorItems.set(key, {
          menuItemId: item.menuItemId,
          menuItemName: item.menuItem.name,
          quantity: item.quantity,
          price: Number(item.price),
        });
      }
    }

    const errors: string[] = [];
    let succeeded = 0;
    let retried = 0;
    const today = getKolkataDateString();

    const result = await prisma.$transaction(async (tx: any) => {
      // Lock inventory rows for this restaurant
      if (allInventoryItems.length > 0) {
        const allInvIds = allInventoryItems.map((i: any) => i.id);
        await tx.$queryRaw`
          SELECT "id" FROM "inventory_items"
          WHERE "id" IN (${Prisma.join(allInvIds)})
          ORDER BY "id" FOR UPDATE
        `;
      }

      // ── Phase 4c: BarDeductionLog-based idempotency (unified with inventoryService.ts) ──
      // Replaces the old InventoryTransaction-based deductedItemIds set so that
      // both retry paths use the same idempotency mechanism.
      const existingBarLogs = await tx.barDeductionLog.findMany({
        where: { orderId, restaurantId },
      });
      const successLogInvIds = new Set(
        existingBarLogs.filter((l: any) => l.status === "SUCCESS").map((l: any) => l.inventoryItemId)
      );
      // Track total quantity already deducted per inventoryItemId
      const successLogQtyByInvId = new Map<string, number>();
      for (const l of existingBarLogs as any[]) {
        if (l.status === "SUCCESS") {
          successLogQtyByInvId.set(l.inventoryItemId, (successLogQtyByInvId.get(l.inventoryItemId) || 0) + Number(l.quantity || 0));
        }
      }

      // ── Phase 4b: Mapping lookup (same as 4a) ──────────────────────────────
      let mappingByKey = new Map<string, any>();
      try {
        const mappings = await tx.barItemMapping.findMany({
          where: {
            restaurantId,
            OR: liquorItems.map((i: any) => ({ menuItemId: i.menuItemId, variantPrice: i.price })),
          },
        });
        mappingByKey = new Map<string, any>(
          mappings.map((m: any) => [`${m.menuItemId}:${Number(m.variantPrice)}`, m] as [string, any])
        );
      } catch (mapErr: any) {
        console.warn(`[Bar Retry] BarItemMapping lookup failed (${mapErr.message}). Using fallback matcher.`);
      }

      for (const [, { menuItemId, menuItemName, quantity: totalQuantity, price: itemPrice }] of aggregatedLiquorItems.entries()) {
        // ── Resolve inventory via mapping table (Phase 4b) ──────────────────
        const mapping = mappingByKey.get(`${menuItemId}:${itemPrice}`);
        let primaryInv: any = null;
        let secondaryInv: any = null;

        if (mapping) {
          primaryInv = allInventoryItems.find((i: any) => i.id === mapping.primaryInvId) ?? null;
          secondaryInv = mapping.secondaryInvId
            ? allInventoryItems.find((i: any) => i.id === mapping.secondaryInvId) ?? null
            : null;
        } else if (barMappingFallback) {
          const matched = findInventoryForOrderedItem(menuItemName, inventoryByName, dualVariantMap, '[Bar Retry]', (m) => console.warn(m));
          primaryInv = matched.primary;
          secondaryInv = matched.secondary;
        }

        if (!primaryInv) {
          errors.push(`NO_MAPPING: ${menuItemName} @ ₹${itemPrice}`);
          // Emit bar:unmapped-item socket event for live dashboard surfacing
          try {
            const io = getIo();
            if (io) io.to(restaurantId).emit('bar:unmapped-item', { menuItemName, menuItemId, price: itemPrice, restaurantId });
          } catch { /* non-fatal */ }
          continue;
        }

        // Compute mlPerUnit before idempotency check
        let mlPerUnit: number;
        let variantLabel: string;
        if (mapping) {
          mlPerUnit = Number(mapping.mlPerUnit);
          variantLabel = `${mlPerUnit}ml`;
        } else {
          const computed = computeMlPerUnit(primaryInv, itemPrice, menuItemName, '[Bar Retry]', (m) => console.warn(m));
          mlPerUnit = computed.mlPerUnit;
          variantLabel = computed.variantLabel;
        }
        const totalMl = mlPerUnit * totalQuantity;

        // ── Phase 4c: Per-item idempotency via BarDeductionLog (matches 4a) ──
        const primaryAlreadyDone = successLogInvIds.has(primaryInv.id);
        const secondaryAlreadyDone = secondaryInv ? successLogInvIds.has(secondaryInv.id) : true;
        const alreadyDeductedQty =
          (successLogQtyByInvId.get(primaryInv.id) || 0) +
          (secondaryInv ? (successLogQtyByInvId.get(secondaryInv.id) || 0) : 0);
        if (primaryAlreadyDone && secondaryAlreadyDone) {
          continue;
        }
        // If the total already deducted equals or exceeds the expected total, skip
        if (alreadyDeductedQty >= totalMl) {
          continue;
        }

        retried++;

        try {
          const isDualVariant = secondaryInv !== null;

          if (isDualVariant) {
            const stock750 = Number(primaryInv.currentStock);
            let deductFrom750: number;
            let deductFrom180: number;

            if (stock750 >= totalMl) {
              deductFrom750 = totalMl;
              deductFrom180 = 0;
            } else if (stock750 > 0) {
              deductFrom750 = stock750;
              deductFrom180 = totalMl - stock750;
            } else {
              deductFrom750 = 0;
              deductFrom180 = totalMl;
            }

            // ── Phase 4c: Idempotency overrides (ported from inventoryService.ts) ──
            // If one variant was already deducted, only deduct the remaining amount from the other
            const remainingMl = totalMl - alreadyDeductedQty;
            if (primaryAlreadyDone) {
              deductFrom750 = 0;
              deductFrom180 = remainingMl;
            }
            if (secondaryAlreadyDone) {
              deductFrom180 = 0;
              if (!primaryAlreadyDone) {
                deductFrom750 = remainingMl;
              }
            }

            const totalAvailable = stock750 + Number(secondaryInv.currentStock);
            if (totalAvailable < totalMl) {
              throw new Error(
                `Insufficient stock for ${menuItemName}: available ${totalAvailable}ml (750ml: ${stock750}ml, 180ml: ${secondaryInv.currentStock}ml), required ${totalMl}ml`
              );
            }

            if (deductFrom750 > 0 && !primaryAlreadyDone) {
              const updated750 = await tx.inventoryItem.update({
                where: { id: primaryInv.id },
                data: { currentStock: { decrement: deductFrom750 } },
              });

              await tx.inventoryTransaction.create({
                data: {
                  restaurantId,
                  itemId: primaryInv.id,
                  orderId,
                  type: "SALE",
                  quantityChange: -deductFrom750,
                  stockBefore: new Prisma.Decimal(Number(updated750.currentStock) + deductFrom750),
                  stockAfter: updated750.currentStock,
                  notes: `Retry: Order #${orderId} - ${totalQuantity}x ${variantLabel} (750ml stock)`,
                  transactionDate: new Date(),
                  createdBy: req.user?.userId || null,
                },
              });

              await tx.dailyInventorySnapshot.upsert({
                where: {
                  restaurantId_snapshotDate_itemId: {
                    restaurantId, snapshotDate: today, itemId: primaryInv.id,
                  },
                },
                create: {
                  restaurantId,
                  itemId: primaryInv.id,
                  snapshotDate: today,
                  itemName: primaryInv.menuItem.name,
                  purchased: 0,
                  sold: deductFrom750,
                  wastage: 0,
                  adjusted: 0,
                  openingStock: primaryInv.currentStock,
                  closingStock: updated750.currentStock,
                },
                update: {
                  sold: { increment: deductFrom750 },
                  closingStock: updated750.currentStock,
                },
              });

              // ── Phase 4c: BarDeductionLog SUCCESS write (ported from inventoryService.ts:372-383) ──
              await tx.barDeductionLog.upsert({
                where: { orderId_inventoryItemId: { orderId, inventoryItemId: primaryInv.id } },
                create: {
                  orderId,
                  restaurantId,
                  inventoryItemId: primaryInv.id,
                  menuItemId,
                  quantity: new Prisma.Decimal(deductFrom750),
                  status: "SUCCESS",
                },
                update: { status: "SUCCESS", quantity: new Prisma.Decimal(deductFrom750) },
              });

              succeeded++;
            }

            if (deductFrom180 > 0 && !secondaryAlreadyDone) {
              const updated180 = await tx.inventoryItem.update({
                where: { id: secondaryInv.id },
                data: { currentStock: { decrement: deductFrom180 } },
              });

              await tx.inventoryTransaction.create({
                data: {
                  restaurantId,
                  itemId: secondaryInv.id,
                  orderId,
                  type: "SALE",
                  quantityChange: -deductFrom180,
                  stockBefore: new Prisma.Decimal(Number(updated180.currentStock) + deductFrom180),
                  stockAfter: updated180.currentStock,
                  notes: `Retry: Order #${orderId} - ${totalQuantity}x ${variantLabel} (180ml stock)`,
                  transactionDate: new Date(),
                  createdBy: req.user?.userId || null,
                },
              });

              await tx.dailyInventorySnapshot.upsert({
                where: {
                  restaurantId_snapshotDate_itemId: {
                    restaurantId, snapshotDate: today, itemId: secondaryInv.id,
                  },
                },
                create: {
                  restaurantId,
                  itemId: secondaryInv.id,
                  snapshotDate: today,
                  itemName: secondaryInv.menuItem.name,
                  purchased: 0,
                  sold: deductFrom180,
                  wastage: 0,
                  adjusted: 0,
                  openingStock: secondaryInv.currentStock,
                  closingStock: updated180.currentStock,
                },
                update: {
                  sold: { increment: deductFrom180 },
                  closingStock: updated180.currentStock,
                },
              });

              // ── Phase 4c: BarDeductionLog SUCCESS write (ported from inventoryService.ts:442-453) ──
              await tx.barDeductionLog.upsert({
                where: { orderId_inventoryItemId: { orderId, inventoryItemId: secondaryInv.id } },
                create: {
                  orderId,
                  restaurantId,
                  inventoryItemId: secondaryInv.id,
                  menuItemId,
                  quantity: new Prisma.Decimal(deductFrom180),
                  status: "SUCCESS",
                },
                update: { status: "SUCCESS", quantity: new Prisma.Decimal(deductFrom180) },
              });

              succeeded++;
            }
          } else {
            // Single inventory item deduction
            if (!primaryAlreadyDone) {
              if (Number(primaryInv.currentStock) < totalMl) {
                throw new Error(
                  `Insufficient stock for ${primaryInv.menuItem?.name ?? "Unknown Item"}: available ${primaryInv.currentStock}ml, required ${totalMl}ml`
                );
              }

              const updatedItem = await tx.inventoryItem.update({
                where: { id: primaryInv.id },
                data: { currentStock: { decrement: totalMl } },
              });

              await tx.inventoryTransaction.create({
                data: {
                  restaurantId,
                  itemId: primaryInv.id,
                  orderId,
                  type: "SALE",
                  quantityChange: -totalMl,
                  stockBefore: new Prisma.Decimal(Number(updatedItem.currentStock) + totalMl),
                  stockAfter: updatedItem.currentStock,
                  notes: `Retry: Order #${orderId} - ${totalQuantity}x ${variantLabel}`,
                  transactionDate: new Date(),
                  createdBy: req.user?.userId || null,
                },
              });

              await tx.dailyInventorySnapshot.upsert({
                where: {
                  restaurantId_snapshotDate_itemId: {
                    restaurantId, snapshotDate: today, itemId: primaryInv.id,
                  },
                },
                create: {
                  restaurantId,
                  itemId: primaryInv.id,
                  snapshotDate: today,
                  itemName: primaryInv.menuItem.name,
                  purchased: 0,
                  sold: totalMl,
                  wastage: 0,
                  adjusted: 0,
                  openingStock: primaryInv.currentStock,
                  closingStock: updatedItem.currentStock,
                },
                update: {
                  sold: { increment: totalMl },
                  closingStock: updatedItem.currentStock,
                },
              });

              // ── Phase 4c: BarDeductionLog SUCCESS write ──
              await tx.barDeductionLog.upsert({
                where: { orderId_inventoryItemId: { orderId, inventoryItemId: primaryInv.id } },
                create: {
                  orderId,
                  restaurantId,
                  inventoryItemId: primaryInv.id,
                  menuItemId,
                  quantity: new Prisma.Decimal(totalMl),
                  status: "SUCCESS",
                },
                update: { status: "SUCCESS", quantity: new Prisma.Decimal(totalMl) },
              });

              succeeded++;
            }
          }
        } catch (err: any) {
          const errMsg = `Bar item "${menuItemName}": ${err.message}`;
          console.error(`[Bar Retry] Deduction failed: ${errMsg}`);
          errors.push(errMsg);

          // ── Phase 4c: BarDeductionLog FAILED writes (ported from inventoryService.ts:540-573) ──
          // Best-effort: a failure to log a failure must not abort the retry itself.
          if (primaryInv && !successLogInvIds.has(primaryInv.id)) {
            await tx.barDeductionLog.upsert({
              where: { orderId_inventoryItemId: { orderId, inventoryItemId: primaryInv.id } },
              create: {
                orderId,
                restaurantId,
                inventoryItemId: primaryInv.id,
                menuItemId,
                quantity: new Prisma.Decimal(0),
                status: "FAILED",
                error: errMsg,
              },
              update: { status: "FAILED", error: errMsg },
            }).catch(() => {});
          }
          if (secondaryInv && !successLogInvIds.has(secondaryInv.id)) {
            await tx.barDeductionLog.upsert({
              where: { orderId_inventoryItemId: { orderId, inventoryItemId: secondaryInv.id } },
              create: {
                orderId,
                restaurantId,
                inventoryItemId: secondaryInv.id,
                menuItemId,
                quantity: new Prisma.Decimal(0),
                status: "FAILED",
                error: errMsg,
              },
              update: { status: "FAILED", error: errMsg },
            }).catch(() => {});
          }
        }
      }

      // Update order flag: barInventoryDeducted is true only if no errors remain
      await tx.order.update({
        where: { id: orderId },
        data: { barInventoryDeducted: errors.length === 0 },
      });

      return { retried, succeeded, failed: errors.length, errors };
    }, { timeout: 15000, maxWait: 20000 });

    // Emit inventory updates via socket
    const io = getIo();
    if (io) {
      io.to(restaurantId).emit("inventory:refresh", { restaurantId });
    }

    res.json({
      message: result.failed === 0
        ? `All ${result.succeeded} bar item(s) deducted successfully`
        : `${result.succeeded} succeeded, ${result.failed} still failing`,
      retried: result.retried,
      succeeded: result.succeeded,
      failed: result.failed,
      errors: result.errors,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Retry deduction failed:");
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bar Item Mapping Routes — Admin-editable mapping from (menuItemId, price)
// to inventory items, replacing runtime name-guessing.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/bar/inventory/mappings — list all mappings for the restaurant
router.get("/mappings", async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user!.restaurantId;

    const mappings = await prisma.barItemMapping.findMany({
      where: { restaurantId },
      include: {
        menuItem: { select: { id: true, name: true, menuType: true } },
        primaryInv: { select: { id: true, menuItem: { select: { name: true } } } },
        secondaryInv: { select: { id: true, menuItem: { select: { name: true } } } },
      },
      orderBy: { menuItem: { name: 'asc' } },
    });

    res.json(mappings.map(m => ({
      id: m.id,
      menuItemId: m.menuItemId,
      menuItemName: m.menuItem?.name ?? null,
      variantPrice: Number(m.variantPrice),
      primaryInvId: m.primaryInvId,
      primaryInvName: m.primaryInv?.menuItem?.name ?? null,
      secondaryInvId: m.secondaryInvId,
      secondaryInvName: m.secondaryInv?.menuItem?.name ?? null,
      mlPerUnit: Number(m.mlPerUnit),
      source: m.source,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })));
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] List mappings failed:");
    res.status(500).json({ error: error.message });
  }
});

// GET /api/bar/inventory/mappings/unmapped — distinct (menuItemId, price) pairs
// from recent liquor order items with no mapping row.
router.get("/mappings/unmapped", async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user!.restaurantId;

    // Recent liquor order items (last 30 days), excluding cancelled/zero-qty
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentOrderItems = await prisma.orderItem.findMany({
      where: {
        menuType: 'LIQUOR',
        removedFromBill: false,
        quantity: { gt: 0 },
        order: {
          restaurantId,
          createdAt: { gte: thirtyDaysAgo },
        },
      },
      select: { menuItemId: true, price: true, name: true },
    });

    // Distinct (menuItemId, price) pairs
    const seenPairs = new Map<string, { menuItemId: string; menuItemName: string; price: number }>();
    for (const oi of recentOrderItems) {
      const key = `${oi.menuItemId}:${Number(oi.price)}`;
      if (!seenPairs.has(key)) {
        seenPairs.set(key, {
          menuItemId: oi.menuItemId,
          menuItemName: oi.name,
          price: Number(oi.price),
        });
      }
    }

    // Existing mapping keys
    const existingMappings = await prisma.barItemMapping.findMany({
      where: { restaurantId },
      select: { menuItemId: true, variantPrice: true },
    });
    const existingKeys = new Set(
      existingMappings.map(m => `${m.menuItemId}:${Number(m.variantPrice)}`)
    );

    const unmapped = [...seenPairs.values()].filter(
      p => !existingKeys.has(`${p.menuItemId}:${p.price}`)
    );

    res.json(unmapped);
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Unmapped list failed:");
    res.status(500).json({ error: error.message });
  }
});

// POST /api/bar/inventory/mappings — upsert a mapping
router.post("/mappings", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user!.restaurantId;
    const { menuItemId, variantPrice, primaryInvId, secondaryInvId, mlPerUnit } = req.body;

    if (!menuItemId || variantPrice === undefined || !primaryInvId || mlPerUnit === undefined) {
      return res.status(400).json({ error: "menuItemId, variantPrice, primaryInvId, mlPerUnit are required" });
    }

    // Validate that the menu item and inventory items belong to this restaurant
    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, restaurantId },
      select: { id: true },
    });
    if (!menuItem) return res.status(404).json({ error: "Menu item not found in this restaurant" });

    const primaryInv = await prisma.inventoryItem.findFirst({
      where: { id: primaryInvId, restaurantId },
      select: { id: true },
    });
    if (!primaryInv) return res.status(404).json({ error: "Primary inventory item not found in this restaurant" });

    if (secondaryInvId) {
      const secondaryInv = await prisma.inventoryItem.findFirst({
        where: { id: secondaryInvId, restaurantId },
        select: { id: true },
      });
      if (!secondaryInv) return res.status(404).json({ error: "Secondary inventory item not found in this restaurant" });
    }

    const mapping = await prisma.barItemMapping.upsert({
      where: { menuItemId_variantPrice: { menuItemId, variantPrice: new Prisma.Decimal(variantPrice) } },
      create: {
        menuItemId,
        restaurantId,
        variantPrice: new Prisma.Decimal(variantPrice),
        primaryInvId,
        secondaryInvId: secondaryInvId ?? null,
        mlPerUnit: new Prisma.Decimal(mlPerUnit),
        source: 'MANUAL',
      },
      update: {
        primaryInvId,
        secondaryInvId: secondaryInvId ?? null,
        mlPerUnit: new Prisma.Decimal(mlPerUnit),
        source: 'MANUAL',
      },
    });

    res.json(mapping);
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Upsert mapping failed:");
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/bar/inventory/mappings/:menuItemId/:variantPrice — remove a single price-row mapping
router.delete("/mappings/:menuItemId/:variantPrice", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user!.restaurantId;
    const { menuItemId, variantPrice } = req.params;

    const existing = await prisma.barItemMapping.findUnique({
      where: { menuItemId_variantPrice: { menuItemId, variantPrice: new Prisma.Decimal(variantPrice) } },
    });

    if (!existing || existing.restaurantId !== restaurantId) {
      return res.status(404).json({ error: "Mapping not found" });
    }

    await prisma.barItemMapping.delete({
      where: { menuItemId_variantPrice: { menuItemId, variantPrice: new Prisma.Decimal(variantPrice) } },
    });

    res.json({ message: "Mapping deleted" });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Delete mapping failed:");
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POST /api/bar/inventory/snapshot
// Initialize inventory baseline from a physical stock count (snapshot).
// Uses image/paper closing values as the new system opening stock.
// ==========================================
router.post("/snapshot", requireRole("OWNER", "ADMIN"), async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      return res.status(400).json({ error: "restaurantId required" });
    }

    const { snapshotDate, items: snapshotItems } = req.body as {
      snapshotDate?: string;
      items?: Array<{
        itemId?: string;
        itemName?: string;
        closingQuantity: number;
        unit?: string;
      }>;
    };

    if (!snapshotDate || !snapshotItems || snapshotItems.length === 0) {
      return res.status(400).json({ error: "snapshotDate and items[] are required" });
    }

    const inventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      include: { menuItem: { select: { name: true } } },
    });

    const inventoryByName = new Map<string, typeof inventoryItems[0]>();
    for (const inv of inventoryItems) {
      const name = (inv.menuItem?.name || "").trim().toLowerCase();
      if (name) inventoryByName.set(name, inv);
    }

    const results: Array<{
      itemName: string;
      matched: boolean;
      inventoryItemId?: string;
      snapshotClosingMl?: number;
      previousCurrentStockMl?: number;
      adjustmentDeltaMl?: number;
      error?: string;
    }> = [];

    for (const snap of snapshotItems) {
      let inv: typeof inventoryItems[0] | undefined;
      let rawName: string;

      if (snap.itemId) {
        inv = inventoryItems.find((i) => i.id === snap.itemId);
        rawName = inv?.menuItem?.name || snap.itemName || snap.itemId;
      } else if (snap.itemName) {
        rawName = snap.itemName.trim();
        inv = inventoryByName.get(rawName.toLowerCase());
      } else {
        results.push({ itemName: "?", matched: false, error: "itemId or itemName required" });
        continue;
      }

      if (!inv) {
        results.push({ itemName: rawName!, matched: false, error: "No matching inventory item found" });
        continue;
      }

      const bottleSize = inv.bottleSize || 750;
      const unit = (snap.unit || "bottles").toLowerCase();

      let closingInMl: number;
      if (unit === "ml") {
        closingInMl = snap.closingQuantity;
      } else if (unit === "peg") {
        closingInMl = snap.closingQuantity * (inv.bottleSize ? inv.bottleSize / 25 : BAR_UNIT_ML);
      } else {
        closingInMl = snap.closingQuantity * bottleSize;
      }
      closingInMl = Math.round(closingInMl * 100) / 100;

      const previousCurrentStock = Number(inv.currentStock);
      const newCurrentStock = closingInMl;
      const adjustmentDelta = Math.round((newCurrentStock - previousCurrentStock) * 100) / 100;

      results.push({
        itemName: rawName!,
        matched: true,
        inventoryItemId: inv.id,
        snapshotClosingMl: closingInMl,
        previousCurrentStockMl: previousCurrentStock,
        adjustmentDeltaMl: adjustmentDelta,
      });

      if (Math.abs(adjustmentDelta) > 0.01) {
        await prisma.$transaction(async (tx) => {
          const stockBefore = new Prisma.Decimal(previousCurrentStock);
          const stockAfter = new Prisma.Decimal(newCurrentStock);
          const change = new Prisma.Decimal(adjustmentDelta);

          await tx.inventoryItem.updateMany({
            where: { id: inv.id, restaurantId: barId },
            data: {
              openingStock: new Prisma.Decimal(closingInMl),
              currentStock: stockAfter,
              updatedAt: new Date(),
            },
          });

          await tx.inventoryTransaction.create({
            data: {
              restaurantId: barId,
              itemId: inv.id,
              type: "ADJUSTMENT",
              quantityChange: change,
              stockBefore,
              stockAfter,
              notes: `Physical inventory snapshot on ${snapshotDate}. Baseline reset to closing count (${snap.closingQuantity} ${unit}).`,
              createdBy: req.user?.name || "Admin",
            },
          });

          const itemName = inv.menuItem?.name || rawName!;
          await tx.dailyInventorySnapshot.upsert({
            where: {
              restaurantId_snapshotDate_itemId: {
                restaurantId: barId,
                snapshotDate,
                itemId: inv.id,
              },
            },
            create: {
              restaurantId: barId,
              itemId: inv.id,
              snapshotDate,
              itemName,
              openingStock: new Prisma.Decimal(closingInMl),
              purchased: new Prisma.Decimal(0),
              sold: new Prisma.Decimal(0),
              wastage: new Prisma.Decimal(0),
              adjusted: change,
              closingStock: stockAfter,
            },
            update: {
              openingStock: new Prisma.Decimal(closingInMl),
              adjusted: { increment: change },
              closingStock: stockAfter,
            },
          });
        });
      } else {
        await prisma.inventoryItem.updateMany({
          where: { id: inv.id, restaurantId: barId },
          data: { openingStock: new Prisma.Decimal(closingInMl), updatedAt: new Date() },
        });
      }
    }

    const matched = results.filter((r) => r.matched);
    const unmatched = results.filter((r) => !r.matched);

    res.json({
      snapshotDate,
      outletId: barId,
      totalItems: snapshotItems.length,
      matched: matched.length,
      unmatched: unmatched.length,
      unmatchedItems: unmatched.map((u) => u.itemName),
      details: results,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Snapshot initialization failed:");
    res.status(500).json({ error: error.message || "Failed to initialize inventory snapshot" });
  }
});

// ==========================================
// GET /api/bar/inventory/reconciliation
// Reconcile physical snapshot vs system stock.
// ==========================================
router.get("/reconciliation", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      return res.status(400).json({ error: "restaurantId required" });
    }

    const snapshotDate = (req.query.snapshotDate as string) || getKolkataDateString();
    const search = (req.query.search as string) || undefined;

    const itemWhere: any = { restaurantId: barId, isActive: true };
    if (search) {
      itemWhere.menuItem = { name: { contains: search, mode: "insensitive" } };
    }

    const items = await prisma.inventoryItem.findMany({
      where: itemWhere,
      include: { menuItem: { select: { name: true } } },
      orderBy: { menuItem: { name: "asc" } },
    });

    const snapshots = await prisma.dailyInventorySnapshot.findMany({
      where: { restaurantId: barId, snapshotDate },
    });
    const snapshotMap = new Map(snapshots.map((s) => [s.itemId, s]));

    const postSnapshotTxns = await prisma.inventoryTransaction.findMany({
      where: {
        restaurantId: barId,
        transactionDate: { gt: new Date(snapshotDate + "T23:59:59.999Z") },
      },
      select: { itemId: true, type: true, quantityChange: true },
    });

    const txnAgg = new Map<string, { purchased: number; sold: number; wastage: number; adjusted: number }>();
    for (const t of postSnapshotTxns) {
      if (!txnAgg.has(t.itemId)) {
        txnAgg.set(t.itemId, { purchased: 0, sold: 0, wastage: 0, adjusted: 0 });
      }
      const agg = txnAgg.get(t.itemId)!;
      const qty = Number(t.quantityChange);
      switch (t.type) {
        case "PURCHASE": agg.purchased += qty; break;
        case "SALE": agg.sold += Math.abs(qty); break;
        case "WASTAGE": agg.wastage += Math.abs(qty); break;
        case "ADJUSTMENT": agg.adjusted += qty; break;
        case "SALE_REVERSAL": agg.sold -= Math.abs(qty); break;
      }
    }

    const reconciliation = items.map((item) => {
      const snap = snapshotMap.get(item.id);
      const agg = txnAgg.get(item.id) || { purchased: 0, sold: 0, wastage: 0, adjusted: 0 };

      const snapshotOpening = snap ? Number(snap.openingStock) : Number(item.openingStock);
      const runningClosing = Math.round(
        (snapshotOpening + agg.purchased - agg.sold - agg.wastage + agg.adjusted) * 100
      ) / 100;

      const systemCurrent = Number(item.currentStock);
      const variance = Math.round((runningClosing - systemCurrent) * 100) / 100;

      const bottleSize = item.bottleSize || 750;
      const toBottles = (ml: number) => formatBottlesPlusMl(Math.round(ml), bottleSize);

      return {
        itemId: item.id,
        itemName: item.menuItem?.name || "Unknown",
        bottleSize,
        snapshotDate,
        snapshotOpening: { ml: snapshotOpening, ...toBottles(snapshotOpening) },
        postSnapshotPurchased: { ml: agg.purchased, ...toBottles(agg.purchased) },
        postSnapshotSold: { ml: agg.sold, ...toBottles(agg.sold) },
        postSnapshotWastage: { ml: agg.wastage, ...toBottles(agg.wastage) },
        postSnapshotAdjusted: { ml: agg.adjusted, ...toBottles(agg.adjusted) },
        runningClosing: { ml: runningClosing, ...toBottles(runningClosing) },
        systemCurrentStock: { ml: systemCurrent, ...toBottles(systemCurrent) },
        variance: { ml: variance, ...toBottles(variance) },
        hasVariance: Math.abs(variance) > 0.01,
      };
    });

    res.json({
      snapshotDate,
      outletId: barId,
      totalItems: reconciliation.length,
      itemsWithVariance: reconciliation.filter((r) => r.hasVariance).length,
      items: reconciliation,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Reconciliation failed:");
    res.status(500).json({ error: error.message || "Failed to generate reconciliation" });
  }
});

export default router;
