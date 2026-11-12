-- =====================================================================
-- Delete POS sales data dated BEFORE 2026-10-01 (IST) for outlets 9O3N45 and Z3695J only.
-- Keeps 01-Oct-2026 .. today. Other outlets are not touched.
-- Cutoff instant: 2026-10-01 00:00 IST = 2026-09-30 18:30:00 UTC
-- Single transaction: if anything fails (incl. an outlet code not found), nothing is deleted.
-- =====================================================================
BEGIN;

-- Login codes -> outlet ids (sales tables store Outlet.id in "restaurantId")
CREATE TEMP TABLE _rids ON COMMIT DROP AS
  SELECT id, "restaurantCode" FROM "Outlet"
  WHERE upper("restaurantCode") IN ('9O3N45', 'Z3695J');

DO $$
BEGIN
  IF (SELECT count(*) FROM _rids) <> 2 THEN
    RAISE EXCEPTION 'Expected 2 outlets for codes 9O3N45, Z3695J; found %. Nothing deleted.',
      (SELECT count(*) FROM _rids);
  END IF;
END $$;

CREATE TEMP TABLE _del_txn ON COMMIT DROP AS
  SELECT id FROM "Transaction"
  WHERE "restaurantId" IN (SELECT id FROM _rids)
    AND (("txnDate" <> '' AND "txnDate" < '2026-10-01')
      OR ("txnDate" = ''  AND "paidAt" < '2026-09-30 18:30:00'));

-- Orders before cutoff, except those billed on/after the cutoff (kept with their bill)
CREATE TEMP TABLE _del_ord ON COMMIT DROP AS
  SELECT o.id FROM "Order" o
  WHERE o."restaurantId" IN (SELECT id FROM _rids)
    AND o."createdAt" < '2026-09-30 18:30:00'
    AND NOT EXISTS (SELECT 1 FROM "Transaction" k
                    WHERE k."orderId" = o.id AND k.id NOT IN (SELECT id FROM _del_txn));

DELETE FROM "Transaction" WHERE id IN (SELECT id FROM _del_txn);
DELETE FROM "Order"       WHERE id IN (SELECT id FROM _del_ord);  -- cascades OrderItem, Kot, KotItem, deduction logs, OrderConflict

DELETE FROM "XReport"                 WHERE "restaurantId" IN (SELECT id FROM _rids) AND "reportDate"  < '2026-10-01';
DELETE FROM "DailyCounter"            WHERE "restaurantId" IN (SELECT id FROM _rids) AND "counterDate" < '2026-10-01';
DELETE FROM "additional_outlet_sales" WHERE "restaurantId" IN (SELECT id FROM _rids) AND "saleDate"    < '2026-10-01';
DELETE FROM "ProcessedRequest"        WHERE "restaurantId" IN (SELECT id FROM _rids) AND "createdAt"   < '2026-09-30 18:30:00';
DELETE FROM "PrintQueue"              WHERE "restaurantId" IN (SELECT id FROM _rids) AND "createdAt"   < '2026-09-30 18:30:00';

-- Result: per outlet, oldest remaining bill date (must be >= 2026-10-01 or empty)
SELECT r."restaurantCode",
       (SELECT min("txnDate") FROM "Transaction" t WHERE t."restaurantId" = r.id AND t."txnDate" <> '') AS oldest_txn_date,
       (SELECT min("reportDate") FROM "XReport" x WHERE x."restaurantId" = r.id)                        AS oldest_xreport,
       (SELECT count(*) FROM "Transaction" t WHERE t."restaurantId" = r.id AND t.status = 'COMPLETED')  AS remaining_completed_txns
FROM _rids r ORDER BY 1;

COMMIT;
