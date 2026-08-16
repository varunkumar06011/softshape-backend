// ─────────────────────────────────────────────────────────────────────────────
// Vendor Routes — Supplier management with outstanding balance tracking
// ─────────────────────────────────────────────────────────────────────────────
// Vendors are soft-deleted (isActive: false) so past POs keep their references.
// outstandingBalance is a cached/derived field recalculated when PO payments
// change — never edited directly by the frontend.
//
// Endpoints:
//   GET    /api/vendors              — list vendors (isActive: true by default)
//   GET    /api/vendors/:id          — single vendor with PO summary
//   POST   /api/vendors              — create (warns on duplicate name)
//   PATCH  /api/vendors/:id          — edit vendor details
//   DELETE /api/vendors/:id          — soft-delete (isActive: false)
//   POST   /api/vendors/:id/payments — record standalone vendor payment
//   POST   /api/vendors/recalc-balances — recalculate outstandingBalance for all vendors
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
import { getKolkataDateString } from "../utils/date";
import logger from "../lib/logger";
import { createAuditLog } from "../lib/auditLog";
import { recalcVendorBalance } from "./purchaseOrders";
import { upsertBalanceSheet } from "../services/dailyBalanceSheetService";
import { PAYMENT_METHODS, AP_CATEGORY_NAME, AP_CATEGORY_ENTRY_TYPE, VENDOR_PAYMENT_TX_TIMEOUT_MS, VENDOR_PAYMENT_TX_MAX_WAIT_MS, GLOBAL_COUNTER_DATE, EXPENDITURE_STATUS, ENTRY_TYPE, BALANCE_SHEET_STATUS, PAID_TO_TYPE } from "../utils/constants";

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
    logger.error({ err }, "[Vendor] AuditLog write failed");
  }
}

