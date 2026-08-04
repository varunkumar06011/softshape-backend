-- Add composite indexes for the single-query today-summary endpoint.
-- These speed up the CTE GROUP BY branches on paidToType/category and paidToName.

CREATE INDEX IF NOT EXISTS "Voucher_restaurantId_voucherDate_status_paidToType_idx"
  ON "Voucher"("restaurantId", "voucherDate", "status", "paidToType");

CREATE INDEX IF NOT EXISTS "Voucher_restaurantId_voucherDate_status_paidToName_idx"
  ON "Voucher"("restaurantId", "voucherDate", "status", "paidToName");
