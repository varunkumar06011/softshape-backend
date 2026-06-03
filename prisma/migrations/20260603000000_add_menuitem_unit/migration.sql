-- Migration: add_menuitem_unit
-- Adds the `unit` column to MenuItem that exists in schema.prisma but was never applied to the DB.
-- Using ADD COLUMN IF NOT EXISTS so this is safe to run even if the column already exists on some environments.

ALTER TABLE "MenuItem"
  ADD COLUMN IF NOT EXISTS "unit" VARCHAR(20);
