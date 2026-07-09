// ─────────────────────────────────────────────────────────────────────────────
// Fixed Asset Register + Depreciation Routes
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints:
//   GET    /api/fixed-assets              — list (filterable by ?status=)
//   GET    /api/fixed-assets/:id          — detail with depreciation history
//   POST   /api/fixed-assets              — manual creation (sourceType: MANUAL)
//   PATCH  /api/fixed-assets/:id          — edit (reject purchaseCost/purchaseDate
//                                            changes if depreciation entries exist)
//   POST   /api/fixed-assets/:id/dispose  — set DISPOSED, stop future depreciation
//   POST   /api/fixed-assets/run-depreciation?periodMonth=YYYY-MM — manual trigger
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
        userId,
        action,
        entityType,
        entityId: entityId || null,
        metadata: metadata || undefined,
      },
    });
  } catch (err) {
    logger.error({ err }, "[FixedAsset] AuditLog write failed");
  }
}

// ── Helper: serialize FixedAsset with computed needsSetup flag ────────────────
function serializeAsset(asset: any) {
  return {
    ...asset,
    purchaseCost: Number(asset.purchaseCost),
    salvageValue: Number(asset.salvageValue),
    currentBookValue: Number(asset.currentBookValue),
    needsSetup: asset.usefulLifeMonths === null,
  };
}

// ── Helper: run straight-line depreciation for one asset+month ────────────────
// Returns true if an entry was written, false if skipped (already exists, not
// eligible, or fully depreciated).
async function runDepreciationForAsset(
  tx: any,
  assetId: string,
  periodMonth: string
): Promise<boolean> {
  const asset = await tx.fixedAsset.findUnique({ where: { id: assetId } });
  if (!asset) return false;

  // Skip if usefulLifeMonths is null (needs setup)
  if (asset.usefulLifeMonths === null) return false;

  // Skip if not ACTIVE
  if (asset.status !== "ACTIVE") return false;

  // Skip if periodMonth is before the asset's purchaseDate month
  const purchaseMonth = asset.purchaseDate.slice(0, 7);
  if (periodMonth < purchaseMonth) return false;

  // Check if an entry already exists for this month (idempotent)
  const existing = await tx.depreciationEntry.findUnique({
    where: {
      DepreciationEntry_fixedAssetId_periodMonth_key: {
        fixedAssetId: assetId,
        periodMonth,
      },
    },
  });
  if (existing) return false;

  const purchaseCost = Number(asset.purchaseCost);
  const salvageValue = Number(asset.salvageValue);
  const usefulLifeMonths = asset.usefulLifeMonths;

  const monthlyDepreciation = (purchaseCost - salvageValue) / usefulLifeMonths;

  // Count existing entries to check if this is the last partial month
  const entryCount = await tx.depreciationEntry.count({
    where: { fixedAssetId: assetId },
  });

  const currentBookValue = Number(asset.currentBookValue);
  let depreciationAmount = monthlyDepreciation;

  // Cap at whatever remains above salvageValue
  if (currentBookValue - depreciationAmount < salvageValue) {
    depreciationAmount = currentBookValue - salvageValue;
    if (depreciationAmount <= 0) {
      // Already at or below salvage — mark fully depreciated
      if (asset.status !== "FULLY_DEPRECIATED") {
        await tx.fixedAsset.update({
          where: { id: assetId },
          data: { status: "FULLY_DEPRECIATED" },
        });
      }
      return false;
    }
  }

  const newBookValue = currentBookValue - depreciationAmount;

  // Write the depreciation entry
  await tx.depreciationEntry.create({
    data: {
      restaurantId: asset.restaurantId,
      fixedAssetId: assetId,
      periodMonth,
      depreciationAmount: new Prisma.Decimal(Math.round(depreciationAmount * 100) / 100),
      bookValueAfter: new Prisma.Decimal(Math.round(newBookValue * 100) / 100),
    },
  });

  // Update the asset's currentBookValue and status
  const isFullyDepreciated = entryCount + 1 >= usefulLifeMonths || newBookValue <= salvageValue;
  await tx.fixedAsset.update({
    where: { id: assetId },
    data: {
      currentBookValue: new Prisma.Decimal(Math.round(newBookValue * 100) / 100),
      status: isFullyDepreciated ? "FULLY_DEPRECIATED" : "ACTIVE",
    },
  });

  return true;
}

