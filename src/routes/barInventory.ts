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
import { isBeerItem, isSpiritItem } from "../utils/itemHelpers";
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
  resolveMenuToInventory,
  parseMlFromName,
  normalizeProductBaseName,
} from "../utils/barMatching";
import { getReportCategory } from "./reports";
import { completedTxnWhere } from "../lib/transactionHelpers";

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
  if (bottleSize <= 0) {
    return { bottles: 0, remainingMl: Math.round(totalMl), display: `${Math.round(totalMl)} ml` };
  }
  const bottles = Math.floor(totalMl / bottleSize);
  const remainingMl = Math.round(totalMl % bottleSize);
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

    // ── Per-item POS sales for the selected date ──
    // Reuses the same paid/completed OrderItem filtering as reports.ts.
    // Respects cancelled/void/refunded bills via status + isDeleted checks.
    const startOfDayUTC = istDateToUTCStart(targetDate);
    const endOfDayUTC = istDateToUTCEnd(targetDate);
    const posOrderItems = await basePrisma.orderItem.findMany({
      where: {
        removedFromBill: false,
        order: {
          status: 'PAID',
          isDeleted: false,
          restaurantId: resolveBarId(req),
          transactions: {
            status: 'COMPLETED',
            paidAt: { gte: startOfDayUTC, lte: endOfDayUTC },
          },
        },
      },
      select: {
        menuItemId: true,
        quantity: true,
        price: true,
        order: { select: { transactions: { select: { discountPercent: true } } } },
      },
    });
    // Build per-menuItemId revenue map
    const posRevenueByMenuItem = new Map<string, number>();
    for (const oi of posOrderItems) {
      if (!oi.menuItemId) continue;
      const qty = oi.quantity || 0;
      const orderDiscountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
      const discountFactor = orderDiscountPercent > 0 ? (1 - orderDiscountPercent / 100) : 1;
      const revenue = Math.round(Number(oi.price) * qty * discountFactor * 100) / 100;
      posRevenueByMenuItem.set(oi.menuItemId, (posRevenueByMenuItem.get(oi.menuItemId) || 0) + revenue);
    }

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
      } else if (isToday) {
        // No snapshot yet today, meaning no transactions occurred today.
        // Therefore today's opening == current closing == currentStock.
        // This applies to ALL items including zero-stock and negative-stock
        // items (e.g. items not on the physical sheet, or over-sold items).
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
      // Per-item POS sales for the selected date (from actual billing data)
      const itemSale = item.menuItemId ? (posRevenueByMenuItem.get(item.menuItemId) || 0) : 0;
      return {
        ...rest,
        todayEntry,
        displayStock,
        displayName,
        itemSale: Math.round(itemSale * 100) / 100,
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
// GET /api/bar/inventory/bottles-for-menu/:menuItemId
// Returns available bottle sizes for a liquor peg (30/60/90ml) so the
// captain/cashier can pick which physical bottle the drink is poured from.
// Excludes beer and full-bottle items (no picker for those).
// No stock quantities are returned — captain should not see stock levels.
// Tenant-scoped via resolveBarId(req).
// ==========================================
router.get("/bottles-for-menu/:menuItemId", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }
    const menuItemId = req.params.menuItemId as string;

    // 1. Fetch the menu item (tenant-scoped)
    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, restaurantId: barId },
      include: { category: true },
    });
    if (!menuItem) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }

    // 2. Exclude beer — no bottle picker for beer
    if (isBeerItem(menuItem)) {
      return res.json({ menuItemId, menuName: menuItem.name, isPeg: false, bottles: [] });
    }

    // 3. Show picker for liquor pegs (30/60/90ml) and half-bottle servings
    // (180ml, 375ml) — the bartender may pour these from a larger bottle.
    // 750ml (full bottle sale) is excluded — you can't pour 750ml from a 180ml.
    const PICKER_SIZES = [30, 60, 90, 180, 375];
    const menuSize = parseMlFromName(menuItem.name);
    if (menuSize === null || !PICKER_SIZES.includes(menuSize)) {
      return res.json({ menuItemId, menuName: menuItem.name, isPeg: false, bottles: [] });
    }

    // 4. Find all active inventory items for this brand (same normalized base name)
    //    Only return bottles that have stock > 0 — the captain should never
    //    see or pick a bottle that's empty. This prevents selecting a 180ml
    //    bottle with 0 stock and having the deduction go negative at settle.
    const baseName = normalizeProductBaseName(menuItem.name);
    const allInventory = await prisma.inventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      include: { menuItem: { select: { name: true } } },
    });
    const bottles = allInventory
      .filter((inv) => {
        const sameBrand = normalizeProductBaseName(inv.menuItem?.name || "") === baseName;
        // Only show bottles that can fulfill the ordered size
        // (e.g., 180ml order → show 180ml, 375ml, 750ml bottles, not smaller)
        const canFulfill = Number(inv.bottleSize || 0) >= menuSize;
        // Hide bottles with no stock — captain can't pour from an empty bottle
        const hasStock = Number(inv.currentStock || 0) > 0;
        return sameBrand && canFulfill && hasStock;
      })
      .map((inv) => ({
        inventoryItemId: inv.id,
        label: `${Number(inv.bottleSize || 0)}ml`,
        bottleSize: Number(inv.bottleSize || 0),
      }))
      .sort((a, b) => b.bottleSize - a.bottleSize); // largest first

    return res.json({
      menuItemId,
      menuName: menuItem.name,
      isPeg: true,
      bottles,
    });
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to fetch bottles for menu item:");
    res.status(500).json({ error: "Failed to fetch bottles for menu item" });
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
      acSellingPerMl,
      nonAcSellingPerMl,
    } = req.body as {
      menuItemId?: string;
      unitOfMeasure?: string;
      bottleSize?: number;
      currentStock?: number;
      openingStockBottles?: number;
      reorderLevel?: number;
      costPerBottle?: number;
      acSellingPerMl?: number;
      nonAcSellingPerMl?: number;
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
        acSellingPerMl: acSellingPerMl != null ? new Prisma.Decimal(acSellingPerMl) : null,
        nonAcSellingPerMl: nonAcSellingPerMl != null ? new Prisma.Decimal(nonAcSellingPerMl) : null,
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
      consumed,
      notes,
      acSellingPerMl,
      nonAcSellingPerMl,
      acSellingPrice,
      isHiddenFromReport,
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
      notes?: string;
      acSellingPerMl?: number | null;
      nonAcSellingPerMl?: number | null;
      acSellingPrice?: number | null;
      isHiddenFromReport?: boolean;
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
    if (acSellingPerMl !== undefined) updateData.acSellingPerMl = acSellingPerMl != null ? new Prisma.Decimal(Number(acSellingPerMl)) : null;
    if (nonAcSellingPerMl !== undefined) updateData.nonAcSellingPerMl = nonAcSellingPerMl != null ? new Prisma.Decimal(Number(nonAcSellingPerMl)) : null;
    if (acSellingPrice !== undefined) updateData.acSellingPrice = acSellingPrice != null ? new Prisma.Decimal(Number(acSellingPrice)) : null;
    if (isHiddenFromReport !== undefined) updateData.isHiddenFromReport = Boolean(isHiddenFromReport);

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

      // Negative closing stock is allowed — items can be over-sold (the business
      // explicitly permits negative stock to track shortfall). Do NOT reject.

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

      // Update currentStock to match the new closingStock.
      // Also update openingStock on the InventoryItem so that the POS deduction
      // fallback (when no previous-day snapshot exists) uses the correct opening
      // instead of the live currentStock which may already have been decremented.
      const stockBeforeNum = Number(existing!.currentStock);
      const invUpdateData: any = { currentStock: new Prisma.Decimal(newClosing) };
      if (effectiveOpeningMl !== undefined) {
        invUpdateData.openingStock = new Prisma.Decimal(effectiveOpeningMl);
      }
      updated = await prisma.inventoryItem.update({
        where: { id },
        data: invUpdateData,
        include: inventoryInclude,
      });

      // When openingStock is changed directly (not via daily ledger edit),
      // create an ADJUSTMENT transaction for audit trail with optional reason.
      if (effectiveOpeningMl !== undefined) {
        const changeNum = newClosing - stockBeforeNum;
        if (Math.abs(changeNum) > 0.01) {
          await prisma.inventoryTransaction.create({
            data: {
              restaurantId: resolveBarId(req),
              itemId: id,
              type: "ADJUSTMENT",
              quantityChange: new Prisma.Decimal(changeNum),
              stockBefore: new Prisma.Decimal(stockBeforeNum),
              stockAfter: new Prisma.Decimal(newClosing),
              notes: notes || "Opening stock edited",
              createdBy: "Admin",
            },
          });
        }
      }
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
// GET /api/bar/inventory/opening-preview/:itemId
// Returns today's sales/purchases/wastage for a specific item, so the
// frontend can show a live preview when the admin enters opening stock.
// Read-only — no writes.
// ==========================================
router.get("/opening-preview/:itemId", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }
    const itemId = req.params.itemId as string;
    const targetDate = (req.query.date as string) || getKolkataDateString();

    const item = await prisma.inventoryItem.findFirst({
      where: { id: itemId, restaurantId: barId },
      select: { id: true, currentStock: true, openingStock: true, bottleSize: true, menuItem: { select: { name: true } } },
    });
    if (!item) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    const dayStartUTC = istDateToUTCStart(targetDate);
    const dayEndUTC = istDateToUTCEnd(targetDate);

    const todayTxns = await prisma.inventoryTransaction.findMany({
      where: {
        itemId,
        transactionDate: { gte: dayStartUTC, lte: dayEndUTC },
        type: { in: ['SALE', 'PURCHASE', 'WASTAGE', 'ADJUSTMENT'] },
      },
      select: { type: true, quantityChange: true, source: true },
    });

    let soldMl = 0, purchasedMl = 0, wastageMl = 0, adjustedMl = 0;
    for (const t of todayTxns) {
      const qty = Number(t.quantityChange);
      if (t.type === 'SALE') soldMl += Math.abs(qty);
      else if (t.type === 'PURCHASE') purchasedMl += Math.abs(qty);
      else if (t.type === 'WASTAGE') wastageMl += Math.abs(qty);
      else if (t.type === 'ADJUSTMENT') adjustedMl += qty;
    }

    res.json({
      itemId: item.id,
      itemName: item.menuItem?.name || 'Unknown',
      currentStock: Number(item.currentStock),
      bottleSize: item.bottleSize,
      todaySoldMl: soldMl,
      todayPurchasedMl: purchasedMl,
      todayWastageMl: wastageMl,
      todayAdjustedMl: adjustedMl,
      date: targetDate,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Opening preview failed:");
    res.status(500).json({ error: error.message || "Failed to fetch opening preview" });
  }
});