// ── GET /api/vendors — list vendors ───────────────────────────────────────────
router.get("/", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const includeInactive = req.query.includeInactive === "true";

    const where: any = { restaurantId };
    if (!includeInactive) {
      where.isActive = true;
    }

    const vendors = await prisma.vendor.findMany({
      where,
      orderBy: { name: "asc" },
    });

    res.json(vendors);
  } catch (error: any) {
    logger.error({ err: error }, "[Vendor] GET list failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/vendors/:id — single vendor with PO summary ──────────────────────
router.get("/:id", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const vendor = await prisma.vendor.findFirst({
      where: { id, restaurantId },
      include: {
        purchaseOrders: {
          select: {
            id: true,
            poNumber: true,
            status: true,
            totalAmount: true,
            amountPaid: true,
            orderDate: true,
          },
          orderBy: { orderDate: "desc" },
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    res.json(vendor);
  } catch (error: any) {
    logger.error({ err: error }, "[Vendor] GET single failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/vendors — create ────────────────────────────────────────────────
router.post("/", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { name, contactPerson, phone, email, address } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    // Check for likely-duplicate name (warn, don't block)
    const existing = await prisma.vendor.findFirst({
      where: {
        restaurantId,
        name: { equals: name.trim(), mode: "insensitive" },
      },
      select: { id: true, isActive: true },
    });

    const created = await prisma.vendor.create({
      data: {
        restaurantId,
        name: name.trim(),
        contactPerson: contactPerson || null,
        phone: phone || null,
        email: email || null,
        address: address || null,
        createdById: userId,
      },
    });

    await writeAuditLog(restaurantId, userId, "VENDOR_CREATED", "Vendor", created.id, {
      name: name.trim(),
      duplicateWarning: existing
        ? `A vendor with a similar name already exists (id: ${existing.id}, isActive: ${existing.isActive})`
        : null,
    });

    res.status(201).json({
      ...created,
      duplicateWarning: existing
        ? `A vendor with a similar name already exists. Please verify this is not a duplicate.`
        : null,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[Vendor] POST failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/vendors/:id — edit ─────────────────────────────────────────────
router.patch("/:id", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { name, contactPerson, phone, email, address } = req.body;

    const existing = await prisma.vendor.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (contactPerson !== undefined) updateData.contactPerson = contactPerson || null;
    if (phone !== undefined) updateData.phone = phone || null;
    if (email !== undefined) updateData.email = email || null;
    if (address !== undefined) updateData.address = address || null;

    const updated = await prisma.vendor.update({
      where: { id },
      data: updateData,
    });

    await writeAuditLog(restaurantId, userId, "VENDOR_UPDATED", "Vendor", id, {
      before: {
        name: existing.name,
        contactPerson: existing.contactPerson,
        phone: existing.phone,
        email: existing.email,
        address: existing.address,
      },
      after: updateData,
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[Vendor] PATCH failed");
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/vendors/:id — soft-delete ─────────────────────────────────────
router.delete("/:id", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;

    const vendor = await prisma.vendor.findFirst({
      where: { id, restaurantId },
      include: {
        purchaseOrders: {
          select: { status: true },
        },
      },
    });
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    // Reject if vendor has any PO not in PAID/CANCELLED status
    const blockingPOs = vendor.purchaseOrders.filter(
      (po) => po.status !== "PAID" && po.status !== "CANCELLED"
    );
    if (blockingPOs.length > 0) {
      return res.status(403).json({
        error: `Cannot retire vendor: ${blockingPOs.length} purchase order(s) are still outstanding (not PAID or CANCELLED). Settle or cancel them first.`,
      });
    }

    const updated = await prisma.vendor.update({
      where: { id },
      data: { isActive: false },
    });

    await writeAuditLog(restaurantId, userId, "VENDOR_RETIRED", "Vendor", id, {
      name: vendor.name,
    });

    res.json({ success: true, message: "Vendor retired (soft-deleted)" });
  } catch (error: any) {
    logger.error({ err: error }, "[Vendor] DELETE failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/vendors/:id/payments — Record a standalone vendor payment ────────
// Undirected (payment on account): reduces vendor outstanding balance without
// allocating to specific POs or daily purchase entries.
// Creates a LIABILITY_PAYMENT expenditure + recalculates vendor balance via
// recalcVendorBalance (single source of truth).
router.post("/:id/payments", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { amount, paymentMethod, paymentDate, narration } = req.body;

    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }
    if (!paymentMethod || !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: `Valid paymentMethod is required (${PAYMENT_METHODS.join(", ")})` });
    }

    const today = paymentDate || getKolkataDateString();

    const result = await basePrisma.$transaction(async (tx: any) => {
      // 1. Lock + read vendor inside transaction (FOR UPDATE prevents concurrent payment race)
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Vendor"
        WHERE "id" = ${id} AND "restaurantId" = ${restaurantId}
        FOR UPDATE
      `;
      if (lockedRows.length === 0) {
        throw new Error("Vendor not found");
      }

      const vendor = await tx.vendor.findFirst({
        where: { id, restaurantId },
      });
      if (!vendor) {
        throw new Error("Vendor not found");
      }
      if (!vendor.isActive) {
        throw new Error("Cannot record payment for an inactive vendor");
      }

      const currentOutstanding = Number(vendor.outstandingBalance);
      if (amount > currentOutstanding) {
        logger.warn({ vendorId: id, amount, currentOutstanding }, "[VendorPayment] Payment exceeds outstanding balance — recording as advance payment");
      }

      // 2. Find or create AP LedgerCategory
      const apCategory = await tx.ledgerCategory.findFirst({
        where: { restaurantId, entryType: AP_CATEGORY_ENTRY_TYPE, name: AP_CATEGORY_NAME },
      });

      // 3. Generate expenditure number
      const counter = await tx.dailyCounter.upsert({
        where: { restaurantId_counterDate: { restaurantId, counterDate: GLOBAL_COUNTER_DATE } },
        update: { expenditureCount: { increment: 1 } },
        create: { restaurantId, counterDate: GLOBAL_COUNTER_DATE, expenditureCount: 1 },
      });

      // 4. Create LIABILITY_PAYMENT expenditure linked to vendor
      const expenditure = await tx.expenditure.create({
        data: {
          restaurantId,
          expenditureNo: counter.expenditureCount,
          expenditureDate: today,
          paidToType: PAID_TO_TYPE.OTHER,
          paidToName: vendor.name,
          amount: new Prisma.Decimal(Math.round(amount * 100) / 100),
          narration: narration || `Vendor payment — ${vendor.name}`,
          createdById: userId,
          status: EXPENDITURE_STATUS.VERIFIED,
          entryType: ENTRY_TYPE.LIABILITY_PAYMENT,
          ledgerCategoryId: apCategory?.id || null,
          paymentMethod,
          isSettled: true,
          settledAt: new Date(),
          isAutoGenerated: true,
          linkedVendorId: vendor.id,
        },
      });

      // 5. Recalculate vendor balance (single source of truth)
      const newBalance = await recalcVendorBalance(restaurantId, vendor.id, tx);

      return { expenditure, vendor, newBalance };
    }, { timeout: VENDOR_PAYMENT_TX_TIMEOUT_MS, maxWait: VENDOR_PAYMENT_TX_MAX_WAIT_MS });

    // 6. Audit log
    createAuditLog({
      userId,
      restaurantId,
      action: "VENDOR_PAYMENT_RECORDED",
      entityType: "Expenditure",
      entityId: result.expenditure.id,
      metadata: {
        vendorId: id,
        vendorName: result.vendor.name,
        amount,
        paymentMethod,
        paymentDate: today,
        newOutstandingBalance: Number(result.newBalance),
      },
    });

    // 7. Refresh daily balance sheet (best-effort, skip if LOCKED)
    try {
      await upsertBalanceSheet(restaurantId, today, {}, userId);
    } catch (err: any) {
      if (err.statusCode === 409 || err.message?.includes(BALANCE_SHEET_STATUS.LOCKED)) {
        logger.warn({ restaurantId, date: today }, "[VendorPayment] Balance sheet LOCKED, skipping refresh");
      } else {
        logger.error({ err }, "[VendorPayment] Failed to refresh balance sheet");
      }
    }

    res.json({
      success: true,
      expenditureId: result.expenditure.id,
      vendorId: id,
      newOutstandingBalance: Number(result.newBalance),
    });
  } catch (error: any) {
    if (error.message === "Vendor not found") {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === "Cannot record payment for an inactive vendor") {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, "[VendorPayment] POST /:id/payments failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/vendors/recalc-balances — recalculate outstandingBalance for all vendors
// Fixes stale cached balances (e.g. from the step-ordering bug where recalcVendorBalance
// ran before daily purchase entries were inserted).
router.post("/recalc-balances", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;

    const vendors = await prisma.vendor.findMany({
      where: { restaurantId },
      select: { id: true, name: true, outstandingBalance: true },
    });

    const results: { id: string; name: string; oldBalance: number; newBalance: number }[] = [];
    for (const v of vendors) {
      const newBalance = await recalcVendorBalance(restaurantId, v.id);
      const oldBalance = Number(v.outstandingBalance);
      if (oldBalance !== Number(newBalance)) {
        results.push({ id: v.id, name: v.name, oldBalance, newBalance: Number(newBalance) });
      }
    }

    await writeAuditLog(restaurantId, userId, "VENDOR_BALANCES_RECALCULATED", "Vendor", null, {
      vendorCount: vendors.length,
      correctedCount: results.length,
    });

    logger.info({ restaurantId, vendorCount: vendors.length, correctedCount: results.length },
      "[VendorBalanceRecalc] Recalculated all vendor balances");

    res.json({
      totalVendors: vendors.length,
      correctedCount: results.length,
      corrections: results,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[VendorBalanceRecalc] POST /recalc-balances failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
