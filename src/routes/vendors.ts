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
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import prisma from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
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

export default router;
