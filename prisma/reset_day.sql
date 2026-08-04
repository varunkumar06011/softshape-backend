-- ═══════════════════════════════════════════════════════════════════════════
-- RESET DAY — Erase all of today's transactions and start clean
--
-- USAGE:
--   1. Set @target_date to today's date in IST (YYYY-MM-DD format)
--   2. Set @restaurant_id to your outlet ID, or leave NULL for ALL outlets
--   3. Run the entire script in one go (it's wrapped in a transaction)
--
-- WHAT THIS DOES (for restaurant 9O3N45 only):
--   • Deletes: transactions, orders, order items
--   • Resets: daily counters (bill, KOT, txn, voucher counts)
--   • Resets: all tables to AVAILABLE / Free
--
-- ⚠️  WARNING: This is destructive and cannot be undone. Back up first!
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── CONFIG ──────────────────────────────────────────────────────────────────
-- Set the date (YYYY-MM-DD, IST). Default: today in IST.
DO $$
DECLARE
  target_date TEXT := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD');
  restaurant_id TEXT := '9O3N45';  -- scoped to this outlet only
  -- IST day boundaries converted to UTC for timestamp comparisons
  -- (Prisma stores timestamps as UTC without timezone)
  day_start_utc TIMESTAMP := (target_date::date || ' 00:00:00')::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC';
  day_end_utc   TIMESTAMP := (target_date::date + 1 || ' 00:00:00')::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC';
BEGIN
  RAISE NOTICE 'Resetting day: % (restaurant_id: %)', target_date, COALESCE(restaurant_id, 'ALL');
  RAISE NOTICE 'UTC range: % to %', day_start_utc, day_end_utc;

  -- ═════════════════════════════════════════════════════════════════════════
  -- STEP 1: DELETE TRANSACTIONS (payment records)
  -- ═════════════════════════════════════════════════════════════════════════
  EXECUTE format(
    'DELETE FROM "Transaction"
     WHERE "txnDate" = %L
       AND (%L IS NULL OR "restaurantId" = %L)',
    target_date, restaurant_id, restaurant_id
  );

  -- ═════════════════════════════════════════════════════════════════════════
  -- STEP 2: DELETE ORDER ITEMS for today's orders
  -- (must delete before Orders due to FK constraint)
  -- ═════════════════════════════════════════════════════════════════════════
  EXECUTE format(
    'DELETE FROM "OrderItem"
     WHERE "orderId" IN (
       SELECT "id" FROM "Order"
       WHERE "createdAt" >= %L AND "createdAt" < %L
         AND (%L IS NULL OR "restaurantId" = %L)
     )',
    day_start_utc, day_end_utc, restaurant_id, restaurant_id
  );

  -- ═════════════════════════════════════════════════════════════════════════
  -- STEP 3: DELETE ORDERS for today
  -- ═════════════════════════════════════════════════════════════════════════
  EXECUTE format(
    'DELETE FROM "Order"
     WHERE "createdAt" >= %L AND "createdAt" < %L
       AND (%L IS NULL OR "restaurantId" = %L)',
    day_start_utc, day_end_utc, restaurant_id, restaurant_id
  );

  -- ═════════════════════════════════════════════════════════════════════════
  -- STEP 4: RESET ALL TABLES to AVAILABLE / Free
  -- ═════════════════════════════════════════════════════════════════════════
  EXECUTE format(
    'UPDATE "Table" SET
      "status" = ''AVAILABLE'',
      "workflowStatus" = ''Free'',
      "captainId" = NULL,
      "guests" = 0,
      "sessionStartedAt" = NULL,
      "currentBill" = 0,
      "kotHistory" = ''[]''::json,
      "discount" = NULL
     WHERE "restaurantId" = %L',
    restaurant_id
  );

  -- ═════════════════════════════════════════════════════════════════════════
  -- STEP 5: RESET DAILY COUNTERS (KOT, bill, txn, voucher counts)
  -- ═════════════════════════════════════════════════════════════════════════
  EXECUTE format(
    'DELETE FROM "DailyCounter"
     WHERE "counterDate" = %L
       AND "restaurantId" = %L',
    target_date, restaurant_id
  );

  RAISE NOTICE 'Day reset complete for: %', target_date;
END $$;

COMMIT;
