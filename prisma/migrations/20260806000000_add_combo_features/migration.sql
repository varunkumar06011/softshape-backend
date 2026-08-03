-- Add combo feature columns to MenuItem
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "isCombo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "showInMenu" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex for combo filtering
CREATE INDEX IF NOT EXISTS "MenuItem_restaurantId_isCombo_idx" ON "MenuItem"("restaurantId", "isCombo");
CREATE INDEX IF NOT EXISTS "MenuItem_restaurantId_showInMenu_idx" ON "MenuItem"("restaurantId", "showInMenu");

-- CreateTable for ComboComponent
CREATE TABLE IF NOT EXISTS "ComboComponent" (
    "id" TEXT NOT NULL,
    "comboMenuItemId" TEXT NOT NULL,
    "componentMenuItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "restaurantId" TEXT NOT NULL,

    CONSTRAINT "ComboComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ComboComponent_comboMenuItemId_idx" ON "ComboComponent"("comboMenuItemId");
CREATE INDEX IF NOT EXISTS "ComboComponent_componentMenuItemId_idx" ON "ComboComponent"("componentMenuItemId");
CREATE INDEX IF NOT EXISTS "ComboComponent_restaurantId_idx" ON "ComboComponent"("restaurantId");

-- AddForeignKey
ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_comboMenuItemId_fkey"
    FOREIGN KEY ("comboMenuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE;
ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_componentMenuItemId_fkey"
    FOREIGN KEY ("componentMenuItemId") REFERENCES "MenuItem"("id");

-- CreateTable for bar_item_mappings (BarItemMapping)
CREATE TABLE IF NOT EXISTS "bar_item_mappings" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "variantPrice" DECIMAL(10,2) NOT NULL,
    "primaryInvId" TEXT NOT NULL,
    "secondaryInvId" TEXT,
    "mlPerUnit" DECIMAL(10,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bar_item_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bar_item_mappings_restaurantId_idx" ON "bar_item_mappings"("restaurantId");
CREATE UNIQUE INDEX IF NOT EXISTS "bar_item_mappings_menuItemId_variantPrice_key" ON "bar_item_mappings"("menuItemId", "variantPrice");

-- AddForeignKey
ALTER TABLE "bar_item_mappings" ADD CONSTRAINT "bar_item_mappings_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE;
ALTER TABLE "bar_item_mappings" ADD CONSTRAINT "bar_item_mappings_primaryInvId_fkey"
    FOREIGN KEY ("primaryInvId") REFERENCES "InventoryItem"("id");
ALTER TABLE "bar_item_mappings" ADD CONSTRAINT "bar_item_mappings_secondaryInvId_fkey"
    FOREIGN KEY ("secondaryInvId") REFERENCES "InventoryItem"("id");

-- Fix XReport.upiTipsAmount: change from nullable to NOT NULL (with default 0)
ALTER TABLE "XReport" ALTER COLUMN "upiTipsAmount" SET NOT NULL;
ALTER TABLE "XReport" ALTER COLUMN "upiTipsAmount" SET DEFAULT 0;
