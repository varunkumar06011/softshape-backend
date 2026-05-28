import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { getIo } from "../socket";

const router = Router();
const prisma = new PrismaClient();
const BAR_ID = "bar-001";

const inventoryInclude = {
  menuItem: {
    include: {
      category: true,
      variants: true,
    },
  },
} as const;

// Helper function to emit socket events
function emitToBar(eventName: string, payload: Record<string, unknown>): void {
  getIo().to(BAR_ID).emit(eventName, { restaurantId: BAR_ID, ...payload });
}

// Helper to get IST date string
function getISTDateString(): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  return nowIST.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ==========================================
// GET /api/bar/inventory/items
// List all inventory items
// ==========================================
router.get("/items", async (req, res) => {
  try {
    const items = await prisma.inventoryItem.findMany({
      where: { restaurantId: BAR_ID },
      include: inventoryInclude,
      orderBy: { createdAt: "desc" },
    });

    res.json(items);
  } catch (error) {
    console.error("[BarInventory] Failed to fetch items:", error);
    res.status(500).json({ error: "Failed to fetch inventory items" });
  }
});

// ==========================================
// GET /api/bar/inventory/items/:id
// Get single item details
// ==========================================
router.get("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const item = await prisma.inventoryItem.findFirst({
      where: { id, restaurantId: BAR_ID },
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

    res.json(item);
  } catch (error) {
    console.error("[BarInventory] Failed to fetch item:", error);
    res.status(500).json({ error: "Failed to fetch inventory item" });
  }
});

// ==========================================
// POST /api/bar/inventory/items
// Create new inventory entry
// ==========================================
router.post("/items", async (req, res) => {
  try {
    const {
      menuItemId,
      unitOfMeasure,
      bottleSize,
      currentStock,
      reorderLevel,
      costPerBottle,
    } = req.body as {
      menuItemId?: string;
      unitOfMeasure?: string;
      bottleSize?: number;
      currentStock?: number;
      reorderLevel?: number;
      costPerBottle?: number;
    };

    // Validation
    if (!menuItemId || !unitOfMeasure || !bottleSize || currentStock === undefined || reorderLevel === undefined) {
      res.status(400).json({
        error: "menuItemId, unitOfMeasure, bottleSize, currentStock, and reorderLevel are required",
      });
      return;
    }

    // Check if menuItem exists and is a bar item
    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, restaurantId: BAR_ID },
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

    const openingStock = new Prisma.Decimal(currentStock);

    // Create inventory item
    const item = await prisma.inventoryItem.create({
      data: {
        menuItemId,
        restaurantId: BAR_ID,
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
        restaurantId: BAR_ID,
        itemId: item.id,
        type: "ADJUSTMENT",
        quantityChange: openingStock,
        stockBefore: new Prisma.Decimal(0),
        stockAfter: openingStock,
        notes: "Initial inventory creation",
        createdBy: "System",
      },
    });

    emitToBar("inventory:updated", { item });

    res.status(201).json(item);
  } catch (error) {
    console.error("[BarInventory] Failed to create item:", error);
    res.status(500).json({ error: "Failed to create inventory item" });
  }
});

// ==========================================
// PATCH /api/bar/inventory/items/:id
// Update inventory item details
// ==========================================
router.patch("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      unitOfMeasure,
      bottleSize,
      reorderLevel,
      costPerBottle,
    } = req.body as {
      unitOfMeasure?: string;
      bottleSize?: number;
      reorderLevel?: number;
      costPerBottle?: number;
    };

    const existing = await prisma.inventoryItem.findFirst({
      where: { id, restaurantId: BAR_ID },
    });

    if (!existing) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Build update payload
    const updateData: Record<string, unknown> = {};
    if (unitOfMeasure !== undefined) updateData.unitOfMeasure = unitOfMeasure;
    if (bottleSize !== undefined) updateData.bottleSize = Number(bottleSize);
    if (reorderLevel !== undefined) updateData.reorderLevel = new Prisma.Decimal(reorderLevel);
    if (costPerBottle !== undefined) updateData.costPerBottle = new Prisma.Decimal(costPerBottle);

    const updated = await prisma.inventoryItem.update({
      where: { id },
      data: updateData,
      include: inventoryInclude,
    });

    emitToBar("inventory:updated", { item: updated });

    res.json(updated);
  } catch (error) {
    console.error("[BarInventory] Failed to update item:", error);
    res.status(500).json({ error: "Failed to update inventory item" });
  }
});

