import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

// ── SC3: CI test for modelsWithRestaurantId completeness ──────────────────────
// Verifies that every model in the modelsWithRestaurantId set in prisma.ts
// actually has a restaurantId field in the Prisma schema. This catches
// drift when new models are added to the schema but not to the tenant-scope set
// (which would allow cross-tenant data leakage) or vice versa (which would
// cause runtime errors when the extension tries to inject restaurantId into
// a model that doesn't have the column).

// This set must be kept in sync with the modelsWithRestaurantId in src/lib/prisma.ts
const EXPECTED_MODELS = new Set([
  "Category",
  "MenuItem",
  "MenuItemVariant",
  "MenuItemAddon",
  "Section",
  "Table",
  "Order",
  "Transaction",
  "DailyCounter",
  "CaptainAssignment",
  "InventoryItem",
  "InventoryTransaction",
  "DailyInventorySnapshot",
  "VenuePrice",
  "Employee",
  "PayrollRecord",
  "Attendance",
  "PrintQueue",
  "ProcessedRequest",
  "Venue",
  "Floor",
  "PriceProfile",
  "PriceProfileItem",
  "TaxProfile",
  "Expenditure",
  "LedgerCategory",
  "VenueMenuItemAvailability",
  "KitchenInventoryItem",
  "MenuItemRecipe",
  "InventoryDailyEntry",
  "DailyBalanceSheet",
  "OpeningBalance",
  "Vendor",
  "PurchaseOrder",
  "DailyCogsEntry",
  "FixedAsset",
  "DepreciationEntry",
  "Liability",
  "EquityAdjustment",
  "RepresentativeQR",
  "OrderConflict",
  "OnboardingPayment",
  "OrderDeductionLog",
  "BarDeductionLog",
  "Kot",
  "PayrollAdvanceHistory",
  "AuditLog",
  "XReport",
  "ComboComponent",
  "CaptainBackfill",
  "KitchenInventoryTransaction",
  "BarItemMapping",
  "DailyPurchaseEntry",
  "DailyPurchaseVendorExpenditure",
  "AdditionalOutletSale",
]);

describe('SC3 — modelsWithRestaurantId completeness', () => {
  it('every model in the set has a restaurantId field in the Prisma schema', () => {
    const prismaModelNames = Object.keys(Prisma.ModelName);
    const missing: string[] = [];

    for (const model of EXPECTED_MODELS) {
      // Check that the model exists in the Prisma schema
      if (!prismaModelNames.includes(model as any)) {
        missing.push(`${model} — model not found in Prisma schema`);
        continue;
      }
      // Check that the model has a restaurantId field by inspecting the payload
      const payload = (Prisma as any)[`${model}ScalarFieldEnum`];
      if (!payload || !('restaurantId' in payload)) {
        missing.push(`${model} — missing restaurantId field in schema`);
      }
    }

    expect(missing, `Models in modelsWithRestaurantId set but missing restaurantId in schema:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no Prisma model with restaurantId is missing from the set', () => {
    const prismaModelNames = Object.keys(Prisma.ModelName) as string[];
    const missing: string[] = [];

    for (const model of prismaModelNames) {
      const payload = (Prisma as any)[`${model}ScalarFieldEnum`];
      if (!payload) continue;

      // Skip models that are intentionally not tenant-scoped
      const INTENTIONALLY_UNSCOPED = new Set([
        'Organization',
        'SuperadminLog',
        'Session',
        'Account',
        'User',
        'VerificationToken',
        'Outlet', // Outlet IS the tenant — it has restaurantId but is scoped differently
        'EdgeConfig',
        'EdgeSyncAudit',
        'EdgeSyncState',
      ]);

      if (INTENTIONALLY_UNSCOPED.has(model)) continue;

      if ('restaurantId' in payload && !EXPECTED_MODELS.has(model)) {
        missing.push(model);
      }
    }

    expect(missing, `Prisma models with restaurantId but NOT in modelsWithRestaurantId set (potential cross-tenant leak):\n${missing.join('\n')}`).toEqual([]);
  });
});
