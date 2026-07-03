-- =============================================================================
-- Migration: add_payroll_kitchen_inventory
-- Adds payroll and kitchen inventory models, drops unused CaptainTarget table,
-- and removes stale Restaurant columns not in the Prisma schema.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Phase 1 cleanup: Drop unused CaptainTarget model
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "CaptainTarget";

-- ---------------------------------------------------------------------------
-- Phase 1 cleanup: Remove stale Restaurant columns not in schema
-- ---------------------------------------------------------------------------
ALTER TABLE "Restaurant" DROP COLUMN IF EXISTS "deliveryPlatforms";
ALTER TABLE "Restaurant" DROP COLUMN IF EXISTS "fssai";
ALTER TABLE "Restaurant" DROP COLUMN IF EXISTS "halfBottleMl";
ALTER TABLE "Restaurant" DROP COLUMN IF EXISTS "pricesIncludeGst";
ALTER TABLE "Restaurant" DROP COLUMN IF EXISTS "serviceChargePercent";

-- ---------------------------------------------------------------------------
-- Payroll: Employee
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Employee" (
    "id"            TEXT           NOT NULL,
    "restaurantId"  TEXT           NOT NULL,
    "name"          TEXT           NOT NULL,
    "age"           INTEGER,
    "role"          TEXT,
    "baseSalary"    DECIMAL(10,2)  NOT NULL,
    "joinDate"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive"      BOOLEAN        NOT NULL DEFAULT true,
    "createdAt"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Employee_restaurantId_idx"
    ON "Employee"("restaurantId");

-- ---------------------------------------------------------------------------
-- Payroll: PayrollRecord
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PayrollRecord" (
    "id"            TEXT           NOT NULL,
    "restaurantId"  TEXT           NOT NULL,
    "employeeId"    TEXT           NOT NULL,
    "monthYear"     TEXT           NOT NULL,
    "baseSalary"    DECIMAL(10,2)  NOT NULL,
    "absentDays"    INTEGER        NOT NULL DEFAULT 0,
    "advanceAmount" DECIMAL(10,2)  NOT NULL DEFAULT 0,
    "otDays"        INTEGER        NOT NULL DEFAULT 0,
    "otAmount"      DECIMAL(10,2)  NOT NULL DEFAULT 0,
    "netPayable"    DECIMAL(10,2)  NOT NULL,
    "paidAmount"    DECIMAL(10,2)  NOT NULL DEFAULT 0,
    "status"        TEXT           NOT NULL DEFAULT 'PENDING',
    "notes"         TEXT,
    "createdAt"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayrollRecord_restaurantId_monthYear_idx"
    ON "PayrollRecord"("restaurantId", "monthYear");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollRecord_employeeId_monthYear_key"
    ON "PayrollRecord"("employeeId", "monthYear");

ALTER TABLE "PayrollRecord"
    ADD CONSTRAINT "PayrollRecord_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Kitchen Inventory: KitchenInventoryItem
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "KitchenInventoryItem" (
    "id"            TEXT           NOT NULL,
    "restaurantId"  TEXT           NOT NULL,
    "name"          TEXT           NOT NULL,
    "unit"          TEXT           NOT NULL,
    "currentStock"  DECIMAL(10,2)  NOT NULL,
    "reorderLevel"  DECIMAL(10,2)  NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KitchenInventoryItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "KitchenInventoryItem_restaurantId_idx"
    ON "KitchenInventoryItem"("restaurantId");

CREATE UNIQUE INDEX IF NOT EXISTS "KitchenInventoryItem_restaurantId_name_key"
    ON "KitchenInventoryItem"("restaurantId", "name");

-- ---------------------------------------------------------------------------
-- Kitchen Inventory: MenuItemRecipe
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "MenuItemRecipe" (
    "id"            TEXT           NOT NULL,
    "menuItemId"    TEXT           NOT NULL,
    "ingredientId"  TEXT           NOT NULL,
    "quantity"      DECIMAL(10,3)  NOT NULL,
    "restaurantId"  TEXT           NOT NULL,

    CONSTRAINT "MenuItemRecipe_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MenuItemRecipe_restaurantId_idx"
    ON "MenuItemRecipe"("restaurantId");

CREATE UNIQUE INDEX IF NOT EXISTS "MenuItemRecipe_menuItemId_ingredientId_key"
    ON "MenuItemRecipe"("menuItemId", "ingredientId");

ALTER TABLE "MenuItemRecipe"
    ADD CONSTRAINT "MenuItemRecipe_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MenuItemRecipe"
    ADD CONSTRAINT "MenuItemRecipe_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "KitchenInventoryItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Kitchen Inventory: InventoryDailyEntry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "InventoryDailyEntry" (
    "id"            TEXT           NOT NULL,
    "restaurantId"  TEXT           NOT NULL,
    "entryDate"     TEXT           NOT NULL,
    "itemId"        TEXT           NOT NULL,
    "openingStock"  DECIMAL(10,2)  NOT NULL,
    "addedStock"    DECIMAL(10,2)  NOT NULL DEFAULT 0,
    "consumedStock" DECIMAL(10,2)  NOT NULL DEFAULT 0,
    "closingStock"  DECIMAL(10,2)  NOT NULL,

    CONSTRAINT "InventoryDailyEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InventoryDailyEntry_restaurantId_entryDate_idx"
    ON "InventoryDailyEntry"("restaurantId", "entryDate");

CREATE UNIQUE INDEX IF NOT EXISTS "InventoryDailyEntry_restaurantId_itemId_entryDate_key"
    ON "InventoryDailyEntry"("restaurantId", "itemId", "entryDate");

ALTER TABLE "InventoryDailyEntry"
    ADD CONSTRAINT "InventoryDailyEntry_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "KitchenInventoryItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
