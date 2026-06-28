-- CreateTable: PlanConfig
CREATE TABLE "PlanConfig" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "basePrice" INTEGER NOT NULL,
    "perExtraOutletPrice" INTEGER NOT NULL,
    "includedOutlets" INTEGER NOT NULL,
    "isCustomQuote" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanConfig_planId_key" ON "PlanConfig"("planId");

-- CreateTable: FeatureFlag
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "enabledGlobally" BOOLEAN NOT NULL DEFAULT false,
    "enabledRestaurants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateTable: Announcement
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'info',
    "target" TEXT NOT NULL DEFAULT 'all',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "activeFrom" TIMESTAMP(3),
    "activeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_isActive_activeFrom_activeUntil_idx" ON "Announcement"("isActive", "activeFrom", "activeUntil");

-- Seed: PlanConfig with hardcoded values from pricing.ts
INSERT INTO "PlanConfig" ("id", "planId", "name", "basePrice", "perExtraOutletPrice", "includedOutlets", "isCustomQuote", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'starter', 'Starter', 999, 499, 1, false, true, NOW(), NOW()),
  (gen_random_uuid(), 'pro', 'Pro', 2499, 999, 1, false, true, NOW(), NOW()),
  (gen_random_uuid(), 'enterprise', 'Enterprise', 0, 0, 0, true, true, NOW(), NOW());
