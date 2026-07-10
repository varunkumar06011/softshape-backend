// ─────────────────────────────────────────────────────────────────────────────
// Opening Balance Routes — One-time-per-outlet financial snapshot
// ─────────────────────────────────────────────────────────────────────────────
// Records what the business owns and owes before the new financial tracking
// system starts measuring day-to-day changes. One OpeningBalance per outlet,
// enforced at schema level via @@unique([restaurantId]).
//
// Endpoints:
//   GET    /api/opening-balance                        — get current snapshot + lines
//   POST   /api/opening-balance                        — create header (rejects if exists)
//   PATCH  /api/opening-balance                        — update header (rejects if finalized)
//   POST   /api/opening-balance/lines                  — add a line
//   PATCH  /api/opening-balance/lines/:id              — edit a line
//   DELETE /api/opening-balance/lines/:id              — remove a line
//   POST   /api/opening-balance/finalize               — lock the snapshot
//   POST   /api/opening-balance/unlock                 — unlock (logged to AuditLog)
//   GET    /api/opening-balance/suggest-stock-lines    — suggested lines from inventory
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import logger from "../lib/logger";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

const VALID_LINE_TYPES = ["STOCK_ITEM", "FIXED_ASSET", "LOAN", "VENDOR_PAYABLE"];

// ── Helper: write AuditLog ────────────────────────────────────────────────────
async function writeAuditLog(
  restaurantId: string,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata?: any
) {
  try {
    await prisma.auditLog.create({
      data: {
        restaurantId,
        userId: userId || null,
        action,
        entityType,
        entityId: entityId || null,
        metadata: metadata || undefined,
      },
    });
  } catch (err) {
    logger.error({ err }, "[OpeningBalance] AuditLog write failed");
  }
}

