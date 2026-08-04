-- Clean up duplicate active orders for the same table before creating the unique index.
-- Keeps the most recently updated order, marks older duplicates as CANCELLED.
UPDATE "Order" SET status = 'CANCELLED', "updatedAt" = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY "tableId"
      ORDER BY "updatedAt" DESC
    ) AS rn
    FROM "Order"
    WHERE status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'BILLING_REQUESTED')
      AND "isDeleted" = false
  ) ranked WHERE rn > 1
);

-- Partial unique index: prevents two concurrent active orders for the same table.
-- Replaces the per-table Redis lock in createOrderService.
-- When two captains create an order for the same empty table simultaneously,
-- the second insert fails with P2002, which the service catches and returns as 409.
CREATE UNIQUE INDEX IF NOT EXISTS "Order_active_per_table"
ON "Order" ("tableId")
WHERE status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'BILLING_REQUESTED')
  AND "isDeleted" = false;
