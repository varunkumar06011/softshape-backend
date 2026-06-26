-- Backfill existing active cashiers with onlineOrders permission so they keep
-- the Online Orders tab after the dashboard refinements deployment.

UPDATE "User"
SET "permissions" = jsonb_set(
  COALESCE("permissions", '{}'::jsonb),
  '{onlineOrders}',
  'true'::jsonb
)
WHERE "role" = 'CASHIER'
  AND "isActive" = true
  AND ("permissions"->>'onlineOrders') IS NULL;
