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
import { convertToBaseUnit } from "../utils/unitConversion";
import { getIo } from "../socket";
import { PAYMENT_METHODS, MAX_ITEM_NAME, MAX_DAILY_ROWS, NORMALIZED_NAME_MAX_LENGTH, TX_TIMEOUT_MS, TX_MAX_WAIT_MS, DAILY_PURCHASE_TX_TIMEOUT_MS, DAILY_PURCHASE_TX_MAX_WAIT_MS, AP_CATEGORY_NAME, AP_CATEGORY_ENTRY_TYPE, EXPENDITURE_STATUS, ENTRY_TYPE, PO_STATUS, BALANCE_SHEET_STATUS, AUDIT_SOURCE, PAID_TO_TYPE, GLOBAL_COUNTER_DATE, CASH_METHOD } from "../utils/constants";

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
    where: { restaurantId, entryType: AP_CATEGORY_ENTRY_TYPE, name: AP_CATEGORY_NAME },
  });
  if (existing) return existing;
  return prisma.ledgerCategory.create({
    data: {
      restaurantId,
      entryType: AP_CATEGORY_ENTRY_TYPE,
      name: AP_CATEGORY_NAME,
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
export async function recalcVendorBalance(restaurantId: string, vendorId: string, tx?: any) {
  const db = tx || prisma;
  const pos = await db.purchaseOrder.findMany({
    where: {
      restaurantId,
      vendorId,
      status: { notIn: [PO_STATUS.CANCELLED] },
    },
    select: { totalAmount: true, amountPaid: true },
  });

  const poOutstanding = pos.reduce(
    (sum: any, po: any) => sum.add(po.totalAmount.sub(po.amountPaid)),
    new Prisma.Decimal(0)
  );

  // Sum open daily-purchase AP directly from DailyPurchaseEntry (PENDING = not yet paid)
  // No Expenditure records are created for daily purchases — vendor outstanding is
  // computed from the entries themselves. Expenditures only appear when admin
  // explicitly records a vendor payment (LIABILITY_PAYMENT).
  const dailyEntries = await db.dailyPurchaseEntry.findMany({
    where: { restaurantId, vendorId, paymentStatus: "PENDING" },
    select: { totalPrice: true },
  });
  const dailyOutstanding = dailyEntries.reduce(
    (sum: number, e: any) => sum + Number(e.totalPrice),
    0
  );

  // Subtract standalone vendor payments (LIABILITY_PAYMENT expenditures linked to this vendor, not VOIDED)
  const standalonePayments = await db.expenditure.findMany({
    where: {
      restaurantId,
      linkedVendorId: vendorId,
      entryType: ENTRY_TYPE.LIABILITY_PAYMENT,
      status: { not: EXPENDITURE_STATUS.VOIDED },
    },
    select: { amount: true },
  });
  const totalStandalonePayments = standalonePayments.reduce(
    (sum: number, e: any) => sum + Number(e.amount),
    0
  );

  const outstanding = new Prisma.Decimal(poOutstanding)
    .add(new Prisma.Decimal(dailyOutstanding))
    .sub(new Prisma.Decimal(totalStandalonePayments));

  // Clamp to 0 — overpayments shouldn't show negative outstanding
  const finalOutstanding = outstanding.lt(0) ? new Prisma.Decimal(0) : outstanding;

  // Guard: verify vendor ownership before update (especially important with raw tx client)
  if (tx) {
    const vendor = await tx.vendor.findFirst({ where: { id: vendorId, restaurantId } });
    if (!vendor) {
      logger.warn({ vendorId, restaurantId }, "[recalcVendorBalance] vendor not found in tenant scope, skipping update");
      return finalOutstanding;
    }
  }

  await db.vendor.update({
    where: { id: vendorId },
    data: { outstandingBalance: finalOutstanding },
  });

  return finalOutstanding;
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
    // Note: status recheck happens inside the transaction with a FOR UPDATE lock
    // to prevent concurrent double-delivery (Critical #4).

    const deliveryDate = deliveredDate || getKolkataDateString();
    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    // ── Step 4: Inventory + AP wiring (single transaction, all-or-nothing) ──────
    const needsSetupAssets: string[] = [];
    const updated = await prisma.$transaction(async (tx) => {
      // ── Critical #4 fix: lock the PO FOR UPDATE and recheck status inside the tx ──
      // Two concurrent delivery requests can both pass the pre-check above.
      // The FOR UPDATE lock + status recheck ensures only one proceeds.
      const lockedPoRows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "PurchaseOrder" WHERE "id" = ${id} FOR UPDATE
      `;
      const lockedPo = lockedPoRows[0];
      if (!lockedPo) {
        throw Object.assign(new Error("Purchase order not found"), { statusCode: 404 });
      }
      // Idempotency: if already DELIVERED, return success without re-adding stock
      if (lockedPo.status === "DELIVERED") {
        return prisma.purchaseOrder.findUnique({ where: { id } });
      }
      if (lockedPo.status !== "PENDING") {
        throw Object.assign(
          new Error(`Cannot mark delivered: current status is ${lockedPo.status}, expected PENDING.`),
          { statusCode: 403 },
        );
      }

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

      // 2. Flip PO status to DELIVERED
      // NOTE: No LIABILITY expenditure is created here. The PO itself tracks the
      // payable (totalAmount - amountPaid). Only actual payments create expenditures.
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          status: "DELIVERED",
          deliveredDate: deliveryDate,
        },
      });
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS });

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_DELIVERED", "PurchaseOrder", id, {
      statusTransition: { from: "PENDING", to: "DELIVERED" },
      deliveredDate: deliveryDate,
      totalAmount: existing.totalAmount.toString(),
      itemsWithInventory: existing.items.filter((i: any) => i.kitchenInventoryItemId).length,
      apCreated: false,
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
    if (po.status === PO_STATUS.PENDING) {
      return res.status(403).json({ error: "Cannot record payment on a PENDING purchase order. Mark it delivered first." });
    }
    if (po.status === PO_STATUS.CANCELLED) {
      return res.status(403).json({ error: "Cannot record payment on a CANCELLED purchase order." });
    }
    if (po.status === PO_STATUS.PAID) {
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
      newStatus = PO_STATUS.PAID;
    } else if (newAmountPaid.greaterThan(new Prisma.Decimal(0))) {
      newStatus = PO_STATUS.PARTIALLY_PAID;
    }

    const updatedPO = await prisma.purchaseOrder.update({
      where: { id },
      data: {
        amountPaid: newAmountPaid,
        status: newStatus,
      },
    });

    // ── Create a LIABILITY_PAYMENT expenditure for this payment ──────────────
    // Every payment (cash, bank, UPI, cheque) creates its own expenditure entry.
    // Dedup: if an expenditure already exists for this payment record, skip.
    const existingExp = await prisma.expenditure.findFirst({
      where: { linkedPurchaseOrderPaymentId: payment.id },
    });

    if (!existingExp) {
      const paymentMethodUpper = (method || "").toUpperCase();
      const resolvedPaymentMethod = paymentMethodUpper || CASH_METHOD;

      const counter = await prisma.dailyCounter.upsert({
        where: { restaurantId_counterDate: { restaurantId, counterDate: GLOBAL_COUNTER_DATE } },
        update: { expenditureCount: { increment: 1 } },
        create: { restaurantId, counterDate: GLOBAL_COUNTER_DATE, expenditureCount: 1 },
      });

      await prisma.expenditure.create({
        data: {
          restaurantId,
          expenditureNo: counter.expenditureCount,
          expenditureDate: paymentDate,
          paidToType: PAID_TO_TYPE.OTHER,
          paidToName: po.vendor?.name || "Vendor",
          amount: paymentAmount,
          narration: `Payment: ${po.poNumber} — ${po.vendor?.name || "Vendor"}`,
          createdById: userId,
          status: EXPENDITURE_STATUS.UNVERIFIED,
          entryType: ENTRY_TYPE.LIABILITY_PAYMENT,
          linkedPurchaseOrderId: id,
          linkedPurchaseOrderPaymentId: payment.id,
          paymentMethod: resolvedPaymentMethod,
          isAutoGenerated: true,
        },
      });
    }

    // Recalculate vendor outstanding balance
    const newVendorBalance = await recalcVendorBalance(restaurantId, po.vendorId);

    // Refresh Daily Balance Sheet (best-effort, skip if LOCKED)
    try {
      await upsertBalanceSheet(restaurantId, paymentDate, {}, userId);
    } catch (err: any) {
      if (err.statusCode === 409 || err.message?.includes(BALANCE_SHEET_STATUS.LOCKED)) {
        logger.warn({ restaurantId, date: paymentDate }, "[PurchaseOrderPayment] Balance sheet LOCKED, skipping refresh");
      } else {
        logger.error({ err, restaurantId, date: paymentDate }, "[PurchaseOrderPayment] Balance sheet refresh failed");
      }
    }

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
    if (po.status === PO_STATUS.CANCELLED) {
      return res.status(400).json({ error: "Purchase order is already cancelled" });
    }
    // Critical #4: block cancellation of DELIVERED POs — stock has already been
    // received. A future vendor-return workflow must append a separate OUT movement.
    if (po.status === PO_STATUS.DELIVERED || po.status === "PARTIALLY_PAID" || po.status === "PAID") {
      return res.status(403).json({
        error: `Cannot cancel a ${po.status} purchase order. Stock has already been received. Use a vendor return workflow instead.`,
      });
    }
    if (po._count.payments > 0) {
      return res.status(403).json({
        error: "Cannot cancel a purchase order with existing payments. Settle or reverse the payment first.",
      });
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data: { status: PO_STATUS.CANCELLED },
    });

    // Recalculate vendor balance (cancelled POs are excluded)
    const newVendorBalance = await recalcVendorBalance(restaurantId, po.vendorId);

    await writeAuditLog(restaurantId, userId, "PURCHASE_ORDER_CANCELLED", "PurchaseOrder", id, {
      statusTransition: { from: po.status, to: PO_STATUS.CANCELLED },
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
        status: { notIn: [PO_STATUS.PAID, PO_STATUS.CANCELLED] },
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

// ── GET /api/purchase-orders/daily/bar-items — bar menu items for autocomplete ──
// Returns all LIQUOR/BAR menu items for the tenant's bar outlet, including
// whether each item has an InventoryItem linked. The frontend uses this to
// show bar items in the daily purchase autocomplete. If a menu item has no
// inventory link, the POST /daily/bar endpoint will auto-create one.
router.get("/daily/bar-items", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const outletId = (req.query.outletId as string) || sessionRestaurantId;

    // Resolve the bar outlet — the user's active outlet IS the bar outlet
    // (bar inventory is scoped to the outlet itself, unlike kitchen which
    // can be shared via sharedKitchenOutletId).
    let barId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      barId = outletId;
    }

    // Fetch all LIQUOR menu items for this outlet
    const menuItems = await prisma.menuItem.findMany({
      where: {
        restaurantId: barId,
        isDeleted: false,
        menuType: "LIQUOR",
      },
      select: {
        id: true,
        name: true,
        menuType: true,
        category: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    });

    // Fetch existing InventoryItem links for these menu items
    const existingInv = await prisma.inventoryItem.findMany({
      where: {
        restaurantId: barId,
        menuItemId: { in: menuItems.map((m) => m.id) },
      },
      select: {
        menuItemId: true,
        id: true,
        bottleSize: true,
        unitOfMeasure: true,
        costPerBottle: true,
        currentStock: true,
        reorderLevel: true,
        isActive: true,
      },
    });

    const invByMenuId = new Map(existingInv.map((i) => [i.menuItemId, i]));

    const items = menuItems.map((m) => {
      const inv = invByMenuId.get(m.id);
      return {
        menuItemId: m.id,
        itemName: m.name,
        menuType: m.menuType,
        category: m.category?.name || null,
        // Inventory link status — if null, the POST /daily/bar endpoint will
        // auto-create an InventoryItem when a purchase is recorded.
        inventoryItemId: inv?.id || null,
        hasInventory: !!inv,
        bottleSize: inv?.bottleSize || 750,
        unitOfMeasure: inv?.unitOfMeasure || "ml",
        costPerBottle: inv?.costPerBottle ? Number(inv.costPerBottle) : 0,
        currentStock: inv?.currentStock ? Number(inv.currentStock) : 0,
        reorderLevel: inv?.reorderLevel ? Number(inv.reorderLevel) : 0,
        isActive: inv?.isActive ?? true,
      };
    });

    res.json(items);
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] GET /daily/bar-items failed");
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
// Returns both kitchen daily-purchase entries and bar inventory purchase transactions.
router.get("/daily", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const date = (req.query.date as string) || getKolkataDateString();

    // Support cross-outlet filtering like the balance sheet endpoints.
    // outletId=all → return entries for all tenant outlets
    // outletId=<id> → return entries for that specific outlet
    // omitted → use the session's active restaurant
    const outletId = (req.query.outletId as string) || null;
    let restaurantIds: string[] = [sessionRestaurantId];
    if (outletId === "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      restaurantIds = ctx.allIds ?? [sessionRestaurantId];
    } else if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      restaurantIds = [outletId];
    }

    // ── Kitchen entries ────────────────────────────────────────────────────────
    const entries = await basePrisma.dailyPurchaseEntry.findMany({
      where: { restaurantId: { in: restaurantIds }, date },
      include: {
        vendor: { select: { id: true, name: true } },
        kitchenInventoryItem: { select: { id: true, name: true, unit: true } },
        category: { select: { id: true, name: true, entryType: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const kitchenFormatted = entries.map((e: any, idx: number) => ({
      id: e.id,
      sNo: idx + 1,
      itemName: e.itemName,
      isBarItem: false,
      unit: e.unit,
      quantity: Number(e.quantity),
      unitPrice: Number(e.unitPrice),
      totalPrice: Number(e.totalPrice),
      previousPrice: e.previousPrice ? Number(e.previousPrice) : null,
      priceChange: e.priceChange,
      vendorId: e.vendorId,
      vendorName: e.vendor?.name,
      kitchenInventoryItemId: e.kitchenInventoryItemId,
      menuItemId: null,
      categoryId: e.categoryId,
      categoryName: e.category?.name || null,
      paymentStatus: e.paymentStatus,
      paymentMethod: e.paymentMethod,
    }));

    // ── Bar purchase transactions ─────────────────────────────────────────────
    // Parse date to get start and end of day in IST (matching barInventory.ts)
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const dateObj = new Date(date + "T00:00:00Z");
    const startOfDayUTC = new Date(dateObj.getTime() - IST_OFFSET_MS);
    const endOfDayUTC = new Date(startOfDayUTC.getTime() + 24 * 60 * 60 * 1000 - 1);

    const barTransactions = await basePrisma.inventoryTransaction.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        type: "PURCHASE",
        transactionDate: { gte: startOfDayUTC, lte: endOfDayUTC },
      },
      include: {
        item: {
          select: {
            id: true,
            menuItemId: true,
            bottleSize: true,
            costPerBottle: true,
            menuItem: { select: { name: true } },
          },
        },
      },
      orderBy: { transactionDate: "asc" },
    });

    const barFormatted = barTransactions.map((t: any, idx: number) => {
      const bottleSize = Number(t.item.bottleSize) || 750;
      const qtyMl = Number(t.quantityChange);
      const bottles = Math.round((qtyMl / bottleSize) * 100) / 100;
      const costPerBottle = Number(t.item.costPerBottle) || 0;
      return {
        id: t.id,
        sNo: kitchenFormatted.length + idx + 1,
        itemName: t.item.menuItem?.name || t.notes?.split(':')[1]?.split('—')[0]?.trim() || 'Bar Item',
        isBarItem: true,
        menuItemId: t.item.menuItemId,
        inventoryItemId: t.item.id,
        unit: 'bottle',
        quantity: bottles,
        unitPrice: costPerBottle,
        totalPrice: bottles * costPerBottle,
        previousPrice: null,
        vendorId: '',
        vendorName: null,
        categoryId: null,
        categoryName: null,
        paymentStatus: 'PENDING',
        paymentMethod: 'CASH',
      };
    });

    const allEntries = [...kitchenFormatted, ...barFormatted];
    res.json(allEntries);
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] GET /daily failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/purchase-orders/daily — save daily purchase entries (today or past dates)
router.post("/daily", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const today = getKolkataDateString();

    // Support explicit outletId — saves to the specified outlet (must be in tenant).
    // If omitted, uses the session's active restaurant (backward compatible).
    const outletId = (req.body.outletId as string) || (req.query.outletId as string) || null;
    let restaurantId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      restaurantId = outletId;
    }

    // Use the date from the request body, defaulting to today.
    // Past dates are allowed for creating/editing entries, but inventory stock
    // updates are skipped (stock has already been consumed since that date).
    const entryDate = (req.body.date as string) || today;

    // Reject future dates — cannot create entries for dates that haven't happened yet
    if (entryDate > today) {
      return res.status(400).json({ error: "Cannot save entries for future dates." });
    }

    // For past dates, skip inventory stock updates (stock has moved on since then)
    const isToday = entryDate === today;

    const rows: any[] = req.body.rows || [];
    if (rows.length === 0) {
      return res.status(400).json({ error: "At least one purchase row is required." });
    }
    if (rows.length > MAX_DAILY_ROWS) {
      return res.status(400).json({ error: `Cannot save more than ${MAX_DAILY_ROWS} rows in a single request.` });
    }

    // Validate rows
    for (const row of rows) {
      if (!row.itemName?.trim()) return res.status(400).json({ error: "Item name is required for all rows." });
      if (row.itemName.trim().length > MAX_ITEM_NAME) return res.status(400).json({ error: `Item name must be ${MAX_ITEM_NAME} characters or less for item "${row.itemName.slice(0, 50)}...".` });
      if (!row.vendorId) return res.status(400).json({ error: `Vendor is required for item "${row.itemName}".` });
      if (!row.unit?.trim()) return res.status(400).json({ error: `Unit is required for item "${row.itemName}".` });
      if (row.paymentStatus !== "PENDING" && row.paymentStatus !== "DONE") {
        return res.status(400).json({ error: `Payment status must be PENDING or DONE for item "${row.itemName}".` });
      }
      if (row.paymentStatus === "DONE" && !PAYMENT_METHODS.includes(row.paymentMethod)) {
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

    // Verify all categoryIds (if provided) belong to this tenant
    const categoryIds = [...new Set(rows.map((r: any) => r.categoryId).filter(Boolean))] as string[];
    let validCategoryMap = new Map<string, any>();
    if (categoryIds.length > 0) {
      const validCategories = await basePrisma.ledgerCategory.findMany({
        where: { id: { in: categoryIds }, restaurantId },
        select: { id: true, name: true },
      });
      validCategoryMap = new Map(validCategories.map((c: any) => [c.id, c]));
      for (const row of rows) {
        if (row.categoryId && !validCategoryMap.has(row.categoryId)) {
          return res.status(400).json({ error: `Category not found for item "${row.itemName}".` });
        }
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

    // Execute everything in a single transaction
    const result = await basePrisma.$transaction(async (tx: any) => {
      // 1. Fetch existing entries for the selected date
      const oldEntries = await tx.dailyPurchaseEntry.findMany({
        where: { restaurantId, date: entryDate },
        select: { id: true, kitchenInventoryItemId: true, vendorId: true, paymentStatus: true, quantity: true, unitPrice: true, unit: true },
      });

      // 2. Build old qty/value maps per kitchenInventoryItemId + old entry map by composite key (array for duplicates)
      const oldQtyMap = new Map<string, number>();
      const oldValueMap = new Map<string, number>();
      const oldEntryMap = new Map<string, typeof oldEntries[0][]>();
      const oldEntriesByItemId = new Map<string, { qty: number; unit: string }[]>();
      for (const old of oldEntries) {
        const kid = old.kitchenInventoryItemId;
        const qty = Number(old.quantity);
        const val = qty * Number(old.unitPrice);
        oldQtyMap.set(kid, (oldQtyMap.get(kid) || 0) + qty);
        oldValueMap.set(kid, (oldValueMap.get(kid) || 0) + val);
        const key = `${old.kitchenInventoryItemId}|${old.vendorId}|${old.paymentStatus}`;
        if (!oldEntryMap.has(key)) oldEntryMap.set(key, []);
        oldEntryMap.get(key)!.push(old);
        if (!oldEntriesByItemId.has(kid)) oldEntriesByItemId.set(kid, []);
        oldEntriesByItemId.get(kid)!.push({ qty, unit: old.unit || "" });
      }

      // 3. (Removed delete-then-recreate — now using diff/update in Step 10)

      // 4. Resolve or create KitchenInventoryItem for each row, collect resolved items
      const resolvedRows: any[] = [];
      for (const row of rows) {
        const rawName = row.itemName.trim().toLowerCase();
        const normalizedName = rawName.slice(0, NORMALIZED_NAME_MAX_LENGTH);

        let kiItem = null;

        // If kitchenInventoryItemId is provided (user selected from dropdown), use it directly
        if (row.kitchenInventoryItemId) {
          kiItem = await tx.kitchenInventoryItem.findFirst({
            where: { id: row.kitchenInventoryItemId, restaurantId: kitchenRestaurantId },
          });
        }

        // Fallback: exact name match first (handles long names correctly)
        if (!kiItem) {
          kiItem = await tx.kitchenInventoryItem.findFirst({
            where: { restaurantId: kitchenRestaurantId, name: row.itemName.trim() },
          });
        }

        // Fallback: normalizedName match (truncated for VarChar(255) index)
        if (!kiItem) {
          kiItem = await tx.kitchenInventoryItem.findFirst({
            where: { restaurantId: kitchenRestaurantId, normalizedName },
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

        // Fetch previous price for this item (from entries before the selected date)
        const lastEntry = await tx.dailyPurchaseEntry.findFirst({
          where: { restaurantId, kitchenInventoryItemId: kiItem.id, date: { lt: entryDate } },
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

        const { effectiveQty } = convertToBaseUnit(Number(row.quantity), row.unit, kiItem.unit || row.unit);

        resolvedRows.push({
          ...row,
          kitchenInventoryItemId: kiItem.id,
          previousPrice,
          priceChange,
          effectiveQty,
        });
      }

      // 5. Build new qty/value maps per kitchenInventoryItemId (using effectiveQty for stock)
      const newQtyMap = new Map<string, number>();
      const newValueMap = new Map<string, number>();
      for (const r of resolvedRows) {
        const kid = r.kitchenInventoryItemId;
        const qty = r.effectiveQty != null ? r.effectiveQty : Number(r.quantity);
        const val = Number(r.quantity) * Number(r.unitPrice);
        newQtyMap.set(kid, (newQtyMap.get(kid) || 0) + qty);
        newValueMap.set(kid, (newValueMap.get(kid) || 0) + val);
      }

      // 6. Sort affected kitchenInventoryItemIds deterministically for lock ordering
      //    Skip inventory stock updates for past dates — stock has already been
      //    consumed/adjusted since then, and updating it would corrupt current levels.
      const allItemIds = isToday ? [...new Set([...oldQtyMap.keys(), ...newQtyMap.keys()])].sort() : [];

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

        const oldQtyRaw = oldQtyMap.get(itemId) || 0;
        const newQty = newQtyMap.get(itemId) || 0;
        const newValue = newValueMap.get(itemId) || 0;

        // Convert old qty to base unit (old entries may have been saved in a different unit)
        let oldQty = oldQtyRaw;
        const oldItemEntries = oldEntriesByItemId.get(itemId);
        if (oldItemEntries && kiItem.unit) {
          oldQty = oldItemEntries.reduce((sum, e) => {
            const { effectiveQty } = convertToBaseUnit(e.qty, e.unit, kiItem.unit);
            return sum + effectiveQty;
          }, 0);
        }

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
        await tx.$queryRaw`SELECT * FROM "InventoryDailyEntry" WHERE "restaurantId" = ${kitchenRestaurantId} AND "itemId" = ${itemId} AND "entryDate" = ${entryDate} FOR UPDATE`;

        // Update InventoryDailyEntry for the selected date
        const existingEntry = await tx.inventoryDailyEntry.findUnique({
          where: {
            restaurantId_itemId_entryDate: {
              restaurantId: kitchenRestaurantId,
              itemId,
              entryDate: entryDate,
            },
          },
        });

        let stockDeficit = 0;
        if (existingEntry) {
          const manualAdded = Math.max(0, Number(existingEntry.addedStock) - oldQty);
          const newAdded = manualAdded + newQty;
          const openingStock = Number(existingEntry.openingStock);
          const consumedStock = Number(existingEntry.consumedStock);
          let closingStock = openingStock + newAdded - consumedStock;

          if (closingStock < 0) {
            stockDeficit = Math.abs(closingStock);
            logger.warn({ restaurantId, itemName: kiItem.name, closingStock, openingStock, newAdded, consumedStock },
              "[DailyPurchase] Closing stock clamped to 0 — consumed exceeds available");
            closingStock = 0;
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

        // Audit: record stock deficit (theft/waste/unrecorded consumption) as a separate transaction
        if (stockDeficit > 0.0001) {
          await tx.kitchenInventoryTransaction.create({
            data: {
              restaurantId: kitchenRestaurantId,
              itemId,
              type: "ADJUSTMENT",
              quantityChange: new Prisma.Decimal(Math.round(-stockDeficit * 100) / 100),
              stockBefore: new Prisma.Decimal(0),
              stockAfter: new Prisma.Decimal(0),
              source: "DAILY_PURCHASE_CLAMP",
              notes: `Stock deficit clamped: ${kiItem.name} — deficit of ${stockDeficit} ${kiItem.unit || ''} (consumed exceeds available)`,
              createdBy: userId,
            },
          });
        }
      }

      // 8. Void existing daily-purchase expenditures (cleanup only — no new ones created)
      // Expenditures are NOT created during daily purchase save. Vendor outstanding
      // is computed directly from DailyPurchaseEntry records in recalcVendorBalance.
      // Expenditures only appear when admin explicitly records a vendor payment.
      const existingMappings = await tx.dailyPurchaseVendorExpenditure.findMany({
        where: { restaurantId, date: entryDate },
        include: { expenditure: true },
      });

      for (const m of existingMappings) {
        if (m.expenditure && m.expenditure.status !== EXPENDITURE_STATUS.VOIDED) {
          await tx.expenditure.update({
            where: { id: m.expenditureId },
            data: { status: EXPENDITURE_STATUS.VOIDED, isSettled: false, settledAt: null },
          });
        }
        await tx.dailyPurchaseVendorExpenditure.delete({ where: { id: m.id } });
      }

      const auditEntries: { action: string; expenditureId: string; amount: number; vendorName: string }[] = [];

      // 10. Diff/update: update existing entries, insert new ones, delete removed ones
      // Group new rows by composite key (array to handle duplicates)
      const newRowGroups = new Map<string, any[]>();
      for (const r of resolvedRows) {
        const key = `${r.kitchenInventoryItemId}|${r.vendorId}|${r.paymentStatus}`;
        if (!newRowGroups.has(key)) newRowGroups.set(key, []);
        newRowGroups.get(key)!.push(r);
      }

      const savedRows: any[] = [];

      for (const [key, newRows] of newRowGroups) {
        const oldEntriesForKey = oldEntryMap.get(key) || [];

        for (let i = 0; i < newRows.length; i++) {
          const newRow = newRows[i];
          if (i < oldEntriesForKey.length) {
            // Update existing entry
            const existing = oldEntriesForKey[i];
            const updated = await tx.dailyPurchaseEntry.update({
              where: { id: existing.id },
              data: {
                itemName: newRow.itemName.trim(),
                unit: newRow.unit?.trim() || null,
                quantity: new Prisma.Decimal(Number(newRow.quantity)),
                unitPrice: new Prisma.Decimal(Number(newRow.unitPrice)),
                totalPrice: new Prisma.Decimal(Math.round(Number(newRow.quantity) * Number(newRow.unitPrice) * 100) / 100),
                previousPrice: newRow.previousPrice != null ? new Prisma.Decimal(newRow.previousPrice) : null,
                priceChange: newRow.priceChange,
                paymentStatus: newRow.paymentStatus,
                paymentMethod: newRow.paymentStatus === "DONE" ? (newRow.paymentMethod || CASH_METHOD) : null,
                categoryId: newRow.categoryId || null,
              },
            });
            savedRows.push({
              id: updated.id, itemName: updated.itemName, unit: updated.unit,
              quantity: Number(updated.quantity), unitPrice: Number(updated.unitPrice),
              totalPrice: Number(updated.totalPrice),
              previousPrice: updated.previousPrice ? Number(updated.previousPrice) : null,
              priceChange: updated.priceChange, vendorId: updated.vendorId,
              kitchenInventoryItemId: updated.kitchenInventoryItemId,
              categoryId: updated.categoryId,
              paymentStatus: updated.paymentStatus, paymentMethod: updated.paymentMethod,
            });
          } else {
            // Insert new entry (more new rows than old for this key)
            const created = await tx.dailyPurchaseEntry.create({
              data: {
                restaurantId,
                date: entryDate,
                paymentStatus: newRow.paymentStatus,
                paymentMethod: newRow.paymentStatus === "DONE" ? (newRow.paymentMethod || CASH_METHOD) : null,
                itemName: newRow.itemName.trim(),
                unit: newRow.unit?.trim() || null,
                quantity: new Prisma.Decimal(Number(newRow.quantity)),
                unitPrice: new Prisma.Decimal(Number(newRow.unitPrice)),
                totalPrice: new Prisma.Decimal(Math.round(Number(newRow.quantity) * Number(newRow.unitPrice) * 100) / 100),
                previousPrice: newRow.previousPrice != null ? new Prisma.Decimal(newRow.previousPrice) : null,
                priceChange: newRow.priceChange,
                vendorId: newRow.vendorId,
                kitchenInventoryItemId: newRow.kitchenInventoryItemId,
                categoryId: newRow.categoryId || null,
                createdById: userId,
              },
            });
            savedRows.push({
              id: created.id, itemName: created.itemName, unit: created.unit,
              quantity: Number(created.quantity), unitPrice: Number(created.unitPrice),
              totalPrice: Number(created.totalPrice),
              previousPrice: created.previousPrice ? Number(created.previousPrice) : null,
              priceChange: created.priceChange, vendorId: created.vendorId,
              kitchenInventoryItemId: created.kitchenInventoryItemId,
              categoryId: created.categoryId,
              paymentStatus: created.paymentStatus, paymentMethod: created.paymentMethod,
            });
          }
        }
      }

      // Delete entries no longer present in new rows (not matched/used)
      for (const [key, oldEntriesForKey] of oldEntryMap) {
        if (!newRowGroups.has(key)) {
          for (const oldEntry of oldEntriesForKey) {
            await tx.dailyPurchaseEntry.delete({ where: { id: oldEntry.id } });
          }
        } else {
          // Delete surplus old entries (more old than new for this key)
          const newCount = newRowGroups.get(key)!.length;
          for (let i = newCount; i < oldEntriesForKey.length; i++) {
            await tx.dailyPurchaseEntry.delete({ where: { id: oldEntriesForKey[i].id } });
          }
        }
      }

      // 9. Recompute affected vendor balances — MUST run AFTER step 10 (diff/update)
      // so that recalcVendorBalance sees the newly inserted/updated entries when
      // summing PENDING DailyPurchaseEntry records. Previously this ran before the
      // entries were saved, causing outstandingBalance to be calculated as ₹0 on
      // first save (entries didn't exist yet in the transaction).
      for (const vendorId of vendorIds) {
        await recalcVendorBalance(restaurantId, vendorId, tx);
      }

      return { auditEntries, vendorIds, savedRows };
    }, { timeout: DAILY_PURCHASE_TX_TIMEOUT_MS, maxWait: DAILY_PURCHASE_TX_MAX_WAIT_MS });

    // 11. After transaction commits — audit trail
    await writeAuditLog(restaurantId, userId, "DAILY_PURCHASE_ENTRY_SAVED", "DailyPurchaseEntry", null, {
      date: entryDate,
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
          entryType: ENTRY_TYPE.LIABILITY,
          source: AUDIT_SOURCE.DAILY_PURCHASE,
        },
      });
    }

    // 12. Refresh Daily Balance Sheet (skip if LOCKED, skip for past dates)
    if (isToday) {
      try {
        await upsertBalanceSheet(restaurantId, entryDate, {}, userId);
      } catch (err: any) {
        if (err.statusCode === 409 || err.message?.includes(BALANCE_SHEET_STATUS.LOCKED)) {
          logger.warn({ restaurantId, date: entryDate }, "[DailyPurchase] Balance sheet is LOCKED, skipping refresh");
        } else {
          logger.error({ err }, "[DailyPurchase] Failed to refresh balance sheet");
        }
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

// ── POST /api/purchase-orders/daily/bar — save bar purchase entries ──────────
// Accepts bar purchase rows (each with menuItemId, quantity/bottles, costPerBottle).
// Auto-creates an InventoryItem for any menu item that doesn't have one yet.
// Updates bar inventory stock (currentStock), writes a PURCHASE ledger entry,
// and updates the DailyInventorySnapshot — mirroring the bar record-purchase flow.
// Multi-tenant safe: all queries are scoped to the bar outlet's restaurantId.
router.post("/daily/bar", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const today = getKolkataDateString();

    // Resolve the bar outlet (multi-tenant)
    const outletId = (req.body.outletId as string) || sessionRestaurantId;
    let barId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      barId = outletId;
    }

    const entryDate = (req.body.date as string) || today;
    if (entryDate > today) {
      return res.status(400).json({ error: "Cannot save entries for future dates." });
    }
    const isToday = entryDate === today;

    const rows: any[] = req.body.rows || [];
    if (rows.length === 0) {
      return res.status(400).json({ error: "At least one bar purchase row is required." });
    }

    // Validate rows
    for (const row of rows) {
      if (!row.menuItemId) {
        return res.status(400).json({ error: "menuItemId is required for all bar purchase rows." });
      }
      if (!row.itemName?.trim()) {
        return res.status(400).json({ error: "Item name is required for all bar purchase rows." });
      }
      const qtyNum = Number(row.quantity || row.purchaseBottles || 0);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        return res.status(400).json({ error: `Quantity must be a positive number for item "${row.itemName}".` });
      }
      const costNum = Number(row.costPerBottle || row.unitPrice || 0);
      if (!Number.isFinite(costNum) || costNum < 0) {
        return res.status(400).json({ error: `Cost per bottle must be a non-negative number for item "${row.itemName}".` });
      }
    }

    // Verify all menuItemIds belong to this tenant's bar outlet
    const menuItemIds = [...new Set(rows.map((r) => r.menuItemId))];
    const validMenuItems = await prisma.menuItem.findMany({
      where: {
        id: { in: menuItemIds },
        restaurantId: barId,
        isDeleted: false,
        menuType: "LIQUOR",
      },
      select: { id: true, name: true },
    });
    const validMenuMap = new Map(validMenuItems.map((m) => [m.id, m]));
    for (const row of rows) {
      if (!validMenuMap.has(row.menuItemId)) {
        return res.status(400).json({ error: `Menu item not found in bar menu for item "${row.itemName}".` });
      }
    }

    // Execute in a single transaction
    const result = await prisma.$transaction(async (tx: any) => {
      const savedRows: any[] = [];

      for (const row of rows) {
        const menuItemId = row.menuItemId;
        const itemName = row.itemName.trim();

        // Find or auto-create the InventoryItem for this menu item
        let invItem = await tx.inventoryItem.findFirst({
          where: { menuItemId, restaurantId: barId },
          select: { id: true, currentStock: true, bottleSize: true, costPerBottle: true, reorderLevel: true, unitOfMeasure: true },
        });

        if (!invItem) {
          // Auto-create InventoryItem — the menu item exists but has no inventory tracking.
          // Use defaults: 750ml bottle, ml unit, 0 opening stock, 0 reorder level.
          const bottleSize = Number(row.bottleSize) || 750;
          const created = await tx.inventoryItem.create({
            data: {
              menuItemId,
              restaurantId: barId,
              unitOfMeasure: "ml",
              bottleSize,
              openingStock: new Prisma.Decimal(0),
              currentStock: new Prisma.Decimal(0),
              reorderLevel: new Prisma.Decimal(0),
              costPerBottle: row.costPerBottle ? new Prisma.Decimal(row.costPerBottle) : null,
              lastRestocked: new Date(),
            },
          });
          invItem = {
            id: created.id,
            currentStock: created.currentStock,
            bottleSize: created.bottleSize,
            costPerBottle: created.costPerBottle,
            reorderLevel: created.reorderLevel,
            unitOfMeasure: created.unitOfMeasure,
          };

          // Create initial ADJUSTMENT transaction for the new item
          await tx.inventoryTransaction.create({
            data: {
              restaurantId: barId,
              itemId: created.id,
              type: "ADJUSTMENT",
              quantityChange: new Prisma.Decimal(0),
              stockBefore: new Prisma.Decimal(0),
              stockAfter: new Prisma.Decimal(0),
              notes: `Auto-created from daily purchase: ${itemName}`,
              createdBy: userId || "System",
            },
          });

          // Create today's daily snapshot
          await tx.dailyInventorySnapshot.create({
            data: {
              restaurantId: barId,
              itemId: created.id,
              snapshotDate: today,
              itemName,
              openingStock: new Prisma.Decimal(0),
              purchased: new Prisma.Decimal(0),
              sold: new Prisma.Decimal(0),
              wastage: new Prisma.Decimal(0),
              adjusted: new Prisma.Decimal(0),
              closingStock: new Prisma.Decimal(0),
            },
          }).catch(() => {
            // Snapshot may already exist from a concurrent request — safe to skip
          });

          logger.info({ menuItemId, inventoryItemId: created.id, barId }, "[DailyPurchase/Bar] Auto-created InventoryItem for menu item");
        }

        // Lock the inventory item row (tenant-scoped FOR UPDATE)
        const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: typeof Prisma.Decimal; bottleSize: number }>>`
          SELECT "id", "currentStock", "bottleSize" FROM "inventory_items"
          WHERE "id" = ${invItem.id} AND "restaurantId" = ${barId}
          FOR UPDATE
        `;
        const lockedItem = lockedRows[0];
        if (!lockedItem) {
          throw Object.assign(new Error(`Inventory item not found for "${itemName}"`), { statusCode: 404 });
        }

        const bottleSize = Number(lockedItem.bottleSize) || 750;
        // Convert bottles to ml if purchaseBottles is provided, otherwise use quantity (ml)
        const purchaseQty = row.purchaseBottles !== undefined
          ? Number(row.purchaseBottles) * bottleSize
          : Number(row.quantity);

        const stockBefore = lockedItem.currentStock;
        const stockAfter = stockBefore.add(new Prisma.Decimal(purchaseQty));

        // Update inventory item (tenant-scoped)
        const updateResult = await tx.inventoryItem.updateMany({
          where: { id: invItem.id, restaurantId: barId },
          data: {
            currentStock: stockAfter,
            lastRestocked: new Date(),
            updatedAt: new Date(),
            ...(row.costPerBottle ? { costPerBottle: new Prisma.Decimal(row.costPerBottle) } : {}),
          },
        });
        if (updateResult.count === 0) {
          throw Object.assign(new Error(`Failed to update inventory for "${itemName}"`), { statusCode: 500 });
        }

        // Write PURCHASE ledger entry
        await tx.inventoryTransaction.create({
          data: {
            restaurantId: barId,
            itemId: invItem.id,
            type: "PURCHASE",
            quantityChange: new Prisma.Decimal(purchaseQty),
            stockBefore,
            stockAfter,
            notes: `Daily bar purchase: ${itemName} — ${row.purchaseBottles !== undefined ? row.purchaseBottles + ' bottles' : purchaseQty + ' ml'} @ ₹${row.costPerBottle || 0}/bottle`,
            createdBy: userId || "Admin",
          },
        });

        // Update daily snapshot
        if (isToday) {
          await tx.dailyInventorySnapshot.upsert({
            where: {
              restaurantId_snapshotDate_itemId: {
                restaurantId: barId,
                snapshotDate: today,
                itemId: invItem.id,
              },
            },
            create: {
              restaurantId: barId,
              itemId: invItem.id,
              snapshotDate: today,
              itemName,
              openingStock: stockBefore,
              purchased: new Prisma.Decimal(purchaseQty),
              sold: new Prisma.Decimal(0),
              wastage: new Prisma.Decimal(0),
              adjusted: new Prisma.Decimal(0),
              closingStock: stockAfter,
            },
            update: {
              purchased: { increment: new Prisma.Decimal(purchaseQty) },
              closingStock: stockAfter,
            },
          });
        }

        savedRows.push({
          menuItemId,
          inventoryItemId: invItem.id,
          itemName,
          quantity: row.purchaseBottles !== undefined ? row.purchaseBottles : row.quantity,
          unit: row.purchaseBottles !== undefined ? "bottles" : "ml",
          costPerBottle: Number(row.costPerBottle || 0),
          bottleSize,
          stockBefore: Number(stockBefore),
          stockAfter: Number(stockAfter),
          autoCreated: !invItem.currentStock?.equals?.(0) === false && invItem.currentStock?.toString() === "0",
        });
      }

      return { savedRows };
    }, { timeout: DAILY_PURCHASE_TX_TIMEOUT_MS, maxWait: DAILY_PURCHASE_TX_MAX_WAIT_MS });

    // Emit socket event so bar inventory UI refreshes
    getIo().to(barId).emit("inventory:updated", { restaurantId: barId });

    res.json(result.savedRows);
  } catch (error: any) {
    if (error.statusCode === 400 || error.statusCode === 403 || error.statusCode === 404) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error({ err: error }, "[DailyPurchase] POST /daily/bar save failed");
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/purchase-orders/daily/:id — delete a kitchen purchase entry + reverse inventory ──
// Idempotent: if the entry doesn't exist, returns success (already deleted).
// Reverses exactly the stock this purchase added, via the existing transaction logic.
// Multi-tenant safe: scoped to the authenticated tenant's restaurantId.
router.delete("/daily/:id", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const today = getKolkataDateString();

    // Resolve outlet from query (for multi-tenant cross-outlet access)
    const outletId = (req.query.outletId as string) || null;
    let restaurantId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      restaurantId = outletId;
    }

    const kitchenRestaurantId = await resolveKitchenRestaurantId(restaurantId);

    const result = await basePrisma.$transaction(async (tx: any) => {
      // 1. Find the entry — scoped to this tenant
      const entry = await tx.dailyPurchaseEntry.findFirst({
        where: { id, restaurantId },
        include: {
          kitchenInventoryItem: { select: { id: true, name: true, unit: true, currentStock: true, price: true } },
        },
      });

      // Idempotency: if entry doesn't exist, it was already deleted — return success
      if (!entry) {
        return { alreadyDeleted: true, itemName: null, reversedStock: 0 };
      }

      const kiItem = entry.kitchenInventoryItem;
      const entryQty = Number(entry.quantity);
      const entryUnitPrice = Number(entry.unitPrice);
      const entryDate = entry.date;

      // 2. Reverse the inventory stock if this was a today entry (past-date entries
      //    didn't update stock on save, so no reversal needed)
      let reversedStock = 0;
      if (entryDate === today && kiItem) {
        // Lock the kitchen inventory item row
        const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: typeof Prisma.Decimal; price: typeof Prisma.Decimal }>>`
          SELECT "id", "currentStock", "price" FROM "KitchenInventoryItem"
          WHERE "id" = ${kiItem.id} AND "restaurantId" = ${kitchenRestaurantId}
          FOR UPDATE
        `;
        const lockedItem = lockedRows[0];
        if (lockedItem) {
          const currentStock = Number(lockedItem.currentStock);
          const currentPrice = Number(lockedItem.price);

          // Convert the entry quantity to base unit for reversal
          const { effectiveQty } = convertToBaseUnit(entryQty, entry.unit || "", kiItem.unit || entry.unit || "");
          const reverseQty = effectiveQty != null ? effectiveQty : entryQty;

          const newStock = Math.max(0, currentStock - reverseQty);

          // Recalculate weighted average price: remove this purchase's value contribution
          // baseValue = (currentStock * currentPrice) - (reverseQty * entryUnitPrice)
          const currentValue = currentStock * currentPrice;
          const reversedValue = reverseQty * entryUnitPrice;
          const baseValue = Math.max(0, currentValue - reversedValue);
          const newPrice = newStock > 0
            ? Math.round((baseValue / newStock) * 100) / 100
            : currentPrice;

          await tx.kitchenInventoryItem.update({
            where: { id: kiItem.id },
            data: {
              currentStock: new Prisma.Decimal(Math.round(newStock * 100) / 100),
              price: new Prisma.Decimal(newPrice),
            },
          });

          // Write reversal ledger entry
          await tx.kitchenInventoryTransaction.create({
            data: {
              restaurantId: kitchenRestaurantId,
              itemId: kiItem.id,
              type: "PURCHASE_REVERSAL",
              quantityChange: new Prisma.Decimal(Math.round(-reverseQty * 100) / 100),
              stockBefore: new Prisma.Decimal(Math.round(currentStock * 100) / 100),
              stockAfter: new Prisma.Decimal(Math.round(newStock * 100) / 100),
              source: "DAILY_PURCHASE_DELETE",
              notes: `Reversal: deleted daily purchase of ${entry.itemName} — ${entryQty} ${entry.unit || ''} @ ₹${entryUnitPrice}`,
              createdBy: userId,
            },
          });

          // Update InventoryDailyEntry for today
          const existingDailyEntry = await tx.inventoryDailyEntry.findUnique({
            where: {
              restaurantId_itemId_entryDate: {
                restaurantId: kitchenRestaurantId,
                itemId: kiItem.id,
                entryDate: today,
              },
            },
          });

          if (existingDailyEntry) {
            const newAddedStock = Math.max(0, Number(existingDailyEntry.addedStock) - reverseQty);
            const openingStock = Number(existingDailyEntry.openingStock);
            const consumedStock = Number(existingDailyEntry.consumedStock);
            const newClosingStock = Math.max(0, openingStock + newAddedStock - consumedStock);

            await tx.inventoryDailyEntry.update({
              where: { id: existingDailyEntry.id },
              data: {
                addedStock: new Prisma.Decimal(Math.round(newAddedStock * 100) / 100),
                closingStock: new Prisma.Decimal(Math.round(newClosingStock * 100) / 100),
              },
            });
          }

          reversedStock = reverseQty;
        }
      }

      // 3. Delete the entry
      await tx.dailyPurchaseEntry.delete({ where: { id: entry.id } });

      // 4. Recalculate vendor outstanding balance
      await recalcVendorBalance(restaurantId, entry.vendorId, tx);

      return { alreadyDeleted: false, itemName: entry.itemName, reversedStock, vendorId: entry.vendorId };
    }, { timeout: DAILY_PURCHASE_TX_TIMEOUT_MS, maxWait: DAILY_PURCHASE_TX_MAX_WAIT_MS });

    // 5. Refresh balance sheet (skip if past date)
    if (!result.alreadyDeleted) {
      try {
        await upsertBalanceSheet(restaurantId, today, {}, userId);
      } catch (err: any) {
        if (err.statusCode === 409 || err.message?.includes(BALANCE_SHEET_STATUS.LOCKED)) {
          logger.warn({ restaurantId, date: today }, "[DailyPurchase] Balance sheet LOCKED, skipping refresh after delete");
        } else {
          logger.error({ err }, "[DailyPurchase] Failed to refresh balance sheet after delete");
        }
      }

      // Audit log
      await writeAuditLog(restaurantId, userId, "DAILY_PURCHASE_ENTRY_DELETED", "DailyPurchaseEntry", id, {
        itemName: result.itemName,
        reversedStock: result.reversedStock,
      });
    }

    res.json({
      success: true,
      alreadyDeleted: result.alreadyDeleted,
      itemName: result.itemName,
      reversedStock: result.reversedStock,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] DELETE /daily/:id failed");
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/purchase-orders/daily/bar/:id — delete a bar purchase transaction + reverse inventory ──
// Idempotent: if the transaction doesn't exist, returns success (already deleted).
// Reverses exactly the stock this purchase added to bar inventory.
// Multi-tenant safe: scoped to the authenticated tenant's bar outlet.
router.delete("/daily/bar/:id", requireRole('ADMIN', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const today = getKolkataDateString();

    // Resolve bar outlet
    const outletId = (req.query.outletId as string) || null;
    let barId = sessionRestaurantId;
    if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      barId = outletId;
    }

    const result = await prisma.$transaction(async (tx: any) => {
      // 1. Find the PURCHASE transaction — scoped to this tenant
      const transaction = await tx.inventoryTransaction.findFirst({
        where: { id, restaurantId: barId, type: "PURCHASE" },
        include: {
          item: {
            select: { id: true, menuItemId: true, currentStock: true, bottleSize: true, costPerBottle: true, menuItem: { select: { name: true } } },
          },
        },
      });

      // Idempotency: if transaction doesn't exist, it was already deleted — return success
      if (!transaction) {
        return { alreadyDeleted: true, itemName: null, reversedStock: 0 };
      }

      const invItem = transaction.item;
      const purchaseQtyMl = Number(transaction.quantityChange);
      const itemName = invItem.menuItem?.name || transaction.notes?.split(':')[1]?.split('—')[0]?.trim() || 'Bar Item';

      // 2. Lock the inventory item row and reverse the stock
      const lockedRows = await tx.$queryRaw<Array<{ id: string; currentStock: typeof Prisma.Decimal; bottleSize: number }>>`
        SELECT "id", "currentStock", "bottleSize" FROM "inventory_items"
        WHERE "id" = ${invItem.id} AND "restaurantId" = ${barId}
        FOR UPDATE
      `;
      const lockedItem = lockedRows[0];
      if (!lockedItem) {
        throw Object.assign(new Error(`Inventory item not found for "${itemName}"`), { statusCode: 404 });
      }

      const stockBefore = Number(lockedItem.currentStock);
      const stockAfter = Math.max(0, stockBefore - purchaseQtyMl);

      // Update inventory item — reverse the stock
      const updateResult = await tx.inventoryItem.updateMany({
        where: { id: invItem.id, restaurantId: barId },
        data: {
          currentStock: new Prisma.Decimal(Math.round(stockAfter * 100) / 100),
          updatedAt: new Date(),
        },
      });
      if (updateResult.count === 0) {
        throw Object.assign(new Error(`Failed to update inventory for "${itemName}"`), { statusCode: 500 });
      }

      // 3. Write reversal ledger entry
      await tx.inventoryTransaction.create({
        data: {
          restaurantId: barId,
          itemId: invItem.id,
          type: "PURCHASE_REVERSAL",
          quantityChange: new Prisma.Decimal(Math.round(-purchaseQtyMl * 100) / 100),
          stockBefore: new Prisma.Decimal(Math.round(stockBefore * 100) / 100),
          stockAfter: new Prisma.Decimal(Math.round(stockAfter * 100) / 100),
          notes: `Reversal: deleted daily bar purchase of ${itemName} — ${purchaseQtyMl} ml`,
          createdBy: userId || "Admin",
        },
      });

      // 4. Delete the original PURCHASE transaction
      await tx.inventoryTransaction.delete({ where: { id: transaction.id } });

      // 5. Update daily snapshot — reverse the purchased amount
      const snapshotDate = getKolkataDateString();
      // Check if the transaction was today (compare dates)
      const txnDate = new Date(transaction.transactionDate);
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const txnIstDate = new Date(txnDate.getTime() + IST_OFFSET_MS).toISOString().split('T')[0];

      if (txnIstDate === snapshotDate) {
        await tx.dailyInventorySnapshot.upsert({
          where: {
            restaurantId_snapshotDate_itemId: {
              restaurantId: barId,
              snapshotDate,
              itemId: invItem.id,
            },
          },
          create: {
            restaurantId: barId,
            itemId: invItem.id,
            snapshotDate,
            itemName,
            openingStock: new Prisma.Decimal(stockBefore),
            purchased: new Prisma.Decimal(Math.round(-purchaseQtyMl * 100) / 100),
            sold: new Prisma.Decimal(0),
            wastage: new Prisma.Decimal(0),
            adjusted: new Prisma.Decimal(0),
            closingStock: new Prisma.Decimal(Math.round(stockAfter * 100) / 100),
          },
          update: {
            purchased: { decrement: new Prisma.Decimal(Math.round(purchaseQtyMl * 100) / 100) },
            closingStock: new Prisma.Decimal(Math.round(stockAfter * 100) / 100),
          },
        });
      }

      return { alreadyDeleted: false, itemName, reversedStock: purchaseQtyMl };
    }, { timeout: DAILY_PURCHASE_TX_TIMEOUT_MS, maxWait: DAILY_PURCHASE_TX_MAX_WAIT_MS });

    // Emit socket event so bar inventory UI refreshes
    getIo().to(barId).emit("inventory:updated", { restaurantId: barId });

    res.json({
      success: true,
      alreadyDeleted: result.alreadyDeleted,
      itemName: result.itemName,
      reversedStock: result.reversedStock,
    });
  } catch (error: any) {
    if (error.statusCode === 403 || error.statusCode === 404) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error({ err: error }, "[DailyPurchase] DELETE /daily/bar/:id failed");
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Purchase History endpoints — date range search with optional item filter
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/purchase-orders/daily/history — purchase history with date range + optional item search
// Returns individual purchase records with vendor + category + payment details.
// If itemName is provided, filters by case-insensitive partial match.
// Vendor outstanding balances are included from the vendor record.
router.get("/daily/history", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { dateFrom, dateTo, itemName } = req.query;

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: "dateFrom and dateTo are required" });
    }

    // Support cross-outlet filtering
    const outletId = (req.query.outletId as string) || null;
    let restaurantIds: string[] = [sessionRestaurantId];
    if (outletId === "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      restaurantIds = ctx.allIds ?? [sessionRestaurantId];
    } else if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      restaurantIds = [outletId];
    }

    const where: any = {
      restaurantId: { in: restaurantIds },
      date: { gte: String(dateFrom), lte: String(dateTo) },
    };
    if (itemName && String(itemName).trim()) {
      where.itemName = { contains: String(itemName).trim(), mode: "insensitive" };
    }

    const entries = await basePrisma.dailyPurchaseEntry.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, outstandingBalance: true } },
        category: { select: { id: true, name: true } },
        kitchenInventoryItem: { select: { id: true, name: true, unit: true } },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 5000,
    });

    const formatted = entries.map((e: any) => ({
      id: e.id,
      date: e.date,
      itemName: e.itemName,
      kitchenInventoryItemId: e.kitchenInventoryItemId,
      categoryId: e.categoryId,
      categoryName: e.category?.name || null,
      vendorId: e.vendorId,
      vendorName: e.vendor?.name || null,
      vendorOutstandingBalance: e.vendor ? Number(e.vendor.outstandingBalance) : 0,
      quantity: Number(e.quantity),
      unit: e.unit,
      unitPrice: Number(e.unitPrice),
      totalPrice: Number(e.totalPrice),
      paymentStatus: e.paymentStatus,
      paymentMethod: e.paymentMethod,
    }));

    res.json(formatted);
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] GET /daily/history failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/purchase-orders/daily/item-analytics — aggregated analytics for a specific item
// Returns timeline + price analytics (weighted avg, min, max, latest) for a given item name
// within the specified date range.
router.get("/daily/item-analytics", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { dateFrom, dateTo, itemName } = req.query;

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: "dateFrom and dateTo are required" });
    }
    if (!itemName || !String(itemName).trim()) {
      return res.status(400).json({ error: "itemName is required" });
    }

    // Support cross-outlet filtering
    const outletId = (req.query.outletId as string) || null;
    let restaurantIds: string[] = [sessionRestaurantId];
    if (outletId === "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      restaurantIds = ctx.allIds ?? [sessionRestaurantId];
    } else if (outletId && outletId !== "all") {
      const ctx = await resolveTenantContext(sessionRestaurantId);
      const tenantIds = ctx.allIds ?? [sessionRestaurantId];
      if (!tenantIds.includes(outletId)) {
        return res.status(403).json({ error: "Outlet not accessible" });
      }
      restaurantIds = [outletId];
    }

    const searchName = String(itemName).trim();

    const entries = await basePrisma.dailyPurchaseEntry.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        date: { gte: String(dateFrom), lte: String(dateTo) },
        itemName: { contains: searchName, mode: "insensitive" },
      },
      include: {
        vendor: { select: { id: true, name: true, outstandingBalance: true } },
        category: { select: { id: true, name: true } },
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      take: 5000,
    });

    if (entries.length === 0) {
      return res.json({
        timeline: [],
        analytics: {
          totalQuantity: 0,
          totalValue: 0,
          purchaseCount: 0,
          avgUnitPrice: 0,
          minUnitPrice: 0,
          maxUnitPrice: 0,
          latestUnitPrice: 0,
          latestPurchaseDate: null,
        },
      });
    }

    // Build timeline grouped by date
    const timelineMap = new Map<string, any[]>();
    for (const e of entries) {
      const dateKey = e.date;
      if (!timelineMap.has(dateKey)) timelineMap.set(dateKey, []);
      timelineMap.get(dateKey)!.push({
        id: e.id,
        vendorId: e.vendorId,
        vendorName: e.vendor?.name || null,
        vendorOutstandingBalance: e.vendor ? Number(e.vendor.outstandingBalance) : 0,
        quantity: Number(e.quantity),
        unit: e.unit,
        unitPrice: Number(e.unitPrice),
        total: Number(e.totalPrice),
        paymentStatus: e.paymentStatus,
        paymentMethod: e.paymentMethod,
        categoryName: e.category?.name || null,
      });
    }

    const timeline = Array.from(timelineMap.entries()).map(([date, purchases]) => ({
      date,
      purchases,
    }));

    // Compute analytics
    const totalQuantity = entries.reduce((sum, e) => sum + Number(e.quantity), 0);
    const totalValue = entries.reduce((sum, e) => sum + Number(e.totalPrice), 0);
    const unitPrices = entries.map((e) => Number(e.unitPrice));
    const minUnitPrice = Math.min(...unitPrices);
    const maxUnitPrice = Math.max(...unitPrices);
    const latestEntry = entries[entries.length - 1];
    const weightedAvg = totalQuantity > 0 ? Math.round((totalValue / totalQuantity) * 100) / 100 : 0;

    res.json({
      timeline,
      analytics: {
        totalQuantity: Math.round(totalQuantity * 100) / 100,
        totalValue: Math.round(totalValue * 100) / 100,
        purchaseCount: entries.length,
        avgUnitPrice: weightedAvg,
        minUnitPrice: Math.round(minUnitPrice * 100) / 100,
        maxUnitPrice: Math.round(maxUnitPrice * 100) / 100,
        latestUnitPrice: Math.round(Number(latestEntry.unitPrice) * 100) / 100,
        latestPurchaseDate: latestEntry.date,
      },
    });
  } catch (error: any) {
    logger.error({ err: error }, "[DailyPurchase] GET /daily/item-analytics failed");
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
