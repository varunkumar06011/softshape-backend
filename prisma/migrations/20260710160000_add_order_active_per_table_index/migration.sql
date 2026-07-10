-- Partial unique index: prevents two concurrent active orders for the same table.
-- Replaces the per-table Redis lock in createOrderService.
-- When two captains create an order for the same empty table simultaneously,
-- the second insert fails with P2002, which the service catches and returns as 409.
CREATE UNIQUE INDEX "Order_active_per_table"
ON "Order" ("tableId")
WHERE status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'BILLING_REQUESTED')
  AND "isDeleted" = false;
