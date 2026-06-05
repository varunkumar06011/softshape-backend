-- Migration: add_missing_softdelete_columns
-- Adds schema elements present in schema.prisma but missing from the database.
-- All statements use IF NOT EXISTS so this is safe to run repeatedly.

-- ---------------------------------------------------------------------------
-- Add missing soft-delete columns to MenuItem
-- ---------------------------------------------------------------------------
ALTER TABLE "MenuItem"
  ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "menuType" TEXT NOT NULL DEFAULT 'FOOD';

-- ---------------------------------------------------------------------------
-- Add missing bill-removal tracking columns to OrderItem
-- ---------------------------------------------------------------------------
ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "removedFromBill" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "removedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3);
