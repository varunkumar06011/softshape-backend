// ─────────────────────────────────────────────────────────────────────────────
// Ledger Category Routes — User-creatable categories for expenses, assets, liabilities, groceries
// ─────────────────────────────────────────────────────────────────────────────
// Manages user-creatable ledger categories that replace the old hardcoded
// VALID_NON_STAFF_CATEGORIES array. Each category is outlet-scoped and typed
// by entryType (ASSET, LIABILITY, GROCERY, EXPENSE).
//
// Endpoints:
//   GET    /api/ledger-categories?entryType=EXPENSE  — list active categories, sorted alphabetically
//   POST   /api/ledger-categories                     — create or reactivate a category
//   PATCH  /api/ledger-categories/:id                 — rename or soft-delete (deactivate)
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
import { createAuditLog } from "../lib/auditLog";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

const VALID_ENTRY_TYPES = ["ASSET", "LIABILITY", "GROCERY", "EXPENSE"];

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

// ── GET /api/ledger-categories ─────────────────────────────────────────────────
router.get("/", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const { entryType } = req.query;

    const where: any = { isActive: true };
    if (entryType && VALID_ENTRY_TYPES.includes(entryType as string)) {
      where.entryType = entryType;
    }

    const categories = await prisma.ledgerCategory.findMany({
      where,
      orderBy: { name: "asc" },
      select: { id: true, name: true, entryType: true, isActive: true },
    });

    res.json(categories);
  } catch (error: any) {
    logger.error({ err: error }, "[LedgerCategories] List failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/ledger-categories ────────────────────────────────────────────────
router.post("/", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { name, entryType } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!entryType || !VALID_ENTRY_TYPES.includes(entryType)) {
      return res.status(400).json({ error: "Invalid entryType" });
    }

    const normalizedName = normalizeName(name);

    // Case-insensitive lookup for existing category (same de-dupe pattern as paidToName in expenditures.ts)
    const existing = await prisma.ledgerCategory.findFirst({
      where: {
        restaurantId,
        entryType,
        name: { equals: normalizedName, mode: "insensitive" },
      },
    });

    if (existing) {
      if (existing.isActive) {
        return res.json(existing);
      }
      // Exists but deactivated — reactivate it
      const reactivated = await prisma.ledgerCategory.update({
        where: { id: existing.id },
        data: { isActive: true },
      });

      createAuditLog({
        userId,
        restaurantId,
        action: "LEDGER_CATEGORY_CREATED",
        entityType: "LedgerCategory",
        entityId: existing.id,
        metadata: {
          name: reactivated.name,
          entryType: reactivated.entryType,
        },
      });

      return res.json(reactivated);
    }

    const created = await prisma.ledgerCategory.create({
      data: {
        restaurantId,
        name: normalizedName,
        entryType,
        createdById: userId,
      },
    });

    createAuditLog({
      userId,
      restaurantId,
      action: "LEDGER_CATEGORY_CREATED",
      entityType: "LedgerCategory",
      entityId: created.id,
      metadata: {
        name: created.name,
        entryType: created.entryType,
      },
    });

    res.json(created);
  } catch (error: any) {
    logger.error({ err: error }, "[LedgerCategories] Create failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/ledger-categories/:id ───────────────────────────────────────────
router.patch("/:id", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { name, isActive } = req.body;

    const existing = await prisma.ledgerCategory.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Category not found" });
    }

    const updateData: any = {};
    if (name !== undefined) {
      const normalizedName = normalizeName(name);
      if (!normalizedName) {
        return res.status(400).json({ error: "name cannot be empty" });
      }
      // Check for case-insensitive collision with a different category
      const collision = await prisma.ledgerCategory.findFirst({
        where: {
          restaurantId,
          entryType: existing.entryType,
          name: { equals: normalizedName, mode: "insensitive" },
          id: { not: id },
        },
      });
      if (collision) {
        return res.status(409).json({ error: "A category with this name already exists" });
      }
      updateData.name = normalizedName;
    }
    if (isActive !== undefined) {
      updateData.isActive = isActive;
    }

    const updated = await prisma.ledgerCategory.update({
      where: { id },
      data: updateData,
    });

    if (updateData.name !== undefined) {
      createAuditLog({
        userId,
        restaurantId,
        action: "LEDGER_CATEGORY_RENAMED",
        entityType: "LedgerCategory",
        entityId: id,
        metadata: {
          oldName: existing.name,
          newName: updateData.name,
          entryType: existing.entryType,
        },
      });
    }
    if (updateData.isActive === false) {
      createAuditLog({
        userId,
        restaurantId,
        action: "LEDGER_CATEGORY_DEACTIVATED",
        entityType: "LedgerCategory",
        entityId: id,
        metadata: {
          name: existing.name,
          entryType: existing.entryType,
        },
      });
    }

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[LedgerCategories] Patch failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
