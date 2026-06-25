-- =============================================================================
-- Migration: create_missing_tables
-- Creates tables that were missing from the migration history but referenced
-- by later migrations. The shadow database failed because these tables didn't
-- exist when later migrations tried to ALTER them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- User table (referenced by Restaurant relation, never had a CREATE TABLE)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "User" (
    "id"           TEXT           NOT NULL,
    "name"         TEXT           NOT NULL,
    "email"        TEXT,
    "passwordHash" TEXT,
    "pin"          TEXT,
    "role"         TEXT           NOT NULL,
    "restaurantId" TEXT           NOT NULL,
    "isActive"     BOOLEAN        NOT NULL DEFAULT true,
    "resetToken"   TEXT,
    "resetTokenAt" TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key"
    ON "User"("email");

CREATE UNIQUE INDEX IF NOT EXISTS "User_restaurantId_id_key"
    ON "User"("restaurantId", "id");

CREATE INDEX IF NOT EXISTS "User_restaurantId_idx"
    ON "User"("restaurantId");

CREATE INDEX IF NOT EXISTS "User_email_idx"
    ON "User"("email");

-- Note: FK User -> Restaurant is not added here because the Restaurant table
-- is created later in schema_modernization (20260524183000). The FK will be
-- added by Prisma's reconciliation or can be added in a later migration.

-- ---------------------------------------------------------------------------
-- Transaction table (referenced by schema_modernization FK, never had CREATE TABLE)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Transaction" (
    "id"           TEXT           NOT NULL,
    "restaurantId" TEXT           NOT NULL,
    "orderId"      TEXT,
    "tableNumber"  INTEGER,
    "captainId"    TEXT,
    "amount"       DECIMAL(10,2)  NOT NULL,
    "method"       TEXT           NOT NULL,
    "itemCount"    INTEGER        NOT NULL DEFAULT 0,
    "items"        JSON           NOT NULL DEFAULT '[]',
    "sectionTag"   TEXT,
    "txnNumber"    INTEGER        NOT NULL DEFAULT 0,
    "txnDate"      TEXT           NOT NULL DEFAULT '',
    "paidAt"       TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Transaction_restaurantId_idx"
    ON "Transaction"("restaurantId");

CREATE INDEX IF NOT EXISTS "Transaction_restaurantId_paidAt_idx"
    ON "Transaction"("restaurantId", "paidAt");

CREATE INDEX IF NOT EXISTS "Transaction_restaurantId_txnDate_idx"
    ON "Transaction"("restaurantId", "txnDate");

CREATE INDEX IF NOT EXISTS "Transaction_orderId_idx"
    ON "Transaction"("orderId");

CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_orderId_key"
    ON "Transaction"("orderId");

CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_restaurantId_id_key"
    ON "Transaction"("restaurantId", "id");

-- ---------------------------------------------------------------------------
-- DailyCounter table (referenced by add_billing_fields ALTER TABLE, never created)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "DailyCounter" (
    "id"           TEXT           NOT NULL,
    "restaurantId" TEXT           NOT NULL,
    "counterDate"  TEXT           NOT NULL,
    "kotCount"     INTEGER        NOT NULL DEFAULT 0,
    "billCount"    INTEGER        NOT NULL DEFAULT 0,
    "txnCount"     INTEGER        NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DailyCounter_restaurantId_counterDate_key"
    ON "DailyCounter"("restaurantId", "counterDate");

CREATE INDEX IF NOT EXISTS "DailyCounter_restaurantId_counterDate_idx"
    ON "DailyCounter"("restaurantId", "counterDate");

-- ---------------------------------------------------------------------------
-- CaptainAssignment table (used by captain targets route, never had CREATE TABLE)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CaptainAssignment" (
    "id"            TEXT           NOT NULL,
    "restaurantId"  TEXT           NOT NULL,
    "captainId"     TEXT           NOT NULL,
    "revenueTarget" DECIMAL(10,2)  NOT NULL,
    "discountLimit" DECIMAL(10,2)  NOT NULL,
    "assignedAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptainAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CaptainAssignment_restaurantId_captainId_key"
    ON "CaptainAssignment"("restaurantId", "captainId");

CREATE INDEX IF NOT EXISTS "CaptainAssignment_restaurantId_idx"
    ON "CaptainAssignment"("restaurantId");

CREATE INDEX IF NOT EXISTS "CaptainAssignment_captainId_idx"
    ON "CaptainAssignment"("captainId");
