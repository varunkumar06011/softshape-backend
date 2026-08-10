// ─────────────────────────────────────────────────────────────────────────────
// Purchase Order Routes — PO lifecycle with payments and vendor balance tracking
// ─────────────────────────────────────────────────────────────────────────────
// Status lifecycle: PENDING → DELIVERED → PARTIALLY_PAID → PAID
//                   PENDING → CANCELLED
//
// poNumber is generated server-side (sequential per outlet, e.g. PO-0001).
// totalAmount is computed server-side from line items — never trusted from client.
// amountPaid is a running total from linked payments.
// Vendor.outstandingBalance is recalculated on every payment.
//
// Endpoints:
//   GET    /api/purchase-orders              — list (filterable by status/vendor/date)
//   GET    /api/purchase-orders/:id          — full detail with items + payments
//   POST   /api/purchase-orders              — create with nested items
//   PATCH  /api/purchase-orders/:id          — edit header/items (PENDING only)
//   POST   /api/purchase-orders/:id/mark-delivered  — PENDING → DELIVERED
//   POST   /api/purchase-orders/:id/payments        — record a payment
//   POST   /api/purchase-orders/:id/cancel          — set CANCELLED
//   DELETE /api/purchase-orders/:id                 — hard delete (PENDING + no payments only)
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma, { basePrisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { resolveKitchenRestaurantId, resolveTenantContext } from "../lib/tenantContext";
import { getKolkataDateString } from "../utils/date";
import logger from "../lib/logger";
import { createAuditLog } from "../lib/auditLog";
import { upsertBalanceSheet } from "../services/dailyBalanceSheetService";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

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
    logger.error({ err }, "[PurchaseOrder] AuditLog write failed");
  }
}

// ── Helper: find or create the "Accounts Payable" system LedgerCategory ──────
async function ensureApCategory(restaurantId: string, userId: string | null) {
  const existing = await prisma.ledgerCategory.findFirst({
    where: { restaurantId, entryType: "LIABILITY", name: "Accounts Payable" },
  });
  if (existing) return existing;
  return prisma.ledgerCategory.create({
    data: {
      restaurantId,
      entryType: "LIABILITY",
      name: "Accounts Payable",
      isActive: true,
      createdById: userId,
    },
  });
}

// ── Helper: generate next poNumber for an outlet ──────────────────────────────
async function generatePoNumber(restaurantId: string): Promise<string> {
  const count = await prisma.purchaseOrder.count({
    where: { restaurantId },
  });
  const next = count + 1;
  return `PO-${String(next).padStart(4, "0")}`;
}

// ── Helper: recalculate vendor outstandingBalance ─────────────────────────────
async function recalcVendorBalance(restaurantId: string, vendorId: string, tx?: any) {
  const db = tx || prisma;
  const pos = await db.purchaseOrder.findMany({
    where: {
      restaurantId,
      vendorId,
      status: { notIn: ["CANCELLED"] },
    },
    select: { totalAmount: true, amountPaid: true },
  });

  const poOutstanding = pos.reduce(
    (sum: any, po: any) => sum.add(po.totalAmount.sub(po.amountPaid)),
    new Prisma.Decimal(0)
  );

  // Sum open daily-purchase AP (isSettled = false, not VOIDED)
  const dailyMappings = await db.dailyPurchaseVendorExpenditure.findMany({
    where: { restaurantId, vendorId },
    include: { expenditure: { select: { amount: true, status: true, isSettled: true } } },
  });
  const dailyOutstanding = dailyMappings.reduce(
    (sum: number, m: any) => {
      if (m.expenditure && m.expenditure.status !== "VOIDED" && !m.expenditure.isSettled) {
        return sum + Number(m.expenditure.amount);
      }
      return sum;
    },
    0
  );

  const outstanding = new Prisma.Decimal(poOutstanding).add(new Prisma.Decimal(dailyOutstanding));

  // Guard: verify vendor ownership before update (especially important with raw tx client)
  if (tx) {
    const vendor = await tx.vendor.findFirst({ where: { id: vendorId, restaurantId } });
    if (!vendor) {
      logger.warn({ vendorId, restaurantId }, "[recalcVendorBalance] vendor not found in tenant scope, skipping update");
      return outstanding;
    }
  }

  await db.vendor.update({
    where: { id: vendorId },
    data: { outstandingBalance: outstanding },
  });

  return outstanding;
}