// ── GET /api/opening-balance ──────────────────────────────────────────────────
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    const openingBalance = await prisma.openingBalance.findFirst({
      where: { restaurantId },
      include: {
        lines: {
          orderBy: { createdAt: "asc" },
          include: {
            ledgerCategory: { select: { id: true, name: true, entryType: true } },
          },
        },
        finalizedBy: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    if (!openingBalance) {
      return res.status(404).json({ error: "No opening balance found" });
    }

    res.json(openingBalance);
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] GET failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/opening-balance — create header ─────────────────────────────────
router.post("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { asOfDate, cashInHand, bankBalance, openingEquity } = req.body;

    if (!asOfDate || typeof asOfDate !== "string") {
      return res.status(400).json({ error: "asOfDate is required (YYYY-MM-DD)" });
    }

    // Check if one already exists — unique constraint at schema level, but give a clear error
    const existing = await prisma.openingBalance.findFirst({
      where: { restaurantId },
    });
    if (existing) {
      return res.status(409).json({
        error: "Opening balance already exists for this outlet. Use PATCH to update it.",
        id: existing.id,
      });
    }

    const created = await prisma.openingBalance.create({
      data: {
        restaurantId,
        asOfDate,
        cashInHand: cashInHand != null ? new Prisma.Decimal(cashInHand) : new Prisma.Decimal(0),
        bankBalance: bankBalance != null ? new Prisma.Decimal(bankBalance) : new Prisma.Decimal(0),
        openingEquity: openingEquity != null ? new Prisma.Decimal(openingEquity) : new Prisma.Decimal(0),
        createdById: userId,
      },
    });

    await writeAuditLog(restaurantId, userId, "opening_balance_created", "OpeningBalance", created.id, {
      asOfDate,
      cashInHand,
      bankBalance,
      openingEquity,
    });

    res.json(created);
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] POST failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/opening-balance — update header ────────────────────────────────
router.patch("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { asOfDate, cashInHand, bankBalance, openingEquity } = req.body;

    const existing = await prisma.openingBalance.findFirst({
      where: { restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "No opening balance found" });
    }
    if (existing.isFinalized) {
      return res.status(403).json({ error: "Opening balance is finalized. Unlock to edit." });
    }

    const updateData: any = {};
    if (asOfDate !== undefined) updateData.asOfDate = asOfDate;
    if (cashInHand !== undefined) updateData.cashInHand = new Prisma.Decimal(cashInHand);
    if (bankBalance !== undefined) updateData.bankBalance = new Prisma.Decimal(bankBalance);
    if (openingEquity !== undefined) updateData.openingEquity = new Prisma.Decimal(openingEquity);

    const updated = await prisma.openingBalance.update({
      where: { id: existing.id },
      data: updateData,
    });

    await writeAuditLog(restaurantId, userId, "opening_balance_updated", "OpeningBalance", existing.id, {
      before: {
        asOfDate: existing.asOfDate,
        cashInHand: existing.cashInHand.toString(),
        bankBalance: existing.bankBalance.toString(),
        openingEquity: existing.openingEquity.toString(),
      },
      after: updateData,
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] PATCH failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/opening-balance/lines — add a line ──────────────────────────────
router.post("/lines", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { lineType, refId, name, quantity, unitCost, amount, ledgerCategoryId, originalDate, notes } = req.body;

    if (!lineType || !VALID_LINE_TYPES.includes(lineType)) {
      return res.status(400).json({ error: "Invalid lineType" });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const parent = await prisma.openingBalance.findFirst({
      where: { restaurantId },
    });
    if (!parent) {
      return res.status(404).json({ error: "No opening balance found. Create the header first." });
    }
    if (parent.isFinalized) {
      return res.status(403).json({ error: "Opening balance is finalized. Unlock to edit." });
    }

    let computedAmount = amount;
    let validatedRefId = refId || null;

    // For STOCK_ITEM: validate refId against KitchenInventoryItem and compute amount server-side
    if (lineType === "STOCK_ITEM") {
      if (refId) {
        const inventoryItem = await prisma.kitchenInventoryItem.findFirst({
          where: { id: refId, restaurantId },
        });
        if (!inventoryItem) {
          return res.status(400).json({ error: "Invalid refId — inventory item not found for this outlet" });
        }
        validatedRefId = refId;
      }
      if (quantity != null && unitCost != null) {
        computedAmount = new Prisma.Decimal(quantity).mul(new Prisma.Decimal(unitCost));
      }
    }

    if (computedAmount == null) {
      return res.status(400).json({ error: "amount is required (or provide quantity + unitCost for STOCK_ITEM)" });
    }

    const line = await prisma.openingBalanceLine.create({
      data: {
        openingBalanceId: parent.id,
        lineType,
        refId: validatedRefId,
        name: name.trim(),
        quantity: quantity != null ? new Prisma.Decimal(quantity) : null,
        unitCost: unitCost != null ? new Prisma.Decimal(unitCost) : null,
        amount: new Prisma.Decimal(computedAmount),
        ledgerCategoryId: ledgerCategoryId || null,
        originalDate: originalDate || null,
        notes: notes || null,
      },
    });

    await writeAuditLog(restaurantId, userId, "opening_balance_line_created", "OpeningBalanceLine", line.id, {
      openingBalanceId: parent.id,
      lineType,
      name: name.trim(),
      amount: computedAmount.toString(),
    });

    res.json(line);
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] POST line failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/opening-balance/lines/:id — edit a line ────────────────────────
router.patch("/lines/:id", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { name, quantity, unitCost, amount, ledgerCategoryId, originalDate, notes } = req.body;

    const parent = await prisma.openingBalance.findFirst({
      where: { restaurantId },
      include: { lines: { where: { id } } },
    });
    if (!parent) {
      return res.status(404).json({ error: "No opening balance found" });
    }
    const line = parent.lines.find((l) => l.id === id);
    if (!line) {
      return res.status(404).json({ error: "Line not found" });
    }
    if (parent.isFinalized) {
      return res.status(403).json({ error: "Opening balance is finalized. Unlock to edit." });
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (quantity !== undefined) updateData.quantity = quantity != null ? new Prisma.Decimal(quantity) : null;
    if (unitCost !== undefined) updateData.unitCost = unitCost != null ? new Prisma.Decimal(unitCost) : null;
    if (ledgerCategoryId !== undefined) updateData.ledgerCategoryId = ledgerCategoryId || null;
    if (originalDate !== undefined) updateData.originalDate = originalDate || null;
    if (notes !== undefined) updateData.notes = notes || null;

    // Recompute amount for STOCK_ITEM if quantity or unitCost changed
    if (line.lineType === "STOCK_ITEM" && (quantity !== undefined || unitCost !== undefined)) {
      const q = quantity !== undefined ? quantity : line.quantity?.toString();
      const uc = unitCost !== undefined ? unitCost : line.unitCost?.toString();
      if (q != null && uc != null) {
        updateData.amount = new Prisma.Decimal(q).mul(new Prisma.Decimal(uc));
      }
    } else if (amount !== undefined) {
      updateData.amount = new Prisma.Decimal(amount);
    }

    const updated = await prisma.openingBalanceLine.update({
      where: { id },
      data: updateData,
    });

    await writeAuditLog(restaurantId, userId, "opening_balance_line_updated", "OpeningBalanceLine", id, {
      before: {
        name: line.name,
        quantity: line.quantity?.toString(),
        unitCost: line.unitCost?.toString(),
        amount: line.amount.toString(),
        ledgerCategoryId: line.ledgerCategoryId,
        originalDate: line.originalDate,
        notes: line.notes,
      },
      after: updateData,
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] PATCH line failed");
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/opening-balance/lines/:id — remove a line ─────────────────────
router.delete("/lines/:id", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;

    const parent = await prisma.openingBalance.findFirst({
      where: { restaurantId },
      include: { lines: { where: { id } } },
    });
    if (!parent) {
      return res.status(404).json({ error: "No opening balance found" });
    }
    const line = parent.lines.find((l) => l.id === id);
    if (!line) {
      return res.status(404).json({ error: "Line not found" });
    }
    if (parent.isFinalized) {
      return res.status(403).json({ error: "Opening balance is finalized. Unlock to edit." });
    }

    await prisma.openingBalanceLine.delete({
      where: { id },
    });

    await writeAuditLog(restaurantId, userId, "opening_balance_line_deleted", "OpeningBalanceLine", id, {
      before: {
        lineType: line.lineType,
        name: line.name,
        amount: line.amount.toString(),
        refId: line.refId,
      },
    });

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] DELETE line failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/opening-balance/finalize — lock the snapshot ─────────────────────
router.post("/finalize", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;

    const existing = await prisma.openingBalance.findFirst({
      where: { restaurantId },
      include: {
        lines: true,
      },
    });
    if (!existing) {
      return res.status(404).json({ error: "No opening balance found" });
    }
    if (existing.isFinalized) {
      return res.status(400).json({ error: "Opening balance is already finalized" });
    }

    // Validation: compare STOCK_ITEM line amounts vs InventoryDailyEntry openingStock × cost
    let stockWarning: string | null = null;
    const stockLines = existing.lines.filter((l) => l.lineType === "STOCK_ITEM");
    if (stockLines.length > 0) {
      const stockLineTotal = stockLines.reduce(
        (sum, l) => sum.add(l.amount),
        new Prisma.Decimal(0)
      );

      // Check if any daily entries exist for this outlet
      const latestEntries = await prisma.inventoryDailyEntry.findMany({
        where: { restaurantId },
        orderBy: { entryDate: "desc" },
        take: 1,
      });

      if (latestEntries.length > 0) {
        const latestDate = latestEntries[0].entryDate;
        const entriesOnDate = await prisma.inventoryDailyEntry.findMany({
          where: { restaurantId, entryDate: latestDate },
          include: { item: true },
        });
        const inventoryTotal = entriesOnDate.reduce(
          (sum, e) => sum.add(e.openingStock.mul(e.item.price)),
          new Prisma.Decimal(0)
        );

        const diff = stockLineTotal.minus(inventoryTotal).abs();
        const threshold = inventoryTotal.mul(new Prisma.Decimal("0.05")); // 5% tolerance
        if (diff.greaterThan(threshold)) {
          stockWarning = `Stock line total (₹${stockLineTotal.toString()}) diverges from inventory daily entry total (₹${inventoryTotal.toString()}) by ₹${diff.toString()}. Please verify before proceeding.`;
        }
      }
    }

    const updated = await prisma.openingBalance.update({
      where: { id: existing.id },
      data: {
        isFinalized: true,
        finalizedById: userId,
        finalizedAt: new Date(),
      },
    });

    await writeAuditLog(restaurantId, userId, "opening_balance_finalized", "OpeningBalance", existing.id, {
      stockWarning,
    });

    res.json({
      ...updated,
      stockWarning,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] Finalize failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/opening-balance/unlock — reverse finalization ───────────────────
router.post("/unlock", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;

    const existing = await prisma.openingBalance.findFirst({
      where: { restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "No opening balance found" });
    }
    if (!existing.isFinalized) {
      return res.status(400).json({ error: "Opening balance is not finalized" });
    }

    const updated = await prisma.openingBalance.update({
      where: { id: existing.id },
      data: {
        isFinalized: false,
        finalizedById: null,
        finalizedAt: null,
      },
    });

    // Sensitive action — always logged with user identity
    await writeAuditLog(restaurantId, userId, "opening_balance_unlocked", "OpeningBalance", existing.id, {
      finalizedAt: existing.finalizedAt,
      finalizedById: existing.finalizedById,
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] Unlock failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/opening-balance/suggest-stock-lines ──────────────────────────────
// Reads all KitchenInventoryItem for the outlet and returns a suggested
// OpeningBalanceLine[] array (not yet saved) using each item's current stock
// quantity and cost as a starting point.
router.get("/suggest-stock-lines", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    const items = await prisma.kitchenInventoryItem.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
    });

    const suggestions = items.map((item) => ({
      lineType: "STOCK_ITEM",
      refId: item.id,
      name: item.name,
      quantity: item.currentStock.toString(),
      unitCost: item.price.toString(),
      amount: item.currentStock.mul(item.price).toString(),
      unit: item.unit,
    }));

    res.json(suggestions);
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] Suggest stock lines failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/opening-balance/convert-asset-lines ─────────────────────────────
// One-time action: converts all FIXED_ASSET OpeningBalanceLines into real
// FixedAsset records. Only callable after OpeningBalance.isFinalized = true.
// Back-fills OpeningBalanceLine.refId with the new FixedAsset.id so it's
// not run twice on the same line.
router.post("/convert-asset-lines", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;

    const parent = await prisma.openingBalance.findFirst({
      where: { restaurantId },
    });
    if (!parent) {
      return res.status(404).json({ error: "No opening balance found" });
    }
    if (!parent.isFinalized) {
      return res.status(403).json({ error: "Opening balance must be finalized before converting asset lines." });
    }

    // Find all FIXED_ASSET lines that haven't been converted yet (refId is null)
    const assetLines = await prisma.openingBalanceLine.findMany({
      where: {
        openingBalanceId: parent.id,
        lineType: "FIXED_ASSET",
        refId: null,
      },
    });

    if (assetLines.length === 0) {
      return res.json({ converted: 0, message: "No unconverted FIXED_ASSET lines found." });
    }

    const created: any[] = [];
    for (const line of assetLines) {
      const purchaseDate = line.originalDate || parent.asOfDate;
      const asset = await prisma.fixedAsset.create({
        data: {
          restaurantId,
          name: line.name,
          ledgerCategoryId: line.ledgerCategoryId || null,
          purchaseDate,
          purchaseCost: line.amount,
          usefulLifeMonths: null,
          salvageValue: new Prisma.Decimal(0),
          depreciationMethod: "STRAIGHT_LINE",
          currentBookValue: line.amount,
          status: "ACTIVE",
          sourceType: "OPENING_BALANCE",
          sourceOpeningBalanceLineId: line.id,
          createdById: userId,
        },
      });

      // Back-fill refId so this line is never converted again
      await prisma.openingBalanceLine.update({
        where: { id: line.id },
        data: { refId: asset.id },
      });

      created.push({ id: asset.id, name: asset.name, purchaseDate: asset.purchaseDate });
    }

    await writeAuditLog(restaurantId, userId, "opening_balance_asset_lines_converted", "OpeningBalance", parent.id, {
      convertedCount: created.length,
      assetIds: created.map((c) => c.id),
    });

    res.json({ converted: created.length, assets: created });
  } catch (error: any) {
    logger.error({ err: error }, "[OpeningBalance] Convert asset lines failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
