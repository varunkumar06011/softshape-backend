-- =============================================================================
-- Migration: schema_modernization
-- Covers Steps 1, 2, 3, 6, 8, 9, 10, 11, 12 of the production schema roadmap
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 11: Create Restaurant model (must come first — other steps reference it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Restaurant" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "address"     TEXT,
  "phone"       TEXT,
  "email"       TEXT,
  "gstin"       TEXT,
  "logoUrl"     TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Restaurant_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- STEP 6: Fix sessionStartedAt — convert String? → DateTime?
--         We cast existing non-null values; invalid strings become NULL safely.
-- ---------------------------------------------------------------------------
ALTER TABLE "Table"
  ALTER COLUMN "sessionStartedAt" TYPE TIMESTAMP(3)
  USING CASE
    WHEN "sessionStartedAt" IS NULL OR "sessionStartedAt" = '' THEN NULL
    ELSE "sessionStartedAt"::TIMESTAMP(3)
  END;

-- ---------------------------------------------------------------------------
-- STEP 3: Add basePrice to MenuItem
--         Defaults to 0.0 — admin can update per item later.
-- ---------------------------------------------------------------------------
ALTER TABLE "MenuItem"
  ADD COLUMN IF NOT EXISTS "basePrice" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- STEP 9: Add isAvailable to MenuItemVariant
-- ---------------------------------------------------------------------------
ALTER TABLE "MenuItemVariant"
  ADD COLUMN IF NOT EXISTS "isAvailable" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- STEP 10: Soft delete on Order
-- ---------------------------------------------------------------------------
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "isDeleted"  BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "deletedAt"  TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- STEP 1: Transaction → Order FK relation
--         orderId already exists as TEXT; we add the FK constraint only.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "Transaction"
    ADD CONSTRAINT "Transaction_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- STEP 2: OrderItem → MenuItem FK relation
--         menuItemId already exists as TEXT; add the FK constraint.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "OrderItem"
    ADD CONSTRAINT "OrderItem_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- STEP 8: Performance indexes
-- ---------------------------------------------------------------------------

-- OrderItem: fast lookup by order
CREATE INDEX IF NOT EXISTS "OrderItem_orderId_idx"
  ON "OrderItem"("orderId");

-- OrderItem: fast lookup by menu item
CREATE INDEX IF NOT EXISTS "OrderItem_menuItemId_idx"
  ON "OrderItem"("menuItemId");

-- Category: per-restaurant listing (sorted)
CREATE INDEX IF NOT EXISTS "Category_restaurantId_idx"
  ON "Category"("restaurantId");

-- MenuItem: per-category listing
CREATE INDEX IF NOT EXISTS "MenuItem_categoryId_idx"
  ON "MenuItem"("categoryId");

-- MenuItem: per-restaurant listing (for admin panels)
CREATE INDEX IF NOT EXISTS "MenuItem_restaurantId_idx"
  ON "MenuItem"("restaurantId");

-- MenuItem: filter available, non-deleted items fast
CREATE INDEX IF NOT EXISTS "MenuItem_restaurantId_isAvailable_isDeleted_idx"
  ON "MenuItem"("restaurantId", "isAvailable", "isDeleted");

-- Transaction: per-restaurant billing reports
CREATE INDEX IF NOT EXISTS "Transaction_restaurantId_paidAt_idx"
  ON "Transaction"("restaurantId", "paidAt");

-- Transaction: join to orders
CREATE INDEX IF NOT EXISTS "Transaction_orderId_idx"
  ON "Transaction"("orderId");

-- MenuItemVariant: per-item lookup
CREATE INDEX IF NOT EXISTS "MenuItemVariant_menuItemId_idx"
  ON "MenuItemVariant"("menuItemId");

-- MenuItemAddon: per-item lookup
CREATE INDEX IF NOT EXISTS "MenuItemAddon_menuItemId_idx"
  ON "MenuItemAddon"("menuItemId");
