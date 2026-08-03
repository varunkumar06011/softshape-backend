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
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ComboComponent_comboMenuItemId_fkey') THEN
        ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_comboMenuItemId_fkey"
            FOREIGN KEY ("comboMenuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ComboComponent_componentMenuItemId_fkey') THEN
        ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_componentMenuItemId_fkey"
            FOREIGN KEY ("componentMenuItemId") REFERENCES "MenuItem"("id");
    END IF;
END $$;