// ==========================================
// PUT /api/bar/inventory/:itemId/stock
// Set absolute stock for a specific inventory item (per-size editing).
// Body: { stockMl: number, notes?: string, createdBy?: string }
// Creates an ADJUSTMENT transaction for the delta and updates currentStock.
// ==========================================
router.put("/:itemId/stock", async (req: any, res) => {
  const barId = resolveBarId(req);
  try {
    const { itemId } = req.params;
    const { stockMl, notes, createdBy } = req.body as {
      stockMl?: number;
      notes?: string;
      createdBy?: string;
    };

    if (stockMl === undefined || stockMl === null || isNaN(Number(stockMl))) {
      res.status(400).json({ error: "stockMl is required and must be a number" });
      return;
    }

    const targetStock = Number(stockMl);

    // Use transaction with row-level locking
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the row — tenant-scoped
        const lockedRows = await tx.$queryRaw<
          Array<{ id: string; currentStock: Prisma.Decimal; bottleSize: number; menuItemId: string }>
        >`
          SELECT "id", "currentStock", "bottleSize", "menuItemId"
          FROM "inventory_items"
          WHERE "id" = ${itemId} AND "restaurantId" = ${barId}
          FOR UPDATE
        `;

        if (lockedRows.length === 0) {
          throw new Error("Inventory item not found");
        }

        const row = lockedRows[0];
        const oldStock = Number(row.currentStock);
        const delta = targetStock - oldStock;

        if (delta === 0) {
          return { itemId, oldStock, newStock: oldStock, delta: 0, message: "No change" };
        }

        // Update currentStock
        const updated = await tx.inventoryItem.update({
          where: { id: itemId },
          data: { currentStock: targetStock },
        });

        // Tenant guard
        if (updated.restaurantId !== barId) {
          throw new Error("Tenant guard: item does not belong to this restaurant");
        }

        // Create adjustment transaction
        await tx.inventoryTransaction.create({
          data: {
            restaurantId: barId,
            itemId,
            type: "ADJUSTMENT",
            source: "ADMIN_SIZE_EDIT",
            quantityChange: delta,
            stockBefore: new Prisma.Decimal(oldStock),
            stockAfter: new Prisma.Decimal(targetStock),
            notes: notes || `Per-size stock edit: ${oldStock}ml → ${targetStock}ml`,
            transactionDate: new Date(),
            createdBy: createdBy || null,
          },
        });

        return {
          itemId,
          oldStock,
          newStock: targetStock,
          delta,
          bottleSize: Number(row.bottleSize),
        };
      },
      { timeout: 10000 },
    );

    res.json(result);
  } catch (error: any) {
    if (error?.message === "Inventory item not found") {
      res.status(404).json({ error: error.message });
      return;
    }
    logger.error({ error }, "[PUT /:itemId/stock] Error:");
    res.status(500).json({ error: "Failed to update stock" });
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
      date: overrideDate,
    } = req.body as {
      itemId?: string;
      quantityChange?: number;
      type?: string;
      notes?: string;
      createdBy?: string;
      requestId?: string;
      date?: string;
    };

    // Validation
    if (!itemId || quantityChange === undefined || !type) {
      res.status(400).json({
        error: "itemId, quantityChange, and type are required",
      });
      return;
    }

    const validTypes = ["WASTAGE", "ADJUSTMENT", "OPENING"];
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

        // ── OPENING: Set absolute opening stock and auto-deduct today's sales ──
        // The admin enters the total/opening stock for the day. The system:
        //   1. Queries today's SALE transactions (from settled bills) for this item
        //   2. Computes closing = opening - todaySold
        //   3. Sets currentStock = closing, openingStock = opening on the item
        //   4. Updates the daily snapshot with opening, sold, and closing
        //
        // This is an ABSOLUTE SET, not an additive change. The entered value
        // IS the opening stock — it replaces whatever was there before.
        let stockAfter: Prisma.Decimal;
        let openingStockValue: Prisma.Decimal;
        let todaySoldMl = new Prisma.Decimal(0);
        let todayPurchasedMl = new Prisma.Decimal(0);
        let todayWastageMl = new Prisma.Decimal(0);
        let todayAdjustedMl = new Prisma.Decimal(0);

        if (type === "OPENING") {
          openingStockValue = change; // the entered value IS the opening stock

          // Query today's transactions for this item to compute the real closing
          const snapshotDateForQuery = (overrideDate && /^\d{4}-\d{2}-\d{2}$/.test(overrideDate))
            ? overrideDate
            : getKolkataDateString();
          const dayStartUTC = istDateToUTCStart(snapshotDateForQuery);
          const dayEndUTC = istDateToUTCEnd(snapshotDateForQuery);

          const todayTxns = await tx.inventoryTransaction.findMany({
            where: {
              itemId,
              transactionDate: { gte: dayStartUTC, lte: dayEndUTC },
              type: { in: ['SALE', 'PURCHASE', 'WASTAGE', 'ADJUSTMENT'] },
            },
            select: { type: true, quantityChange: true, source: true },
          });

          for (const t of todayTxns) {
            const qty = Number(t.quantityChange);
            if (t.type === 'SALE') {
              todaySoldMl = todaySoldMl.add(Math.abs(qty));
            } else if (t.type === 'PURCHASE') {
              todayPurchasedMl = todayPurchasedMl.add(Math.abs(qty));
            } else if (t.type === 'WASTAGE') {
              todayWastageMl = todayWastageMl.add(Math.abs(qty));
            } else if (t.type === 'ADJUSTMENT') {
              todayAdjustedMl = todayAdjustedMl.add(qty); // preserve sign
            }
          }

          // closing = opening + purchased - sold - wastage + adjusted(net)
          stockAfter = openingStockValue
            .add(todayPurchasedMl)
            .sub(todaySoldMl)
            .sub(todayWastageMl)
            .add(todayAdjustedMl);

          // Allow negative stock (consistent with POS deduction policy)
          // — the opening stock entered may be less than what was already sold.
        } else {
          // WASTAGE / ADJUSTMENT: additive change (existing behavior)
          stockAfter = stockBefore.add(change);

          // Prevent negative stock for manual adjustments
          if (stockAfter.lessThan(0)) {
            throw Object.assign(
              new Error("Adjustment would result in negative stock"),
              { statusCode: 400, currentStock: stockBefore.toString(), requestedChange: change.toString() }
            );
          }
        }

        // Update inventory item — tenant-scoped (High #5): use updateMany with
        // restaurantId filter to enforce ownership inside the transaction, then
        // re-fetch with relations to preserve the response shape.
        // For OPENING: set both currentStock (closing after deductions) and
        // openingStock (the entered value). For other types: only update currentStock.
        const updateResult = await tx.inventoryItem.updateMany({
          where: { id: itemId, restaurantId: barId },
          data: {
            currentStock: stockAfter,
            ...(type === "OPENING" ? { openingStock: openingStockValue! } : {}),
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
        // For OPENING: quantityChange is the delta (stockAfter - stockBefore),
        //   not the entered opening value. The entered opening value is stored
        //   in the snapshot's openingStock field and on the InventoryItem.
        // For WASTAGE/ADJUSTMENT: quantityChange is the entered amount.
        const txnQuantityChange = type === "OPENING"
          ? stockAfter.sub(stockBefore)
          : change;
        const transaction = await tx.inventoryTransaction.create({
          data: {
            restaurantId: barId,
            itemId,
            type,
            source: type === "WASTAGE" ? "WASTAGE_ENTRY" : (type === "OPENING" ? "OPENING_STOCK" : "MANUAL"),
            quantityChange: txnQuantityChange,
            stockBefore,
            stockAfter,
            notes: notes || null,
            createdBy: createdBy || "Unknown",
          },
        });

        // Update daily inventory snapshot
        // Use overrideDate if provided (for historical date edits from the
        // Inventory page), otherwise default to today's Kolkata date.
        const snapshotDate = (overrideDate && /^\d{4}-\d{2}-\d{2}$/.test(overrideDate))
          ? overrideDate
          : getKolkataDateString();
        const menuItem = updatedItem.menuItem;
        // For OPENING: set openingStock to the new stock value (the opening
        // stock for the day). For WASTAGE: increment wastage. For ADJUSTMENT:
        // increment adjusted (preserve sign).
        const snapshotFieldName = type === "WASTAGE" ? "wastage" : "adjusted";
        // For WASTAGE: always store absolute value (wastage is always a reduction).
        // For ADJUSTMENT: preserve the sign so the GET endpoint's consumed formula
        //   (adjusted < 0 ? |adjusted| : 0) correctly counts negative adjustments
        //   as consumption. Using .abs() here would lose the sign and cause the
        //   consumed display to undercount when stock is removed via ADJUSTMENT.
        const snapshotIncrement = type === "WASTAGE" ? change.abs() : change;
        if (type === "OPENING") {
          // OPENING: set openingStock to the entered value, sold to today's
          // actual sales, and closingStock = opening + purchased - sold - wastage + adjusted.
          // This is an ABSOLUTE SET (not increment) — the admin is establishing
          // a new baseline for the day. All values are recomputed from today's
          // actual transactions.
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
              openingStock: openingStockValue!,
              purchased: todayPurchasedMl,
              sold: todaySoldMl,
              wastage: todayWastageMl,
              adjusted: todayAdjustedMl,
              closingStock: stockAfter,
            },
            update: {
              openingStock: openingStockValue!,
              purchased: todayPurchasedMl,
              sold: todaySoldMl,
              wastage: todayWastageMl,
              adjusted: todayAdjustedMl,
              closingStock: stockAfter,
            },
          });
        } else {
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
              [snapshotFieldName]: { increment: snapshotIncrement },
              closingStock: stockAfter,
            },
          });
        }

        // Write idempotency marker inside the transaction so it only persists on success.
        // If a concurrent request with the same requestId already wrote the marker,
        // P2002 is thrown. We MUST throw (not return) so the transaction rolls back
        // — otherwise our updateMany already modified stock and would double-count.
        // The outer catch handler re-reads the cached result and returns it.
        const txResult = {
          item: updatedItem,
          transaction,
          ...(type === "OPENING" ? {
            openingStock: openingStockValue!.toString(),
            todaySoldMl: todaySoldMl.toString(),
            todayPurchasedMl: todayPurchasedMl.toString(),
            todayWastageMl: todayWastageMl.toString(),
            todayAdjustedMl: todayAdjustedMl.toString(),
            closingStock: stockAfter.toString(),
          } : {}),
        };
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
      paymentStatus,
      paymentMethod,
      date: purchaseDate,
    } = req.body as {
      itemId?: string;
      quantity?: number;
      purchaseBottles?: number;
      costPerBottle?: number;
      notes?: string;
      createdBy?: string;
      skipPriceUpdate?: boolean;
      requestId?: string;
      paymentStatus?: string;
      paymentMethod?: string;
      date?: string;
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

        // Compute purchase cost for P&L tracking.
        // unitCost = costPerBottle (if provided), else item's existing costPerBottle.
        // totalCost = (quantityChange / bottleSize) * unitCost.
        const effectiveCostPerBottle = costPerBottle !== undefined
          ? Number(costPerBottle)
          : (updatedItem.costPerBottle ? Number(updatedItem.costPerBottle) : 0);
        const bottleSizeNum = Number(updatedItem.bottleSize || 750);
        const totalCostVal = bottleSizeNum > 0
          ? Math.round((Number(purchaseQty) / bottleSizeNum) * effectiveCostPerBottle * 100) / 100
          : 0;

        // Normalize payment fields for bar purchases.
        // Accepts "PENDING" or "DONE"; if DONE, requires a payment method.
        const validPaymentStatus = paymentStatus === "DONE" ? "DONE" : "PENDING";
        const validPaymentMethod = validPaymentStatus === "DONE"
          ? (paymentMethod || "CASH")
          : null;

        // Create transaction record (with cost + payment info for P&L)
        const transaction = await tx.inventoryTransaction.create({
          data: {
            restaurantId: barId,
            itemId,
            type: "PURCHASE",
            source: "PURCHASE",
            quantityChange: purchaseQty,
            stockBefore,
            stockAfter,
            unitCost: effectiveCostPerBottle > 0 ? new Prisma.Decimal(effectiveCostPerBottle) : null,
            totalCost: totalCostVal > 0 ? new Prisma.Decimal(totalCostVal) : null,
            paymentStatus: validPaymentStatus,
            paymentMethod: validPaymentMethod,
            notes: notes || null,
            createdBy: createdBy || "Unknown",
          },
        });

        // Update daily inventory snapshot
        // Use purchaseDate if provided (for historical date purchases),
        // otherwise default to today's Kolkata date.
        const snapshotDate = (purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate))
          ? purchaseDate
          : getKolkataDateString();
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
// GET /api/bar/inventory/stock-sheet
// Daily Stock & Sales Summary — printable stock sheet for a specific date.
//
// Returns ONLY items that had relevant activity on the selected date:
//   - sold/used in bills (SALE / SALE_REVERSAL transactions)
//   - purchased/received (PURCHASE transactions)
//   - wastage or manual adjustments (WASTAGE / ADJUSTMENT)
//   - a daily snapshot exists for that date
//
// For each relevant item:
//   openingStock  = previous day's closing stock (snapshot or last tx stockAfter)
//   received      = sum of PURCHASE transactions on the date
//   consumption   = sum of |SALE| + |WASTAGE| (stock out)
//   additional    = sum of ADJUSTMENT (signed; for manual write-in / verified adj.)
//   closingStock  = snapshot.closingStock or last transaction's stockAfter
//
// Reconciliation:
//   opening + received + additional - consumption == closing
//   previousDayClosing == opening
// Discrepancies are flagged per-item so the admin can investigate.
//
// Items are grouped by category with category totals. Only categories
// containing relevant items are included.
// ==========================================
router.get("/stock-sheet", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }

    const { date } = req.query as { date?: string };
    const reportDate = date || getKolkataDateString();

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }

    // Compute previous day's date string
    const [py, pm, pd] = reportDate.split("-").map(Number);
    const prevDateObj = new Date(Date.UTC(py, pm - 1, pd - 1));
    const prevDate = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getUTCDate()).padStart(2, "0")}`;

    // IST day boundaries for transaction queries
    const startOfDayUTC = istDateToUTCStart(reportDate);
    const endOfDayUTC = istDateToUTCEnd(reportDate);

    // Outlet name for the sheet header
    const outlet = await basePrisma.outlet.findFirst({
      where: { id: barId },
      select: { id: true, name: true, restaurantType: true },
    });
    const outletName = outlet?.name || "Outlet";

    // All active inventory items (to resolve names/categories)
    const allItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      include: {
        menuItem: { include: { category: true, variants: true } },
      },
    });
    const itemMap = new Map(allItems.map((i) => [i.id, i]));

    // Transactions on the selected date
    const transactions = await prisma.inventoryTransaction.findMany({
      where: {
        restaurantId: barId,
        transactionDate: { gte: startOfDayUTC, lte: endOfDayUTC },
      },
      orderBy: { transactionDate: "asc" },
    });

    // Snapshots for the selected date and the previous date
    const [todaySnapshots, prevSnapshots] = await Promise.all([
      prisma.dailyInventorySnapshot.findMany({
        where: { restaurantId: barId, snapshotDate: reportDate },
      }),
      prisma.dailyInventorySnapshot.findMany({
        where: { restaurantId: barId, snapshotDate: prevDate },
      }),
    ]);
    const todaySnapMap = new Map(todaySnapshots.map((s) => [s.itemId, s]));
    const prevSnapMap = new Map(prevSnapshots.map((s) => [s.itemId, s]));

    // Group transactions by item
    const txByItem = new Map<string, typeof transactions>();
    for (const tx of transactions) {
      const arr = txByItem.get(tx.itemId) || [];
      arr.push(tx);
      txByItem.set(tx.itemId, arr);
    }

    // Determine relevant items: those with a snapshot OR any transaction on the date
    const relevantItemIds = new Set<string>();
    for (const s of todaySnapshots) relevantItemIds.add(s.itemId);
    for (const tx of transactions) relevantItemIds.add(tx.itemId);

    // Build per-item rows
    const rows: any[] = [];
    let itemNumber = 0;
    for (const itemId of relevantItemIds) {
      const inv = itemMap.get(itemId);
      if (!inv) continue; // item may have been archived; skip

      const snap = todaySnapMap.get(itemId);
      const prevSnap = prevSnapMap.get(itemId);
      const itemTx = txByItem.get(itemId) || [];

      const bottleSize = inv.bottleSize ? Number(inv.bottleSize) : 750;
      const isBeer = isBeerItem(inv.menuItem);
      const isSpirit = !isBeer && inv.menuItem.variants?.some((v: any) => v.name.trim().toLowerCase() === "30ml");

      // ── Source-of-truth resolution ──────────────────────────────────────
      // When a daily snapshot exists, it IS the authoritative record for that
      // day's opening/purchased/sold/wastage/adjusted/closing. We use ITS
      // values for the sheet columns AND for the reconciliation math — this
      // avoids false mismatches from recomputing sold/received from raw
      // transactions (bar snapshots may use ML-estimated sold values).
      //
      // The displayed Opening Stock follows the business rule:
      //   Opening = Previous Day's Closing Stock
      // When both prevSnap and today's snap exist, we flag a discrepancy if
      //   prevSnap.closingStock != snap.openingStock
      // (i.e. the snapshot's own opening doesn't match the previous day's
      // closing — a real data integrity issue the admin should investigate).
      //
      // When NO snapshot exists, we fall back to transaction-derived values.
      // ────────────────────────────────────────────────────────────────────

      let openingStock: number;   // displayed opening (prev day closing per business rule)
      let received: number;
      let consumption: number;
      let soldMl: number;
      let wastageMl: number;
      let additional: number;
      let closingStock: number;
      let openingSource: string;
      let closingSource: string;
      let computedClosing: number;
      let reconciled: boolean;
      let prevDayClosingMatches: boolean;

      if (snap) {
        // ── Snapshot is the source of truth ──
        // Displayed opening = previous day's closing (business rule).
        // Fallback to snapshot's own opening if no previous snapshot.
        if (prevSnap) {
          openingStock = Number(prevSnap.closingStock);
          openingSource = "previous_snapshot";
        } else {
          openingStock = Number(snap.openingStock);
          openingSource = "today_snapshot";
        }

        // Use the snapshot's own movement values (authoritative)
        received = Number(snap.purchased);
        soldMl = Number(snap.sold);
        wastageMl = Number(snap.wastage);
        consumption = soldMl + wastageMl;
        additional = Number(snap.adjusted);
        closingStock = Number(snap.closingStock);
        closingSource = "snapshot";

        // Reconciliation uses the snapshot's OWN opening (not the displayed
        // prev-day-closing) so the math is internally consistent.
        const snapOpening = Number(snap.openingStock);
        computedClosing = snapOpening + received + additional - consumption;
        reconciled = Math.abs(computedClosing - closingStock) < 0.01;

        // Real discrepancy: does the snapshot's opening match prev day's closing?
        prevDayClosingMatches = prevSnap
          ? Math.abs(Number(prevSnap.closingStock) - snapOpening) < 0.01
          : true; // cannot verify without prev snapshot
      } else {
        // ── No snapshot — derive from transactions ──
        if (prevSnap) {
          openingStock = Number(prevSnap.closingStock);
          openingSource = "previous_snapshot";
        } else if (itemTx.length > 0) {
          openingStock = Number(itemTx[0].stockBefore);
          openingSource = "first_transaction";
        } else {
          openingStock = Number(inv.currentStock);
          openingSource = "current_stock_fallback";
        }

        received = itemTx
          .filter((t) => t.type === "PURCHASE")
          .reduce((sum, t) => sum + Number(t.quantityChange), 0);

        soldMl = itemTx
          .filter((t) => t.type === "SALE")
          .reduce((sum, t) => sum + Math.abs(Number(t.quantityChange)), 0);
        const saleReversalMl = itemTx
          .filter((t) => t.type === "SALE_REVERSAL")
          .reduce((sum, t) => sum + Number(t.quantityChange), 0);
        wastageMl = itemTx
          .filter((t) => t.type === "WASTAGE")
          .reduce((sum, t) => sum + Math.abs(Number(t.quantityChange)), 0);
        consumption = soldMl + wastageMl - saleReversalMl;

        additional = itemTx
          .filter((t) => t.type === "ADJUSTMENT")
          .reduce((sum, t) => sum + Number(t.quantityChange), 0);

        if (itemTx.length > 0) {
          closingStock = Number(itemTx[itemTx.length - 1].stockAfter);
          closingSource = "last_transaction";
        } else {
          closingStock = openingStock + received + additional - consumption;
          closingSource = "computed";
        }

        computedClosing = openingStock + received + additional - consumption;
        reconciled = Math.abs(computedClosing - closingStock) < 0.01;
        prevDayClosingMatches = prevSnap
          ? Math.abs(Number(prevSnap.closingStock) - openingStock) < 0.01
          : true;
      }

      itemNumber += 1;
      const categoryName = inv.menuItem?.category?.name || "Uncategorized";
      const unitMl = isBeer ? 650 : isSpirit ? BAR_UNIT_ML : bottleSize;

      rows.push({
        itemNumber,
        itemId: inv.id,
        itemName: inv.menuItem?.name || "Unknown",
        category: categoryName,
        unitOfMeasure: inv.unitOfMeasure,
        bottleSize,
        isBeer,
        isSpirit,
        openingStock,
        received,
        consumption,
        soldMl,
        wastageMl,
        additional,
        closingStock,
        // Display helpers (preserve bar ML-based format)
        displayOpening: formatBottlesPlusMl(openingStock, bottleSize).display,
        displayReceived: formatBottlesPlusMl(received, bottleSize).display,
        displayConsumption: formatBottlesPlusMl(consumption, bottleSize).display,
        displayAdditional: formatBottlesPlusMl(additional, bottleSize).display,
        displayClosing: formatBottlesPlusMl(closingStock, bottleSize).display,
        // Reconciliation
        computedClosing,
        reconciled,
        prevDayClosingMatches,
        openingSource,
        closingSource,
        transactionCount: itemTx.length,
        hasSnapshot: !!snap,
      });
    }

    // Sort rows by category then item name
    rows.sort((a, b) => {
      if (a.category === b.category) return a.itemName.localeCompare(b.itemName);
      return a.category.localeCompare(b.category);
    });

    // Re-number after sort
    rows.forEach((r, i) => { r.itemNumber = i + 1; });

    // Group by category with totals
    const categoryMap = new Map<string, any[]>();
    for (const r of rows) {
      const arr = categoryMap.get(r.category) || [];
      arr.push(r);
      categoryMap.set(r.category, arr);
    }
    const categories = Array.from(categoryMap.keys()).sort((a, b) => a.localeCompare(b));
    const categorySections = categories.map((cat) => {
      const items = categoryMap.get(cat)!;
      const totalOpening = items.reduce((s, r) => s + r.openingStock, 0);
      const totalReceived = items.reduce((s, r) => s + r.received, 0);
      const totalConsumption = items.reduce((s, r) => s + r.consumption, 0);
      const totalAdditional = items.reduce((s, r) => s + r.additional, 0);
      const totalClosing = items.reduce((s, r) => s + r.closingStock, 0);
      return {
        category: cat,
        items,
        totals: {
          openingStock: Math.round(totalOpening * 100) / 100,
          received: Math.round(totalReceived * 100) / 100,
          consumption: Math.round(totalConsumption * 100) / 100,
          additional: Math.round(totalAdditional * 100) / 100,
          closingStock: Math.round(totalClosing * 100) / 100,
        },
      };
    });

    // Overall reconciliation flags
    const discrepancies = rows.filter((r) => !r.reconciled || !r.prevDayClosingMatches);
    const grandTotals = categorySections.reduce(
      (acc, c) => ({
        openingStock: acc.openingStock + c.totals.openingStock,
        received: acc.received + c.totals.received,
        consumption: acc.consumption + c.totals.consumption,
        additional: acc.additional + c.totals.additional,
        closingStock: acc.closingStock + c.totals.closingStock,
      }),
      { openingStock: 0, received: 0, consumption: 0, additional: 0, closingStock: 0 }
    );

    res.json({
      date: reportDate,
      outletName,
      wing: "BAR",
      outletType: outlet?.restaurantType || null,
      categories: categorySections,
      grandTotals: {
        openingStock: Math.round(grandTotals.openingStock * 100) / 100,
        received: Math.round(grandTotals.received * 100) / 100,
        consumption: Math.round(grandTotals.consumption * 100) / 100,
        additional: Math.round(grandTotals.additional * 100) / 100,
        closingStock: Math.round(grandTotals.closingStock * 100) / 100,
      },
      totalRelevantItems: rows.length,
      discrepancies: discrepancies.map((r) => ({
        itemId: r.itemId,
        itemName: r.itemName,
        reconciled: r.reconciled,
        prevDayClosingMatches: r.prevDayClosingMatches,
        computedClosing: r.computedClosing,
        storedClosing: r.closingStock,
        openingStock: r.openingStock,
      })),
      hasDiscrepancies: discrepancies.length > 0,
    });
  } catch (error) {
    logger.error({ err: error }, "[BarInventory] Failed to generate stock sheet:");
    res.status(500).json({ error: "Failed to generate stock sheet" });
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

    // Fetch ALL active inventory items for this restaurant and match by name
    // (bar inventory items are linked to hidden menu items, not the visible ordered ones)
    const allInventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId, isActive: true },
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

    // Fetch all active inventory items for this restaurant (matched by name, not menuItemId)
    const allInventoryItems = await prisma.inventoryItem.findMany({
      where: { restaurantId, isActive: true },
      include: { menuItem: { include: { variants: true } } },
    });
    // Also fetch inactive items for the pourFromInventoryItemId override lookup
    const allInventoryItemsIncludingInactive = await prisma.inventoryItem.findMany({
      where: { restaurantId },
      include: { menuItem: { include: { variants: true } } },
    });

    const inventoryByName = buildInventoryByName(allInventoryItems);
    const dualVariantMap = buildDualVariantMap(inventoryByName);

    // Aggregate liquor items by menuItemId + price + pourFromInventoryItemId
    // (same key as deductInventoryForOrder — preserves bottle selection)
    const aggregatedLiquorItems = new Map<string, { menuItemId: string; menuItemName: string; quantity: number; price: number; pourFromInventoryItemId?: string | null }>();
    for (const item of liquorItems) {
      const key = `${item.menuItemId}:${Number(item.price)}:${item.pourFromInventoryItemId ?? 'auto'}`;
      const existing = aggregatedLiquorItems.get(key);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        aggregatedLiquorItems.set(key, {
          menuItemId: item.menuItemId,
          menuItemName: item.menuItem.name,
          quantity: item.quantity,
          price: Number(item.price),
          pourFromInventoryItemId: item.pourFromInventoryItemId,
        });
      }
    }

    const errors: string[] = [];
    let succeeded = 0;
    let retried = 0;
    // Use the order's settlement date for snapshots, not today's date.
    // This ensures retry deductions are recorded under the original bill date.
    const settlementDate = order.settledAt || order.paidAt || new Date();
    const today = getKolkataDateString(settlementDate);

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

      for (const [, { menuItemId, menuItemName, quantity: totalQuantity, price: itemPrice, pourFromInventoryItemId }] of aggregatedLiquorItems.entries()) {
        // ── Universal menu→inventory resolution ─────────────────────────────
        const match = resolveMenuToInventory(
          menuItemId,
          menuItemName,
          itemPrice,
          allInventoryItems,
          {
            mappings: mappingByKey,
            logPrefix: '[Bar Retry]',
            log: (m) => console.warn(m),
          },
        );

        let primaryInv: any = match.primary;
        let secondaryInv: any = match.secondary;
        let mlPerUnit: number = match.mlPerUnit;
        let variantLabel: string = match.variantLabel;

        // If the captain/cashier explicitly selected a bottle, honor it
        // (same logic as deductInventoryForOrder — includes inactive bottles)
        if (pourFromInventoryItemId) {
          let selectedInv = allInventoryItemsIncludingInactive.find((i: any) => i.id === pourFromInventoryItemId);
          if (!selectedInv) {
            selectedInv = allInventoryItemsIncludingInactive.find((i: any) => i.menuItemId === pourFromInventoryItemId);
          }
          if (selectedInv) {
            primaryInv = selectedInv;
            secondaryInv = null;
          }
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
              source: "PHYSICAL_COUNT",
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

// ==========================================
// GET /api/bar/inventory/liquor-daily-report
// Daily Liquor Stock Report with ML-based stock, physical/system consumption,
// variance (both wastage-adjusted and physical-count), and gross profitability.
// Reuses the existing stock-sheet data loading pattern.
// Only includes items with relevant activity on the selected date (Req #18).
// Supports optional endDate param for date-range reports (aggregated across dates).
// ==========================================
async function buildLiquorReportForDate(barId: string, reportDate: string): Promise<any> {
  try {
    // Compute previous day's date
    const [py, pm, pd] = reportDate.split("-").map(Number);
    const prevDateObj = new Date(Date.UTC(py, pm - 1, pd - 1));
    const prevDate = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getUTCDate()).padStart(2, "0")}`;

    const startOfDayUTC = istDateToUTCStart(reportDate);
    const endOfDayUTC = istDateToUTCEnd(reportDate);

    // Outlet info
    const outlet = await basePrisma.outlet.findFirst({
      where: { id: barId },
      select: { id: true, name: true, restaurantType: true, gstCategory: true },
    });
    const outletName = outlet?.name || "Outlet";
    const outletGstCategory = outlet?.gstCategory || "NON_AC";

    // Load Non-AC manual entries for this date (admin-entered, NOT from POS)
    const nonAcManualEntries = await prisma.liquorReportNonAcEntry.findMany({
      where: { restaurantId: barId, reportDate },
    });
    const nonAcManualMap = new Map<string, { nonAcSales: number; nonAcLandingCost: number; notes: string | null }>();
    let summaryOverrides: Record<string, number> | null = null;
    for (const e of nonAcManualEntries) {
      if (e.categoryName === '__SUMMARY__') {
        // Summary overrides stored as JSON in notes
        try { summaryOverrides = JSON.parse(e.notes || '{}'); } catch { summaryOverrides = null; }
        continue;
      }
      nonAcManualMap.set(e.categoryName, {
        nonAcSales: Number(e.nonAcSales),
        nonAcLandingCost: Number(e.nonAcLandingCost),
        notes: e.notes,
      });
    }
    const nonAcTotalManual = nonAcManualMap.get('TOTAL') || { nonAcSales: 0, nonAcLandingCost: 0, notes: null };

    // ── Carry-forward: load PREVIOUS day's saved closingStockValue ──
    // The admin's saved closingStockValue for date D-1 must become the
    // openingStockValue for date D. This is the business rule:
    //   31-08 saved Closing Stock Value → 01-09 Opening Stock Value
    // Without this, openingStockValue is computed from item-level snapshots
    // which can have negative/incorrect values. The saved override is the
    // admin's authoritative closing value and must carry forward.
    const prevDaySummaryEntry = await prisma.liquorReportNonAcEntry.findFirst({
      where: { restaurantId: barId, reportDate: prevDate, categoryName: '__SUMMARY__' },
    });
    let prevDayClosingStockValue: number | null = null;
    if (prevDaySummaryEntry) {
      try {
        const prevOverrides = JSON.parse(prevDaySummaryEntry.notes || '{}');
        if (typeof prevOverrides.closingStockValue === 'number' && !Number.isNaN(prevOverrides.closingStockValue)) {
          prevDayClosingStockValue = Math.round(prevOverrides.closingStockValue * 100) / 100;
          logger.info(`[BarInventory] Carry-forward: ${prevDate} closingStockValue=${prevDayClosingStockValue} → ${reportDate} openingStockValue`);
        }
      } catch { /* ignore parse errors */ }
    } else {
      logger.info(`[BarInventory] Carry-forward: No __SUMMARY__ entry found for ${prevDate} (restaurantId=${barId})`);
    }

    // Load all active inventory items — exclude Soft Drinks from Liquor report
    const allItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      include: {
        menuItem: { include: { category: true, variants: true } },
      },
    });
    // Filter out Soft Drinks/Beverages — only liquor items in the PDF report
    const SOFT_DRINK_KEYWORDS = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
    const isSoftDrink = (inv: any): boolean => {
      const catName = String(inv.menuItem?.category?.name || '').toLowerCase();
      const itemName = String(inv.menuItem?.name || '').toLowerCase();
      return SOFT_DRINK_KEYWORDS.some(k => catName === k || catName.includes(k)) ||
             SOFT_DRINK_KEYWORDS.some(k => itemName.includes(k));
    };
    const filteredItems = allItems.filter(inv => !isSoftDrink(inv));
    const itemMap = new Map(filteredItems.map((i) => [i.id, i]));

    // Transactions on the selected date
    const transactions = await prisma.inventoryTransaction.findMany({
      where: {
        restaurantId: barId,
        transactionDate: { gte: startOfDayUTC, lte: endOfDayUTC },
      },
      orderBy: { transactionDate: "asc" },
    });

    // Snapshots for today and previous day
    const [todaySnapshots, prevSnapshots] = await Promise.all([
      prisma.dailyInventorySnapshot.findMany({
        where: { restaurantId: barId, snapshotDate: reportDate },
      }),
      prisma.dailyInventorySnapshot.findMany({
        where: { restaurantId: barId, snapshotDate: prevDate },
      }),
    ]);
    const todaySnapMap = new Map(todaySnapshots.map((s) => [s.itemId, s]));
    const prevSnapMap = new Map(prevSnapshots.map((s) => [s.itemId, s]));

    // ── Self-healing: sync currentStock to snapshot closingStock ──
    // If currentStock has drifted from the snapshot's closingStock (e.g. due to
    // external scripts or manual DB edits), correct it so future POS deductions
    // start from the right value. The snapshot is the source of truth.
    for (const snap of todaySnapshots) {
      const inv = allItems.find((i) => i.id === snap.itemId);
      if (!inv) continue;
      const snapClosing = Number(snap.closingStock);
      const liveStock = Number(inv.currentStock);
      if (Math.abs(snapClosing - liveStock) > 0.01) {
        await prisma.inventoryItem.update({
          where: { id: inv.id },
          data: { currentStock: new Prisma.Decimal(snapClosing) },
        });
        logger.warn(
          `[BarInventory] Self-healing: synced currentStock for "${inv.menuItem?.name}" ` +
          `from ${liveStock}ml to ${snapClosing}ml (snapshot closing)`,
        );
      }
    }

    // Group transactions by item
    const txByItem = new Map<string, typeof transactions>();
    for (const tx of transactions) {
      const arr = txByItem.get(tx.itemId) || [];
      arr.push(tx);
      txByItem.set(tx.itemId, arr);
    }

    // Relevant items: those with a snapshot OR any transaction on the date
    const relevantItemIds = new Set<string>();
    for (const s of todaySnapshots) relevantItemIds.add(s.itemId);
    for (const tx of transactions) relevantItemIds.add(tx.itemId);

    // Load POS order items for the date to compute AC/Non-AC revenue per item
    // Join: OrderItem → Order → Table → Section → Venue → TaxProfile
    const posOrderItems = await basePrisma.orderItem.findMany({
      where: {
        removedFromBill: false,
        order: {
          status: 'PAID',
          isDeleted: false,
          restaurantId: barId,
          transactions: {
            status: 'COMPLETED',
            paidAt: { gte: startOfDayUTC, lte: endOfDayUTC },
          },
        },
      },
      include: {
        menuItem: { select: { id: true, name: true, menuType: true, reportCategory: true, isCombo: true, category: { select: { name: true } } } },
        order: {
          select: {
            restaurantId: true,
            transactions: { select: { discountPercent: true } },
            table: {
              select: {
                section: {
                  select: {
                    venue: {
                      select: {
                        taxProfile: { select: { gstCategory: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Build per-item POS revenue map (by menuItemId)
    // AC = System/POS data (automatically populated). ALL POS revenue is AC.
    // Non-AC = Manual admin entry (outlets not using our POS). Loaded separately.
    // Key: menuItemId, Value: { acRevenue, nonAcRevenue, totalRevenue, grossRevenue }
    const posRevenueByMenuItem = new Map<string, { acRevenue: number; nonAcRevenue: number; totalRevenue: number; grossRevenue: number }>();

    for (const oi of posOrderItems) {
      const mi = oi.menuItem;
      if (!mi) continue;
      // Only Liquor items (uses the same getReportCategory as the dashboard)
      if (getReportCategory(mi) !== 'Liquor') continue;

      const qty = oi.quantity || 0;
      const orderDiscountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
      const discountFactor = orderDiscountPercent > 0 ? (1 - orderDiscountPercent / 100) : 1;
      const grossLineRevenue = Math.round(Number(oi.price) * qty * 100) / 100;
      const revenue = Math.round(grossLineRevenue * discountFactor * 100) / 100;

      // ALL POS revenue is AC (system data). Non-AC is manual entry only.
      const existing = posRevenueByMenuItem.get(mi.id) || { acRevenue: 0, nonAcRevenue: 0, totalRevenue: 0, grossRevenue: 0 };
      existing.acRevenue += revenue;
      existing.totalRevenue += revenue;
      existing.grossRevenue += grossLineRevenue;
      posRevenueByMenuItem.set(mi.id, existing);
    }

    // ── Scale POS revenue to match Transaction.grandTotal ──
    // This is the SAME scaling used by the dashboard's getItemwiseSalesData
    // (reports.ts). It ensures that the sum of all category revenues
    // (Food + Beverages + Liquor + Combo) equals the actual Transaction.grandTotal.
    // Without this scaling, the PDF AC Sales would diverge from the Dashboard
    // Liquor Revenue due to rounding and items not captured in order items.
    const allPosRevenueRaw = posOrderItems.reduce((s, oi) => {
      const qty = oi.quantity || 0;
      const orderDiscountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
      const discountFactor = orderDiscountPercent > 0 ? (1 - orderDiscountPercent / 100) : 1;
      return s + Math.round(Number(oi.price) * qty * discountFactor * 100) / 100;
    }, 0);
    // Raw liquor revenue (before scaling) — used for summary total
    let liquorRevenueRaw = 0;
    for (const [, val] of posRevenueByMenuItem) {
      liquorRevenueRaw += val.acRevenue;
    }
    const txnAgg = await basePrisma.transaction.aggregate({
      where: completedTxnWhere(barId, {
        paidAt: { gte: startOfDayUTC, lte: endOfDayUTC },
      }),
      _sum: { grandTotal: true, amount: true },
    });
    const txnTotal = Number(txnAgg._sum.grandTotal) || Number(txnAgg._sum.amount) || 0;
    const scaleFactor = allPosRevenueRaw > 0 ? txnTotal / allPosRevenueRaw : 1;
    // Summary total = single rounding of raw × scaleFactor (matches dashboard exactly)
    const totalAcRevenueScaled = Math.round(liquorRevenueRaw * scaleFactor * 100) / 100;
    // Apply scaleFactor to each liquor item's acRevenue (per-item for display)
    for (const [, val] of posRevenueByMenuItem) {
      val.acRevenue = Math.round(val.acRevenue * scaleFactor * 100) / 100;
      val.totalRevenue = Math.round(val.totalRevenue * scaleFactor * 100) / 100;
    }

    // Include items with POS revenue in the report even if they have no
    // snapshot or transaction (e.g. deduction was skipped due to the
    // barInventoryDeducted bug). These items will show correct revenue
    // with systemConsumptionMl = 0, surfacing the variance instead of
    // silently missing from the report.
    for (const [menuItemId] of posRevenueByMenuItem) {
      const inv = filteredItems.find(i => i.menuItemId === menuItemId);
      if (inv) relevantItemIds.add(inv.id);
    }

    // Build per-item report rows
    const rows: any[] = [];
    let hasAnyPhysicalCount = false;

    for (const itemId of relevantItemIds) {
      const inv = itemMap.get(itemId);
      if (!inv) continue;

      const snap = todaySnapMap.get(itemId);
      const prevSnap = prevSnapMap.get(itemId);
      const itemTx = txByItem.get(itemId) || [];

      const bottleSize = inv.bottleSize ? Number(inv.bottleSize) : 0;
      const menuItemId = inv.menuItemId;

      // ── Stock calculations (reuse stock-sheet logic) ──
      let openingMl: number;
      let purchasedMl: number;
      let additionsMl: number;       // manual adjustments (source != PHYSICAL_COUNT)
      let physicalCountAdjustmentMl: number; // source == PHYSICAL_COUNT
      let closingMl: number;
      let systemConsumptionMl: number;
      let wastageMl: number;
      let prevDayClosingMatches: boolean;

      if (snap) {
        openingMl = Number(snap.openingStock);
        purchasedMl = Number(snap.purchased);
        wastageMl = Number(snap.wastage);
        systemConsumptionMl = Number(snap.sold);
        closingMl = Number(snap.closingStock);
        // Adjustments: split by source
        additionsMl = 0;
        physicalCountAdjustmentMl = 0;
        for (const tx of itemTx) {
          if (tx.type === 'ADJUSTMENT') {
            if (tx.source === 'PHYSICAL_COUNT') {
              physicalCountAdjustmentMl += Number(tx.quantityChange);
              hasAnyPhysicalCount = true;
            } else {
              additionsMl += Number(tx.quantityChange);
            }
          }
        }
        // If no transactions to split by source (e.g. snapshot was created
        // without a transaction), use the snapshot's adjusted field.
        // Positive adjusted = manual addition; negative adjusted = physical
        // count correction / stock reduction (NOT a negative addition).
        if (itemTx.filter(t => t.type === 'ADJUSTMENT').length === 0) {
          const rawAdjusted = Number(snap.adjusted);
          if (rawAdjusted >= 0) {
            additionsMl = rawAdjusted;
          } else {
            // Negative adjustment is a physical count correction, not an addition.
            // Treating it as a negative addition would make physical consumption
            // negative (physically impossible). It represents stock that was
            // consumed/lost/corrected — record it as a physical count adjustment.
            physicalCountAdjustmentMl = rawAdjusted;
            if (rawAdjusted !== 0) hasAnyPhysicalCount = true;
          }
        }
        prevDayClosingMatches = prevSnap
          ? Math.abs(Number(prevSnap.closingStock) - Number(snap.openingStock)) < 0.01
          : true;
      } else {
        // No snapshot — derive from transactions
        openingMl = prevSnap ? Number(prevSnap.closingStock) : (itemTx.length > 0 ? Number(itemTx[0].stockBefore) : Number(inv.currentStock));
        purchasedMl = 0;
        additionsMl = 0;
        physicalCountAdjustmentMl = 0;
        systemConsumptionMl = 0;
        wastageMl = 0;
        let lastStockAfter = openingMl;
        for (const tx of itemTx) {
          const qty = Number(tx.quantityChange);
          lastStockAfter = Number(tx.stockAfter);
          switch (tx.type) {
            case 'PURCHASE': purchasedMl += qty; break;
            case 'SALE': systemConsumptionMl += Math.abs(qty); break;
            case 'WASTAGE': wastageMl += Math.abs(qty); break;
            case 'ADJUSTMENT':
              if (tx.source === 'PHYSICAL_COUNT') {
                physicalCountAdjustmentMl += qty;
                hasAnyPhysicalCount = true;
              } else {
                additionsMl += qty;
              }
              break;
          }
        }
        closingMl = lastStockAfter;
        prevDayClosingMatches = true; // cannot verify without snapshot
      }

      const totalAvailableMl = openingMl + purchasedMl + additionsMl;
      const physicalConsumptionMl = totalAvailableMl - closingMl;

      // ── Variance (Option C: both columns) ──
      const wastageAdjustedVarianceMl = physicalConsumptionMl - systemConsumptionMl;
      const hasPhysicalCount = itemTx.some(t => t.source === 'PHYSICAL_COUNT') || (snap && physicalCountAdjustmentMl !== 0);
      const physicalCountVarianceMl = hasPhysicalCount ? physicalCountAdjustmentMl : null;
      const variancePct = (hasPhysicalCount && systemConsumptionMl > 0)
        ? Math.round(Math.abs(physicalCountVarianceMl!) / systemConsumptionMl * 100 * 100) / 100
        : null;

      // ── Profitability ──
      // COST LOGIC:
      //   Purchase Cost  = costPerBottle  → what admin PAYS to acquire the item.
      //                     Same for AC and Non-AC (shared field on InventoryItem).
      //   Selling Price  = what admin SELLS the item for to customers.
      //     AC selling   = actual POS billed amount (real customer payment).
      //     Non-AC selling = admin-entered total in the report preview.
      //
      //   AC Consumption/Landing Cost = soldMl × (costPerBottle / bottleSize)
      //     → derived from purchase cost (same costPerBottle for AC & Non-AC).
      //   Non-AC Consumption/Landing Cost = admin-entered in report preview
      //     → may include extra overhead (transport, commission, etc.) on top
      //       of the same purchase cost, so it's kept as a manual field.
      //
      // Gross Profit uses SYSTEM consumption cost (cost of goods actually sold
      // through POS), NOT physical consumption. Physical consumption includes
      // theft/spillage/variance which is a separate loss indicator, not COGS.
      // Using physical consumption here would inflate the cost beyond actual
      // sales and produce incorrect negative margins.
      const costPerBottle = inv.costPerBottle ? Number(inv.costPerBottle) : null;
      const costPerMl = (costPerBottle && bottleSize > 0) ? costPerBottle / bottleSize : null;

      // AC Revenue = actual POS billed amount (what the customer paid).
      // This IS the AC selling price — no need for a separate acSellingPerMl field.
      const posRev = posRevenueByMenuItem.get(menuItemId) || { acRevenue: 0, nonAcRevenue: 0, totalRevenue: 0, grossRevenue: 0 };
      const acRevenue = Math.round(posRev.acRevenue * 100) / 100;
      const nonAcRevenue = Math.round(posRev.nonAcRevenue * 100) / 100;
      const totalRevenue = Math.round(posRev.totalRevenue * 100) / 100;
      const grossRevenue = Math.round(posRev.grossRevenue * 100) / 100;

      // AC COGS = purchase cost × sold ml.
      // Only items with POS revenue count toward consumption cost.
      // Items consumed but not sold (system consumption with ₹0 revenue) are
      // inventory shrinkage/loss, not COGS — including them would create
      // fake negative profit with no revenue to offset.
      const soldMl = totalRevenue > 0 ? systemConsumptionMl : 0;
      const consumptionCost = costPerMl != null ? Math.round(soldMl * costPerMl * 100) / 100 : null;
      const grossProfit = consumptionCost != null ? Math.round((totalRevenue - consumptionCost) * 100) / 100 : null;
      const grossMarginPct = (grossProfit != null && totalRevenue > 0)
        ? Math.round(grossProfit / totalRevenue * 100 * 100) / 100
        : null;

      const stockValue = costPerMl != null ? Math.round(closingMl * costPerMl * 100) / 100 : null;

      // Bottle equivalents
      const openingBottles = formatBottlesPlusMl(Math.round(openingMl), bottleSize);
      const purchasedBottles = formatBottlesPlusMl(Math.round(purchasedMl), bottleSize);
      const totalAvailableBottles = formatBottlesPlusMl(Math.round(totalAvailableMl), bottleSize);
      const closingBottles = formatBottlesPlusMl(Math.round(closingMl), bottleSize);
      const physicalConsumptionBottles = formatBottlesPlusMl(Math.round(physicalConsumptionMl), bottleSize);
      const systemConsumptionBottles = formatBottlesPlusMl(Math.round(systemConsumptionMl), bottleSize);

      rows.push({
        itemId,
        itemName: inv.menuItem?.name || "Unknown",
        categoryName: inv.menuItem?.category?.name || "Uncategorized",
        bottleSize,
        date: reportDate,
        opening: { ml: Math.round(openingMl * 100) / 100, ...openingBottles },
        purchases: { ml: Math.round(purchasedMl * 100) / 100, ...purchasedBottles },
        totalAvailable: { ml: Math.round(totalAvailableMl * 100) / 100, ...totalAvailableBottles },
        closing: { ml: Math.round(closingMl * 100) / 100, ...closingBottles },
        physicalConsumption: { ml: Math.round(physicalConsumptionMl * 100) / 100, ...physicalConsumptionBottles },
        systemConsumption: { ml: Math.round(systemConsumptionMl * 100) / 100, ...systemConsumptionBottles },
        wastageAdjustedVariance: { ml: Math.round(wastageAdjustedVarianceMl * 100) / 100 },
        physicalCountVariance: physicalCountVarianceMl != null
          ? { ml: Math.round(physicalCountVarianceMl * 100) / 100 }
          : null,
        variancePct,
        hasPhysicalCount,
        prevDayClosingMatches,
        // Profitability
        costPerMl: costPerMl != null ? Math.round(costPerMl * 10000) / 10000 : null,
        costPerBottle: costPerBottle,
        acRevenue,
        nonAcRevenue,
        totalRevenue,
        grossRevenue,
        consumptionCost,
        grossProfit,
        grossMarginPct,
        stockValue,
        acSellingPerMlOverride: inv.acSellingPerMl ? Number(inv.acSellingPerMl) : null,
        nonAcSellingPerMlOverride: inv.nonAcSellingPerMl ? Number(inv.nonAcSellingPerMl) : null,
      });
    }

    // ── Surface unmapped POS liquor items ──
    // These are liquor items sold in POS but have NO inventory item created.
    // Their revenue is included in the summary total (matching the dashboard)
    // but they would be invisible in the per-item breakdown without this.
    // This surfaces deduction/mapping mistakes so the admin can take action.
    for (const [menuItemId, posRev] of posRevenueByMenuItem) {
      const inv = filteredItems.find(i => i.menuItemId === menuItemId);
      if (inv) continue; // already in the report via relevantItemIds

      // Find the menu item name from the POS order items
      const posOi = posOrderItems.find(oi => oi.menuItem?.id === menuItemId);
      const itemName = posOi?.menuItem?.name || `Unknown (ID: ${menuItemId})`;
      const categoryName = posOi?.menuItem?.category?.name || 'Uncategorized';

      const acRevenue = Math.round(posRev.acRevenue * 100) / 100;
      const grossRevenue = Math.round(posRev.grossRevenue * 100) / 100;

      rows.push({
        itemId: `unmapped:${menuItemId}`,
        itemName: `${itemName} ⚠ NO INVENTORY`,
        categoryName,
        bottleSize: 0,
        date: reportDate,
        opening: { ml: 0, bottles: 0, mlRemainder: 0 },
        purchases: { ml: 0, bottles: 0, mlRemainder: 0 },
        totalAvailable: { ml: 0, bottles: 0, mlRemainder: 0 },
        closing: { ml: 0, bottles: 0, mlRemainder: 0 },
        physicalConsumption: { ml: 0, bottles: 0, mlRemainder: 0 },
        systemConsumption: { ml: 0, bottles: 0, mlRemainder: 0 },
        wastageAdjustedVariance: { ml: 0 },
        physicalCountVariance: null,
        variancePct: null,
        hasPhysicalCount: false,
        prevDayClosingMatches: true,
        costPerMl: null,
        costPerBottle: null,
        acRevenue,
        nonAcRevenue: 0,
        totalRevenue: acRevenue,
        grossRevenue,
        consumptionCost: null,
        grossProfit: null,
        grossMarginPct: null,
        stockValue: null,
        acSellingPerMlOverride: null,
        nonAcSellingPerMlOverride: null,
        unmappedPOSItem: true, // flag for frontend to highlight
      });
    }

    // Sort rows by category then item name
    rows.sort((a, b) => {
      const catCmp = a.categoryName.localeCompare(b.categoryName);
      if (catCmp !== 0) return catCmp;
      return a.itemName.localeCompare(b.itemName);
    });

    // ── Category-wise aggregation (Req #5) ──
    // Aggregate item-level data into category totals for the PDF.
    // Fixed category order: Beer, Whisky, Brandy, Vodka, Breezers, Rum, Gin, Wine
    const LIQUOR_CATEGORY_ORDER = ['Beer', 'Whisky', 'Brandy', 'Vodka', 'Breezers', 'Rum', 'Gin', 'Wine'];
    const categoryMap = new Map<string, {
      categoryName: string;
      openingMl: number;
      openingBottles: number;
      purchasedMl: number;
      closingMl: number;
      closingBottles: number;
      physicalConsumptionMl: number;
      systemConsumptionMl: number;
      varianceMl: number;
      stockValue: number;
      sales: number;
      consumptionCost: number;
      grossProfit: number;
      acRevenue: number;
      nonAcRevenue: number;
      acConsumptionCost: number;
      nonAcConsumptionCost: number;
      acProfit: number;
      nonAcProfit: number;
      totalProfit: number;
      acProfitPct: number;
      nonAcProfitPct: number;
      totalProfitPct: number;
    }>();

    for (const r of rows) {
      const cat = r.categoryName;
      const existing = categoryMap.get(cat) || {
        categoryName: cat,
        openingMl: 0,
        openingBottles: 0,
        purchasedMl: 0,
        closingMl: 0,
        closingBottles: 0,
        physicalConsumptionMl: 0,
        systemConsumptionMl: 0,
        varianceMl: 0,
        stockValue: 0,
        sales: 0,
        consumptionCost: 0,
        grossProfit: 0,
        acRevenue: 0,
        nonAcRevenue: 0,
        acConsumptionCost: 0,
        nonAcConsumptionCost: 0,
        acProfit: 0,
        nonAcProfit: 0,
        totalProfit: 0,
        acProfitPct: 0,
        nonAcProfitPct: 0,
        totalProfitPct: 0,
      };
      existing.openingMl += r.opening.ml;
      existing.openingBottles += (r.opening.bottles || 0);
      existing.purchasedMl += r.purchases.ml;
      existing.closingMl += r.closing.ml;
      existing.closingBottles += (r.closing.bottles || 0);
      existing.physicalConsumptionMl += r.physicalConsumption.ml;
      existing.systemConsumptionMl += r.systemConsumption.ml;
      existing.varianceMl += r.wastageAdjustedVariance.ml;
      existing.stockValue += (r.stockValue || 0);
      // AC sales = POS revenue (system data). Non-AC = 0 at item level (manual at category level).
      existing.acRevenue += r.acRevenue;
      existing.sales += r.totalRevenue; // POS total (all AC)
      existing.consumptionCost += (r.consumptionCost || 0);
      existing.grossProfit += (r.grossProfit || 0);
      // All POS consumption cost is AC cost
      existing.acConsumptionCost += (r.consumptionCost || 0);
      categoryMap.set(cat, existing);
    }

    // ── Overlay Non-AC manual data (admin-entered, NOT from POS) ──
    // Non-AC represents outlets NOT using our POS. These values are manually entered.
    // Non-AC Revenue (selling price) = admin-entered total sales.
    // Non-AC Landing Cost (consumption cost) = admin-entered, may include extra
    //   overhead on top of the same purchase cost (costPerBottle).
    for (const [catName, manual] of nonAcManualMap) {
      if (catName === 'TOTAL') continue; // handled separately in summary
      const existing = categoryMap.get(catName);
      if (existing) {
        existing.nonAcRevenue = manual.nonAcSales;
        existing.nonAcConsumptionCost = manual.nonAcLandingCost;
        existing.sales = existing.acRevenue + existing.nonAcRevenue;
      } else {
        // Category doesn't exist from POS but has manual Non-AC data — create it
        categoryMap.set(catName, {
          categoryName: catName,
          openingMl: 0, openingBottles: 0,
          purchasedMl: 0,
          closingMl: 0, closingBottles: 0,
          physicalConsumptionMl: 0, systemConsumptionMl: 0, varianceMl: 0,
          stockValue: 0,
          sales: manual.nonAcSales,
          consumptionCost: 0,
          grossProfit: 0,
          acRevenue: 0,
          nonAcRevenue: manual.nonAcSales,
          acConsumptionCost: 0,
          nonAcConsumptionCost: manual.nonAcLandingCost,
          acProfit: 0, nonAcProfit: 0, totalProfit: 0,
          acProfitPct: 0, nonAcProfitPct: 0, totalProfitPct: 0,
        });
      }
    }

    const categories = Array.from(categoryMap.values()).map((c) => {
      // AC/Non-AC profit
      c.acProfit = Math.round((c.acRevenue - c.acConsumptionCost) * 100) / 100;
      c.nonAcProfit = Math.round((c.nonAcRevenue - c.nonAcConsumptionCost) * 100) / 100;
      c.totalProfit = Math.round((c.acProfit + c.nonAcProfit) * 100) / 100;
      c.acProfitPct = c.acRevenue > 0 ? Math.round(c.acProfit / c.acRevenue * 100 * 100) / 100 : 0;
      c.nonAcProfitPct = c.nonAcRevenue > 0 ? Math.round(c.nonAcProfit / c.nonAcRevenue * 100 * 100) / 100 : 0;
      c.totalProfitPct = c.sales > 0 ? Math.round(c.totalProfit / c.sales * 100 * 100) / 100 : 0;
      return {
        ...c,
        openingMl: Math.round(c.openingMl * 100) / 100,
        openingBottles: Math.round(c.openingBottles * 100) / 100,
        purchasedMl: Math.round(c.purchasedMl * 100) / 100,
        closingMl: Math.round(c.closingMl * 100) / 100,
        closingBottles: Math.round(c.closingBottles * 100) / 100,
        physicalConsumptionMl: Math.round(c.physicalConsumptionMl * 100) / 100,
        systemConsumptionMl: Math.round(c.systemConsumptionMl * 100) / 100,
        varianceMl: Math.round(c.varianceMl * 100) / 100,
        stockValue: Math.round(c.stockValue * 100) / 100,
        sales: Math.round(c.sales * 100) / 100,
        consumptionCost: Math.round(c.consumptionCost * 100) / 100,
        grossProfit: Math.round(c.grossProfit * 100) / 100,
        acRevenue: Math.round(c.acRevenue * 100) / 100,
        nonAcRevenue: Math.round(c.nonAcRevenue * 100) / 100,
        acConsumptionCost: Math.round(c.acConsumptionCost * 100) / 100,
        nonAcConsumptionCost: Math.round(c.nonAcConsumptionCost * 100) / 100,
        grossMarginPct: c.sales > 0 ? Math.round(c.grossProfit / c.sales * 100 * 100) / 100 : 0,
      };
    });
    // Sort by fixed category order; unknown categories go last alphabetically
    categories.sort((a, b) => {
      const ai = LIQUOR_CATEGORY_ORDER.indexOf(a.categoryName);
      const bi = LIQUOR_CATEGORY_ORDER.indexOf(b.categoryName);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.categoryName.localeCompare(b.categoryName);
    });

    // ── Summary totals ──
    const totalStockValue = rows.reduce((s, r) => s + (r.stockValue || 0), 0);
    const totalGrossSales = rows.reduce((s, r) => s + (r.grossRevenue || 0), 0);
    // AC sales = POS revenue (system), scaled to match Transaction.grandTotal.
    // Uses the single-rounded scaled total (not sum of per-item rounded values)
    // to match the dashboard's round2(liquorRevenueRaw * scaleFactor) exactly.
    const totalAcRevenuePos = totalAcRevenueScaled;
    // Non-AC: use TOTAL manual entry if available, otherwise sum from categories
    const totalNonAcRevenue = nonAcTotalManual.nonAcSales > 0
      ? nonAcTotalManual.nonAcSales
      : categories.reduce((s, c) => s + c.nonAcRevenue, 0);
    const totalNonAcConsumptionCost = nonAcTotalManual.nonAcLandingCost > 0
      ? nonAcTotalManual.nonAcLandingCost
      : categories.reduce((s, c) => s + c.nonAcConsumptionCost, 0);

    // AC totals: visible items only (hidden items and unmapped POS items excluded from PDF Business Position)
    const visibleRows = rows.filter(r => {
      if (r.unmappedPOSItem) return false;
      const inv = itemMap.get(r.itemId);
      return inv ? !inv.isHiddenFromReport : true;
    });
    const totalAcRevenueVisible = visibleRows.reduce((s, r) => s + r.acRevenue, 0);
    const totalAcConsumptionCostVisible = visibleRows.reduce((s, r) => s + (r.consumptionCost || 0), 0);
    const totalAcProfitVisible = Math.round((totalAcRevenueVisible - totalAcConsumptionCostVisible) * 100) / 100;

    const totalLiquorSales = totalAcRevenueVisible + totalNonAcRevenue; // AC + Non-AC
    const totalDiscounts = Math.round((totalGrossSales - totalAcRevenuePos) * 100) / 100; // discounts from POS only (all items)
    const netSales = totalLiquorSales; // Total = AC + Non-AC
    // AC consumption cost from visible items, Non-AC from manual
    const totalAcConsumptionCost = totalAcConsumptionCostVisible;
    const totalConsumptionCost = totalAcConsumptionCost + totalNonAcConsumptionCost;
    // Gross profit = AC profit + Non-AC profit
    const totalAcProfit = totalAcProfitVisible;
    const totalNonAcProfit = Math.round((totalNonAcRevenue - totalNonAcConsumptionCost) * 100) / 100;
    const totalGrossProfit = totalAcProfit + totalNonAcProfit;
    const totalGrossMarginPct = netSales > 0
      ? Math.round(totalGrossProfit / netSales * 100 * 100) / 100
      : 0;
    const totalStockVariance = rows.reduce((s, r) => s + (r.physicalCountVariance?.ml || 0), 0);
    // Stock value totals for business summary
    const totalOpeningStockValue = rows.reduce((s, r) => {
      const costPerMl = r.costPerMl;
      return s + (costPerMl != null ? r.opening.ml * costPerMl : 0);
    }, 0);
    const totalPurchasesValue = rows.reduce((s, r) => {
      const costPerMl = r.costPerMl;
      return s + (costPerMl != null ? r.purchases.ml * costPerMl : 0);
    }, 0);
    const totalClosingStockValue = totalStockValue;
    const totalPhysicalConsumption = rows.reduce((s, r) => s + r.physicalConsumption.ml, 0);
    const totalSystemConsumption = rows.reduce((s, r) => s + r.systemConsumption.ml, 0);
    const totalVarianceMl = rows.reduce((s, r) => s + r.wastageAdjustedVariance.ml, 0);
    // Total bottle counts for summary (sum of item-level bottle equivalents)
    const totalOpeningBottles = rows.reduce((s, r) => s + (r.opening.bottles || 0), 0);
    const totalClosingBottles = rows.reduce((s, r) => s + (r.closing.bottles || 0), 0);
    // AC totals
    const totalAcRevenue = totalAcRevenueVisible;
    const totalAcProfitPct = totalAcRevenue > 0 ? Math.round(totalAcProfit / totalAcRevenue * 100 * 100) / 100 : 0;
    const totalNonAcProfitPct = totalNonAcRevenue > 0 ? Math.round(totalNonAcProfit / totalNonAcRevenue * 100 * 100) / 100 : 0;
    const totalProfit = totalAcProfit + totalNonAcProfit;
    const totalProfitPct = netSales > 0 ? Math.round(totalProfit / netSales * 100 * 100) / 100 : 0;

    // Outlet wing (AC/Non-AC venue classification) — derive from outlet gstCategory
    const outletWing = outletGstCategory === 'AC' ? 'AC' : 'Non-AC';

    // Non-AC manual entries for frontend editing (exclude __SUMMARY__)
    const nonAcEntries = nonAcManualEntries
      .filter((e: any) => e.categoryName !== '__SUMMARY__')
      .map((e: any) => ({
        categoryName: e.categoryName,
        nonAcSales: Number(e.nonAcSales),
        nonAcLandingCost: Number(e.nonAcLandingCost),
        notes: e.notes,
      }));

    // Build summary object
    const summaryObj: Record<string, any> = {
      totalStockValue: Math.round(totalStockValue * 100) / 100,
      totalGrossSales: Math.round(totalGrossSales * 100) / 100,
      totalLiquorSales: Math.round(totalLiquorSales * 100) / 100,
      totalDiscounts,
      netSales: Math.round(netSales * 100) / 100,
      totalConsumptionCost: Math.round(totalConsumptionCost * 100) / 100,
      totalGrossProfit: Math.round(totalGrossProfit * 100) / 100,
      totalGrossMarginPct,
      totalStockVariance: Math.round(totalStockVariance * 100) / 100,
      totalItems: rows.length,
      // Business summary (Req #6)
      totalOpeningStockValue: Math.round(totalOpeningStockValue * 100) / 100,
      totalPurchasesValue: Math.round(totalPurchasesValue * 100) / 100,
      totalClosingStockValue: Math.round(totalClosingStockValue * 100) / 100,
      totalPhysicalConsumption: Math.round(totalPhysicalConsumption * 100) / 100,
      totalSystemConsumption: Math.round(totalSystemConsumption * 100) / 100,
      totalVarianceMl: Math.round(totalVarianceMl * 100) / 100,
      totalOpeningBottles: Math.round(totalOpeningBottles * 100) / 100,
      totalClosingBottles: Math.round(totalClosingBottles * 100) / 100,
      // AC/Non-AC totals
      totalAcRevenue: Math.round(totalAcRevenue * 100) / 100,
      totalNonAcRevenue: Math.round(totalNonAcRevenue * 100) / 100,
      totalAcConsumptionCost: Math.round(totalAcConsumptionCost * 100) / 100,
      totalNonAcConsumptionCost: Math.round(totalNonAcConsumptionCost * 100) / 100,
      totalAcProfit,
      totalNonAcProfit,
      totalProfit,
      totalAcProfitPct,
      totalNonAcProfitPct,
      totalProfitPct,
    };

    // ── Carry-forward: previous day's saved closingStockValue → today's openingStockValue ──
    // This runs BEFORE applying today's overrides so that if the admin has
    // ALSO manually edited today's openingStockValue, that explicit edit wins.
    // But if the admin has NOT edited openingStockValue today, the previous
    // day's saved closing value is used instead of the (often incorrect)
    // item-level computed value.
    if (prevDayClosingStockValue != null && !summaryOverrides?.openingStockValue) {
      summaryObj.openingStockValue = prevDayClosingStockValue;
    }

    // Apply saved summary overrides (editable business position fields)
    if (summaryOverrides) {
      for (const [key, val] of Object.entries(summaryOverrides)) {
        if (typeof val === 'number' && !Number.isNaN(val)) {
          summaryObj[key] = Math.round(val * 100) / 100;
        }
      }
    }

    // ── Build item-wise arrays for the PDF detailed tables ──
    // AC items: from the existing rows array, formatted for the AC Bar table
    // Columns: S.No | Item Name | Qty(ml) | Sale(btl) | Purchase Cost | Consumption | Selling Price | Sale Amount | Profit
    //
    // Sale (btl) = soldMl ÷ bottleSize (bottles sold, derived from POS billing)
    // Consumption = Sale × Purchase Cost  (30ML cost logic: sale_btl × purchaseCost = (soldMl/bottleSize) × purchaseCost
    //   = (soldMl/30) × (purchaseCost × 30/bottleSize) = pegs × 30ML_cost — mathematically equivalent)
    // Selling Price = POS revenue ÷ Sale (btl) — per-bottle selling price from actual POS billing
    // Sale Amount = Sale × Selling Price  (equals actual POS revenue)
    // Profit = Sale Amount − Consumption
    //
    // Admin adjustments (ac_report_adjustments) override POS-derived values where present.
    // POS data is never modified — adjustments are stored separately for auditability.
    const acAdjustments = await prisma.acReportAdjustment.findMany({
      where: { restaurantId: barId, entryDate: reportDate },
    });
    const acAdjMap = new Map(acAdjustments.map(a => [a.itemId, a]));

    // ── AC Selling Price: ADMIN-MANAGED, persisted on InventoryItem.acSellingPrice ──
    // The admin manually enters the selling price per bottle. It is persisted on
    // the inventory item so it carries forward to future reports/dates automatically.
    // Resolution order for the base selling price:
    //   1. InventoryItem.acSellingPrice (admin-saved persistent price)
    //   2. menuItem.basePrice (one-time fallback before admin sets a price)
    //   3. 0 (flagged as hasMissingSellingPrice)
    // Admin adjustments (ac_report_adjustments) for this date still override the
    // base price for this specific report, but the persistent acSellingPrice is
    // the source of truth across dates.

    const acItems = rows.filter(r => (r.systemConsumption.ml > 0 || r.acRevenue > 0) && !r.unmappedPOSItem).map((r, idx) => {
      const bottleSize = r.bottleSize || 0;
      const purchaseCost = r.costPerBottle || 0;
      const saleMl = r.systemConsumption.ml;  // actual sold ml from POS (database)
      const saleBtl = bottleSize > 0 ? Math.round((saleMl / bottleSize) * 10000) / 10000 : 0;  // bottles sold
      const consumption = Math.round(saleBtl * purchaseCost * 100) / 100;  // Sale × Purchase Cost

      // Determine if this is a spirit (30ml peg-based) or beer (bottle-based)
      // Spirits: Sale is in 30ml pegs, unitCost = purchaseCost × 30 / 750
      // Beer/other: Sale is in bottles, unitCost = purchaseCost
      // 180ml items are half-bottles (bottle-based, not peg-based)
      // NOTE: unitCost is computed AFTER adjustments (see finalPurchaseCost below)
      // because it must use the adjusted purchase cost, not the master value.
      const inv = itemMap.get(r.itemId);
      const isBeer = isBeerItem(inv?.menuItem);
      const isSpirit = isSpiritItem(inv?.menuItem, bottleSize);

      // ── Stock flow (bottles) — from actual snapshot/transaction data ──
      // Admin overrides (adjustedOpeningBtl, adjustedReceivedBtl, adjustedClosingBtl)
      // take precedence over snapshot-derived values when present.
      const snapOpeningBtl = bottleSize > 0 ? Math.round((r.opening.ml / bottleSize) * 10000) / 10000 : 0;
      const snapReceivedBtl = bottleSize > 0 ? Math.round((r.purchases.ml / bottleSize) * 10000) / 10000 : 0;
      const snapClosingBtl = bottleSize > 0 ? Math.round((r.closing.ml / bottleSize) * 10000) / 10000 : 0;

      // ── AC Selling Price: admin-managed persistent price ──
      // `inv` already declared above (with isBeer/isSpirit detection)
      let sellingPrice = 0;
      let hasMissingSellingPrice = false;
      const adminSavedPrice = inv?.acSellingPrice ? Number(inv.acSellingPrice) : 0;
      const basePrice = inv?.menuItem?.basePrice ? Number(inv.menuItem.basePrice) : 0;
      if (adminSavedPrice > 0) {
        sellingPrice = Math.round(adminSavedPrice * 100) / 100;
      } else if (basePrice > 0) {
        sellingPrice = Math.round(basePrice * 100) / 100;
      } else {
        hasMissingSellingPrice = true;
      }

      // Sale Amount = actual POS revenue (what the customer paid).
      // This MUST match the dashboard's acSaleAmount which uses the same
      // posRevenueByMenuItem data. Previously this was saleBtl × sellingPrice
      // which diverged from POS revenue due to discounts and price mismatches.
      const posRevenue = r.acRevenue || 0;
      const saleAmount = Math.round(posRevenue * 100) / 100;
      const profit = Math.round((saleAmount - consumption) * 100) / 100;

      // Apply admin adjustments if present (override for this date's report)
      // Purchase Cost and Selling Price are PERSISTENT per-item fields stored
      // on InventoryItem, but the admin can override them per-date via the
      // adjustment. If the adjustment has a non-null adjustedPurchaseCost or
      // adjustedSellingPrice, use it for this report. Otherwise fall back to
      // the inventory master value.
      const adj = acAdjMap.get(r.itemId);
      const finalSale = adj?.adjustedSaleBtl != null ? Number(adj.adjustedSaleBtl) : saleBtl;
      const finalPurchaseCost = adj?.adjustedPurchaseCost != null
        ? Number(adj.adjustedPurchaseCost)
        : purchaseCost;
      const finalSellingPrice = adj?.adjustedSellingPrice != null
        ? Number(adj.adjustedSellingPrice)
        : sellingPrice;

      // Compute unitCost from the FINAL (adjusted) purchase cost, not the master.
      // For spirits: unitCost = finalPurchaseCost × 30 / 750 (per-peg cost)
      // For beer/other: unitCost = finalPurchaseCost (per-bottle cost)
      // This must use finalPurchaseCost so that when the admin overrides the
      // purchase cost via adjustment, the per-peg cost is recalculated correctly.
      // BUG FIX: previously this used the master purchaseCost, which produced
      // wrong consumption when the adjusted cost differed from the master.
      const effectiveBottleSize = isSpirit ? 750 : bottleSize;
      const unitCost = isSpirit
        ? Math.round((finalPurchaseCost * 30 / effectiveBottleSize) * 1000000) / 1000000
        : finalPurchaseCost;

      // Display sale quantity: prefer admin-set value from adjustment notes, then auto-compute
      let displaySale = finalSale;
      if (adj?.notes) {
        try {
          const noteObj = JSON.parse(adj.notes);
          if (noteObj.displaySale != null) {
            displaySale = Number(noteObj.displaySale);
          }
        } catch { /* ignore invalid JSON */ }
      }
      // Only apply the peg/bottle heuristic when there is NO adjustment.
      // When an adjustment exists, finalSale (adjustedSaleBtl) is already in
      // the correct unit (pegs for spirits, bottles for beer) — the admin
      // entered it directly. Overriding with saleMl/30 would replace the
      // admin's value with a POS-derived value that may be 0 or different.
      if (!adj && displaySale === finalSale) {
        // Fallback heuristic: pegs for spirits, bottles for beer/other
        const isBeer = isBeerItem(inv?.menuItem);
        const isSpirit = isSpiritItem(inv?.menuItem, bottleSize);
        displaySale = isSpirit && bottleSize > 0
          ? Math.round((saleMl / 30) * 100) / 100
          : finalSale;
      }
      const finalConsumption = adj?.adjustedConsumption != null
        ? Number(adj.adjustedConsumption)
        : Math.round(finalSale * finalPurchaseCost * 100) / 100;
      const finalSaleAmount = adj?.adjustedSaleAmount != null
        ? Number(adj.adjustedSaleAmount)
        : saleAmount;  // POS revenue (matches dashboard)
      const finalProfit = adj?.adjustedProfit != null
        ? Number(adj.adjustedProfit)
        : Math.round((finalSaleAmount - finalConsumption) * 100) / 100;

      // Update hasMissingSellingPrice based on the FINAL selling price
      // (which may come from the adjustment override, not just the inventory master)
      hasMissingSellingPrice = finalSellingPrice <= 0;

      // Stock flow — use admin overrides if present, else snapshot-derived
      const finalOpening = adj?.adjustedOpeningBtl != null ? Number(adj.adjustedOpeningBtl) : snapOpeningBtl;
      const finalReceived = adj?.adjustedReceivedBtl != null ? Number(adj.adjustedReceivedBtl) : snapReceivedBtl;
      const finalStockBtl = Math.round((finalOpening + finalReceived) * 10000) / 10000;
      const finalSoldBtl = finalSale;
      const finalClosingBtl = adj?.adjustedClosingBtl != null
        ? Number(adj.adjustedClosingBtl)
        : Math.round((finalStockBtl - finalSoldBtl) * 10000) / 10000;

      return {
        sno: idx + 1,
        itemId: r.itemId,
        itemName: r.itemName,
        categoryName: r.categoryName,
        qty: bottleSize,           // bottle/container volume in ML
        sale: finalSale,           // bottles sold (from POS or admin adjustment)
        displaySale,               // pegs for spirits, bottles for beer (for display only)
        saleMl,                    // raw ml sold (for reference, always from POS)
        purchaseCost: finalPurchaseCost,     // actual purchase cost (from inventory or adjustment)
        consumption: finalConsumption,       // Sale × Purchase Cost (30ML cost logic applied)
        sellingPrice: finalSellingPrice,     // per-bottle selling price (admin-saved or adjustment)
        saleAmount: finalSaleAmount,         // Sale × Selling Price
        profit: finalProfit,                 // Sale Amount − Consumption
        // Stock flow (bottles) — admin-overridden or snapshot-derived
        opening: finalOpening,
        received: finalReceived,
        stock: finalStockBtl,
        sold: finalSoldBtl,
        closing: finalClosingBtl,
        hasMissingPrice: finalPurchaseCost <= 0,
        hasMissingBottleSize: bottleSize <= 0,
        hasMissingSellingPrice: hasMissingSellingPrice,  // from persistent item master
        isHidden: inv?.isHiddenFromReport ?? false,  // admin hide/show flag
        hasAdjustment: !!adj,                 // flag: admin adjustment exists
        isSpirit,                            // 30ml peg-based item (Sale in pegs)
        isBeer,                              // bottle-based item (Sale in bottles)
        unitCost,                            // cost per sale unit (per peg for spirits, per bottle for beer)
      };
    });

    // ── Include AC inventory items that have stock but no POS activity ──
    // An item should appear in the report if ANY of these are true:
    //   1. It has POS activity (already in acItems from the filter above)
    //   2. It has an AcReportAdjustment for this date (admin entered values)
    //   3. It has a snapshot for today (stock carried forward from previous day)
    //   4. It has a snapshot for the previous day (closing stock → today's opening)
    // Previously only (1) and (2) were included, which meant items with stock
    // carried forward from 31-08 but no POS sales on 01-09 were MISSING from
    // the 01-09 report. This caused the entire AC item-wise table to be empty
    // even though ₹9 lakhs of closing stock existed from the previous day.
    const acItemIdsInReport = new Set(acItems.map(a => a.itemId));
    for (const inv of filteredItems) {
      if (acItemIdsInReport.has(inv.id)) continue;
      // Skip hidden items — they should never appear in the report
      if (inv.isHiddenFromReport) continue;

      const adj = acAdjMap.get(inv.id);
      const snap = todaySnapMap.get(inv.id);
      const prevSnap = prevSnapMap.get(inv.id);

      // Include if: has adjustment, OR has today's snapshot, OR has prev day's snapshot
      // (prev day's closing = today's opening via the rollover business rule)
      if (!adj && !snap && !prevSnap) continue;

      const bottleSize = inv.bottleSize ? Number(inv.bottleSize) : 0;
      const purchaseCost = inv.costPerBottle ? Number(inv.costPerBottle) : 0;

      // Determine if this is a spirit (30ml peg-based) or beer (bottle-based)
      // NOTE: unitCost is computed AFTER adjustments (see finalPurchaseCost below)
      const isBeer = isBeerItem(inv.menuItem);
      const isSpirit = isSpiritItem(inv.menuItem, bottleSize);

      // ── Stock flow (bottles) — from snapshot data for this item ──
      // Admin overrides take precedence when present.
      // snap and prevSnap are already declared above (before the inclusion check)
      const openingMl = snap ? Number(snap.openingStock) : (prevSnap ? Number(prevSnap.closingStock) : 0);
      const purchasedMl = snap ? Number(snap.purchased) : 0;
      const closingMl = snap ? Number(snap.closingStock) : (prevSnap ? Number(prevSnap.closingStock) : 0);
      const snapOpeningBtl = bottleSize > 0 ? Math.round((openingMl / bottleSize) * 10000) / 10000 : 0;
      const snapReceivedBtl = bottleSize > 0 ? Math.round((purchasedMl / bottleSize) * 10000) / 10000 : 0;
      const snapClosingBtl = bottleSize > 0 ? Math.round((closingMl / bottleSize) * 10000) / 10000 : 0;

      // Selling price: admin-saved persistent price → basePrice fallback
      let sellingPrice = 0;
      let hasMissingSellingPrice = false;
      const adminSavedPrice = inv.acSellingPrice ? Number(inv.acSellingPrice) : 0;
      const basePrice = inv.menuItem?.basePrice ? Number(inv.menuItem.basePrice) : 0;
      if (adminSavedPrice > 0) {
        sellingPrice = Math.round(adminSavedPrice * 100) / 100;
      } else if (basePrice > 0) {
        sellingPrice = Math.round(basePrice * 100) / 100;
      } else {
        hasMissingSellingPrice = true;
      }

      // Apply admin adjustments (adj already declared above)
      // Purchase Cost and Selling Price: use adjustment override if present,
      // else fall back to persistent item master values.
      const finalSale = adj?.adjustedSaleBtl != null ? Number(adj.adjustedSaleBtl) : 0;
      const finalPurchaseCost = adj?.adjustedPurchaseCost != null
        ? Number(adj.adjustedPurchaseCost)
        : purchaseCost;
      const finalSellingPrice = adj?.adjustedSellingPrice != null
        ? Number(adj.adjustedSellingPrice)
        : sellingPrice;

      // Compute unitCost from the FINAL (adjusted) purchase cost, not the master.
      // BUG FIX: previously this used the master purchaseCost, which produced
      // wrong consumption when the adjusted cost differed from the master.
      const effectiveBottleSize = isSpirit ? 750 : bottleSize;
      const unitCost = isSpirit
        ? Math.round((finalPurchaseCost * 30 / effectiveBottleSize) * 1000000) / 1000000
        : finalPurchaseCost;
      // Display sale quantity from adjustment notes
      let displaySale = finalSale;
      if (adj?.notes) {
        try {
          const noteObj = JSON.parse(adj.notes);
          if (noteObj.displaySale != null) {
            displaySale = Number(noteObj.displaySale);
          }
        } catch { /* ignore invalid JSON */ }
      }
      const finalConsumption = adj?.adjustedConsumption != null
        ? Number(adj.adjustedConsumption)
        : 0;
      const finalSaleAmount = adj?.adjustedSaleAmount != null
        ? Number(adj.adjustedSaleAmount)
        : 0;
      const finalProfit = adj?.adjustedProfit != null
        ? Number(adj.adjustedProfit)
        : 0;

      // Update hasMissingSellingPrice based on the FINAL selling price
      hasMissingSellingPrice = finalSellingPrice <= 0;

      // Stock flow — use admin overrides if present, else snapshot-derived
      const finalOpening = adj?.adjustedOpeningBtl != null ? Number(adj.adjustedOpeningBtl) : snapOpeningBtl;
      const finalReceived = adj?.adjustedReceivedBtl != null ? Number(adj.adjustedReceivedBtl) : snapReceivedBtl;
      const finalStockBtl = Math.round((finalOpening + finalReceived) * 10000) / 10000;
      const finalSoldBtl = finalSale;
      const finalClosingBtl = adj?.adjustedClosingBtl != null
        ? Number(adj.adjustedClosingBtl)
        : Math.round((finalStockBtl - finalSoldBtl) * 10000) / 10000;

      acItems.push({
        sno: 0, // will be re-numbered after sort
        itemId: inv.id,
        itemName: inv.menuItem?.name || "Unknown",
        categoryName: inv.menuItem?.category?.name || "Uncategorized",
        qty: bottleSize,
        sale: finalSale,
        displaySale,
        saleMl: 0,
        purchaseCost: finalPurchaseCost,
        consumption: finalConsumption,
        sellingPrice: finalSellingPrice,
        saleAmount: finalSaleAmount,
        profit: finalProfit,
        // Stock flow (bottles) — admin-overridden or snapshot-derived
        opening: finalOpening,
        received: finalReceived,
        stock: finalStockBtl,
        sold: finalSoldBtl,
        closing: finalClosingBtl,
        hasMissingPrice: finalPurchaseCost <= 0,
        hasMissingBottleSize: bottleSize <= 0,
        hasMissingSellingPrice: hasMissingSellingPrice,  // from persistent item master
        isHidden: inv.isHiddenFromReport ?? false,
        hasAdjustment: !!adj,
        isSpirit,
        isBeer,
        unitCost,
      });
    }

    // Re-sort AC items by category then item name, and re-number S.No
    acItems.sort((a, b) => {
      const catCmp = a.categoryName.localeCompare(b.categoryName);
      if (catCmp !== 0) return catCmp;
      return a.itemName.localeCompare(b.itemName);
    });
    acItems.forEach((a, i) => { a.sno = i + 1; });

    // Non-AC items: load from non_ac_inventory_items + non_ac_daily_entries
    // Columns: S.No | Item Name | Qty | Opening | Received | Stock | Sold | Closing | Sale | Purchase Cost | Consumption | Selling Price | Sale Amount | Profit
    const nonAcInvItems = await prisma.nonAcInventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
    });
    const nonAcEntriesForDate = await prisma.nonAcDailyEntry.findMany({
      where: { restaurantId: barId, entryDate: reportDate },
    });
    const nonAcEntryMap = new Map(nonAcEntriesForDate.map(e => [e.itemId, e]));

    // Load previous day's Non-AC entries to get prev closing = today's opening
    const nonAcPrevEntries = await prisma.nonAcDailyEntry.findMany({
      where: { restaurantId: barId, entryDate: prevDate },
    });
    const nonAcPrevEntryMap = new Map(nonAcPrevEntries.map(e => [e.itemId, e]));

    const LIQUOR_CATS = new Set(['Beer', 'Whisky', 'Brandy', 'Vodka', 'Breezers', 'Rum', 'Gin', 'Wine']);
    // Include ALL active Non-AC inventory items in the report, EXCEPT soft drinks/beverages.
    // Only liquor items appear in the PDF-to-Admin report.
    const SOFT_DRINK_KEYWORDS_NA = ['soft drink', 'soft drinks', 'soda', 'water', 'juice', 'beverage', 'beverages'];
    const isNonAcSoftDrink = (item: any): boolean => {
      const catName = String(item.category || '').toLowerCase();
      const itemName = String(item.itemName || '').toLowerCase();
      return SOFT_DRINK_KEYWORDS_NA.some(k => catName === k || catName.includes(k)) ||
             SOFT_DRINK_KEYWORDS_NA.some(k => itemName.includes(k));
    };
    const nonAcItems = nonAcInvItems
      .filter((item) => !isNonAcSoftDrink(item))
      .map((item) => {
        const entry = nonAcEntryMap.get(item.id);
        const prevEntry = nonAcPrevEntryMap.get(item.id);
        const sale = entry ? Number(entry.adminDeduction) : 0;  // bottles sold (admin-entered)
        const bottleSize = Number(item.bottleSize) || 0;
        const purchaseCost = item.purchaseRate ? Number(item.purchaseRate) : 0;
        const consumption = Math.round(sale * purchaseCost * 100) / 100;  // Sale × Purchase Cost
        const sellingPrice = item.nonAcSellingPrice ? Number(item.nonAcSellingPrice) : 0;
        const saleAmount = Math.round(sale * sellingPrice * 100) / 100;  // Sale × Selling Price
        const profit = Math.round((saleAmount - consumption) * 100) / 100;

        // ── Stock flow (bottles) — from NonAcDailyEntry ──
        // Opening: today's entry openingBottles, or prev day's closingBottles,
        // or currentBottles from the item master (live stock from Main Inventory).
        // IMPORTANT: Fall back to currentBottles (NOT openingBottles) because
        // currentBottles is the live stock count that updates with each day's
        // closing, while openingBottles is a static field set at creation time.
        const opening = entry
          ? Number(entry.openingBottles)
          : prevEntry
            ? Number(prevEntry.closingBottles)
            : Number(item.currentBottles) || 0;
        const received = entry ? Number(entry.receivedBottles) : 0;
        const stock = Math.round((opening + received) * 100) / 100;
        const sold = sale;
        // Closing: use saved closingBottles if entry exists (may be admin-overridden),
        // otherwise calculate as Total Stock - Sold.
        const closing = entry
          ? Number(entry.closingBottles)
          : Math.round((stock - sold) * 100) / 100;

        return {
          sno: 0, // renumbered after sort below
          itemId: item.id,
          itemName: item.itemName,
          categoryName: item.category,
          qty: bottleSize,           // bottle size in ML
          sale,                      // bottles sold (admin-entered)
          purchaseCost,              // actual purchase cost from database
          consumption,               // Sale × Purchase Cost
          sellingPrice,              // admin-configured selling price
          saleAmount,                // Sale × Selling Price
          profit,                    // Sale Amount − Consumption
          // Stock flow (bottles)
          opening,
          received,
          stock,
          sold,
          closing,
          hasMissingPrice: purchaseCost <= 0,
          hasMissingSellingPrice: sellingPrice <= 0,
          isHidden: item.isHiddenFromReport ?? false,  // admin hide/show flag
        };
      });

    // Sort Non-AC items by category then item name, and assign S.No (matches AC behavior)
    nonAcItems.sort((a, b) => {
      const catCmp = (a.categoryName || '').localeCompare(b.categoryName || '');
      if (catCmp !== 0) return catCmp;
      return (a.itemName || '').localeCompare(b.itemName || '');
    });
    nonAcItems.forEach((n, i) => { n.sno = i + 1; });

    // Item-wise totals (visible items only — hidden items excluded from PDF totals)
    const visibleAcItems = acItems.filter(i => !i.isHidden);
    const acItemTotals: { consumption: number; saleAmount: number; profit: number; profitMarginPct: number } = {
      consumption: Math.round(visibleAcItems.reduce((s, i) => s + i.consumption, 0) * 100) / 100,
      saleAmount: Math.round(visibleAcItems.reduce((s, i) => s + i.saleAmount, 0) * 100) / 100,
      profit: Math.round(visibleAcItems.reduce((s, i) => s + i.profit, 0) * 100) / 100,
      profitMarginPct: 0,
    };
    acItemTotals.profitMarginPct = acItemTotals.consumption > 0
      ? Math.round(acItemTotals.profit / acItemTotals.consumption * 100 * 100) / 100
      : 0;

    const visibleNonAcItems = nonAcItems.filter(i => !i.isHidden);
    const nonAcItemTotals: { consumption: number; saleAmount: number; profit: number; profitMarginPct: number } = {
      consumption: Math.round(visibleNonAcItems.reduce((s, i) => s + i.consumption, 0) * 100) / 100,
      saleAmount: Math.round(visibleNonAcItems.reduce((s, i) => s + i.saleAmount, 0) * 100) / 100,
      profit: Math.round(visibleNonAcItems.reduce((s, i) => s + i.profit, 0) * 100) / 100,
      profitMarginPct: 0,
    };
    nonAcItemTotals.profitMarginPct = nonAcItemTotals.consumption > 0
      ? Math.round(nonAcItemTotals.profit / nonAcItemTotals.consumption * 100 * 100) / 100
      : 0;

    // ── Load manual PDF-only report items ──
    // These are admin-added items that do NOT exist in Main Inventory.
    // They appear in the AC or Non-AC section of the PDF based on their
    // `section` field. They do NOT affect inventory stock, deductions, or
    // the inventory master list.
    const manualItems = await prisma.manualReportItem.findMany({
      where: { restaurantId: barId, reportDate },
      orderBy: { createdAt: 'asc' },
    });
    for (const mi of manualItems) {
      const itemObj = {
        sno: 0, // will be re-numbered after sort
        itemId: `manual:${mi.id}`,
        itemName: mi.itemName,
        categoryName: mi.categoryName || (mi.section === 'AC' ? 'Manual AC' : 'Manual Non-AC'),
        qty: Number(mi.qty) || 0,
        sale: Number(mi.sale) || 0,
        displaySale: Number(mi.sale) || 0,
        saleMl: 0,
        purchaseCost: Number(mi.purchaseCost) || 0,
        consumption: Number(mi.consumption) || 0,
        sellingPrice: Number(mi.sellingPrice) || 0,
        saleAmount: Number(mi.saleAmount) || 0,
        profit: Number(mi.profit) || 0,
        opening: Number(mi.opening) || 0,
        received: Number(mi.received) || 0,
        stock: Math.round(((Number(mi.opening) || 0) + (Number(mi.received) || 0)) * 100) / 100,
        sold: Number(mi.sale) || 0,
        closing: Number(mi.closing) || 0,
        hasMissingPrice: (Number(mi.purchaseCost) || 0) <= 0,
        hasMissingBottleSize: (Number(mi.qty) || 0) <= 0,
        hasMissingSellingPrice: (Number(mi.sellingPrice) || 0) <= 0,
        isHidden: mi.isHidden,
        hasAdjustment: false,
        isManualItem: true, // flag so frontend knows this is a manual item
        manualItemId: mi.id, // original DB ID for save/delete operations
        isSpirit: false,
        isBeer: false,
        unitCost: Number(mi.purchaseCost) || 0, // manual items: unitCost = purchaseCost
      };
      if (mi.section === 'AC') {
        acItems.push(itemObj);
      } else {
        nonAcItems.push(itemObj);
      }
    }

    // Re-sort and re-number after adding manual items
    acItems.sort((a, b) => {
      const catCmp = (a.categoryName || '').localeCompare(b.categoryName || '');
      if (catCmp !== 0) return catCmp;
      return (a.itemName || '').localeCompare(b.itemName || '');
    });
    acItems.forEach((a, i) => { a.sno = i + 1; });

    nonAcItems.sort((a, b) => {
      const catCmp = (a.categoryName || '').localeCompare(b.categoryName || '');
      if (catCmp !== 0) return catCmp;
      return (a.itemName || '').localeCompare(b.itemName || '');
    });
    nonAcItems.forEach((n, i) => { n.sno = i + 1; });

    // Recalculate totals after adding manual items
    const visibleAcItemsAll = acItems.filter(i => !i.isHidden);
    acItemTotals.consumption = Math.round(visibleAcItemsAll.reduce((s, i) => s + i.consumption, 0) * 100) / 100;
    acItemTotals.saleAmount = Math.round(visibleAcItemsAll.reduce((s, i) => s + i.saleAmount, 0) * 100) / 100;
    acItemTotals.profit = Math.round(visibleAcItemsAll.reduce((s, i) => s + i.profit, 0) * 100) / 100;
    acItemTotals.profitMarginPct = acItemTotals.consumption > 0
      ? Math.round(acItemTotals.profit / acItemTotals.consumption * 100 * 100) / 100
      : 0;

    const visibleNonAcItemsAll = nonAcItems.filter(i => !i.isHidden);
    nonAcItemTotals.consumption = Math.round(visibleNonAcItemsAll.reduce((s, i) => s + i.consumption, 0) * 100) / 100;
    nonAcItemTotals.saleAmount = Math.round(visibleNonAcItemsAll.reduce((s, i) => s + i.saleAmount, 0) * 100) / 100;
    nonAcItemTotals.profit = Math.round(visibleNonAcItemsAll.reduce((s, i) => s + i.profit, 0) * 100) / 100;
    nonAcItemTotals.profitMarginPct = nonAcItemTotals.consumption > 0
      ? Math.round(nonAcItemTotals.profit / nonAcItemTotals.consumption * 100 * 100) / 100
      : 0;

    return {
      date: reportDate,
      outletName,
      outletWing,
      outletId: barId,
      hasAnyPhysicalCount,
      rows,
      categories,
      nonAcEntries,
      // Item-wise arrays for PDF detailed tables
      acItems,
      nonAcItems,
      acItemTotals,
      nonAcItemTotals,
      summary: summaryObj,
      // Return raw saved overrides separately so the frontend can re-apply
      // them on top of the combined API summary (which doesn't know about
      // overrides). Without this, the combined API overwrites saved values.
      // Also include the carry-forward openingStockValue from the previous
      // day's saved closingStockValue, so the frontend merge applies it.
      summaryOverrides: (() => {
        const overrides = { ...(summaryOverrides || {}) };
        // If the admin hasn't explicitly overridden today's openingStockValue,
        // but we have a valid prevDayClosingStockValue, include it as an
        // override so the frontend's { ...combined.summary, ...overrides }
        // merge picks it up instead of the computed (often wrong) value.
        if (prevDayClosingStockValue != null && overrides.openingStockValue == null) {
          overrides.openingStockValue = prevDayClosingStockValue;
        }
        return overrides;
      })(),
    };
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Liquor daily report failed:");
    throw error;
  }
}

// Helper: enumerate dates from startDate to endDate inclusive (YYYY-MM-DD)
function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const start = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  if (end < start) return [startDate]; // invalid range, fallback to single date
  const cur = new Date(start);
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Helper: aggregate multiple per-date report results into a single range report
function aggregateRangeResults(perDateResults: any[], startDate: string, endDate: string): any {
  if (perDateResults.length === 0) return null;
  if (perDateResults.length === 1) return { ...perDateResults[0], date: startDate, endDate, isRange: true };

  const first = perDateResults[0];
  const last = perDateResults[perDateResults.length - 1];

  // Aggregate AC items by itemId — opening from first date, closing from last date, sum sales/consumption
  const acItemMap = new Map<string, any>();
  for (const result of perDateResults) {
    for (const item of (result.acItems || [])) {
      const existing = acItemMap.get(item.itemId);
      if (existing) {
        existing.sale = Math.round((Number(existing.sale) + Number(item.sale)) * 10000) / 10000;
        existing.saleMl = Math.round((Number(existing.saleMl) + Number(item.saleMl)) * 100) / 100;
        existing.consumption = Math.round((Number(existing.consumption) + Number(item.consumption)) * 100) / 100;
        existing.saleAmount = Math.round((Number(existing.saleAmount) + Number(item.saleAmount)) * 100) / 100;
        existing.profit = Math.round((Number(existing.profit) + Number(item.profit)) * 100) / 100;
        existing.received = Math.round((Number(existing.received) + Number(item.received)) * 10000) / 10000;
        existing.sold = Math.round((Number(existing.sold) + Number(item.sold)) * 10000) / 10000;
        // Opening = first date's opening; Closing = last date's closing
        existing.opening = Number(perDateResults[0].acItems.find((i: any) => i.itemId === item.itemId)?.opening ?? existing.opening);
        existing.closing = Number(item.closing);
        existing.stock = Math.round((Number(existing.opening) + Number(existing.received)) * 10000) / 10000;
      } else {
        acItemMap.set(item.itemId, { ...item });
      }
    }
  }
  const aggregatedAcItems = [...acItemMap.values()];
  aggregatedAcItems.sort((a, b) => {
    const catCmp = (a.categoryName || '').localeCompare(b.categoryName || '');
    if (catCmp !== 0) return catCmp;
    return (a.itemName || '').localeCompare(b.itemName || '');
  });
  aggregatedAcItems.forEach((a, i) => { a.sno = i + 1; });

  // Aggregate Non-AC items by itemId
  const nonAcItemMap = new Map<string, any>();
  for (const result of perDateResults) {
    for (const item of (result.nonAcItems || [])) {
      const existing = nonAcItemMap.get(item.itemId);
      if (existing) {
        existing.sale = Math.round((Number(existing.sale) + Number(item.sale)) * 10000) / 10000;
        existing.consumption = Math.round((Number(existing.consumption) + Number(item.consumption)) * 100) / 100;
        existing.saleAmount = Math.round((Number(existing.saleAmount) + Number(item.saleAmount)) * 100) / 100;
        existing.profit = Math.round((Number(existing.profit) + Number(item.profit)) * 100) / 100;
        existing.received = Math.round((Number(existing.received) + Number(item.received)) * 10000) / 10000;
        existing.sold = Math.round((Number(existing.sold) + Number(item.sold)) * 10000) / 10000;
        existing.opening = Number(perDateResults[0].nonAcItems.find((i: any) => i.itemId === item.itemId)?.opening ?? existing.opening);
        existing.closing = Number(item.closing);
        existing.stock = Math.round((Number(existing.opening) + Number(existing.received)) * 10000) / 10000;
      } else {
        nonAcItemMap.set(item.itemId, { ...item });
      }
    }
  }
  const aggregatedNonAcItems = [...nonAcItemMap.values()];
  aggregatedNonAcItems.sort((a, b) => {
    const catCmp = (a.categoryName || '').localeCompare(b.categoryName || '');
    if (catCmp !== 0) return catCmp;
    return (a.itemName || '').localeCompare(b.itemName || '');
  });
  aggregatedNonAcItems.forEach((n, i) => { n.sno = i + 1; });

  // Aggregate item totals
  const acItemTotals = {
    consumption: Math.round(aggregatedAcItems.reduce((s, i) => s + i.consumption, 0) * 100) / 100,
    saleAmount: Math.round(aggregatedAcItems.reduce((s, i) => s + i.saleAmount, 0) * 100) / 100,
    profit: Math.round(aggregatedAcItems.reduce((s, i) => s + i.profit, 0) * 100) / 100,
    profitMarginPct: 0,
  };
  acItemTotals.profitMarginPct = acItemTotals.consumption > 0
    ? Math.round(acItemTotals.profit / acItemTotals.consumption * 100 * 100) / 100 : 0;

  const nonAcItemTotals = {
    consumption: Math.round(aggregatedNonAcItems.reduce((s, i) => s + i.consumption, 0) * 100) / 100,
    saleAmount: Math.round(aggregatedNonAcItems.reduce((s, i) => s + i.saleAmount, 0) * 100) / 100,
    profit: Math.round(aggregatedNonAcItems.reduce((s, i) => s + i.profit, 0) * 100) / 100,
    profitMarginPct: 0,
  };
  nonAcItemTotals.profitMarginPct = nonAcItemTotals.consumption > 0
    ? Math.round(nonAcItemTotals.profit / nonAcItemTotals.consumption * 100 * 100) / 100 : 0;

  // Aggregate summary — sum across dates, opening from first, closing from last
  const sumField = (field: string) => Math.round(perDateResults.reduce((s, r) => s + (Number(r.summary?.[field]) || 0), 0) * 100) / 100;
  const aggregatedSummary = {
    ...first.summary,
    totalOpeningStockValue: Number(first.summary?.totalOpeningStockValue || 0),
    totalClosingStockValue: Number(last.summary?.totalClosingStockValue || 0),
    totalGrossSales: sumField('totalGrossSales'),
    totalGrossProfit: sumField('totalGrossProfit'),
    totalAcRevenue: sumField('totalAcRevenue'),
    totalNonAcRevenue: sumField('totalNonAcRevenue'),
    totalAcProfit: sumField('totalAcProfit'),
    totalNonAcProfit: sumField('totalNonAcProfit'),
    totalAcConsumptionCost: sumField('totalAcConsumptionCost'),
    totalNonAcConsumptionCost: sumField('totalNonAcConsumptionCost'),
  };

  return {
    date: startDate,
    endDate,
    isRange: true,
    dateRange: `${startDate} → ${endDate}`,
    outletName: first.outletName,
    outletWing: first.outletWing,
    outletId: first.outletId,
    hasAnyPhysicalCount: perDateResults.some(r => r.hasAnyPhysicalCount),
    rows: [], // not used by frontend in range mode
    categories: [], // not used by frontend in range mode
    nonAcEntries: first.nonAcEntries,
    acItems: aggregatedAcItems,
    nonAcItems: aggregatedNonAcItems,
    acItemTotals,
    nonAcItemTotals,
    summary: aggregatedSummary,
  };
}

router.get("/liquor-daily-report", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }

    const { date, endDate } = req.query as { date?: string; endDate?: string };
    const reportDate = date || getKolkataDateString();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }

    // Date range mode: aggregate across all dates from reportDate to endDate
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate !== reportDate) {
      const dates = enumerateDates(reportDate, endDate);
      const perDateResults: any[] = [];
      for (const d of dates) {
        try {
          const result = await buildLiquorReportForDate(barId, d);
          perDateResults.push(result);
        } catch (e) {
          logger.error({ err: e, date: d }, "[BarInventory] Range sub-date failed:");
        }
      }
      const aggregated = aggregateRangeResults(perDateResults, reportDate, endDate);
      if (!aggregated) {
        res.status(500).json({ error: "No data available for the selected date range" });
        return;
      }
      res.json(aggregated);
      return;
    }

    // Single-date mode
    const result = await buildLiquorReportForDate(barId, reportDate);
    res.json(result);
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Liquor daily report failed:");
    res.status(500).json({ error: error.message || "Failed to generate liquor daily report" });
  }
});

// ==========================================
// GET /api/bar/inventory/liquor-report-non-ac
// Returns saved Non-AC manual entries for a date
// ==========================================
router.get("/liquor-report-non-ac", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }
    const { date } = req.query as { date?: string };
    const reportDate = date || getKolkataDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }
    const entries = await prisma.liquorReportNonAcEntry.findMany({
      where: { restaurantId: barId, reportDate },
    });
    res.json({ date: reportDate, entries });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Get Non-AC entries failed:");
    res.status(500).json({ error: error.message || "Failed to fetch Non-AC entries" });
  }
});

