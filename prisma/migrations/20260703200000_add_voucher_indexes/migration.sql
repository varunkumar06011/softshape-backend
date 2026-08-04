-- Add missing indexes to speed up voucher loading and summary queries

-- Index for today-summary and date-range queries filtered by status
CREATE INDEX "Voucher_restaurantId_voucherDate_status_idx" ON "Voucher"("restaurantId", "voucherDate", "status");

-- Index for ordering voucher lists by createdAt
CREATE INDEX "Voucher_restaurantId_createdAt_idx" ON "Voucher"("restaurantId", "createdAt");

-- Index for narration suggestion lookups
CREATE INDEX "Voucher_restaurantId_narration_idx" ON "Voucher"("restaurantId", "narration");
