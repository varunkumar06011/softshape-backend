-- =====================================================================
-- Delete POS sales data dated BEFORE 2026-10-01 (IST). Keeps 01-Oct-2026 .. today.
-- Cutoff instant: 2026-10-01 00:00 IST = 2026-09-30 18:30:00 UTC
--
-- STEP 1 (PREVIEW) : run only the "PREVIEW" query below. Read-only.
-- STEP 2 (DELETE)  : run the "DELETE" block. One transaction: all or nothing.
--
-- Default = ALL outlets. For one outlet only, replace NULL in BOTH blocks
-- with the outlet id in quotes, e.g.  'cmqy60ci200027dscyj9ubg8h'
--
-- Not touched: menu, tables, users, inventory/stock/snapshots, bar daily records,
-- expenditures, balance sheets, payroll, vendors, Transaction_backup_* tables.
-- =====================================================================


-- ============================ PREVIEW ================================
WITH p AS (SELECT '2026-10-01'::text AS d, '2026-09-30 18:30:00'::timestamp AS ts, NULL::text AS rid),
del_txn AS (
  SELECT t.id FROM "Transaction" t, p
  WHERE (p.rid IS NULL OR t."restaurantId" = p.rid)
    AND ((t."txnDate" <> '' AND t."txnDate" < p.d) OR (t."txnDate" = '' AND t."paidAt" < p.ts))
),
del_ord AS (
  SELECT o.id FROM "Order" o, p
  WHERE (p.rid IS NULL OR o."restaurantId" = p.rid)
    AND o."createdAt" < p.ts
    AND NOT EXISTS (SELECT 1 FROM "Transaction" k WHERE k."orderId" = o.id AND k.id NOT IN (SELECT id FROM del_txn))
)
SELECT 'Transaction' AS tbl, count(*) AS rows_to_delete FROM del_txn
UNION ALL SELECT 'Order', count(*) FROM del_ord
UNION ALL SELECT '  OrderItem (cascade)', count(*) FROM "OrderItem" WHERE "orderId" IN (SELECT id FROM del_ord)
UNION ALL SELECT '  Kot (cascade)', count(*) FROM "Kot" WHERE "orderId" IN (SELECT id FROM del_ord)
UNION ALL SELECT '  KotItem (cascade)', count(*) FROM "KotItem" WHERE "kotId" IN (SELECT id FROM "Kot" WHERE "orderId" IN (SELECT id FROM del_ord))
UNION ALL SELECT '  OrderDeductionLog (cascade)', count(*) FROM "OrderDeductionLog" WHERE "orderId" IN (SELECT id FROM del_ord)
UNION ALL SELECT '  BarDeductionLog (cascade)', count(*) FROM "BarDeductionLog" WHERE "orderId" IN (SELECT id FROM del_ord)
UNION ALL SELECT '  OrderConflict (cascade)', count(*) FROM "OrderConflict" WHERE "orderId" IN (SELECT id FROM del_ord)
UNION ALL SELECT 'XReport', count(*) FROM "XReport", p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "reportDate" < p.d
UNION ALL SELECT 'DailyCounter', count(*) FROM "DailyCounter", p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "counterDate" < p.d
UNION ALL SELECT 'additional_outlet_sales', count(*) FROM "additional_outlet_sales", p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "saleDate" < p.d
UNION ALL SELECT 'ProcessedRequest', count(*) FROM "ProcessedRequest", p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "createdAt" < p.ts
UNION ALL SELECT 'PrintQueue', count(*) FROM "PrintQueue", p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "createdAt" < p.ts
UNION ALL SELECT '-- KEPT completed txns (>= cutoff)', count(*) FROM "Transaction" t, p
  WHERE (p.rid IS NULL OR t."restaurantId" = p.rid) AND t.status = 'COMPLETED' AND t.id NOT IN (SELECT id FROM del_txn);


-- ============================ DELETE =================================
BEGIN;

CREATE TEMP TABLE _p ON COMMIT DROP AS
  SELECT '2026-10-01'::text AS d, '2026-09-30 18:30:00'::timestamp AS ts, NULL::text AS rid;

CREATE TEMP TABLE _del_txn ON COMMIT DROP AS
  SELECT t.id FROM "Transaction" t, _p p
  WHERE (p.rid IS NULL OR t."restaurantId" = p.rid)
    AND ((t."txnDate" <> '' AND t."txnDate" < p.d) OR (t."txnDate" = '' AND t."paidAt" < p.ts));

-- Orders before cutoff, except those billed on/after the cutoff (kept with their bill)
CREATE TEMP TABLE _del_ord ON COMMIT DROP AS
  SELECT o.id FROM "Order" o, _p p
  WHERE (p.rid IS NULL OR o."restaurantId" = p.rid)
    AND o."createdAt" < p.ts
    AND NOT EXISTS (SELECT 1 FROM "Transaction" k WHERE k."orderId" = o.id AND k.id NOT IN (SELECT id FROM _del_txn));

-- Transaction -> Order FK has no cascade, so transactions first.
DELETE FROM "Transaction" WHERE id IN (SELECT id FROM _del_txn);
-- Cascades to OrderItem, Kot, KotItem, OrderDeductionLog, BarDeductionLog, OrderConflict
DELETE FROM "Order" WHERE id IN (SELECT id FROM _del_ord);

DELETE FROM "XReport"                 USING _p p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "reportDate"  < p.d;
DELETE FROM "DailyCounter"            USING _p p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "counterDate" < p.d;
DELETE FROM "additional_outlet_sales" USING _p p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "saleDate"    < p.d;
DELETE FROM "ProcessedRequest"        USING _p p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "createdAt"   < p.ts;
DELETE FROM "PrintQueue"              USING _p p WHERE (p.rid IS NULL OR "restaurantId" = p.rid) AND "createdAt"   < p.ts;

-- Verification (shown as the result): oldest remaining dates must be >= 2026-10-01
SELECT
  (SELECT min("txnDate") FROM "Transaction" WHERE "txnDate" <> '')        AS oldest_txn_date,
  (SELECT min("createdAt") + interval '5 hours 30 minutes' FROM "Order")  AS oldest_order_ist,
  (SELECT min("reportDate") FROM "XReport")                               AS oldest_xreport,
  (SELECT count(*) FROM "Transaction" WHERE status = 'COMPLETED')         AS remaining_completed_txns;

COMMIT;
