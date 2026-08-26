-- Add source field to InventoryTransaction to distinguish physical-count
-- adjustments from manual adjustments. Required for meaningful variance
-- detection in the Daily Liquor Stock report.
--
-- Values: "PHYSICAL_COUNT" | "MANUAL" | "POS_DEDUCTION" | "PURCHASE" | "WASTAGE_ENTRY"
-- All existing rows default to "MANUAL" (we cannot retroactively classify
-- historical adjustments).

ALTER TABLE "inventory_transactions" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'MANUAL';

CREATE INDEX IF NOT EXISTS "inventory_transactions_source_idx" ON "inventory_transactions"("source");
