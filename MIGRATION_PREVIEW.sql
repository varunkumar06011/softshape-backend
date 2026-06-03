-- Migration Preview: Add unit field to MenuItem table
-- This file shows what the migration will do
-- DO NOT RUN MANUALLY - Use: npx prisma migrate dev --name "add_unit_field_to_menu_item"

-- ============================================================
-- Migration: add_unit_field_to_menu_item
-- ============================================================

BEGIN;

-- AlterTable: Add unit field to MenuItem
ALTER TABLE "MenuItem"
ADD COLUMN "unit" VARCHAR(20);

-- No indexes needed (nullable field, not used for filtering)
-- No default value needed (NULL is acceptable)
-- No NOT NULL constraint (optional field for liquor items only)

COMMIT;

-- ============================================================
-- Post-Migration Verification Queries
-- ============================================================

-- 1. Check column was added
SELECT column_name, data_type, character_maximum_length, is_nullable
FROM information_schema.columns
WHERE table_name = 'MenuItem' AND column_name = 'unit';

-- Expected:
-- column_name | data_type         | character_maximum_length | is_nullable
-- unit        | character varying | 20                       | YES

-- 2. Check existing data (should be NULL)
SELECT COUNT(*) as total_items,
       COUNT("unit") as items_with_unit,
       COUNT(*) - COUNT("unit") as items_without_unit
FROM "MenuItem";

-- Expected BEFORE re-import:
-- total_items | items_with_unit | items_without_unit
-- 516         | 0               | 516

-- Expected AFTER re-import:
-- total_items | items_with_unit | items_without_unit
-- 514         | ~152            | ~362

-- 3. Sample liquor items with units (after re-import)
SELECT name, "menuType", unit
FROM "MenuItem"
WHERE "menuType" = 'LIQUOR' AND unit IS NOT NULL
ORDER BY name
LIMIT 10;

-- Expected (after re-import):
-- name                          | menuType | unit
-- Bagpiper 30Ml                 | LIQUOR   | 30ml
-- Haywards 5000 650Ml          | LIQUOR   | 650ml
-- Kingfisher Beer 650Ml        | LIQUOR   | 650ml
-- Officer's Choice 750Ml       | LIQUOR   | 750ml
-- Royal Stag 30Ml              | LIQUOR   | 30ml
-- ...

-- ============================================================
-- Rollback (if needed)
-- ============================================================

-- BEGIN;
-- ALTER TABLE "MenuItem" DROP COLUMN IF EXISTS "unit";
-- COMMIT;