// ==========================================
// POST /api/bar/inventory/liquor-report-non-ac
// Save/Update Non-AC manual entries + summary overrides for a date
// Body: { date, entries: [{ categoryName, nonAcSales, nonAcLandingCost, notes? }], summaryOverrides?: {...} }
// ==========================================
router.post("/liquor-report-non-ac", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }
    const { date, entries, summaryOverrides } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }
    if (!Array.isArray(entries)) {
      res.status(400).json({ error: "entries must be an array" });
      return;
    }
    const userId = req.user?.userId || req.user?.id || 'system';

    // Wrap all save operations in a transaction so that if any write fails,
    // the entire save is rolled back. This prevents partial saves where
    // __SUMMARY__ is saved but category entries are not (or vice versa).
    const results = await prisma.$transaction(async (tx) => {
      // Save summary overrides as a special __SUMMARY__ entry (notes = JSON)
      // MERGE with existing overrides instead of replacing the entire JSON.
      // This prevents data loss when the frontend only sends edited fields —
      // previously saved fields (e.g. closingStockValue from a prior save)
      // are preserved and only the newly submitted fields are updated.
      if (summaryOverrides && typeof summaryOverrides === 'object') {
        // Load existing __SUMMARY__ to merge
        const existingSummary = await tx.liquorReportNonAcEntry.findFirst({
          where: { restaurantId: barId, reportDate: date, categoryName: '__SUMMARY__' },
        });
        let mergedOverrides: Record<string, number> = {};
        if (existingSummary) {
          try {
            mergedOverrides = JSON.parse(existingSummary.notes || '{}');
          } catch { /* start fresh if corrupt */ }
        }
        // Merge new overrides on top of existing (new values win)
        for (const [key, val] of Object.entries(summaryOverrides)) {
          if (typeof val === 'number' && !Number.isNaN(val)) {
            mergedOverrides[key] = val;
          }
        }
        await tx.liquorReportNonAcEntry.upsert({
          where: {
            restaurantId_reportDate_categoryName: {
              restaurantId: barId,
              reportDate: date,
              categoryName: '__SUMMARY__',
            },
          },
          create: {
            restaurantId: barId,
            reportDate: date,
            categoryName: '__SUMMARY__',
            nonAcSales: 0,
            nonAcLandingCost: 0,
            notes: JSON.stringify(mergedOverrides),
            createdBy: userId,
          },
          update: {
            notes: JSON.stringify(mergedOverrides),
            updatedBy: userId,
          },
        });
      }

      // Upsert each entry
      const entryResults = [];
      for (const entry of entries) {
        const { categoryName, nonAcSales, nonAcLandingCost, notes } = entry;
        if (!categoryName || typeof categoryName !== 'string') continue;
        const sales = Math.max(0, Number(nonAcSales) || 0);
        const cost = Math.max(0, Number(nonAcLandingCost) || 0);

        const result = await tx.liquorReportNonAcEntry.upsert({
          where: {
            restaurantId_reportDate_categoryName: {
              restaurantId: barId,
              reportDate: date,
              categoryName,
            },
          },
          create: {
            restaurantId: barId,
            reportDate: date,
            categoryName,
            nonAcSales: sales,
            nonAcLandingCost: cost,
            notes: notes || null,
            createdBy: userId,
          },
          update: {
            nonAcSales: sales,
            nonAcLandingCost: cost,
            notes: notes || null,
            updatedBy: userId,
          },
        });
        entryResults.push(result);
      }

      // Delete entries not in the payload (for this date), except __SUMMARY__
      const submittedCategories = entries.map((e: any) => e.categoryName).filter(Boolean);
      await tx.liquorReportNonAcEntry.deleteMany({
        where: {
          restaurantId: barId,
          reportDate: date,
          categoryName: { notIn: [...submittedCategories, '__SUMMARY__'] },
        },
      });

      return entryResults;
    });

    logger.info(`[BarInventory] Save Non-AC: date=${date}, entries=${results.length}, summaryOverrides=${summaryOverrides ? Object.keys(summaryOverrides).join(',') : 'none'}`);
    res.json({ date, saved: results.length, entries: results });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Save Non-AC entries failed:");
    res.status(500).json({ error: error.message || "Failed to save Non-AC entries" });
  }
});

