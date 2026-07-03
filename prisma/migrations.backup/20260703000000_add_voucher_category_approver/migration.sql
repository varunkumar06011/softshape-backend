-- Add category and static approver name columns to Voucher
ALTER TABLE "Voucher" ADD COLUMN "category" TEXT;
ALTER TABLE "Voucher" ADD COLUMN "approvedByName" TEXT;

-- Migrate existing non-staff vouchers into the new category field
UPDATE "Voucher" SET "category" = "paidToType" WHERE "paidToType" IN ('MAINTENANCE', 'OTHER') AND "category" IS NULL;

-- Normalize legacy non-staff rows to paidToType = 'OTHER' so the new code only deals with STAFF/OTHER
UPDATE "Voucher" SET "paidToType" = 'OTHER' WHERE "paidToType" IN ('MAINTENANCE', 'OTHER');
