-- Backfill Transaction.platform and Transaction.sectionId from the linked Order
-- and Table. Order.platform already has DEFAULT 'DINE_IN', so existing orders
-- are populated; Transaction.platform/sectionId were added without a default.

UPDATE "Transaction" t
SET "platform" = COALESCE(o."platform", 'DINE_IN'),
    "sectionId" = tb."sectionId"
FROM "Order" o
JOIN "Table" tb ON tb.id = o."tableId"
WHERE t."orderId" = o.id
  AND t."platform" IS NULL;

-- Edge case: transactions without an associated order (should be rare).
-- Mark platform explicitly so they are not excluded from aggregate reports.
UPDATE "Transaction"
SET "platform" = 'DINE_IN'
WHERE "platform" IS NULL;