// ==========================================
// DELETE /api/bar/inventory/items/:id
// Delete inventory item
// ==========================================
router.delete("/items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.inventoryItem.findFirst({
      where: { id, restaurantId: BAR_ID },
    });

    if (!existing) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    // Delete related transactions and snapshots via cascade
    await prisma.inventoryItem.delete({
      where: { id },
    });

    emitToBar("inventory:deleted", { itemId: id });

    res.json({ ok: true, id });
  } catch (error) {
    console.error("[BarInventory] Failed to delete item:", error);
    res.status(500).json({ error: "Failed to delete inventory item" });
  }
});

// ==========================================
// POST /api/bar/inventory/adjust-stock
// Manual stock adjustment
// ==========================================
router.post("/adjust-stock", async (req, res) => {
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

    const item = await prisma.inventoryItem.findFirst({
      where: { id: itemId, restaurantId: BAR_ID },
    });

    if (!item) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    const change = new Prisma.Decimal(quantityChange);
    const stockBefore = item.currentStock;
    const stockAfter = stockBefore.add(change);

    // Prevent negative stock
    if (stockAfter.lessThan(0)) {
      res.status(400).json({
        error: "Adjustment would result in negative stock",
        currentStock: stockBefore.toString(),
        requestedChange: change.toString(),
      });
      return;
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(
      async (tx) => {
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
            restaurantId: BAR_ID,
            itemId,
            type,
            quantityChange: change,
            stockBefore,
            stockAfter,
            notes: notes || null,
            createdBy: createdBy || "Unknown",
          },
        });

        return { item: updatedItem, transaction };
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // Emit socket event
    emitToBar("inventory:updated", { item: result.item });

    // Check if stock is low
    if (result.item.currentStock.lessThanOrEqualTo(result.item.reorderLevel)) {
      emitToBar("inventory:low_stock", {
        item: result.item,
        currentStock: result.item.currentStock.toString(),
        reorderLevel: result.item.reorderLevel.toString(),
      });
    }

    res.json(result);
  } catch (error) {
    console.error("[BarInventory] Failed to adjust stock:", error);
    res.status(500).json({ error: "Failed to adjust stock" });
  }
});