// ── GET /api/purchase-orders — list ───────────────────────────────────────────
router.get("/", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { status, vendorId, dateFrom, dateTo } = req.query;

    const where: any = { restaurantId };
    if (status) where.status = status;
    if (vendorId) where.vendorId = vendorId;
    if (dateFrom || dateTo) {
      where.orderDate = {};
      if (dateFrom) where.orderDate.gte = dateFrom;
      if (dateTo) where.orderDate.lte = dateTo;
    }

    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { orderDate: "desc" },
    });

    res.json(purchaseOrders);
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] GET list failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/purchase-orders — create with nested items ──────────────────────
router.post("/", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { vendorId, orderDate, notes, items } = req.body;

    if (!vendorId) {
      return res.status(400).json({ error: "vendorId is required" });
    }
    if (!orderDate) {
      return res.status(400).json({ error: "orderDate is required" });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one line item is required" });
    }

    // Validate vendor belongs to this outlet
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, restaurantId },
    });
    if (!vendor) {
      return res.status(400).json({ error: "Invalid vendor for this outlet" });
    }

    // Compute line totals and header total server-side
    let totalAmount = new Prisma.Decimal(0);
    const itemData = items.map((item: any) => {
      if (!item.name || !item.name.trim()) {
        throw new Error("Each item must have a name");
      }
      const qty = new Prisma.Decimal(item.quantity || 0);
      const uc = new Prisma.Decimal(item.unitCost || 0);
      const lineTotal = qty.mul(uc);
      totalAmount = totalAmount.add(lineTotal);

      return {
        name: item.name.trim(),
        quantity: qty,
        unit: item.unit || null,
        unitCost: uc,
        lineTotal,
        ledgerCategoryId: item.ledgerCategoryId || null,
      };
    });

    const poNumber = await generatePoNumber(restaurantId);

    const created = await prisma.purchaseOrder.create({
      data: {
        restaurantId,
        vendorId,
        poNumber,
        status: "PENDING",
        orderDate,
        totalAmount,
        notes: notes || null,
        createdById: userId,
        items: {
          create: itemData,
        },
      },
      include: {
        items: true,
        vendor: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_CREATED", "PurchaseOrder", created.id, {
      poNumber,
      vendorId,
      vendorName: vendor.name,
      orderDate,
      totalAmount: totalAmount.toString(),
      itemCount: items.length,
    });

    res.status(201).json(created);
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] POST failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/purchase-orders/:id — edit header/items (PENDING only) ─────────
router.patch("/:id", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { vendorId, orderDate, notes, items } = req.body;

    const existing = await prisma.purchaseOrder.findFirst({
      where: { id, restaurantId },
      include: { items: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Purchase order not found" });
    }
    if (existing.status !== "PENDING") {
      return res.status(403).json({
        error: `Cannot edit a purchase order with status ${existing.status}. Cancel and recreate if changes are needed.`,
      });
    }

    const updateData: any = {};
    if (vendorId !== undefined) {
      const vendor = await prisma.vendor.findFirst({
        where: { id: vendorId, restaurantId },
      });
      if (!vendor) {
        return res.status(400).json({ error: "Invalid vendor for this outlet" });
      }
      updateData.vendorId = vendorId;
    }
    if (orderDate !== undefined) updateData.orderDate = orderDate;
    if (notes !== undefined) updateData.notes = notes || null;

    // If items are provided, replace them entirely
    if (items && Array.isArray(items)) {
      if (items.length === 0) {
        return res.status(400).json({ error: "Cannot have zero line items" });
      }

      // Delete existing items and create new ones
      await prisma.purchaseOrderItem.deleteMany({
        where: { purchaseOrderId: id },
      });

      let totalAmount = new Prisma.Decimal(0);
      const itemData = items.map((item: any) => {
        if (!item.name || !item.name.trim()) {
          throw new Error("Each item must have a name");
        }
        const qty = new Prisma.Decimal(item.quantity || 0);
        const uc = new Prisma.Decimal(item.unitCost || 0);
        const lineTotal = qty.mul(uc);
        totalAmount = totalAmount.add(lineTotal);

        return {
          purchaseOrderId: id,
          name: item.name.trim(),
          quantity: qty,
          unit: item.unit || null,
          unitCost: uc,
          lineTotal,
          ledgerCategoryId: item.ledgerCategoryId || null,
        };
      });

      await prisma.purchaseOrderItem.createMany({
        data: itemData,
      });

      updateData.totalAmount = totalAmount;
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data: updateData,
      include: {
        items: {
          include: {
            ledgerCategory: { select: { id: true, name: true, entryType: true } },
          },
        },
        vendor: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_UPDATED", "PurchaseOrder", id, {
      before: {
        vendorId: existing.vendorId,
        orderDate: existing.orderDate,
        notes: existing.notes,
        totalAmount: existing.totalAmount.toString(),
        itemCount: existing.items.length,
      },
      after: updateData,
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] PATCH failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/purchase-orders/:id/mark-delivered ──────────────────────────────
router.post("/:id/mark-delivered", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { deliveredDate } = req.body;

    const existing = await prisma.purchaseOrder.findFirst({
      where: { id, restaurantId },
      include: { items: true, vendor: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Purchase order not found" });
    }
    if (existing.status !== "PENDING") {
      return res.status(403).json({
        error: `Cannot mark delivered: current status is ${existing.status}, expected PENDING.`,
      });
    }

    const deliveryDate = deliveredDate || getKolkataDateString();
    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    // ── Step 4: Inventory + AP wiring (single transaction, all-or-nothing) ──────
    const needsSetupAssets: string[] = [];
    const updated = await prisma.$transaction(async (tx) => {
      // 1. Process each line item with a kitchenInventoryItemId
      for (const item of existing.items) {
        // Step 5: if item's ledgerCategory is asset-type, create a FixedAsset
        // instead of writing to inventory.
        if (item.ledgerCategoryId) {
          const cat = await tx.ledgerCategory.findUnique({
            where: { id: item.ledgerCategoryId },
          });
          if (cat && cat.isAssetCategory) {
            await tx.fixedAsset.create({
              data: {
                restaurantId,
                name: item.name,
                ledgerCategoryId: item.ledgerCategoryId,
                purchaseDate: deliveryDate,
                purchaseCost: item.lineTotal,
                usefulLifeMonths: null,
                salvageValue: new Prisma.Decimal(0),
                depreciationMethod: "STRAIGHT_LINE",
                currentBookValue: item.lineTotal,
                status: "ACTIVE",
                sourceType: "PURCHASE_ORDER",
                sourcePurchaseOrderItemId: item.id,
                createdById: userId,
              },
            });
            needsSetupAssets.push(item.name);
            continue;
          }
        }

        if (!item.kitchenInventoryItemId) continue;

        // Tenant-scoped FOR UPDATE lock
        const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: any; price: any; name: string; unit: string | null }>>`
          SELECT "id", "currentStock", "price", "name", "unit" FROM "KitchenInventoryItem"
          WHERE "id" = ${item.kitchenInventoryItemId} AND "restaurantId" = ${kitchenRestaurantId}
          FOR UPDATE
        `;
        if (lockedRows.length === 0) continue;

        const kiItem = lockedRows[0];
        const deliveredQty = Number(item.quantity);
        const unitCost = Number(item.unitCost);
        const currentStock = Number(kiItem.currentStock);
        const currentAvgCost = Number(kiItem.price);

        // Update InventoryDailyEntry.addedStock for this item+date
        const existingEntry = await tx.inventoryDailyEntry.findUnique({
          where: {
            restaurantId_itemId_entryDate: {
              restaurantId: kitchenRestaurantId,
              itemId: item.kitchenInventoryItemId,
              entryDate: deliveryDate,
            },
          },
        });

        if (existingEntry) {
          const openingStock = Number(existingEntry.openingStock);
          const consumedStock = Number(existingEntry.consumedStock);
          const newAddedStock = Number(existingEntry.addedStock) + deliveredQty;
          const closingStock = openingStock + newAddedStock - consumedStock;

          await tx.inventoryDailyEntry.update({
            where: { id: existingEntry.id },
            data: {
              addedStock: new Prisma.Decimal(newAddedStock),
              closingStock: new Prisma.Decimal(closingStock),
            },
          });
        } else {
          // Carry forward prior day's closing as opening
          const priorEntry = await tx.inventoryDailyEntry.findFirst({
            where: {
              restaurantId: kitchenRestaurantId,
              itemId: item.kitchenInventoryItemId,
              entryDate: { lt: deliveryDate },
            },
            orderBy: { entryDate: "desc" },
          });
          const opening = priorEntry ? Number(priorEntry.closingStock) : currentStock;

          await tx.inventoryDailyEntry.create({
            data: {
              restaurantId: kitchenRestaurantId,
              itemId: item.kitchenInventoryItemId,
              entryDate: deliveryDate,
              openingStock: new Prisma.Decimal(opening),
              addedStock: new Prisma.Decimal(deliveredQty),
              consumedStock: new Prisma.Decimal(0),
              closingStock: new Prisma.Decimal(opening + deliveredQty),
            },
          });
        }

        // Update KitchenInventoryItem.currentStock and weighted average cost (price)
        const newStock = currentStock + deliveredQty;
        const newAvgCost = currentStock > 0
          ? (currentStock * currentAvgCost + deliveredQty * unitCost) / newStock
          : unitCost;

        await tx.kitchenInventoryItem.update({
          where: { id: item.kitchenInventoryItemId },
          data: {
            currentStock: new Prisma.Decimal(newStock),
            price: new Prisma.Decimal(Math.round(newAvgCost * 100) / 100),
          },
        });

        // Write ledger entry for this stock movement
        await tx.kitchenInventoryTransaction.create({
          data: {
            restaurantId: kitchenRestaurantId,
            itemId: item.kitchenInventoryItemId,
            type: "PURCHASE",
            quantityChange: new Prisma.Decimal(Math.round(deliveredQty * 100) / 100),
            stockBefore: new Prisma.Decimal(Math.round(currentStock * 100) / 100),
            stockAfter: new Prisma.Decimal(Math.round(newStock * 100) / 100),
            source: "PO_DELIVERY",
            notes: `PO delivery: ${existing.poNumber} — ${deliveredQty} ${kiItem.unit || ''} @ ₹${unitCost}`,
            createdBy: userId,
          },
        });
      }

      // 2. Auto-create AP liability Expenditure if there's an unpaid balance
      const totalAmount = Number(existing.totalAmount);
      const amountPaid = Number(existing.amountPaid);
      const unpaidBalance = totalAmount - amountPaid;

      if (unpaidBalance > 0) {
        const apCategory = await ensureApCategory(restaurantId, userId);

        // Generate expenditure number using DailyCounter
        const counter = await tx.dailyCounter.upsert({
          where: { restaurantId_counterDate: { restaurantId, counterDate: "global" } },
          update: { expenditureCount: { increment: 1 } },
          create: { restaurantId, counterDate: "global", expenditureCount: 1 },
        });

        await tx.expenditure.create({
          data: {
            restaurantId,
            expenditureNo: counter.expenditureCount,
            expenditureDate: deliveryDate,
            paidToType: "OTHER",
            paidToName: existing.vendor?.name || "Vendor",
            amount: new Prisma.Decimal(Math.round(unpaidBalance * 100) / 100),
            narration: `AP: ${existing.poNumber} — ${existing.vendor?.name || "Vendor"}`,
            createdById: userId,
            status: "UNVERIFIED",
            entryType: "LIABILITY",
            ledgerCategoryId: apCategory.id,
            linkedPurchaseOrderId: id,
            isSettled: false,
          },
        });
      }

      // 3. Flip PO status to DELIVERED
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          status: "DELIVERED",
          deliveredDate: deliveryDate,
        },
      });
    }, { timeout: 30000, maxWait: 35000 });

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_DELIVERED", "PurchaseOrder", id, {
      statusTransition: { from: "PENDING", to: "DELIVERED" },
      deliveredDate: deliveryDate,
      totalAmount: existing.totalAmount.toString(),
      itemsWithInventory: existing.items.filter((i: any) => i.kitchenInventoryItemId).length,
      apCreated: Number(existing.totalAmount) - Number(existing.amountPaid) > 0,
      fixedAssetsCreated: needsSetupAssets.length,
    });

    res.json({ ...updated, needsSetupAssets });
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] Mark delivered failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/purchase-orders/:id/payments — record a payment ─────────────────
router.post("/:id/payments", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { amount, paymentDate, method, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    if (!paymentDate) {
      return res.status(400).json({ error: "paymentDate is required" });
    }

    const po = await prisma.purchaseOrder.findFirst({
      where: { id, restaurantId },
      include: { vendor: { select: { name: true } } },
    });
    if (!po) {
      return res.status(404).json({ error: "Purchase order not found" });
    }
    if (po.status === "PENDING") {
      return res.status(403).json({ error: "Cannot record payment on a PENDING purchase order. Mark it delivered first." });
    }
    if (po.status === "CANCELLED") {
      return res.status(403).json({ error: "Cannot record payment on a CANCELLED purchase order." });
    }
    if (po.status === "PAID") {
      return res.status(403).json({ error: "This purchase order is already fully paid." });
    }

    const paymentAmount = new Prisma.Decimal(amount);
    const newAmountPaid = po.amountPaid.add(paymentAmount);

    // Reject overpayment
    if (newAmountPaid.greaterThan(po.totalAmount)) {
      return res.status(400).json({
        error: `Payment of ₹${amount} would exceed the total amount. Remaining balance: ₹${po.totalAmount.sub(po.amountPaid).toString()}`,
      });
    }

    // Create the payment record
    const payment = await prisma.purchaseOrderPayment.create({
      data: {
        purchaseOrderId: id,
        amount: paymentAmount,
        paymentDate,
        method: method || null,
        notes: notes || null,
        createdById: userId,
      },
    });

    // Update PO amountPaid and status
    let newStatus = po.status;
    if (newAmountPaid.equals(po.totalAmount)) {
      newStatus = "PAID";
    } else if (newAmountPaid.greaterThan(new Prisma.Decimal(0))) {
      newStatus = "PARTIALLY_PAID";
    }

    const updatedPO = await prisma.purchaseOrder.update({
      where: { id },
      data: {
        amountPaid: newAmountPaid,
        status: newStatus,
      },
    });

    // ── Step 4.4: Settle/adjust the linked AP liability Expenditure ─────────────
    const linkedExpenditure = await prisma.expenditure.findFirst({
      where: { linkedPurchaseOrderId: id, entryType: "LIABILITY", status: { not: "VOIDED" } },
    });

    if (linkedExpenditure) {
      if (newStatus === "PAID") {
        // Fully paid — mark the liability as settled
        await prisma.expenditure.update({
          where: { id: linkedExpenditure.id },
          data: {
            isSettled: true,
            settledAt: new Date(),
            amount: new Prisma.Decimal(0),
          },
        });
      } else if (newStatus === "PARTIALLY_PAID") {
        // Partial payment — reduce the liability amount to reflect remaining balance
        const remainingBalance = po.totalAmount.sub(newAmountPaid);
        await prisma.expenditure.update({
          where: { id: linkedExpenditure.id },
          data: {
            amount: new Prisma.Decimal(Math.round(Number(remainingBalance) * 100) / 100),
            isSettled: false,
          },
        });
      }
    }

    // ── Step 7.1: Create a LIABILITY_PAYMENT expenditure row for cash-paid portion ──
    // Only cash payments reduce the till's cash balance on the Daily Balance Sheet.
    // Bank/UPI payments do not affect cash-in-hand.
    const paymentMethodUpper = (method || "").toUpperCase();
    const isCashPayment = paymentMethodUpper === "CASH" || (!method && true);

    if (isCashPayment) {
      const counter = await prisma.dailyCounter.upsert({
        where: { restaurantId_counterDate: { restaurantId, counterDate: "global" } },
        update: { expenditureCount: { increment: 1 } },
        create: { restaurantId, counterDate: "global", expenditureCount: 1 },
      });

      await prisma.expenditure.create({
        data: {
          restaurantId,
          expenditureNo: counter.expenditureCount,
          expenditureDate: paymentDate,
          paidToType: "OTHER",
          paidToName: po.vendor?.name || "Vendor",
          amount: paymentAmount,
          narration: `Payment: ${po.poNumber} — ${po.vendor?.name || "Vendor"}`,
          createdById: userId,
          status: "UNVERIFIED",
          entryType: "LIABILITY_PAYMENT",
          linkedPurchaseOrderId: id,
          paymentMethod: "CASH",
        },
      });
    }

    // Recalculate vendor outstanding balance
    const newVendorBalance = await recalcVendorBalance(restaurantId, po.vendorId);

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_PAYMENT_RECORDED", "PurchaseOrderPayment", payment.id, {
      purchaseOrderId: id,
      poNumber: po.poNumber,
      paymentAmount: paymentAmount.toString(),
      newAmountPaid: newAmountPaid.toString(),
      totalAmount: po.totalAmount.toString(),
      statusTransition: { from: po.status, to: newStatus },
      vendorOutstandingBalance: newVendorBalance.toString(),
    });

    res.json({
      payment,
      purchaseOrder: updatedPO,
      vendorOutstandingBalance: newVendorBalance.toString(),
    });
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] Payment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/purchase-orders/:id/cancel ──────────────────────────────────────
router.post("/:id/cancel", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;

    const po = await prisma.purchaseOrder.findFirst({
      where: { id, restaurantId },
      include: { _count: { select: { payments: true } } },
    });
    if (!po) {
      return res.status(404).json({ error: "Purchase order not found" });
    }
    if (po.status === "CANCELLED") {
      return res.status(400).json({ error: "Purchase order is already cancelled" });
    }
    if (po._count.payments > 0) {
      return res.status(403).json({
        error: "Cannot cancel a purchase order with existing payments. Settle or reverse the payment first.",
      });
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    // Recalculate vendor balance (cancelled POs are excluded)
    const newVendorBalance = await recalcVendorBalance(restaurantId, po.vendorId);

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_CANCELLED", "PurchaseOrder", id, {
      statusTransition: { from: po.status, to: "CANCELLED" },
      poNumber: po.poNumber,
      totalAmount: po.totalAmount.toString(),
      vendorOutstandingBalance: newVendorBalance.toString(),
    });

    res.json({
      ...updated,
      vendorOutstandingBalance: newVendorBalance.toString(),
    });
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] Cancel failed");
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/purchase-orders/:id — hard delete (PENDING + no payments only) ─
router.delete("/:id", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;

    const po = await prisma.purchaseOrder.findFirst({
      where: { id, restaurantId },
      include: { _count: { select: { payments: true } } },
    });
    if (!po) {
      return res.status(404).json({ error: "Purchase order not found" });
    }
    if (po.status !== "PENDING") {
      return res.status(403).json({
        error: "Can only delete purchase orders with status PENDING. Use /cancel for non-pending orders.",
      });
    }
    if (po._count.payments > 0) {
      return res.status(403).json({
        error: "Cannot delete a purchase order with existing payments. Use /cancel instead.",
      });
    }

    await prisma.purchaseOrder.delete({
      where: { id },
    });

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_DELETED", "PurchaseOrder", id, {
      poNumber: po.poNumber,
      totalAmount: po.totalAmount.toString(),
    });

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] DELETE failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/purchase-orders/reconciliation/outstanding ──────────────────────
// Returns all PurchaseOrders where status is not PAID and not CANCELLED,
// with their outstanding balance (totalAmount - sum of payments).
router.get("/reconciliation/outstanding", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    const outletId = (req.query.outletId as string) || "all";
    const queryIds = outletId === "all" ? tenantIds : [outletId];

    if (outletId !== "all" && !tenantIds.includes(outletId)) {
      return res.status(403).json({ error: "Outlet not accessible" });
    }

    const purchaseOrders = await basePrisma.purchaseOrder.findMany({
      where: {
        restaurantId: { in: queryIds },
        status: { notIn: ["PAID", "CANCELLED"] },
      },
      include: {
        vendor: { select: { id: true, name: true } },
        payments: { select: { amount: true } },
      },
      orderBy: { orderDate: "desc" },
    });

    const outstanding = purchaseOrders.map((po: any) => {
      const paidAmount = po.payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0);
      const outstandingAmount = Math.round((Number(po.totalAmount) - paidAmount) * 100) / 100;
      return {
        id: po.id,
        vendorName: po.vendor?.name || "Unknown Vendor",
        orderDate: po.orderDate,
        totalAmount: Number(po.totalAmount),
        paidAmount: Math.round(paidAmount * 100) / 100,
        outstandingAmount,
        status: po.status,
      };
    });

    // Sort by outstandingAmount descending
    outstanding.sort((a: any, b: any) => b.outstandingAmount - a.outstandingAmount);

    const totalOutstanding = Math.round(
      outstanding.reduce((sum: number, o: any) => sum + o.outstandingAmount, 0) * 100
    ) / 100;

    res.json({
      outstanding,
      totalOutstanding,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] Outstanding reconciliation failed");
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Daily Purchase Entry endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/purchase-orders/daily/items — kitchen inventory items + previous purchase entries for autocomplete
router.get("/daily/items", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    // Fetch all kitchen inventory items for this tenant
    const kitchenItems = await basePrisma.kitchenInventoryItem.findMany({
      where: { restaurantId: kitchenRestaurantId },
      select: { id: true, name: true, unit: true },
      orderBy: { name: "asc" },
    });

    // Also fetch distinct items from previous purchase entries (for price history)
    const entries = await basePrisma.dailyPurchaseEntry.findMany({
      where: { restaurantId },
      select: { kitchenInventoryItemId: true, itemName: true, unit: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    // Merge: start with kitchen items, then add any entry items not already included
    const seen = new Set<string>();
    const items: { kitchenInventoryItemId: string; itemName: string; unit: string | null }[] = [];

    // Add all kitchen inventory items first
    for (const ki of kitchenItems) {
      if (seen.has(ki.id)) continue;
      seen.add(ki.id);
      items.push({
        kitchenInventoryItemId: ki.id,
        itemName: ki.name,
        unit: ki.unit,
      });
    }

    // Add any purchase entry items not already in the list
    for (const e of entries) {
      if (seen.has(e.kitchenInventoryItemId)) continue;
      seen.add(e.kitchenInventoryItemId);
      items.push({
        kitchenInventoryItemId: e.kitchenInventoryItemId,
        itemName: e.itemName,
        unit: e.unit,
      });
    }

    res.json(items);
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] GET /daily/items failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/purchase-orders/daily/previous-price — last purchase price for an item
router.get("/daily/previous-price", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { kitchenInventoryItemId, beforeDate } = req.query;

    if (!kitchenInventoryItemId) {
      return res.json({ previousPrice: null });
    }

    const entryWhere: any = {
      restaurantId,
      kitchenInventoryItemId: String(kitchenInventoryItemId),
    };
    if (beforeDate) {
      entryWhere.date = { lt: String(beforeDate) };
    }

    const lastEntry = await basePrisma.dailyPurchaseEntry.findFirst({
      where: entryWhere,
      orderBy: { createdAt: "desc" },
      select: { unitPrice: true },
    });

    if (lastEntry) {
      res.json({ previousPrice: Number(lastEntry.unitPrice) });
    } else {
      // Fallback: check PO items linked to this kitchen item (tenant-scoped)
      const lastPoItem = await basePrisma.purchaseOrderItem.findFirst({
        where: {
          kitchenInventoryItemId: String(kitchenInventoryItemId),
          purchaseOrder: { restaurantId },
        },
        orderBy: { createdAt: "desc" },
        select: { unitCost: true },
      });
      res.json({ previousPrice: lastPoItem ? Number(lastPoItem.unitCost) : null });
    }
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] GET /daily/previous-price failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/purchase-orders/daily — fetch today's (or a specific date's) entries
router.get("/daily", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const date = (req.query.date as string) || getKolkataDateString();

    const entries = await basePrisma.dailyPurchaseEntry.findMany({
      where: { restaurantId, date },
      include: {
        vendor: { select: { id: true, name: true } },
        kitchenInventoryItem: { select: { id: true, name: true, unit: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const formatted = entries.map((e: any, idx: number) => ({
      id: e.id,
      sNo: idx + 1,
      itemName: e.itemName,
      unit: e.unit,
      quantity: Number(e.quantity),
      unitPrice: Number(e.unitPrice),
      totalPrice: Number(e.totalPrice),
      previousPrice: e.previousPrice ? Number(e.previousPrice) : null,
      priceChange: e.priceChange,
      vendorId: e.vendorId,
      vendorName: e.vendor?.name,
      kitchenInventoryItemId: e.kitchenInventoryItemId,
      paymentStatus: e.paymentStatus,
      paymentMethod: e.paymentMethod,
    }));

    res.json(formatted);
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] GET /daily failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/purchase-orders/daily — save today's daily purchase entries
router.post("/daily", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const today = getKolkataDateString();

    // Reject historical saves
    if (req.body.date && req.body.date !== today) {
      return res.status(403).json({ error: "Cannot save entries for past dates. Only today is editable." });
    }

    const rows: any[] = req.body.rows || [];
    if (rows.length === 0) {
      return res.status(400).json({ error: "At least one purchase row is required." });
    }
    if (rows.length > 200) {
      return res.status(400).json({ error: "Cannot save more than 200 rows in a single request." });
    }

    // Validate rows
    for (const row of rows) {
      if (!row.itemName?.trim()) return res.status(400).json({ error: "Item name is required for all rows." });
      if (row.itemName.trim().length > 255) return res.status(400).json({ error: `Item name must be 255 characters or less for item "${row.itemName.slice(0, 50)}...".` });
      if (!row.vendorId) return res.status(400).json({ error: `Vendor is required for item "${row.itemName}".` });
      if (!row.unit?.trim()) return res.status(400).json({ error: `Unit is required for item "${row.itemName}".` });
      if (row.paymentStatus !== "PENDING" && row.paymentStatus !== "DONE") {
        return res.status(400).json({ error: `Payment status must be PENDING or DONE for item "${row.itemName}".` });
      }
      if (row.paymentStatus === "DONE" && !["CASH", "BANK", "UPI", "CHEQUE"].includes(row.paymentMethod)) {
        return res.status(400).json({ error: `Payment method is required for DONE item "${row.itemName}".` });
      }
      const qtyNum = Number(row.quantity);
      const priceNum = Number(row.unitPrice);
      if (!Number.isFinite(qtyNum) || !Number.isFinite(priceNum)) {
        return res.status(400).json({ error: `Quantity and unit price must be valid numbers for item "${row.itemName}".` });
      }
      if (qtyNum < 0 || priceNum < 0) {
        return res.status(400).json({ error: `Quantity and unit price must be non-negative for item "${row.itemName}".` });
      }
    }

    // Verify all vendorIds belong to this tenant
    const vendorIds = [...new Set(rows.map((r: any) => r.vendorId))];
    const validVendors = await basePrisma.vendor.findMany({
      where: { id: { in: vendorIds }, restaurantId },
      select: { id: true, name: true },
    });
    const validVendorMap = new Map(validVendors.map((v: any) => [v.id, v]));
    for (const row of rows) {
      if (!validVendorMap.has(row.vendorId)) {
        return res.status(400).json({ error: `Vendor not found for item "${row.itemName}".` });
      }
    }

    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);
    const apCategory = await ensureApCategory(restaurantId, userId);

    // Execute everything in a single transaction
    const result = await basePrisma.$transaction(async (tx: any) => {
      // 1. Fetch existing entries for today
      const oldEntries = await tx.dailyPurchaseEntry.findMany({
        where: { restaurantId, date: today },
        select: { id: true, kitchenInventoryItemId: true, quantity: true, unitPrice: true },
      });

      // 2. Build old qty/value maps per kitchenInventoryItemId
      const oldQtyMap = new Map<string, number>();
      const oldValueMap = new Map<string, number>();
      for (const old of oldEntries) {
        const kid = old.kitchenInventoryItemId;
        const qty = Number(old.quantity);
        const val = qty * Number(old.unitPrice);
        oldQtyMap.set(kid, (oldQtyMap.get(kid) || 0) + qty);
        oldValueMap.set(kid, (oldValueMap.get(kid) || 0) + val);
      }

      // 3. Delete old entries
      if (oldEntries.length > 0) {
        await tx.dailyPurchaseEntry.deleteMany({
          where: { restaurantId, date: today },
        });
      }

      // 4. Resolve or create KitchenInventoryItem for each row, collect resolved items
      const resolvedRows: any[] = [];
      for (const row of rows) {
        const normalizedName = row.itemName.trim().toLowerCase();

        let kiItem = null;

        // If kitchenInventoryItemId is provided (user selected from dropdown), use it directly
        if (row.kitchenInventoryItemId) {
          kiItem = await tx.kitchenInventoryItem.findFirst({
            where: { id: row.kitchenInventoryItemId, restaurantId: kitchenRestaurantId },
          });
        }

        // Fallback: find by normalizedName, then by exact name
        if (!kiItem) {
          kiItem = await tx.kitchenInventoryItem.findFirst({
            where: { restaurantId: kitchenRestaurantId, normalizedName },
          });
        }

        if (!kiItem) {
          // Fallback: exact name match (for items created before normalizedName was added)
          kiItem = await tx.kitchenInventoryItem.findFirst({
            where: { restaurantId: kitchenRestaurantId, name: row.itemName.trim() },
          });
        }

        if (!kiItem) {
          // Create new item
          try {
            kiItem = await tx.kitchenInventoryItem.create({
              data: {
                name: row.itemName.trim(),
                normalizedName,
                unit: row.unit.trim(),
                category: "",
                currentStock: new Prisma.Decimal(0),
                reorderLevel: new Prisma.Decimal(0),
                price: new Prisma.Decimal(0),
                restaurantId: kitchenRestaurantId,
              },
            });
          } catch (createErr: any) {
            // Race condition: another request created it. Try to find again.
            kiItem = await tx.kitchenInventoryItem.findFirst({
              where: { restaurantId: kitchenRestaurantId, normalizedName },
            });
            if (!kiItem) {
              throw new Error(`Failed to create or find kitchen item "${row.itemName}".`);
            }
          }
        }

        // Fetch previous price for this item (from entries before today)
        const lastEntry = await tx.dailyPurchaseEntry.findFirst({
          where: { restaurantId, kitchenInventoryItemId: kiItem.id, date: { lt: today } },
          orderBy: { createdAt: "desc" },
          select: { unitPrice: true },
        });
        const previousPrice = lastEntry ? Number(lastEntry.unitPrice) : null;
        const currentPrice = Number(row.unitPrice);
        let priceChange: string | null = null;
        if (previousPrice !== null) {
          if (currentPrice > previousPrice) priceChange = "UP";
          else if (currentPrice < previousPrice) priceChange = "DOWN";
          else priceChange = "SAME";
        }

        resolvedRows.push({
          ...row,
          kitchenInventoryItemId: kiItem.id,
          previousPrice,
          priceChange,
        });
      }

      // 5. Build new qty/value maps per kitchenInventoryItemId
      const newQtyMap = new Map<string, number>();
      const newValueMap = new Map<string, number>();
      for (const r of resolvedRows) {
        const kid = r.kitchenInventoryItemId;
        const qty = Number(r.quantity);
        const val = qty * Number(r.unitPrice);
        newQtyMap.set(kid, (newQtyMap.get(kid) || 0) + qty);
        newValueMap.set(kid, (newValueMap.get(kid) || 0) + val);
      }

      // 6. Sort affected kitchenInventoryItemIds deterministically for lock ordering
      const allItemIds = [...new Set([...oldQtyMap.keys(), ...newQtyMap.keys()])].sort();

      // 7. Take FOR UPDATE locks and compute new stock + avg price
      for (const itemId of allItemIds) {
        // Lock the row (tenant-scoped)
        const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "KitchenInventoryItem"
          WHERE "id" = ${itemId} AND "restaurantId" = ${kitchenRestaurantId}
          FOR UPDATE
        `;
        if (lockedRows.length === 0) continue;

        const kiItem = await tx.kitchenInventoryItem.findUnique({
          where: { id: itemId },
        });
        if (!kiItem) continue;

        const oldQty = oldQtyMap.get(itemId) || 0;
        const newQty = newQtyMap.get(itemId) || 0;
        const newValue = newValueMap.get(itemId) || 0;

        const currentStock = Number(kiItem.currentStock);
        const currentPrice = Number(kiItem.price);

        // baseStock = stock that existed before today's purchase block
        const baseStock = Math.max(0, currentStock - oldQty);
        const baseValue = baseStock * currentPrice;
        const newStock = baseStock + newQty;

        // Negative stock check
        if (newStock < 0) {
          throw new Error(`Insufficient stock for "${kiItem.name}". Current: ${currentStock}, old purchase qty: ${oldQty}, new purchase qty: ${newQty}. Stock would become ${newStock}.`);
        }

        const newAvgPrice = newStock > 0
          ? Math.round(((baseValue + newValue) / newStock) * 100) / 100
          : currentPrice;

        // Lock the InventoryDailyEntry row if it exists (FOR UPDATE)
        await tx.$queryRaw`SELECT * FROM "InventoryDailyEntry" WHERE "restaurantId" = ${kitchenRestaurantId} AND "itemId" = ${itemId} AND "entryDate" = ${today} FOR UPDATE`;

        // Update InventoryDailyEntry for today
        const existingEntry = await tx.inventoryDailyEntry.findUnique({
          where: {
            restaurantId_itemId_entryDate: {
              restaurantId: kitchenRestaurantId,
              itemId,
              entryDate: today,
            },
          },
        });

        if (existingEntry) {
          const manualAdded = Math.max(0, Number(existingEntry.addedStock) - oldQty);
          const newAdded = manualAdded + newQty;
          const openingStock = Number(existingEntry.openingStock);
          const consumedStock = Number(existingEntry.consumedStock);
          const closingStock = openingStock + newAdded - consumedStock;

          // Negative closing stock check
          if (closingStock < 0) {
            throw new Error(`Insufficient stock for "${kiItem.name}". Closing stock would become ${closingStock} (opening: ${openingStock}, added: ${newAdded}, consumed: ${consumedStock}).`);
          }

          await tx.inventoryDailyEntry.update({
            where: { id: existingEntry.id },
            data: {
              addedStock: new Prisma.Decimal(newAdded),
              closingStock: new Prisma.Decimal(closingStock),
            },
          });
        } else {
          await tx.inventoryDailyEntry.create({
            data: {
              restaurantId: kitchenRestaurantId,
              itemId,
              entryDate: today,
              openingStock: new Prisma.Decimal(baseStock),
              addedStock: new Prisma.Decimal(newQty),
              consumedStock: new Prisma.Decimal(0),
              closingStock: new Prisma.Decimal(baseStock + newQty),
            },
          });
        }

        // Update KitchenInventoryItem
        await tx.kitchenInventoryItem.update({
          where: { id: itemId },
          data: {
            currentStock: new Prisma.Decimal(newStock),
            price: new Prisma.Decimal(newAvgPrice),
          },
        });

        // Write ledger entry for this stock movement
        const netChange = newQty - oldQty;
        if (Math.abs(netChange) > 0.0001) {
          await tx.kitchenInventoryTransaction.create({
            data: {
              restaurantId: kitchenRestaurantId,
              itemId,
              type: "PURCHASE",
              quantityChange: new Prisma.Decimal(Math.round(netChange * 100) / 100),
              stockBefore: new Prisma.Decimal(Math.round((newStock - netChange) * 100) / 100),
              stockAfter: new Prisma.Decimal(Math.round(newStock * 100) / 100),
              source: "DAILY_PURCHASE",
              notes: `Daily purchase: ${kiItem.name} — ${newQty} ${kiItem.unit || ''} @ ₹${newAvgPrice}`,
              createdBy: userId,
            },
          });
        }
      }

      // 8. Reconcile vendor expenditures
      // Fetch existing mappings for today
      const existingMappings = await tx.dailyPurchaseVendorExpenditure.findMany({
        where: { restaurantId, date: today },
        include: { expenditure: true },
      });

      // Group new rows by (vendorId, paymentStatus)
      const newGroups = new Map<string, { vendorId: string; paymentStatus: string; total: number; paymentMethod: string | null }>();
      for (const r of resolvedRows) {
        const key = `${r.vendorId}|${r.paymentStatus}`;
        const existing = newGroups.get(key);
        const rowTotal = Number(r.quantity) * Number(r.unitPrice);
        if (existing) {
          existing.total += rowTotal;
        } else {
          newGroups.set(key, {
            vendorId: r.vendorId,
            paymentStatus: r.paymentStatus,
            total: rowTotal,
            paymentMethod: r.paymentStatus === "DONE" ? (r.paymentMethod || "CASH") : null,
          });
        }
      }

      // Build lookup of existing mappings by (vendorId, paymentStatus)
      const existingMap = new Map<string, any>();
      for (const m of existingMappings) {
        const key = `${m.vendorId}|${m.paymentStatus}`;
        existingMap.set(key, m);
      }

      // Track which existing mappings are still needed
      const usedMappingIds = new Set<string>();

      // Process new groups
      const auditEntries: { action: string; expenditureId: string; amount: number; vendorName: string }[] = [];

      for (const [key, group] of newGroups) {
        if (group.total <= 0) continue;

        const vendor = validVendorMap.get(group.vendorId);
        const vendorName = vendor?.name || "Vendor";
        const existingMapping = existingMap.get(key);

        if (existingMapping && existingMapping.expenditure && existingMapping.expenditure.status !== "VOIDED") {
          // Update existing expenditure in place (preserve expenditureNo)
          const updated = await tx.expenditure.update({
            where: { id: existingMapping.expenditureId },
            data: {
              amount: new Prisma.Decimal(Math.round(group.total * 100) / 100),
              status: group.paymentStatus === "DONE" ? "VERIFIED" : "UNVERIFIED",
              isSettled: group.paymentStatus === "DONE",
              settledAt: group.paymentStatus === "DONE" ? new Date() : null,
              paymentMethod: group.paymentMethod,
              isAutoGenerated: true,
            },
          });
          usedMappingIds.add(existingMapping.id);

          // Update mapping paymentMethod if changed
          await tx.dailyPurchaseVendorExpenditure.update({
            where: { id: existingMapping.id },
            data: { paymentMethod: group.paymentMethod },
          });

          if (group.paymentStatus === "DONE") {
            auditEntries.push({ action: "EXPENDITURE_APPROVED", expenditureId: updated.id, amount: group.total, vendorName });
          }
        } else {
          // Create new expenditure + mapping
          const counter = await tx.dailyCounter.upsert({
            where: { restaurantId_counterDate: { restaurantId, counterDate: "global" } },
            update: { expenditureCount: { increment: 1 } },
            create: { restaurantId, counterDate: "global", expenditureCount: 1 },
          });

          const newExp = await tx.expenditure.create({
            data: {
              restaurantId,
              expenditureNo: counter.expenditureCount,
              expenditureDate: today,
              paidToType: "OTHER",
              paidToName: vendorName,
              amount: new Prisma.Decimal(Math.round(group.total * 100) / 100),
              narration: `Daily Purchase — ${vendorName} — ${group.paymentStatus}`,
              createdById: userId,
              status: group.paymentStatus === "DONE" ? "VERIFIED" : "UNVERIFIED",
              entryType: "LIABILITY",
              ledgerCategoryId: apCategory.id,
              paymentMethod: group.paymentMethod,
              isSettled: group.paymentStatus === "DONE",
              settledAt: group.paymentStatus === "DONE" ? new Date() : null,
              isAutoGenerated: true,
            },
          });

          await tx.dailyPurchaseVendorExpenditure.create({
            data: {
              restaurantId,
              date: today,
              vendorId: group.vendorId,
              paymentStatus: group.paymentStatus,
              paymentMethod: group.paymentMethod,
              expenditureId: newExp.id,
            },
          });

          auditEntries.push({
            action: group.paymentStatus === "DONE" ? "EXPENDITURE_APPROVED" : "EXPENDITURE_CREATED",
            expenditureId: newExp.id,
            amount: group.total,
            vendorName,
          });
        }
      }

      // Void+delete mappings for groups no longer present (preserve audit trail)
      for (const [key, mapping] of existingMap) {
        if (!usedMappingIds.has(mapping.id)) {
          // Void the expenditure (if not already VOIDED) to preserve audit trail
          if (mapping.expenditure && mapping.expenditure.status !== "VOIDED") {
            await tx.expenditure.update({
              where: { id: mapping.expenditureId },
              data: { status: "VOIDED", isSettled: false, settledAt: null },
            });
          }
          await tx.dailyPurchaseVendorExpenditure.delete({ where: { id: mapping.id } });
        }
      }

      // 9. Recompute affected vendor balances
      for (const vendorId of vendorIds) {
        await recalcVendorBalance(restaurantId, vendorId, tx);
      }

      // 10. Create new DailyPurchaseEntry rows
      const savedRows: any[] = [];
      for (const r of resolvedRows) {
        const created = await tx.dailyPurchaseEntry.create({
          data: {
            restaurantId,
            date: today,
            paymentStatus: r.paymentStatus,
            paymentMethod: r.paymentStatus === "DONE" ? (r.paymentMethod || "CASH") : null,
            itemName: r.itemName.trim(),
            unit: r.unit?.trim() || null,
            quantity: new Prisma.Decimal(Number(r.quantity)),
            unitPrice: new Prisma.Decimal(Number(r.unitPrice)),
            totalPrice: new Prisma.Decimal(Math.round(Number(r.quantity) * Number(r.unitPrice) * 100) / 100),
            previousPrice: r.previousPrice != null ? new Prisma.Decimal(r.previousPrice) : null,
            priceChange: r.priceChange,
            vendorId: r.vendorId,
            kitchenInventoryItemId: r.kitchenInventoryItemId,
            createdById: userId,
          },
        });
        savedRows.push({
          id: created.id,
          itemName: created.itemName,
          unit: created.unit,
          quantity: Number(created.quantity),
          unitPrice: Number(created.unitPrice),
          totalPrice: Number(created.totalPrice),
          previousPrice: created.previousPrice ? Number(created.previousPrice) : null,
          priceChange: created.priceChange,
          vendorId: created.vendorId,
          kitchenInventoryItemId: created.kitchenInventoryItemId,
          paymentStatus: created.paymentStatus,
          paymentMethod: created.paymentMethod,
        });
      }

      return { auditEntries, vendorIds, savedRows };
    }, { timeout: 30000, maxWait: 35000 });

    // 11. After transaction commits — audit trail
    await writeAuditLog(restaurantId, userId, "DAILY_PURCHASE_ENTRY_SAVED", "DailyPurchaseEntry", null, {
      date: today,
      rowCount: rows.length,
      vendorIds: result.vendorIds,
    });

    for (const audit of result.auditEntries) {
      createAuditLog({
        userId,
        restaurantId,
        action: audit.action,
        entityType: "Expenditure",
        entityId: audit.expenditureId,
        metadata: {
          amount: audit.amount,
          vendorName: audit.vendorName,
          entryType: "LIABILITY",
          source: "DAILY_PURCHASE",
        },
      });
    }

    // 12. Refresh Daily Balance Sheet (skip if LOCKED)
    try {
      await upsertBalanceSheet(restaurantId, today, {}, userId);
    } catch (err: any) {
      if (err.statusCode === 409 || err.message?.includes("LOCKED")) {
        logger.warn({ restaurantId, date: today }, "[DailyPurchase] Balance sheet is LOCKED, skipping refresh");
      } else {
        logger.error({ err }, "[DailyPurchase] Failed to refresh balance sheet");
      }
    }

    res.json(result.savedRows);
  } catch (error: any) {
    if (error.message?.includes("Insufficient stock")) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, "[DailyPurchase] POST /daily save failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/purchase-orders/:id — full detail (MUST be after all specific routes) ─
router.get("/:id", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const po = await prisma.purchaseOrder.findFirst({
      where: { id, restaurantId },
      include: {
        vendor: { select: { id: true, name: true, contactPerson: true, phone: true, email: true, address: true } },
        items: {
          include: {
            kitchenInventoryItem: { select: { id: true, name: true, unit: true } },
            ledgerCategory: { select: { id: true, name: true, entryType: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        payments: {
          include: {
            createdBy: { select: { id: true, name: true } },
          },
          orderBy: { paymentDate: "desc" },
        },
        createdBy: { select: { id: true, name: true } },
      },
    });

    if (!po) {
      return res.status(404).json({ error: "Purchase order not found" });
    }

    res.json(po);
  } catch (error: any) {
    logger.error({ err: error }, "[PurchaseOrder] GET detail failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
