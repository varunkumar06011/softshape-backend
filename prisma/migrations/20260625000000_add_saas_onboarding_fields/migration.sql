-- Add SaaS onboarding fields to Restaurant (idempotent)
ALTER TABLE "Restaurant"
  ADD COLUMN IF NOT EXISTS "enabledModules"        JSONB,
  ADD COLUMN IF NOT EXISTS "planPriceSnapshot"     DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "paymentStatus"         TEXT NOT NULL DEFAULT 'LEGACY_EXEMPT',
  ADD COLUMN IF NOT EXISTS "paymentReference"      TEXT,
  ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMP(3);

-- Create OnboardingPayment table
CREATE TABLE IF NOT EXISTS "OnboardingPayment" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "sessionId"        TEXT NOT NULL,
  "restaurantId"     TEXT,
  "plan"             TEXT NOT NULL,
  "numberOfOutlets"  INTEGER NOT NULL,
  "amount"           DECIMAL(10,2) NOT NULL,
  "currency"         TEXT NOT NULL DEFAULT 'INR',
  "gateway"          TEXT NOT NULL DEFAULT 'MOCK',
  "status"           TEXT NOT NULL DEFAULT 'CREATED',
  "gatewayOrderId"   TEXT,
  "gatewayPaymentId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "OnboardingPayment_sessionId_idx"    ON "OnboardingPayment"("sessionId");
CREATE INDEX IF NOT EXISTS "OnboardingPayment_restaurantId_idx" ON "OnboardingPayment"("restaurantId");
