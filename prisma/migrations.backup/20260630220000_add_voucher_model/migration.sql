-- Add voucherCount column to DailyCounter
ALTER TABLE "DailyCounter" ADD COLUMN IF NOT EXISTS "voucherCount" INTEGER NOT NULL DEFAULT 0;

-- Create Voucher table
CREATE TABLE IF NOT EXISTS "Voucher" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "voucherNo" INTEGER NOT NULL,
    "voucherDate" TEXT NOT NULL,
    "paidToType" TEXT NOT NULL,
    "paidToName" TEXT NOT NULL,
    "employeeId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "narration" TEXT,
    "approvedById" TEXT,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "payrollRecordId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_payrollRecordId_fkey"
    FOREIGN KEY ("payrollRecordId") REFERENCES "PayrollRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX IF NOT EXISTS "Voucher_restaurantId_voucherDate_idx" ON "Voucher"("restaurantId", "voucherDate");
CREATE INDEX IF NOT EXISTS "Voucher_restaurantId_status_idx" ON "Voucher"("restaurantId", "status");
CREATE INDEX IF NOT EXISTS "Voucher_employeeId_idx" ON "Voucher"("employeeId");
CREATE INDEX IF NOT EXISTS "Voucher_idempotencyKey_restaurantId_idx" ON "Voucher"("idempotencyKey", "restaurantId");
