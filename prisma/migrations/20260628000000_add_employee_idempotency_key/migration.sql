-- Add idempotencyKey to Employee for payroll duplicate-click protection
ALTER TABLE "Employee" ADD COLUMN "idempotencyKey" TEXT;

CREATE INDEX "Employee_idempotencyKey_restaurantId_idx" ON "Employee"("idempotencyKey", "restaurantId");