// ==========================================
// POST /api/bar/inventory/record-purchase
// Record new stock purchase
// ==========================================
router.post("/record-purchase", async (req, res) => {
  try {
    const {
      itemId,
      quantity,
      costPerBottle,
      notes,
      createdBy,
    } = req.body as {
      itemId?: string;
      quantity?: number;
      costPerBottle?: number;
      notes?: string;
      createdBy?: string;
    };

    // Validation
    if (!itemId || quantity === undefined || quantity <= 0) {
      res.status(400).json({
        error: "itemId and positive quantity are required",
      });
      return;
    }

    const item = await prisma.inventoryItem.findFirst({
      where: { id: itemId, restaurantId: BAR_ID },
    });

    if (!item) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }

    const purchaseQty = new Prisma.Decimal(quantity);
    const stockBefore = item.currentStock;
    const stockAfter = stockBefore.add(purchaseQty);

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(
      async (tx) => {
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

        // Create transaction record
        const transaction = await tx.inventoryTransaction.create({
          data: {
            restaurantId: BAR_ID,
            itemId,
            type: "PURCHASE",
            quantityChange: purchaseQty,
            stockBefore,
            stockAfter,
            notes: notes || null,
            createdBy: createdBy || "Unknown",
          },
        });

        return { item: updatedItem, transaction };
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // Emit socket event
    emitToBar("inventory:updated", { item: result.item });

    res.json(result);
  } catch (error) {
    console.error("[BarInventory] Failed to record purchase:", error);
    res.status(500).json({ error: "Failed to record purchase" });
  }
});

// ==========================================
// GET /api/bar/inventory/transactions
// Get transaction history with optional filters
// ==========================================
router.get("/transactions", async (req, res) => {
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
      restaurantId: BAR_ID,
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
        (where.transactionDate as Record<string, unknown>).gte = new Date(startDate);
      }
      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        (where.transactionDate as Record<string, unknown>).lte = endDateTime;
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
    console.error("[BarInventory] Failed to fetch transactions:", error);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ==========================================
// GET /api/bar/inventory/daily-report
// Get daily inventory report for a specific date
// ==========================================
router.get("/daily-report", async (req, res) => {
  try {
    const { date } = req.query as { date?: string };

    // Use IST date if not provided
    const reportDate = date || getISTDateString();

    // Parse date to get start and end of day in IST
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const dateObj = new Date(reportDate + "T00:00:00Z");
    const startOfDayUTC = new Date(dateObj.getTime() - IST_OFFSET_MS);
    const endOfDayUTC = new Date(startOfDayUTC.getTime() + 24 * 60 * 60 * 1000 - 1);

    // Get all inventory items
    const items = await prisma.inventoryItem.findMany({
      where: { restaurantId: BAR_ID },
      include: {
        menuItem: {
          select: { name: true, id: true },
        },
      },
    });

    // Get all transactions for the day
    const transactions = await prisma.inventoryTransaction.findMany({
      where: {
        restaurantId: BAR_ID,
        transactionDate: {
          gte: startOfDayUTC,
          lte: endOfDayUTC,
        },
      },
      orderBy: { transactionDate: "asc" },
    });

    // Build report for each item
    const report = items.map((item) => {
      const itemTransactions = transactions.filter((t) => t.itemId === item.id);

      // Calculate aggregates
      const purchased = itemTransactions
        .filter((t) => t.type === "PURCHASE")
        .reduce((sum, t) => sum.add(t.quantityChange), new Prisma.Decimal(0));

      const sold = itemTransactions
        .filter((t) => t.type === "SALE")
        .reduce((sum, t) => sum.add(t.quantityChange.abs()), new Prisma.Decimal(0));

      const wastage = itemTransactions
        .filter((t) => t.type === "WASTAGE")
        .reduce((sum, t) => sum.add(t.quantityChange.abs()), new Prisma.Decimal(0));

      const adjustments = itemTransactions
        .filter((t) => t.type === "ADJUSTMENT")
        .reduce((sum, t) => sum.add(t.quantityChange), new Prisma.Decimal(0));

      // Opening stock is the stockBefore of the first transaction, or current stock if no transactions
      const openingStock = itemTransactions.length > 0
        ? itemTransactions[0].stockBefore
        : item.currentStock;

      // Closing stock is the stockAfter of the last transaction, or current stock if no transactions
      const closingStock = itemTransactions.length > 0
        ? itemTransactions[itemTransactions.length - 1].stockAfter
        : item.currentStock;

      return {
        itemId: item.id,
        itemName: item.menuItem.name,
        unitOfMeasure: item.unitOfMeasure,
        bottleSize: item.bottleSize,
        openingStock: openingStock.toString(),
        purchased: purchased.toString(),
        sold: sold.toString(),
        wastage: wastage.toString(),
        adjusted: adjustments.toString(),
        closingStock: closingStock.toString(),
        reorderLevel: item.reorderLevel.toString(),
        isLowStock: closingStock.lessThanOrEqualTo(item.reorderLevel),
        transactionCount: itemTransactions.length,
      };
    });

    res.json({
      date: reportDate,
      restaurantId: BAR_ID,
      items: report,
      summary: {
        totalItems: items.length,
        lowStockItems: report.filter((r) => r.isLowStock).length,
        totalTransactions: transactions.length,
      },
    });
  } catch (error) {
    console.error("[BarInventory] Failed to generate daily report:", error);
    res.status(500).json({ error: "Failed to generate daily report" });
  }
});

// ==========================================
// GET /api/bar/inventory/low-stock
// Get items with stock at or below reorder level
// ==========================================
router.get("/low-stock", async (req, res) => {
  try {
    const items = await prisma.$queryRaw<
      Array<{
        id: string;
        menuItemId: string;
        restaurantId: string;
        unitOfMeasure: string;
        bottleSize: number;
        currentStock: Prisma.Decimal;
        reorderLevel: Prisma.Decimal;
        costPerBottle: Prisma.Decimal | null;
      }>
    >`
      SELECT *
      FROM "inventory_items"
      WHERE "restaurantId" = ${BAR_ID}
        AND "currentStock" <= "reorderLevel"
      ORDER BY ("currentStock" / NULLIF("reorderLevel", 0)) ASC
    `;

    // Fetch full details for each low stock item
    const detailedItems = await Promise.all(
      items.map(async (item) => {
        const fullItem = await prisma.inventoryItem.findUnique({
          where: { id: item.id },
          include: inventoryInclude,
        });
        return fullItem;
      })
    );

    // Calculate urgency percentage
    const itemsWithUrgency = detailedItems
      .filter((item) => item !== null)
      .map((item) => {
        if (!item) return null;
        const urgencyPercent = item.reorderLevel.greaterThan(0)
          ? item.currentStock.div(item.reorderLevel).mul(100).toNumber()
          : 100;

        return {
          ...item,
          urgencyPercent: Math.round(urgencyPercent),
          stockDeficit: item.reorderLevel.sub(item.currentStock).toString(),
        };
      })
      .filter((item) => item !== null);

    // Emit low stock alert if there are items
    if (itemsWithUrgency.length > 0) {
      emitToBar("inventory:low_stock_alert", {
        count: itemsWithUrgency.length,
        items: itemsWithUrgency.slice(0, 5), // Send top 5 most urgent
      });
    }

    res.json(itemsWithUrgency);
  } catch (error) {
    console.error("[BarInventory] Failed to fetch low stock items:", error);
    res.status(500).json({ error: "Failed to fetch low stock items" });
  }
});

export default router;
