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
async function recalcVendorBalance(restaurantId: string, vendorId: string) {
  const pos = await prisma.purchaseOrder.findMany({
    where: {
      restaurantId,
      vendorId,
      status: { notIn: ["CANCELLED"] },
    },
    select: { totalAmount: true, amountPaid: true },
  });

  const outstanding = pos.reduce(
    (sum, po) => sum.add(po.totalAmount.sub(po.amountPaid)),
    new Prisma.Decimal(0)
  );

  await prisma.vendor.update({
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

// ── GET /api/purchase-orders/:id — full detail ────────────────────────────────
router.get("/:id", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const po = await prisma.purchaseOrder.findFirst({
      where: { id, restaurantId },
      include: {
        vendor: { select: { id: true, name: true, contactPerson: true, phone: true } },
        items: {
          include: {
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

        const kiItem = await tx.kitchenInventoryItem.findUnique({
          where: { id: item.kitchenInventoryItemId },
        });
        if (!kiItem) continue;

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
          await tx.inventoryDailyEntry.update({
            where: { id: existingEntry.id },
            data: {
              addedStock: { increment: new Prisma.Decimal(deliveredQty) },
              closingStock: new Prisma.Decimal(currentStock + deliveredQty),
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

export default router;
