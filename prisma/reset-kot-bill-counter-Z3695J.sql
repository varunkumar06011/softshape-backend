-- =============================================================
-- Reset KOT & Bill counters for outlet Z3695J — today's IST date
-- Run this in PostgreSQL against the Softshape database
-- =============================================================

DO $$
DECLARE
  today_ist TEXT := to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD');
  rid       TEXT := 'Z3695J';
BEGIN
  RAISE NOTICE 'Resetting KOT & bill counters for outlet %, IST date: %', rid, today_ist;

  UPDATE "DailyCounter"
  SET "kotCount"  = 0,
      "billCount" = 0,
      "updatedAt" = NOW()
  WHERE "restaurantId" = rid
    AND "counterDate"  = today_ist;

  RAISE NOTICE 'Done. kotCount=0, billCount=0 for %', today_ist;
END $$;
