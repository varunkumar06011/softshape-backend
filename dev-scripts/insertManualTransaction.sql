-- ============================================================
-- Manual Transaction Insert
-- Restaurant : Z3695J
-- Bill No    : 8   |  Table : 16
-- Date       : 2026-07-07  |  Time  : 15:12 IST (03:12 PM)
-- ============================================================

BEGIN;

-- Step 1: Upsert DailyCounter to get the next txnNumber for this day
INSERT INTO "DailyCounter" (
  "id",
  "restaurantId",
  "counterDate",
  "txnCount",
  "billCount",
  "kotCount",
  "voucherCount",
  "createdAt",
  "updatedAt"
)
VALUES (
  'c' || replace(gen_random_uuid()::text, '-', ''),
  'Z3695J',
  '2026-07-07',
  1, 0, 0, 0,
  NOW(), NOW()
)
ON CONFLICT ("restaurantId", "counterDate")
DO UPDATE SET
  "txnCount" = "DailyCounter"."txnCount" + 1,
  "updatedAt" = NOW();

-- Step 2: Insert the Transaction (reads txnNumber from the counter we just upserted)
INSERT INTO "Transaction" (
  "id",
  "restaurantId",
  "tableNumber",
  "billNumber",
  "amount",
  "method",
  "itemCount",
  "items",
  "subtotal",
  "discountPercent",
  "discountAmount",
  "cgst",
  "sgst",
  "grandTotal",
  "roundOff",
  "tipAmount",
  "txnNumber",
  "txnDate",
  "paidAt",
  "createdAt",
  "platform"
)
SELECT
  'c' || replace(gen_random_uuid()::text, '-', ''),
  'Z3695J',
  16,
  '8',
  3552.00,
  'CASH',
  10,
  '[
    {"name": "Gongura Chicken Biryani",   "quantity": 1,  "price": 330, "menuType": "FOOD"},
    {"name": "Raju Gari Chicken Biryani", "quantity": 1,  "price": 410, "menuType": "FOOD"},
    {"name": "Jeera Rice",                "quantity": 1,  "price": 260, "menuType": "FOOD"},
    {"name": "Today Spl Indian B/L",      "quantity": 1,  "price": 410, "menuType": "FOOD"},
    {"name": "Chicken Hot and Sour Soup", "quantity": 2,  "price": 170, "menuType": "FOOD"},
    {"name": "Boiled Palli Masala",       "quantity": 1,  "price": 179, "menuType": "FOOD"},
    {"name": "Royal Challenge Whiskey",   "quantity": 3,  "price": 61,  "menuType": "LIQUOR"},
    {"name": "Royal Stag",                "quantity": 21, "price": 61,  "menuType": "LIQUOR"},
    {"name": "Chicken Manchow Soup",      "quantity": 2,  "price": 170, "menuType": "FOOD"},
    {"name": "Water Bottle 1 Ltr",        "quantity": 4,  "price": 25,  "menuType": "FOOD"}
  ]'::jsonb,
  3833.00,
  10.00,
  383.00,
  51.00,
  51.00,
  3552.00,
  0.00,
  0.00,
  "txnCount",
  '2026-07-07',
  '2026-07-07 09:42:00+00',   -- 03:12 PM IST = 09:42 UTC
  NOW(),
  'DINE_IN'
FROM "DailyCounter"
WHERE "restaurantId" = 'Z3695J'
  AND "counterDate"  = '2026-07-07';

COMMIT;