// ==========================================
// POST /api/bar/inventory/manual-report-items
// Save manual PDF-only report items for a specific date.
// These items do NOT exist in Main Inventory — they are report-only.
// Body: {
//   date: "YYYY-MM-DD",
//   items: [{ id?, section, itemName, categoryName?, qty, sale, purchaseCost, sellingPrice, consumption, saleAmount, profit, opening, received, closing, isHidden }]
// }
// Items with an `id` are updated; items without an `id` are created.
// Items not in the payload are deleted (for that date).
// ==========================================
router.post("/manual-report-items", async (req: any, res: any) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }
    const { date, items } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }
    if (!Array.isArray(items)) {
      res.status(400).json({ error: "items must be an array" });
      return;
    }
    const userId = req.user?.userId || req.user?.id || 'system';

    const result = await prisma.$transaction(async (tx) => {
      const savedIds: string[] = [];
      for (const item of items) {
        const section = item.section === 'AC' ? 'AC' : 'NON_AC';
        const data = {
          restaurantId: barId,
          reportDate: date,
          section,
          itemName: String(item.itemName || '').trim() || 'Unnamed Item',
          categoryName: item.categoryName || null,
          qty: Math.max(0, Number(item.qty) || 0),
          sale: Math.max(0, Number(item.sale) || 0),
          purchaseCost: Math.max(0, Number(item.purchaseCost) || 0),
          sellingPrice: Math.max(0, Number(item.sellingPrice) || 0),
          consumption: Math.max(0, Number(item.consumption) || 0),
          saleAmount: Math.max(0, Number(item.saleAmount) || 0),
          profit: Number(item.profit) || 0,
          opening: Math.max(0, Number(item.opening) || 0),
          received: Math.max(0, Number(item.received) || 0),
          closing: Math.max(0, Number(item.closing) || 0),
          isHidden: Boolean(item.isHidden),
          createdBy: userId,
        };

        if (item.id) {
          // Update existing — use upsert so a stale/missing id does not
          // abort the whole transaction with "Record to update not found".
          // If the record was deleted in another session, we recreate it.
          const upserted = await tx.manualReportItem.upsert({
            where: { id: item.id },
            update: { ...data, createdBy: undefined },
            create: data,
          });
          savedIds.push(upserted.id);
        } else {
          // Create new
          const created = await tx.manualReportItem.create({ data });
          savedIds.push(created.id);
        }
      }

      // Delete items not in the payload (for this date)
      await tx.manualReportItem.deleteMany({
        where: {
          restaurantId: barId,
          reportDate: date,
          id: { notIn: savedIds },
        },
      });

      return savedIds;
    });

    logger.info(`[BarInventory] Save manual items: date=${date}, saved=${result.length}`);
    res.json({ date, saved: result.length });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Save manual report items failed:");
    res.status(500).json({ error: error.message || "Failed to save manual report items" });
  }
});

