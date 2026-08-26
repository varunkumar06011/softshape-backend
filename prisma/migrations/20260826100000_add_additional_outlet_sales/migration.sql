-- Additional / Offline Sales — manually entered reference figures for outlets
-- without a PC/system. NOT included in Total Sales, AOV, POS revenue, billing,
-- or inventory. Separate informational ledger only.

CREATE TABLE IF NOT EXISTS "additional_outlet_sales" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "saleDate" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "outletName" TEXT NOT NULL,
    "revenue" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "additional_outlet_sales_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "additional_outlet_sales_restaurant_id_sale_date_idx" ON "additional_outlet_sales"("restaurantId", "saleDate");
CREATE INDEX IF NOT EXISTS "additional_outlet_sales_restaurant_id_category_sale_date_idx" ON "additional_outlet_sales"("restaurantId", "category", "saleDate");
