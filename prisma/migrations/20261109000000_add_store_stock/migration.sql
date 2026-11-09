-- Store Stock (standalone /store portal). New tables only; nothing existing is altered.

CREATE TABLE "store_items" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_items_outletId_nameKey_key" ON "store_items"("outletId", "nameKey");
CREATE INDEX "store_items_outletId_idx" ON "store_items"("outletId");

CREATE TABLE "store_entries" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qty" DECIMAL(14,4) NOT NULL,
    "rate" DECIMAL(14,4),
    "dept" TEXT,
    "receivedBy" TEXT,
    "supplier" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "approvedBy" TEXT,
    "reverses" TEXT,
    "enteredBy" TEXT NOT NULL,
    "entQty" DECIMAL(14,4),
    "entUnit" TEXT,
    "entRate" DECIMAL(14,4),
    CONSTRAINT "store_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_entries_reverses_key" ON "store_entries"("reverses");
CREATE INDEX "store_entries_outletId_date_idx" ON "store_entries"("outletId", "date");
CREATE INDEX "store_entries_itemId_createdAt_idx" ON "store_entries"("itemId", "createdAt");

CREATE TABLE "store_settings" (
    "outletId" TEXT NOT NULL,
    "depts" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_settings_pkey" PRIMARY KEY ("outletId")
);

CREATE TABLE "store_audit" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    CONSTRAINT "store_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "store_audit_outletId_createdAt_idx" ON "store_audit"("outletId", "createdAt");