// ==========================================
// POST /api/bar/inventory/liquor-report-item-wise
// Save item-wise edits for both Non-AC and AC tables.
// Body: {
//   date: "YYYY-MM-DD",
//   nonAcItems: [{ itemId, bottleSize, sale, purchaseRate, sellingPrice }],
//   acAdjustments: [{ itemId, adjustedSaleBtl, adjustedPurchaseCost, adjustedSellingPrice, adjustedConsumption, adjustedSaleAmount, adjustedProfit }]
// }
// Non-AC edits persist to non_ac_inventory_items + non_ac_daily_entries.
// AC edits persist to ac_report_adjustments (separate from POS data).
// ==========================================
router.post("/liquor-report-item-wise", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) {
      res.status(400).json({ error: "Restaurant context required" });
      return;
    }
    const { date, endDate, nonAcItems, acAdjustments } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }
    // When endDate is provided (range mode), adjustments are saved against the end date
    // of the range — this is the "as of" date for the report.
    const saveDate = (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) ? endDate : date;
    const userId = req.user?.userId || req.user?.id || 'system';

    // ── ALL saves in a single transaction ──
    // If any operation fails, the entire save is rolled back.
    // No partial saves. The frontend retains pending edits on failure.
    //
    // Performance: combine multiple updates to the same InventoryItem into a
    // single update call, and batch Promise.all to avoid overwhelming Prisma's
    // transaction connection pool (which caused "Failed to fetch" timeouts).
    // Smaller batch size + longer timeout for large saves with 200+ items.
    // Batch size 25 is safe with pre-fetched data (no N+1 queries).
    const BATCH_SIZE = 25;
    async function batchedAll(ops: Promise<void>[]): Promise<void> {
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        await Promise.all(ops.slice(i, i + BATCH_SIZE));
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      let nonAcCount = 0;
      let acCount = 0;

      // ── Pre-fetch data to avoid N+1 queries inside the loops ──
      // For AC snapshot sync: need bottleSize for each item. Use the adjustment's
      // adjustedBottleSize if provided, otherwise look up from inventory items.
      const acItemIds = (acAdjustments || []).map((a: any) => a.itemId).filter(Boolean) as string[];
      const acItemsMap = new Map<string, { bottleSize: number; menuItemName: string }>();
      if (acItemIds.length > 0) {
        const acInvItems = await tx.inventoryItem.findMany({
          where: { id: { in: acItemIds }, restaurantId: barId },
          select: { id: true, bottleSize: true, menuItem: { select: { name: true } } },
        });
        for (const inv of acInvItems) {
          acItemsMap.set(inv.id, {
            bottleSize: Number(inv.bottleSize) || 0,
            menuItemName: inv.menuItem?.name ?? 'Unknown',
          });
        }
      }

      // Pre-fetch all existing snapshots for saveDate in one query
      const existingSnaps = await tx.dailyInventorySnapshot.findMany({
        where: { restaurantId: barId, snapshotDate: saveDate, itemId: { in: acItemIds } },
      });
      const snapMap = new Map<string, any>();
      for (const snap of existingSnaps) snapMap.set(snap.itemId, snap);

      // Pre-fetch next-day snapshots for items with closing edits
      const itemsWithClosingEdit = (acAdjustments || []).
        filter((a: any) => a.adjustedClosingBtl != null && a.itemId).
        map((a: any) => a.itemId) as string[];
      const nextDateObj = new Date(saveDate + 'T00:00:00');
      nextDateObj.setDate(nextDateObj.getDate() + 1);
      const nextDateStr = nextDateObj.toISOString().slice(0, 10);
      const nextSnaps = itemsWithClosingEdit.length > 0
        ? await tx.dailyInventorySnapshot.findMany({
            where: { restaurantId: barId, snapshotDate: nextDateStr, itemId: { in: itemsWithClosingEdit } },
          })
        : [];
      const nextSnapMap = new Map<string, any>();
      for (const snap of nextSnaps) nextSnapMap.set(snap.itemId, snap);

      // Pre-fetch all Non-AC daily entries for saveDate to avoid N+1 inside the loop
      const nonAcItemIds = (nonAcItems || []).map((e: any) => e.itemId).filter(Boolean) as string[];
      const nonAcExistingEntries = nonAcItemIds.length > 0
        ? await tx.nonAcDailyEntry.findMany({
            where: { restaurantId: barId, entryDate: saveDate, itemId: { in: nonAcItemIds } },
          })
        : [];
      const nonAcEntryMap = new Map<string, any>();
      for (const entry of nonAcExistingEntries) nonAcEntryMap.set(entry.itemId, entry);

      // ── Non-AC: persist to non_ac_inventory_items + non_ac_daily_entries ──
      // OPTIMIZATION: Only process items that are in the payload (frontend now
      // sends only dirty items). Merge master field update + currentBottles sync
      // into a SINGLE update call to halve the DB operations.
      if (Array.isArray(nonAcItems)) {
        const nonAcOps: Promise<void>[] = [];
        for (const edit of nonAcItems) {
          if (!edit.itemId) continue;
          const bottleSize = edit.bottleSize != null ? Math.max(0, Number(edit.bottleSize)) : undefined;
          const purchaseRate = edit.purchaseRate != null ? Math.max(0, Number(edit.purchaseRate)) : undefined;
          const sellingPrice = edit.sellingPrice != null ? Math.max(0, Number(edit.sellingPrice)) : undefined;
          const sale = edit.sale != null ? Math.max(0, Number(edit.sale)) : undefined;
          const isHidden = edit.isHidden != null ? Boolean(edit.isHidden) : undefined;

          // Update/create the daily entry first (need closingBtl for currentBottles sync)
          if (sale !== undefined || edit.opening != null || edit.received != null || edit.closingOverride != null) {
            nonAcOps.push(
              (async () => {
                const existing = nonAcEntryMap.get(edit.itemId);
                const openingBtl = edit.opening != null ? Math.max(0, Number(edit.opening)) : (existing ? Number(existing.openingBottles) : 0);
                const receivedBtl = edit.received != null ? Math.max(0, Number(edit.received)) : (existing ? Number(existing.receivedBottles) : 0);
                const saleBtl = sale ?? (existing ? Number(existing.adminDeduction) : 0);
                // Use admin override if provided, otherwise auto-calculate
                const closingBtl = edit.closingOverride != null
                  ? Math.round(Math.max(0, Number(edit.closingOverride)) * 100) / 100
                  : Math.round((openingBtl + receivedBtl - saleBtl) * 100) / 100;
                const entryData: any = {
                  adminDeduction: saleBtl,
                  openingBottles: openingBtl,
                  receivedBottles: receivedBtl,
                  closingBottles: closingBtl,
                };
                if (existing) {
                  await tx.nonAcDailyEntry.update({
                    where: { id: existing.id },
                    data: entryData,
                  });
                } else {
                  await tx.nonAcDailyEntry.create({
                    data: {
                      restaurantId: barId,
                      itemId: edit.itemId,
                      entryDate: saveDate,
                      ...entryData,
                      createdBy: userId,
                    },
                  });
                }
                // Merge currentBottles sync WITH the master field update into
                // a SINGLE update call (previously two separate updates).
                const mergedUpdate: any = { currentBottles: closingBtl };
                if (bottleSize !== undefined) mergedUpdate.bottleSize = bottleSize;
                if (purchaseRate !== undefined) mergedUpdate.purchaseRate = purchaseRate;
                if (sellingPrice !== undefined) mergedUpdate.nonAcSellingPrice = sellingPrice;
                if (isHidden !== undefined) mergedUpdate.isHiddenFromReport = isHidden;
                await tx.nonAcInventoryItem.update({
                  where: { id: edit.itemId },
                  data: mergedUpdate,
                });
              })().then(() => {})
            );
          } else {
            // No daily entry update needed — still update master fields if any
            const updateData: any = {};
            if (bottleSize !== undefined) updateData.bottleSize = bottleSize;
            if (purchaseRate !== undefined) updateData.purchaseRate = purchaseRate;
            if (sellingPrice !== undefined) updateData.nonAcSellingPrice = sellingPrice;
            if (isHidden !== undefined) updateData.isHiddenFromReport = isHidden;
            if (Object.keys(updateData).length > 0) {
              nonAcOps.push(tx.nonAcInventoryItem.update({
                where: { id: edit.itemId },
                data: updateData,
              }).then(() => {}));
            }
          }
          nonAcCount++;
        }
        // Execute Non-AC ops in batches of BATCH_SIZE to avoid connection pool exhaustion
        await batchedAll(nonAcOps);
      }

      // ── AC: persist to ac_report_adjustments + InventoryItem + DailyInventorySnapshot ──
      // The snapshot update is CRITICAL for Inventory page ↔ PDF preview sync.
      // Without it, the Inventory page (which reads snapshots) would never see
      // the admin's PDF preview edits (which are stored in ac_report_adjustments).
      if (Array.isArray(acAdjustments)) {
        const acOps: Promise<void>[] = [];
        for (const adj of acAdjustments) {
          if (!adj.itemId) continue;
          const data: any = { createdBy: userId };
          if (adj.adjustedSaleBtl != null) data.adjustedSaleBtl = Math.max(0, Number(adj.adjustedSaleBtl));
          if (adj.adjustedPurchaseCost != null) data.adjustedPurchaseCost = Math.max(0, Number(adj.adjustedPurchaseCost));
          if (adj.adjustedSellingPrice != null) data.adjustedSellingPrice = Math.max(0, Number(adj.adjustedSellingPrice));
          if (adj.adjustedConsumption != null) data.adjustedConsumption = Number(adj.adjustedConsumption);
          if (adj.adjustedSaleAmount != null) data.adjustedSaleAmount = Number(adj.adjustedSaleAmount);
          if (adj.adjustedProfit != null) data.adjustedProfit = Number(adj.adjustedProfit);
          if (adj.adjustedOpeningBtl != null) data.adjustedOpeningBtl = Math.max(0, Number(adj.adjustedOpeningBtl));
          if (adj.adjustedReceivedBtl != null) data.adjustedReceivedBtl = Math.max(0, Number(adj.adjustedReceivedBtl));
          if (adj.adjustedClosingBtl != null) data.adjustedClosingBtl = Math.max(0, Number(adj.adjustedClosingBtl));
          if (adj.notes) data.notes = String(adj.notes);

          // 1. Upsert the per-date adjustment record
          acOps.push(tx.acReportAdjustment.upsert({
            where: { restaurantId_itemId_entryDate: { restaurantId: barId, itemId: adj.itemId, entryDate: saveDate } },
            create: {
              restaurantId: barId,
              itemId: adj.itemId,
              entryDate: saveDate,
              ...data,
            },
            update: data,
          }).then(() => {}));

          // 2. Combine ALL InventoryItem field updates into a SINGLE update call
          //    (previously 4 separate updates per item → caused ~440 ops in one
          //    Promise.all, overwhelming Prisma's transaction connection and
          //    triggering Railway proxy timeout → "Failed to fetch")
          const invUpdateData: any = {};
          if (adj.adjustedSellingPrice != null) invUpdateData.acSellingPrice = Math.max(0, Number(adj.adjustedSellingPrice));
          if (adj.adjustedPurchaseCost != null) invUpdateData.costPerBottle = Math.max(0, Number(adj.adjustedPurchaseCost));
          if (adj.adjustedBottleSize != null && Number(adj.adjustedBottleSize) > 0) invUpdateData.bottleSize = Math.max(0, Number(adj.adjustedBottleSize));
          if (adj.isHidden != null) invUpdateData.isHiddenFromReport = Boolean(adj.isHidden);
          if (Object.keys(invUpdateData).length > 0) {
            acOps.push(tx.inventoryItem.update({
              where: { id: adj.itemId },
              data: invUpdateData,
            }).then(() => {}));
          }

          // 3. Sync to DailyInventorySnapshot — this is what the Inventory page reads.
          //    Uses pre-fetched data (acItemsMap, snapMap, nextSnapMap) to avoid N+1 queries.
          const hasSnapshotUpdate =
            adj.adjustedSaleBtl != null ||
            adj.adjustedOpeningBtl != null ||
            adj.adjustedReceivedBtl != null ||
            adj.adjustedClosingBtl != null;
          if (hasSnapshotUpdate) {
            acOps.push(
              (async () => {
                // Use pre-fetched item data (bottleSize + name)
                const invMeta = acItemsMap.get(adj.itemId);
                const btlSize = adj.adjustedBottleSize != null && Number(adj.adjustedBottleSize) > 0
                  ? Number(adj.adjustedBottleSize)
                  : (invMeta?.bottleSize || 0);
                if (btlSize <= 0) return;

                // Use pre-fetched existing snapshot
                const existingSnap = snapMap.get(adj.itemId);

                const openingMl = adj.adjustedOpeningBtl != null
                  ? Math.round(Number(adj.adjustedOpeningBtl) * btlSize * 100) / 100
                  : (existingSnap ? Number(existingSnap.openingStock) : 0);
                const purchasedMl = adj.adjustedReceivedBtl != null
                  ? Math.round(Number(adj.adjustedReceivedBtl) * btlSize * 100) / 100
                  : (existingSnap ? Number(existingSnap.purchased) : 0);
                const soldMl = adj.adjustedSaleBtl != null
                  ? Math.round(Number(adj.adjustedSaleBtl) * btlSize * 100) / 100
                  : (existingSnap ? Number(existingSnap.sold) : 0);
                const closingMl = adj.adjustedClosingBtl != null
                  ? Math.round(Number(adj.adjustedClosingBtl) * btlSize * 100) / 100
                  : (existingSnap ? Number(existingSnap.closingStock) : Math.round((openingMl + purchasedMl - soldMl) * 100) / 100);

                await tx.dailyInventorySnapshot.upsert({
                  where: {
                    restaurantId_snapshotDate_itemId: {
                      restaurantId: barId,
                      snapshotDate: saveDate,
                      itemId: adj.itemId,
                    },
                  },
                  create: {
                    restaurantId: barId,
                    itemId: adj.itemId,
                    snapshotDate: saveDate,
                    itemName: invMeta?.menuItemName ?? "Unknown",
                    openingStock: openingMl,
                    purchased: purchasedMl,
                    sold: soldMl,
                    wastage: existingSnap ? existingSnap.wastage : new Prisma.Decimal(0),
                    adjusted: existingSnap ? existingSnap.adjusted : new Prisma.Decimal(0),
                    closingStock: closingMl,
                  },
                  update: {
                    openingStock: openingMl,
                    purchased: purchasedMl,
                    sold: soldMl,
                    closingStock: closingMl,
                  },
                });

                // ── Rollover: update NEXT day's openingStock to match this day's closing ──
                // Uses pre-fetched nextSnapMap to avoid per-item lookup.
                if (adj.adjustedClosingBtl != null) {
                  const nextSnap = nextSnapMap.get(adj.itemId);
                  if (nextSnap) {
                    const nextPurchased = Number(nextSnap.purchased);
                    const nextSold = Number(nextSnap.sold);
                    const nextWastage = Number(nextSnap.wastage);
                    const nextAdjusted = Number(nextSnap.adjusted);
                    const nextClosing = Math.round((closingMl + nextPurchased - nextSold - nextWastage + nextAdjusted) * 100) / 100;

                    await tx.dailyInventorySnapshot.update({
                      where: { id: nextSnap.id },
                      data: {
                        openingStock: closingMl,
                        closingStock: nextClosing,
                      },
                    });
                  }
                  // If no next-day snapshot exists, the combined inventory API will
                  // fall back to prevSnap.closingStock for opening, so the rollover
                  // happens automatically via the read path.
                }
              })().then(() => {})
            );
          }

          acCount++;
        }
        // Execute AC ops in batches of BATCH_SIZE
        await batchedAll(acOps);
      }

      return { nonAcCount, acCount };
    }, {
      // 60s is plenty with dirty checking — only changed items are saved
      timeout: 60000,
    });

    res.json({
      date,
      nonAcSaved: result.nonAcCount,
      acSaved: result.acCount,
      message: `Saved ${result.nonAcCount} Non-AC item(s) and ${result.acCount} AC adjustment(s)`,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Save item-wise report edits failed:");
    res.status(500).json({ error: error.message || "Failed to save item-wise edits" });
  }
});