// ── GET /api/fixed-assets — list ──────────────────────────────────────────────
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { status } = req.query;

    const where: any = { restaurantId };
    if (status) where.status = status;

    const assets = await prisma.fixedAsset.findMany({
      where,
      include: {
        ledgerCategory: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(assets.map(serializeAsset));
  } catch (error: any) {
    logger.error({ err: error }, "[FixedAsset] GET list failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/fixed-assets/:id — detail with depreciation history ──────────────
router.get("/:id", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const asset = await prisma.fixedAsset.findFirst({
      where: { id, restaurantId },
      include: {
        ledgerCategory: { select: { id: true, name: true } },
        depreciationEntries: { orderBy: { periodMonth: "asc" } },
        sourcePurchaseOrderItem: { select: { id: true, name: true } },
        sourceOpeningBalanceLine: { select: { id: true, name: true } },
      },
    });

    if (!asset) {
      return res.status(404).json({ error: "Fixed asset not found" });
    }

    res.json(serializeAsset(asset));
  } catch (error: any) {
    logger.error({ err: error }, "[FixedAsset] GET detail failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/fixed-assets — manual creation ──────────────────────────────────
router.post("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const {
      name, ledgerCategoryId, purchaseDate, purchaseCost,
      usefulLifeMonths, salvageValue, depreciationMethod,
      serialNumber,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!purchaseDate) {
      return res.status(400).json({ error: "purchaseDate is required" });
    }
    if (purchaseCost === undefined || parseFloat(purchaseCost) <= 0) {
      return res.status(400).json({ error: "purchaseCost must be a positive number" });
    }

    const cost = new Prisma.Decimal(purchaseCost);
    const asset = await prisma.fixedAsset.create({
      data: {
        restaurantId,
        name: name.trim(),
        ledgerCategoryId: ledgerCategoryId || null,
        purchaseDate,
        purchaseCost: cost,
        usefulLifeMonths: usefulLifeMonths ?? null,
        salvageValue: new Prisma.Decimal(salvageValue || 0),
        depreciationMethod: depreciationMethod || "STRAIGHT_LINE",
        serialNumber: serialNumber || null,
        currentBookValue: cost,
        status: "ACTIVE",
        sourceType: "MANUAL",
        createdById: userId,
      },
    });

    await writeAuditLog(restaurantId, userId, "fixed_asset_created", "FixedAsset", asset.id, {
      name: asset.name,
      purchaseCost: cost.toString(),
      purchaseDate,
      sourceType: "MANUAL",
    });

    res.json(serializeAsset(asset));
  } catch (error: any) {
    logger.error({ err: error }, "[FixedAsset] POST failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/fixed-assets/:id — edit ────────────────────────────────────────
router.patch("/:id", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const {
      name, ledgerCategoryId, usefulLifeMonths, salvageValue,
      depreciationMethod, serialNumber,
      purchaseCost, purchaseDate,
    } = req.body;

    const existing = await prisma.fixedAsset.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Fixed asset not found" });
    }

    // Check if any depreciation entries exist
    const depEntryCount = await prisma.depreciationEntry.count({
      where: { fixedAssetId: id },
    });

    if (depEntryCount > 0) {
      // Reject changing purchaseCost or purchaseDate once depreciation has run
      if (purchaseCost !== undefined && Number(purchaseCost) !== Number(existing.purchaseCost)) {
        return res.status(400).json({
          error: "Cannot change purchaseCost after depreciation entries exist. Dispose and recreate instead.",
        });
      }
      if (purchaseDate !== undefined && purchaseDate !== existing.purchaseDate) {
        return res.status(400).json({
          error: "Cannot change purchaseDate after depreciation entries exist. Dispose and recreate instead.",
        });
      }
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (ledgerCategoryId !== undefined) updateData.ledgerCategoryId = ledgerCategoryId || null;
    if (usefulLifeMonths !== undefined) updateData.usefulLifeMonths = usefulLifeMonths;
    if (salvageValue !== undefined) updateData.salvageValue = new Prisma.Decimal(salvageValue);
    if (depreciationMethod !== undefined) updateData.depreciationMethod = depreciationMethod;
    if (serialNumber !== undefined) updateData.serialNumber = serialNumber || null;
    if (purchaseCost !== undefined && depEntryCount === 0) {
      updateData.purchaseCost = new Prisma.Decimal(purchaseCost);
      updateData.currentBookValue = new Prisma.Decimal(purchaseCost);
    }
    if (purchaseDate !== undefined && depEntryCount === 0) {
      updateData.purchaseDate = purchaseDate;
    }

    const updated = await prisma.fixedAsset.update({
      where: { id },
      data: updateData,
    });

    await writeAuditLog(restaurantId, userId, "fixed_asset_updated", "FixedAsset", id, {
      before: {
        name: existing.name,
        usefulLifeMonths: existing.usefulLifeMonths,
        salvageValue: existing.salvageValue.toString(),
      },
      after: updateData,
    });

    res.json(serializeAsset(updated));
  } catch (error: any) {
    logger.error({ err: error }, "[FixedAsset] PATCH failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/fixed-assets/:id/dispose — dispose an asset ─────────────────────
router.post("/:id/dispose", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { disposedDate, disposalNotes } = req.body;

    const existing = await prisma.fixedAsset.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Fixed asset not found" });
    }
    if (existing.status === "DISPOSED") {
      return res.status(400).json({ error: "Asset is already disposed" });
    }

    const updated = await prisma.fixedAsset.update({
      where: { id },
      data: {
        status: "DISPOSED",
        disposedDate: disposedDate || getKolkataDateString(),
        disposalNotes: disposalNotes || null,
      },
    });

    await writeAuditLog(restaurantId, userId, "fixed_asset_disposed", "FixedAsset", id, {
      name: existing.name,
      disposedDate: updated.disposedDate,
      disposalNotes: disposalNotes || null,
      finalBookValue: existing.currentBookValue.toString(),
    });

    res.json(serializeAsset(updated));
  } catch (error: any) {
    logger.error({ err: error }, "[FixedAsset] Dispose failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/fixed-assets/run-depreciation?periodMonth=YYYY-MM ───────────────
// Manually trigger depreciation for all eligible assets for a given month.
// Idempotent: re-running for the same month is a no-op for assets that already
// have an entry for that period.
router.post("/run-depreciation", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const periodMonth = (req.query.periodMonth as string) || getKolkataDateString().slice(0, 7);

    // Validate format
    if (!/^\d{4}-\d{2}$/.test(periodMonth)) {
      return res.status(400).json({ error: "periodMonth must be in YYYY-MM format" });
    }

    const assets = await prisma.fixedAsset.findMany({
      where: { restaurantId, status: "ACTIVE" },
    });

    let entriesWritten = 0;
    let assetsSkipped = 0;

    await prisma.$transaction(async (tx) => {
      for (const asset of assets) {
        const written = await runDepreciationForAsset(tx, asset.id, periodMonth);
        if (written) {
          entriesWritten++;
        } else {
          assetsSkipped++;
        }
      }
    });

    await writeAuditLog(restaurantId, userId, "depreciation_run", "FixedAsset", null, {
      periodMonth,
      entriesWritten,
      assetsSkipped,
      totalAssets: assets.length,
    });

    res.json({
      periodMonth,
      entriesWritten,
      assetsSkipped,
      totalAssets: assets.length,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[FixedAsset] Run depreciation failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
