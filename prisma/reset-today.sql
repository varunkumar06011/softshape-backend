-- =============================================================
-- Reset Today's Data: Orders, Transactions, DailyCounters
-- Run this in PostgreSQL against the Softshape database
-- "Today" is determined in IST (Asia/Kolkata)
-- =============================================================

-- Today's date in IST as 'YYYY-MM-DD' (matches counterDate / txnDate format)
DO $$
DECLARE
  today_ist TEXT := to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD');
  restaurant_code TEXT := 'Z3695J';
  rid TEXT;
BEGIN
  SELECT "id" INTO rid FROM "Outlet" WHERE "restaurantCode" = restaurant_code;
  IF rid IS NULL THEN
    RAISE EXCEPTION 'No Outlet found with restaurantCode = %', restaurant_code;
  END IF;
  RAISE NOTICE 'Resetting data for restaurant % (id: %), IST date: %', restaurant_code, rid, today_ist;

  -- 1. Delete today's transactions
  --    txnDate is 'YYYY-MM-DD' IST; also fallback to paidAt for safety
  DELETE FROM "Transaction"
  WHERE "restaurantId" = rid
    AND ("txnDate" = today_ist
         OR ("txnDate" = '' AND DATE("paidAt" AT TIME ZONE 'Asia/Kolkata') = today_ist::date));

  RAISE NOTICE 'Transactions deleted for %', today_ist;

  -- 2. Delete today's orders (OrderItem rows cascade-delete automatically)
  --    createdAt is stored in UTC; compare against IST calendar date
  DELETE FROM "Order"
  WHERE "restaurantId" = rid
    AND DATE("createdAt" AT TIME ZONE 'Asia/Kolkata') = today_ist::date;

  RAISE NOTICE 'Orders deleted for %', today_ist;

  -- 3. Reset DailyCounter for today: kotCount=0, billCount=0, txnCount=0
  UPDATE "DailyCounter"
  SET "kotCount" = 0,
      "billCount" = 0,
      "txnCount" = 0,
      "updatedAt" = NOW()
  WHERE "restaurantId" = rid AND "counterDate" = today_ist;

  RAISE NOTICE 'DailyCounter reset for %', today_ist;

  -- 4. If no DailyCounter row exists for today, create one with zeros
  INSERT INTO "DailyCounter" ("id", "restaurantId", "counterDate", "kotCount", "billCount", "txnCount", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), r."id", today_ist, 0, 0, 0, NOW(), NOW()
  FROM "Outlet" r
  WHERE r."id" = rid
    AND NOT EXISTS (
      SELECT 1 FROM "DailyCounter" dc
      WHERE dc."restaurantId" = r."id" AND dc."counterDate" = today_ist
    );

  RAISE NOTICE 'DailyCounter ensured for restaurant %, IST date: %', rid, today_ist;
END $$;