// ==========================================
// NON-AC BAR INVENTORY — Separate stock pool
// AC stock is system-controlled (ml, via POS deductions).
// Non-AC stock is admin-controlled (bottles, manual deductions).
// These are two separate stock pools for the same item brand.
// ==========================================

// GET /api/bar/inventory/non-ac/items
// List all Non-AC inventory items with today's daily entry
router.get("/non-ac/items", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const today = getKolkataDateString();
    const { date } = req.query as { date?: string };
    const targetDate = date || today;

    const items = await prisma.nonAcInventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      orderBy: [{ category: "asc" }, { itemName: "asc" }],
    });

    const entries = await prisma.nonAcDailyEntry.findMany({
      where: { restaurantId: barId, entryDate: targetDate },
    });
    const entryMap = new Map(entries.map(e => [e.itemId, e]));

    // Previous day entries for continuity check
    const [py, pm, pd] = targetDate.split("-").map(Number);
    const prevDateObj = new Date(Date.UTC(py, pm - 1, pd - 1));
    const prevDate = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getUTCDate()).padStart(2, "0")}`;
    const prevEntries = await prisma.nonAcDailyEntry.findMany({
      where: { restaurantId: barId, entryDate: prevDate },
    });
    const prevEntryMap = new Map(prevEntries.map(e => [e.itemId, e]));

    const rows = items.map(item => {
      const entry = entryMap.get(item.id);
      const prevEntry = prevEntryMap.get(item.id);
      const isToday = targetDate === today;

      let openingBottles: number;
      let receivedBottles: number;
      let adminDeduction: number;
      let closingBottles: number;

      if (entry) {
        openingBottles = Number(entry.openingBottles);
        receivedBottles = Number(entry.receivedBottles);
        adminDeduction = Number(entry.adminDeduction);
        closingBottles = Number(entry.closingBottles);
      } else if (isToday) {
        // Carry forward from previous day closing, or use item's openingBottles
        openingBottles = prevEntry ? Number(prevEntry.closingBottles) : Number(item.openingBottles);
        receivedBottles = 0;
        adminDeduction = 0;
        closingBottles = openingBottles;
      } else {
        openingBottles = prevEntry ? Number(prevEntry.closingBottles) : Number(item.openingBottles);
        receivedBottles = 0;
        adminDeduction = 0;
        closingBottles = openingBottles;
      }

      return {
        id: item.id,
        itemName: item.itemName,
        category: item.category,
        bottleSize: item.bottleSize,
        unit: item.unit,
        openingBottles,
        receivedBottles,
        adminDeduction,
        closingBottles,
        purchaseRate: item.purchaseRate ? Number(item.purchaseRate) : null,
        nonAcSellingPrice: item.nonAcSellingPrice ? Number(item.nonAcSellingPrice) : null,
        acInventoryItemId: item.acInventoryItemId,
        needsConfirmation: item.needsConfirmation,
        notes: item.notes,
        stockValue: item.purchaseRate ? Math.round(closingBottles * Number(item.purchaseRate) * 100) / 100 : null,
        potentialSalesValue: item.nonAcSellingPrice ? Math.round(closingBottles * Number(item.nonAcSellingPrice) * 100) / 100 : null,
        prevDayClosing: prevEntry ? Number(prevEntry.closingBottles) : null,
        continuityOk: prevEntry ? Math.abs(Number(prevEntry.closingBottles) - openingBottles) < 0.01 : true,
      };
    });

    res.json({ date: targetDate, items: rows });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Non-AC items fetch failed:");
    res.status(500).json({ error: error.message || "Failed to fetch Non-AC items" });
  }
});

// GET /api/bar/inventory/non-ac/combined
// Combined AC + Non-AC view for the main inventory table
router.get("/non-ac/combined", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const today = getKolkataDateString();
    const { date, fromDate: qFromDate, toDate: qToDate } = req.query as { date?: string; fromDate?: string; toDate?: string };

    // Support date-range queries: fromDate = start, toDate = end.
    // Falls back to single `date` param for backward compatibility.
    const fromDate = qFromDate || date || today;
    const toDate = qToDate || fromDate;

    // Load AC items
    const acItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      include: { menuItem: { select: { name: true, basePrice: true, category: { select: { name: true } } } } },
    });

    // Load AC report adjustments for the date range.
    // Used ONLY for sale amount (₹) overrides — stock values come from
    // DailyInventorySnapshot which both edit paths update. This ensures
    // the Inventory page's Business Position acSales matches the PDF preview
    // after admin edits, while stock values remain snapshot-driven.
    const acAdjustments = await prisma.acReportAdjustment.findMany({
      where: { restaurantId: barId, entryDate: { gte: fromDate, lte: toDate } },
    });
    const acAdjMap = new Map<string, any>();
    {
      const byItem = new Map<string, any[]>();
      for (const a of acAdjustments) {
        const arr = byItem.get(a.itemId) || [];
        arr.push(a);
        byItem.set(a.itemId, arr);
      }
      for (const [itemId, adjs] of byItem) {
        adjs.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
        acAdjMap.set(itemId, {
          adjustedSaleAmount: adjs.reduce((sum, a) => sum + (Number(a.adjustedSaleAmount) || 0), 0),
        });
      }
    }

    // Load AC snapshots across the full date range [fromDate..toDate]
    const acSnapshots = await prisma.dailyInventorySnapshot.findMany({
      where: { restaurantId: barId, snapshotDate: { gte: fromDate, lte: toDate } },
    });
    // Aggregate per item: sum purchased/sold, take last closing, take first opening
    const acSnapMap = new Map<string, any>();
    {
      const byItem = new Map<string, any[]>();
      for (const s of acSnapshots) {
        const arr = byItem.get(s.itemId) || [];
        arr.push(s);
        byItem.set(s.itemId, arr);
      }
      for (const [itemId, snaps] of byItem) {
        snaps.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
        const first = snaps[0];
        const last = snaps[snaps.length - 1];
        acSnapMap.set(itemId, {
          openingStock: Number(first.openingStock),
          purchased: snaps.reduce((sum, s) => sum + Number(s.purchased), 0),
          sold: snaps.reduce((sum, s) => sum + Number(s.sold), 0),
          closingStock: Number(last.closingStock),
        });
      }
    }

    // Load previous day's snapshot (day before fromDate) so opening stock = prev day's closing stock
    let prevDateStr: string | null = null;
    try {
      const [y, m, d] = fromDate.split("-").map(Number);
      const prev = new Date(Date.UTC(y, m - 1, d - 1));
      prevDateStr = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
    } catch { prevDateStr = null; }

    const acPrevSnapshots = prevDateStr
      ? await prisma.dailyInventorySnapshot.findMany({
          where: { restaurantId: barId, snapshotDate: prevDateStr },
        })
      : [];
    const acPrevSnapMap = new Map(acPrevSnapshots.map(s => [s.itemId, s]));

    // ── AC Sales revenue from settled (PAID) bills across [fromDate..toDate] ──
    // AC Sales = total sales AMOUNT (₹) from finalized AC bills, not ml consumed.
    // Only counts PAID + COMPLETED transactions (settled bills).
    const startOfRangeUTC = istDateToUTCStart(fromDate);
    const endOfRangeUTC = istDateToUTCEnd(toDate);
    const posOrderItems = await basePrisma.orderItem.findMany({
      where: {
        removedFromBill: false,
        order: {
          status: 'PAID',
          isDeleted: false,
          restaurantId: barId,
          transactions: {
            status: 'COMPLETED',
            paidAt: { gte: startOfRangeUTC, lte: endOfRangeUTC },
          },
        },
      },
      select: {
        menuItemId: true,
        quantity: true,
        price: true,
        order: { select: { transactions: { select: { discountPercent: true } } } },
      },
    });
    // Build per-menuItemId AC revenue map
    const acRevenueByMenuItem = new Map<string, number>();
    let allPosRevenueRaw = 0;
    for (const oi of posOrderItems) {
      if (!oi.menuItemId) continue;
      const qty = oi.quantity || 0;
      const orderDiscountPercent = Number(oi.order?.transactions?.discountPercent ?? 0);
      const discountFactor = orderDiscountPercent > 0 ? (1 - orderDiscountPercent / 100) : 1;
      const revenue = Math.round(Number(oi.price) * qty * discountFactor * 100) / 100;
      acRevenueByMenuItem.set(oi.menuItemId, (acRevenueByMenuItem.get(oi.menuItemId) || 0) + revenue);
      allPosRevenueRaw += revenue;
    }

    // ── Scale AC revenue to match Transaction.grandTotal (matches liquor report) ──
    // Without this, the combined endpoint's AC sales diverge from the dashboard
    // and the PDF due to rounding and items not captured in order items.
    const txnAgg = await basePrisma.transaction.aggregate({
      where: completedTxnWhere(barId, {
        paidAt: { gte: startOfRangeUTC, lte: endOfRangeUTC },
      }),
      _sum: { grandTotal: true, amount: true },
    });
    const txnTotal = Number(txnAgg._sum.grandTotal) || Number(txnAgg._sum.amount) || 0;
    const scaleFactor = allPosRevenueRaw > 0 ? txnTotal / allPosRevenueRaw : 1;
    for (const [menuItemId, rev] of acRevenueByMenuItem) {
      acRevenueByMenuItem.set(menuItemId, Math.round(rev * scaleFactor * 100) / 100);
    }

    // Load Non-AC items + entries across the full date range
    const nonAcItems = await prisma.nonAcInventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
    });
    const nonAcEntriesAll = await prisma.nonAcDailyEntry.findMany({
      where: { restaurantId: barId, entryDate: { gte: fromDate, lte: toDate } },
    });
    // Aggregate Non-AC entries per item: sum received/deduction, take first opening, take last closing
    const nonAcEntryMap = new Map<string, any>();
    {
      const byItem = new Map<string, any[]>();
      for (const e of nonAcEntriesAll) {
        const arr = byItem.get(e.itemId) || [];
        arr.push(e);
        byItem.set(e.itemId, arr);
      }
      for (const [itemId, entries] of byItem) {
        entries.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
        const first = entries[0];
        const last = entries[entries.length - 1];
        nonAcEntryMap.set(itemId, {
          openingBottles: Number(first.openingBottles),
          receivedBottles: entries.reduce((sum, e) => sum + Number(e.receivedBottles), 0),
          adminDeduction: entries.reduce((sum, e) => sum + Number(e.adminDeduction), 0),
          closingBottles: Number(last.closingBottles),
        });
      }
    }

    // Build combined rows
    // Group by category, then by brand name (normalized)
    const LIQUOR_CATEGORY_ORDER = ['Beer', 'Whisky', 'Brandy', 'Vodka', 'Breezers', 'Rum', 'Gin', 'Wine'];

    const combinedMap = new Map<string, any>();

    // Add AC items
    for (const ac of acItems) {
      const catName = ac.menuItem?.category?.name || 'Uncategorized';
      const snap = acSnapMap.get(ac.id);
      const adj = acAdjMap.get(ac.id);
      const key = `${ac.id}`;
      const btlSize = ac.bottleSize ? Number(ac.bottleSize) : 0;
      // Stock values ALWAYS from snapshot — both edit paths (PDF preview save
      // and Inventory page adjustStock) update the snapshot, so it's always
      // the most recent. The adjustment is only used for sale amount (₹).
      // When today's snapshot exists, use snap.openingStock directly — this
      // respects admin edits via OPENING type. Only fall back to prevSnap
      // (previous day's closing = today's opening) when today's snapshot
      // doesn't exist yet.
      const prevSnap = acPrevSnapMap.get(ac.id);
      const openingAcMl = snap
        ? Number(snap.openingStock)
        : (prevSnap ? Number(prevSnap.closingStock) : Number(ac.currentStock));
      const acReceivedMl = snap ? Number(snap.purchased) : 0;
      const acSaleMl = snap ? Number(snap.sold) : 0;
      const acClosingMl = snap ? Number(snap.closingStock) : Number(ac.currentStock);
      // Sale amount (₹): use adjustment when present (PDF preview override),
      // otherwise POS revenue from settled bills.
      const acSaleAmount = adj
        ? Number(adj.adjustedSaleAmount)
        : (ac.menuItemId ? (acRevenueByMenuItem.get(ac.menuItemId) || 0) : 0);

      // Single physical opening stock and purchases (from AC snapshot).
      // AC and Non-AC share the SAME physical inventory — do NOT sum them.
      // Only sales/deductions are separate (AC from POS, Non-AC from admin entry).
      const openingStockBtl = btlSize > 0 ? Math.round(openingAcMl / btlSize * 100) / 100 : 0;
      const purchasesBtl = btlSize > 0 ? Math.round(acReceivedMl / btlSize * 100) / 100 : 0;

      combinedMap.set(key, {
        id: key,
        category: catName,
        itemName: ac.menuItem?.name || 'Unknown',
        unit: ac.unitOfMeasure || 'ml',
        bottleSize: ac.bottleSize,
        // SINGLE physical stock values (not summed with Non-AC)
        openingStockBottles: openingStockBtl,
        purchasesBottles: purchasesBtl,
        // AC fields (ml internally, bottles for display) — kept for reference
        openingAc: openingAcMl,
        openingAcBottles: openingStockBtl,
        acReceived: acReceivedMl,
        acReceivedBottles: purchasesBtl,
        acSale: acSaleMl,
        acSaleBottles: btlSize > 0 ? Math.round(acSaleMl / btlSize * 100) / 100 : 0,
        acSaleAmount,
        acClosing: acClosingMl,
        acClosingBottles: btlSize > 0 ? Math.round(acClosingMl / btlSize * 100) / 100 : 0,
        // Non-AC fields (bottles) — only deduction/sale is used, NOT opening/purchases
        openingNonAc: 0,
        nonAcReceived: 0,
        nonAcDeduction: 0,
        nonAcClosing: 0,
        // Pricing
        purchaseRate: ac.costPerBottle ? Number(ac.costPerBottle) : null,
        acSellingPrice: ac.acSellingPrice ? Number(ac.acSellingPrice) : (ac.menuItem?.basePrice ? Number(ac.menuItem.basePrice) : null),
        isHiddenFromReport: ac.isHiddenFromReport ?? false,
        nonAcSellingPrice: null,
        // Stock value
        stockValue: ac.costPerBottle ? Math.round(Number(ac.currentStock) * Number(ac.costPerBottle) * 100) / 100 : null,
        // Source flags
        hasAc: true,
        hasNonAc: false,
        acItemId: ac.id,
        nonAcItemId: null,
        // Adjustment flag for frontend
        hasAdjustment: !!adj,
      });
    }

    // Add/link Non-AC items
    for (const nonAc of nonAcItems) {
      const entry = nonAcEntryMap.get(nonAc.id);
      const opening = entry ? Number(entry.openingBottles) : Number(nonAc.openingBottles);
      const received = entry ? Number(entry.receivedBottles) : 0;
      const deduction = entry ? Number(entry.adminDeduction) : 0;
      const closing = entry ? Number(entry.closingBottles) : Number(nonAc.currentBottles);

      if (nonAc.acInventoryItemId && combinedMap.has(nonAc.acInventoryItemId)) {
        // Link to existing AC item — Non-AC is a separate SALES channel,
        // NOT a separate stock. Opening stock and purchases remain from
        // the AC snapshot (physical inventory). Only deduction is added.
        const row = combinedMap.get(nonAc.acInventoryItemId);
        row.hasNonAc = true;
        row.nonAcItemId = nonAc.id;
        // Do NOT set openingNonAc or nonAcReceived — same physical stock as AC.
        // Only the Non-AC deduction (sale) is separate.
        row.nonAcDeduction = deduction;
        row.nonAcClosing = closing; // Non-AC closing (for reference only)
        row.nonAcSellingPrice = nonAc.nonAcSellingPrice ? Number(nonAc.nonAcSellingPrice) : null;
        // Closing = Opening + Purchases - AC Sale - Non-AC Sale (calculated)
        const calcClosing = (Number(row.openingStockBottles) || 0)
          + (Number(row.purchasesBottles) || 0)
          - (Number(row.acSaleBottles) || 0)
          - deduction;
        row.calculatedClosingBottles = Math.round(calcClosing * 100) / 100;
      } else {
        // Standalone Non-AC item (no AC link) — opening/purchases from Non-AC entry
        const key = `nonac-${nonAc.id}`;
        combinedMap.set(key, {
          id: key,
          category: nonAc.category,
          itemName: nonAc.itemName,
          unit: nonAc.unit || 'BOTTLE',
          bottleSize: nonAc.bottleSize,
          // SINGLE physical stock values
          openingStockBottles: opening,
          purchasesBottles: received,
          // AC fields (ml) — zero for Non-AC only items
          openingAc: 0,
          openingAcBottles: 0,
          acReceived: 0,
          acReceivedBottles: 0,
          acSale: 0,
          acSaleBottles: 0,
          acClosing: 0,
          // Non-AC fields (bottles) — only deduction is meaningful
          openingNonAc: opening, // kept for reference
          nonAcReceived: received, // kept for reference
          nonAcDeduction: deduction,
          nonAcClosing: closing,
          // Pricing
          purchaseRate: nonAc.purchaseRate ? Number(nonAc.purchaseRate) : null,
          acSellingPrice: null,
          nonAcSellingPrice: nonAc.nonAcSellingPrice ? Number(nonAc.nonAcSellingPrice) : null,
          isHiddenFromReport: nonAc.isHiddenFromReport ?? false,
          // Stock value
          stockValue: nonAc.purchaseRate ? Math.round(closing * Number(nonAc.purchaseRate) * 100) / 100 : null,
          // Source flags
          hasAc: false,
          hasNonAc: true,
          acItemId: null,
          nonAcItemId: nonAc.id,
          needsConfirmation: nonAc.needsConfirmation,
          notes: nonAc.notes,
        });
      }
    }

    // Sort by category order then item name
    const rows = [...combinedMap.values()].sort((a, b) => {
      const ca = LIQUOR_CATEGORY_ORDER.indexOf(a.category);
      const cb = LIQUOR_CATEGORY_ORDER.indexOf(b.category);
      const ia = ca === -1 ? 99 : ca;
      const ib = cb === -1 ? 99 : cb;
      if (ia !== ib) return ia - ib;
      return a.itemName.localeCompare(b.itemName);
    });

    // ── Business Position summary (16 fields) ──
    // Computed from the SAME combined item data so the Inventory page and
    // PDF-to-Admin preview show identical values.
    //   Opening Stock Value  = Σ (opening_bottles × purchase_rate)
    //   Purchase Value       = Σ (received_bottles × purchase_rate)
    //   Consumption          = Σ (sold_bottles × purchase_rate)
    //   Closing Stock Value  = Σ (closing_bottles × purchase_rate)
    //   AC Sales             = Σ acSaleAmount (adjusted from PDF preview or POS revenue)
    //   AC Consumption       = Σ (acSaleBottles × purchaseRate) — uses adjusted sale bottles when present
    //   Non-AC Sales         = Σ (nonAcDeduction × nonAcSellingPrice)
    //   Non-AC Consumption   = Σ (nonAcDeduction × purchaseRate)
    let openingStockValue = 0;
    let purchaseValue = 0;
    let consumption = 0;
    let closingStockValue = 0;
    let acSales = 0;
    let acConsumption = 0;
    let nonAcSales = 0;
    let nonAcConsumption = 0;

    for (const r of rows) {
      const pr = Number(r.purchaseRate) || 0;
      const btl = Number(r.bottleSize) || 0;
      // SINGLE physical opening stock and purchases — NOT summed AC+Non-AC.
      // AC and Non-AC share the same physical inventory.
      const openingBtl = Number(r.openingStockBottles) || 0;
      const receivedBtl = Number(r.purchasesBottles) || 0;
      // Sold bottles (AC sale + Non-AC deduction — separate sales channels)
      const acSaleBtl = btl > 0 ? (Number(r.acSale) || 0) / btl : 0;
      const nonAcSaleBtl = Number(r.nonAcDeduction) || 0;
      const soldBtl = acSaleBtl + nonAcSaleBtl;
      // Closing = snapshot's closingStock (includes wastage/adjustments),
      // falling back to the formula only when snapshot data is unavailable.
      const snapClosingBtl = Number(r.acClosingBottles) || 0;
      const hasSnapClosing = r.acClosingBottles != null;
      const closingBtl = hasSnapClosing
        ? snapClosingBtl
        : (openingBtl + receivedBtl - acSaleBtl - nonAcSaleBtl);

      openingStockValue += openingBtl * pr;
      purchaseValue += receivedBtl * pr;
      consumption += soldBtl * pr;
      closingStockValue += closingBtl * pr;

      // AC Sales = adjusted sale amount (₹) from PDF preview, or POS revenue
      acSales += Number(r.acSaleAmount) || 0;
      // AC Consumption = AC sale bottles × purchase rate
      acConsumption += acSaleBtl * pr;
      // Non-AC Sales = Non-AC deduction bottles × Non-AC selling price
      const nonAcSP = Number(r.nonAcSellingPrice) || 0;
      nonAcSales += nonAcSaleBtl * nonAcSP;
      // Non-AC Consumption = Non-AC deduction bottles × purchase rate
      nonAcConsumption += nonAcSaleBtl * pr;
    }

    const acProfit = acSales - acConsumption;
    const nonAcProfit = nonAcSales - nonAcConsumption;
    const totalSales = acSales + nonAcSales;
    const totalConsumption = acConsumption + nonAcConsumption;
    const totalProfit = acProfit + nonAcProfit;

    const round2s = (n: number) => Math.round(n * 100) / 100;
    const summary = {
      openingStockValue: round2s(openingStockValue),
      purchaseValue: round2s(purchaseValue),
      consumption: round2s(consumption),
      closingStockValue: round2s(closingStockValue),
      acSales: round2s(acSales),
      acConsumption: round2s(acConsumption),
      acProfit: round2s(acProfit),
      acProfitPct: acSales > 0 ? round2s(acProfit / acSales * 100) : 0,
      nonAcSales: round2s(nonAcSales),
      nonAcConsumption: round2s(nonAcConsumption),
      nonAcProfit: round2s(nonAcProfit),
      nonAcProfitPct: nonAcSales > 0 ? round2s(nonAcProfit / nonAcSales * 100) : 0,
      totalSales: round2s(totalSales),
      totalConsumption: round2s(totalConsumption),
      totalProfit: round2s(totalProfit),
      totalProfitPct: totalSales > 0 ? round2s(totalProfit / totalSales * 100) : 0,
    };

    res.json({ date: fromDate, fromDate, toDate, items: rows, summary });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Combined AC/Non-AC fetch failed:");
    res.status(500).json({ error: error.message || "Failed to fetch combined inventory" });
  }
});

// POST /api/bar/inventory/non-ac/deduct
// Admin enters Non-AC deduction for an item on a specific date
// Formula: closing = opening + received - adminDeduction
// Validation: closing cannot be negative
router.post("/non-ac/deduct", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const { itemId, adminDeduction, receivedBottles, date, reason } = req.body as {
      itemId?: string;
      adminDeduction?: number;
      receivedBottles?: number;
      date?: string;
      reason?: string;
    };

    if (!itemId) { res.status(400).json({ error: "itemId is required" }); return; }

    const today = getKolkataDateString();
    const targetDate = (typeof date === "string" && date) ? date : today;

    const deduction = adminDeduction !== undefined ? Number(adminDeduction) : 0;
    const received = receivedBottles !== undefined ? Number(receivedBottles) : 0;

    if (isNaN(deduction) || deduction < 0) {
      res.status(400).json({ error: "adminDeduction must be a non-negative number" });
      return;
    }
    if (isNaN(received) || received < 0) {
      res.status(400).json({ error: "receivedBottles must be a non-negative number" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // Lock the Non-AC item row
      const lockedRows = await tx.$queryRaw<Array<{ id: string; currentBottles: Prisma.Decimal; openingBottles: Prisma.Decimal }>>`
        SELECT "id", "currentBottles", "openingBottles"
        FROM "non_ac_inventory_items"
        WHERE "id" = ${itemId} AND "restaurantId" = ${barId}
        FOR UPDATE
      `;
      const item = lockedRows[0];
      if (!item) {
        throw Object.assign(new Error("Non-AC item not found"), { statusCode: 404 });
      }

      // Lock existing entry if present
      const lockedEntries = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "non_ac_daily_entries"
        WHERE "restaurantId" = ${barId} AND "itemId" = ${itemId} AND "entryDate" = ${targetDate}
        FOR UPDATE
      `;
      const existing = lockedEntries.length > 0
        ? await tx.nonAcDailyEntry.findUnique({ where: { id: lockedEntries[0].id } })
        : null;

      // Get previous day closing for opening
      const [py, pm, pd] = targetDate.split("-").map(Number);
      const prevDateObj = new Date(Date.UTC(py, pm - 1, pd - 1));
      const prevDate = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getUTCDate()).padStart(2, "0")}`;

      const priorEntry = existing
        ? null
        : await tx.nonAcDailyEntry.findFirst({
            where: { restaurantId: barId, itemId, entryDate: { lt: targetDate } },
            orderBy: { entryDate: "desc" },
          });

      const openingBottles = existing
        ? Number(existing.openingBottles)
        : (priorEntry ? Number(priorEntry.closingBottles) : Number(item.openingBottles));

      const closingBottles = openingBottles + received - deduction;

      // Rule 1: No negative stock
      if (closingBottles < 0) {
        throw Object.assign(
          new Error(`Non-AC deduction exceeds available stock. Opening=${openingBottles} + Received=${received} - Deduction=${deduction} = ${closingBottles}`),
          { statusCode: 400, closingBottles }
        );
      }

      if (existing) {
        // Update existing entry — preserve opening, update received/deduction/closing
        const updated = await tx.nonAcDailyEntry.update({
          where: { id: existing.id },
          data: {
            receivedBottles: new Prisma.Decimal(received),
            adminDeduction: new Prisma.Decimal(deduction),
            closingBottles: new Prisma.Decimal(closingBottles),
            reason: reason || existing.reason,
            createdBy: req.user?.userId ?? null,
          },
        });

        // Update item's currentBottles if today
        if (targetDate === today) {
          await tx.nonAcInventoryItem.update({
            where: { id: itemId },
            data: { currentBottles: new Prisma.Decimal(closingBottles) },
          });
        }

        return { entry: updated, item: { id: itemId, currentBottles: closingBottles } };
      }

      // Create new entry
      const entry = await tx.nonAcDailyEntry.create({
        data: {
          restaurantId: barId,
          itemId,
          entryDate: targetDate,
          openingBottles: new Prisma.Decimal(openingBottles),
          receivedBottles: new Prisma.Decimal(received),
          adminDeduction: new Prisma.Decimal(deduction),
          closingBottles: new Prisma.Decimal(closingBottles),
          reason: reason || null,
          createdBy: req.user?.userId ?? null,
        },
      });

      if (targetDate === today) {
        await tx.nonAcInventoryItem.update({
          where: { id: itemId },
          data: { currentBottles: new Prisma.Decimal(closingBottles) },
        });
      }

      return { entry, item: { id: itemId, currentBottles: closingBottles } };
    }, { timeout: 15000, maxWait: 5000 });

    res.json(result);
  } catch (error: any) {
    const statusCode = error?.statusCode || 500;
    if (statusCode === 400) {
      res.status(400).json({ error: error.message, ...(error.closingBottles !== undefined ? { closingBottles: error.closingBottles } : {}) });
      return;
    }
    if (statusCode === 404) {
      res.status(404).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, "[BarInventory] Non-AC deduction failed:");
    res.status(500).json({ error: error.message || "Failed to record Non-AC deduction" });
  }
});

// PUT /api/bar/inventory/non-ac/entry
// Admin edits Non-AC daily entry fields: opening, sale (deduction), closing
// All values persist to the database and recalculate dependents.
// Formula: closing = opening + received - sale (adminDeduction)
router.put("/non-ac/entry", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const { itemId, date, openingBottles, saleBottles, closingBottles, receivedBottles, reason } = req.body as {
      itemId?: string;
      date?: string;
      openingBottles?: number;
      saleBottles?: number;
      closingBottles?: number;
      receivedBottles?: number;
      reason?: string;
    };

    if (!itemId) { res.status(400).json({ error: "itemId is required" }); return; }

    const today = getKolkataDateString();
    const targetDate = (typeof date === "string" && date) ? date : today;

    const result = await prisma.$transaction(async (tx) => {
      // Lock the Non-AC item
      const lockedRows = await tx.$queryRaw<Array<{ id: string; currentBottles: Prisma.Decimal; openingBottles: Prisma.Decimal }>>`
        SELECT "id", "currentBottles", "openingBottles"
        FROM "non_ac_inventory_items"
        WHERE "id" = ${itemId} AND "restaurantId" = ${barId}
        FOR UPDATE
      `;
      const item = lockedRows[0];
      if (!item) {
        throw Object.assign(new Error("Non-AC item not found"), { statusCode: 404 });
      }

      // Lock existing entry if present
      const lockedEntries = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "non_ac_daily_entries"
        WHERE "restaurantId" = ${barId} AND "itemId" = ${itemId} AND "entryDate" = ${targetDate}
        FOR UPDATE
      `;
      const existing = lockedEntries.length > 0
        ? await tx.nonAcDailyEntry.findUnique({ where: { id: lockedEntries[0].id } })
        : null;

      // Determine values: use provided values or fall back to existing/defaults
      const opening = openingBottles !== undefined ? Number(openingBottles) : (existing ? Number(existing.openingBottles) : Number(item.openingBottles));
      const sale = saleBottles !== undefined ? Number(saleBottles) : (existing ? Number(existing.adminDeduction) : 0);
      const received = receivedBottles !== undefined ? Number(receivedBottles) : (existing ? Number(existing.receivedBottles) : 0);

      // Calculate closing: if admin provided closing explicitly, use it; otherwise compute from formula
      let closing: number;
      if (closingBottles !== undefined) {
        closing = Number(closingBottles);
      } else {
        closing = opening + received - sale;
      }

      if (isNaN(opening) || opening < 0) {
        throw Object.assign(new Error("openingBottles must be a non-negative number"), { statusCode: 400 });
      }
      if (isNaN(sale) || sale < 0) {
        throw Object.assign(new Error("saleBottles must be a non-negative number"), { statusCode: 400 });
      }
      if (isNaN(closing) || closing < 0) {
        throw Object.assign(new Error("closingBottles must be a non-negative number"), { statusCode: 400 });
      }

      if (existing) {
        // Update existing entry
        const updated = await tx.nonAcDailyEntry.update({
          where: { id: existing.id },
          data: {
            openingBottles: new Prisma.Decimal(opening),
            receivedBottles: new Prisma.Decimal(received),
            adminDeduction: new Prisma.Decimal(sale),
            closingBottles: new Prisma.Decimal(closing),
            reason: reason || existing.reason,
            createdBy: req.user?.userId ?? null,
          },
        });

        // Update item's currentBottles if today
        if (targetDate === today) {
          await tx.nonAcInventoryItem.update({
            where: { id: itemId },
            data: { currentBottles: new Prisma.Decimal(closing) },
          });
        }

        // ── Rollover: update next day's openingBottles to match this day's closing ──
        {
          const nextDay = new Date(targetDate + "T00:00:00");
          nextDay.setDate(nextDay.getDate() + 1);
          const nextDateStr = nextDay.toISOString().slice(0, 10);
          const nextExisting = await tx.nonAcDailyEntry.findUnique({
            where: { restaurantId_itemId_entryDate: { restaurantId: barId, itemId, entryDate: nextDateStr } },
          });
          if (nextExisting) {
            const nextReceived = Number(nextExisting.receivedBottles);
            const nextSale = Number(nextExisting.adminDeduction);
            const nextClosing = Math.round((closing + nextReceived - nextSale) * 100) / 100;
            await tx.nonAcDailyEntry.update({
              where: { id: nextExisting.id },
              data: {
                openingBottles: new Prisma.Decimal(closing),
                closingBottles: new Prisma.Decimal(nextClosing),
              },
            });
          }
        }

        return { entry: updated };
      }

      // Create new entry
      const entry = await tx.nonAcDailyEntry.create({
        data: {
          restaurantId: barId,
          itemId,
          entryDate: targetDate,
          openingBottles: new Prisma.Decimal(opening),
          receivedBottles: new Prisma.Decimal(received),
          adminDeduction: new Prisma.Decimal(sale),
          closingBottles: new Prisma.Decimal(closing),
          reason: reason || null,
          createdBy: req.user?.userId ?? null,
        },
      });

      if (targetDate === today) {
        await tx.nonAcInventoryItem.update({
          where: { id: itemId },
          data: { currentBottles: new Prisma.Decimal(closing) },
        });
      }

      // ── Rollover: update next day's openingBottles to match this day's closing ──
      {
        const nextDay = new Date(targetDate + "T00:00:00");
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDateStr = nextDay.toISOString().slice(0, 10);
        const nextExisting = await tx.nonAcDailyEntry.findUnique({
          where: { restaurantId_itemId_entryDate: { restaurantId: barId, itemId, entryDate: nextDateStr } },
        });
        if (nextExisting) {
          const nextReceived = Number(nextExisting.receivedBottles);
          const nextSale = Number(nextExisting.adminDeduction);
          const nextClosing = Math.round((closing + nextReceived - nextSale) * 100) / 100;
          await tx.nonAcDailyEntry.update({
            where: { id: nextExisting.id },
            data: {
              openingBottles: new Prisma.Decimal(closing),
              closingBottles: new Prisma.Decimal(nextClosing),
            },
          });
        }
      }

      return { entry };
    }, { timeout: 15000, maxWait: 5000 });

    res.json(result);
  } catch (error: any) {
    const statusCode = error?.statusCode || 500;
    if (statusCode === 400) { res.status(400).json({ error: error.message }); return; }
    if (statusCode === 404) { res.status(404).json({ error: error.message }); return; }
    logger.error({ err: error }, "[BarInventory] Non-AC entry edit failed:");
    res.status(500).json({ error: error.message || "Failed to update Non-AC entry" });
  }
});

