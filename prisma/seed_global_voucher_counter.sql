-- Seed the global voucher counter for each outlet from the current MAX voucherNo.
-- Run this ONCE after deploying the continuous-numbering change so that new
-- vouchers continue from where the highest existing number left off.
--
-- Safe to run multiple times (uses INSERT ... ON CONFLICT DO UPDATE).

INSERT INTO "DailyCounter" ("id", "restaurantId", "counterDate", "voucherCount", "kotCount", "billCount", "txnCount", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  v."restaurantId",
  'global',
  MAX(v."voucherNo"),
  0,
  0,
  0,
  NOW(),
  NOW()
FROM "Voucher" v
GROUP BY v."restaurantId"
ON CONFLICT ("restaurantId", "counterDate")
DO UPDATE SET
  "voucherCount" = GREATEST(EXCLUDED."voucherCount", "DailyCounter"."voucherCount"),
  "updatedAt"    = NOW();
