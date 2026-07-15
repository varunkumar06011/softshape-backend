-- Fix: Reset barInventoryDeducted to false for all orders that contain
-- LIQUOR items but were never deducted (flag was incorrectly left as true
-- due to the schema default + missing field in createOrderService).
--
-- Targets both PAID orders (for retry-deduction endpoint) and active orders
-- (PREPARING, BILLING_REQUESTED, etc.) so settlement will deduct correctly.
--
-- Only targets orders with LIQUOR menu items where no inventory
-- transaction (SALE type) has been recorded for that order.

UPDATE "Order" o
SET "barInventoryDeducted" = false
WHERE o."barInventoryDeducted" = true
  AND o.status != 'CANCELLED'
  AND EXISTS (
    SELECT 1
    FROM "OrderItem" oi
    JOIN "MenuItem" mi ON mi.id = oi."menuItemId"
    WHERE oi."orderId" = o.id
      AND oi."removedFromBill" = false
      AND oi.quantity > 0
      AND mi."menuType" = 'LIQUOR'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "inventory_transactions" it
    WHERE it."orderId" = o.id
      AND it.type = 'SALE'
  );