// GET /api/bar/inventory/non-ac/audit-trail
// Audit trail for Non-AC adjustments (Rule 5)
router.get("/non-ac/audit-trail", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const { itemId, date, startDate, endDate } = req.query as {
      itemId?: string;
      date?: string;
      startDate?: string;
      endDate?: string;
    };

    const where: any = { restaurantId: barId };
    if (itemId) where.itemId = itemId;
    if (date) {
      where.entryDate = date;
    } else if (startDate || endDate) {
      where.entryDate = {};
      if (startDate) where.entryDate.gte = startDate;
      if (endDate) where.entryDate.lte = endDate;
    }

    const entries = await prisma.nonAcDailyEntry.findMany({
      where,
      include: { item: { select: { itemName: true, category: true, bottleSize: true, nonAcSellingPrice: true } } },
      orderBy: [{ entryDate: "desc" }, { item: { itemName: "asc" } }],
    });

    const audit = entries.map(e => ({
      date: e.entryDate,
      itemId: e.itemId,
      itemName: e.item?.itemName,
      category: e.item?.category,
      bottleSize: e.item?.bottleSize,
      openingNonAc: Number(e.openingBottles),
      receivedBottles: Number(e.receivedBottles),
      adminDeduction: Number(e.adminDeduction),
      closingNonAc: Number(e.closingBottles),
      reason: e.reason,
      createdBy: e.createdBy,
      timestamp: e.updatedAt,
    }));

    res.json({ entries: audit, count: audit.length });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Non-AC audit trail failed:");
    res.status(500).json({ error: error.message || "Failed to fetch audit trail" });
  }
});

// POST /api/bar/inventory/non-ac/items
// Create a new Non-AC inventory item
router.post("/non-ac/items", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const { itemName, category, bottleSize, openingBottles, purchaseRate, nonAcSellingPrice, acInventoryItemId } = req.body as {
      itemName?: string;
      category?: string;
      bottleSize?: number;
      openingBottles?: number;
      purchaseRate?: number;
      nonAcSellingPrice?: number;
      acInventoryItemId?: string;
    };

    if (!itemName || !category || !bottleSize) {
      res.status(400).json({ error: "itemName, category, bottleSize are required" });
      return;
    }

    const item = await prisma.nonAcInventoryItem.create({
      data: {
        restaurantId: barId,
        itemName,
        category,
        bottleSize: Number(bottleSize),
        openingBottles: new Prisma.Decimal(openingBottles || 0),
        currentBottles: new Prisma.Decimal(openingBottles || 0),
        purchaseRate: purchaseRate ? new Prisma.Decimal(purchaseRate) : null,
        nonAcSellingPrice: nonAcSellingPrice ? new Prisma.Decimal(nonAcSellingPrice) : null,
        acInventoryItemId: acInventoryItemId || null,
      },
    });

    // Create today's entry
    const today = getKolkataDateString();
    await prisma.nonAcDailyEntry.create({
      data: {
        restaurantId: barId,
        itemId: item.id,
        entryDate: today,
        openingBottles: new Prisma.Decimal(openingBottles || 0),
        receivedBottles: new Prisma.Decimal(0),
        adminDeduction: new Prisma.Decimal(0),
        closingBottles: new Prisma.Decimal(openingBottles || 0),
        reason: "Initial creation",
      },
    });

    res.json({ item });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Non-AC item creation failed:");
    res.status(500).json({ error: error.message || "Failed to create Non-AC item" });
  }
});

// PATCH /api/bar/inventory/non-ac/items/:id
// Update a Non-AC inventory item (e.g., set selling price, confirm flagged item)
router.patch("/non-ac/items/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const { id } = req.params;
    const { itemName, category, nonAcSellingPrice, purchaseRate, needsConfirmation, notes, acInventoryItemId, isHiddenFromReport } = req.body;

    const updateData: any = {};
    if (itemName !== undefined) updateData.itemName = itemName;
    if (category !== undefined) updateData.category = category;
    if (nonAcSellingPrice !== undefined) updateData.nonAcSellingPrice = nonAcSellingPrice !== null ? new Prisma.Decimal(nonAcSellingPrice) : null;
    if (purchaseRate !== undefined) updateData.purchaseRate = purchaseRate !== null ? new Prisma.Decimal(purchaseRate) : null;
    if (needsConfirmation !== undefined) updateData.needsConfirmation = needsConfirmation;
    if (notes !== undefined) updateData.notes = notes;
    if (acInventoryItemId !== undefined) updateData.acInventoryItemId = acInventoryItemId || null;
    if (isHiddenFromReport !== undefined) updateData.isHiddenFromReport = Boolean(isHiddenFromReport);

    const item = await prisma.nonAcInventoryItem.updateMany({
      where: { id, restaurantId: barId },
      data: updateData,
    });
    if (item.count === 0) {
      res.status(404).json({ error: "Non-AC item not found" });
      return;
    }

    const updated = await prisma.nonAcInventoryItem.findUnique({ where: { id } });
    res.json({ item: updated });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Non-AC item update failed:");
    res.status(500).json({ error: error.message || "Failed to update Non-AC item" });
  }
});

// GET /api/bar/inventory/non-ac/dashboard
// Dashboard metrics: separate AC and Non-AC stock
router.get("/non-ac/dashboard", async (req: any, res) => {
  try {
    const barId = resolveBarId(req);
    if (!barId) { res.status(400).json({ error: "Restaurant context required" }); return; }

    const today = getKolkataDateString();

    // AC metrics
    const acItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      select: { id: true, currentStock: true, costPerBottle: true, bottleSize: true },
    });
    const acSnapshots = await prisma.dailyInventorySnapshot.findMany({
      where: { restaurantId: barId, snapshotDate: today },
    });

    let totalAcStockMl = 0;
    let acStockValue = 0;
    let todayAcUsage = 0;
    for (const ac of acItems) {
      totalAcStockMl += Number(ac.currentStock);
      if (ac.costPerBottle && ac.bottleSize > 0) {
        acStockValue += (Number(ac.currentStock) / ac.bottleSize) * Number(ac.costPerBottle);
      }
    }
    for (const s of acSnapshots) {
      todayAcUsage += Number(s.sold);
    }

    // Non-AC metrics
    const nonAcItems = await prisma.nonAcInventoryItem.findMany({
      where: { restaurantId: barId, isActive: true },
      select: { id: true, currentBottles: true, purchaseRate: true, nonAcSellingPrice: true },
    });
    const nonAcEntries = await prisma.nonAcDailyEntry.findMany({
      where: { restaurantId: barId, entryDate: today },
    });

    let totalNonAcStockBottles = 0;
    let nonAcStockValue = 0;
    let todayNonAcDeduction = 0;
    for (const nac of nonAcItems) {
      totalNonAcStockBottles += Number(nac.currentBottles);
      if (nac.purchaseRate) {
        nonAcStockValue += Number(nac.currentBottles) * Number(nac.purchaseRate);
      }
    }
    for (const e of nonAcEntries) {
      todayNonAcDeduction += Number(e.adminDeduction);
    }

    res.json({
      ac: {
        totalStockMl: Math.round(totalAcStockMl * 100) / 100,
        stockValue: Math.round(acStockValue * 100) / 100,
        todayUsage: Math.round(todayAcUsage * 100) / 100,
      },
      nonAc: {
        totalStockBottles: Math.round(totalNonAcStockBottles * 100) / 100,
        stockValue: Math.round(nonAcStockValue * 100) / 100,
        todayDeduction: Math.round(todayNonAcDeduction * 100) / 100,
      },
      combined: {
        totalStockValue: Math.round((acStockValue + nonAcStockValue) * 100) / 100,
      },
    });
  } catch (error: any) {
    logger.error({ err: error }, "[BarInventory] Non-AC dashboard failed:");
    res.status(500).json({ error: error.message || "Failed to fetch dashboard" });
  }
});

export default router;
