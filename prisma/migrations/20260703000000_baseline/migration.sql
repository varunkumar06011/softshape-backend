-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'CASHIER', 'CAPTAIN', 'KITCHEN');

-- CreateEnum
CREATE TYPE "MenuType" AS ENUM ('FOOD', 'LIQUOR');

-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'BILLING_REQUESTED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'BILLING_REQUESTED', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "Outlet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "restaurantCode" TEXT NOT NULL,
    "restaurantType" TEXT,
    "outletCount" INTEGER NOT NULL DEFAULT 1,
    "parentRestaurantId" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "logoUrl" TEXT,
    "receiptHeader" TEXT,
    "receiptSubHeader" TEXT,
    "themePrimary" TEXT,
    "themeSecondary" TEXT,
    "printerConfig" JSONB,
    "barUnitMl" INTEGER NOT NULL DEFAULT 30,
    "fullBottleMl" INTEGER NOT NULL DEFAULT 750,
    "halfBottleMl" INTEGER NOT NULL DEFAULT 375,
    "fssai" TEXT,
    "pricesIncludeGst" BOOLEAN NOT NULL DEFAULT false,
    "gstCategory" TEXT NOT NULL DEFAULT 'NON_AC',
    "gstRate" DOUBLE PRECISION,
    "gstRegistered" BOOLEAN NOT NULL DEFAULT true,
    "serviceChargePercent" INTEGER NOT NULL DEFAULT 0,
    "deliveryPlatforms" TEXT[],
    "enabledModules" JSONB,
    "sharedKitchenOutletId" TEXT,
    "planPriceSnapshot" DECIMAL(10,2),
    "paymentReference" TEXT,
    "onboardingCompletedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "venuesMigrated" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Outlet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "subscriptionId" TEXT,
    "billingStatus" TEXT NOT NULL DEFAULT 'trialing',
    "trialEndsAt" TIMESTAMP(3),
    "paymentStatus" TEXT NOT NULL DEFAULT 'LEGACY_EXEMPT',
    "features" JSONB,
    "enabledModules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingPayment" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "plan" TEXT NOT NULL,
    "numberOfOutlets" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "gateway" TEXT NOT NULL DEFAULT 'MOCK',
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "gatewayOrderId" TEXT,
    "gatewayPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "pin" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "resetToken" TEXT,
    "resetTokenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "venueId" TEXT,
    "permissions" JSONB DEFAULT '{}',
    "role" "UserRole" NOT NULL,
    "outletId" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutletAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "permissions" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutletAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "printerTarget" TEXT,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "categoryId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "basePrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "unit" VARCHAR(20),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "printerTarget" TEXT,
    "printerName" TEXT,
    "menuType" "MenuType" NOT NULL DEFAULT 'FOOD',
    "gstEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemVariant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "menuItemId" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "restaurantId" TEXT NOT NULL,

    CONSTRAINT "MenuItemVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemAddon" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "menuItemId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,

    CONSTRAINT "MenuItemAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "floorId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "venueId" TEXT,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "status" "TableStatus" NOT NULL DEFAULT 'AVAILABLE',
    "sectionId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workflowStatus" TEXT,
    "captainId" TEXT,
    "guests" INTEGER NOT NULL DEFAULT 0,
    "sessionStartedAt" TIMESTAMP(3),
    "currentBill" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "kotHistory" JSONB NOT NULL DEFAULT '[]',
    "discount" DECIMAL(5,2),
    "sectionTag" TEXT,
    "lastWaiterCallAt" TIMESTAMP(3),

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxProfile" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstCategory" TEXT NOT NULL DEFAULT 'NON_AC',
    "gstRate" DOUBLE PRECISION,
    "gstRegistered" BOOLEAN NOT NULL DEFAULT true,
    "serviceChargePercent" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceProfile" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceProfileItem" (
    "id" TEXT NOT NULL,
    "priceProfileId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceProfileItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venueType" TEXT NOT NULL DEFAULT 'DINE_IN',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "priceProfileId" TEXT,
    "taxProfileId" TEXT,
    "kotPrinterName" TEXT,
    "billPrinterName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "kotEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Floor" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "billingRequested" BOOLEAN NOT NULL DEFAULT false,
    "billingRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "billNumber" TEXT,
    "paidAt" TIMESTAMP(3),
    "lastRequestId" TEXT,
    "inventoryDeducted" BOOLEAN NOT NULL DEFAULT false,
    "platform" TEXT DEFAULT 'DINE_IN',

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "notes" TEXT,
    "addedByCashier" BOOLEAN NOT NULL DEFAULT false,
    "originalQuantity" INTEGER,
    "cancelledQuantity" INTEGER NOT NULL DEFAULT 0,
    "editedQuantity" INTEGER NOT NULL DEFAULT 0,
    "removedFromBill" BOOLEAN NOT NULL DEFAULT false,
    "removedBy" TEXT,
    "removedAt" TIMESTAMP(3),
    "menuType" "MenuType" NOT NULL DEFAULT 'FOOD',

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT,
    "tableNumber" INTEGER,
    "captainId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL DEFAULT '[]',
    "sectionTag" TEXT,
    "txnNumber" INTEGER NOT NULL DEFAULT 0,
    "txnDate" TEXT NOT NULL DEFAULT '',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(10,2),
    "discountPercent" DECIMAL(5,2),
    "discountAmount" DECIMAL(10,2),
    "cgst" DECIMAL(10,2),
    "sgst" DECIMAL(10,2),
    "grandTotal" DECIMAL(10,2),
    "billNumber" TEXT,
    "tableLabel" TEXT,
    "sectionId" TEXT,
    "platform" TEXT,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyCounter" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "counterDate" TEXT NOT NULL,
    "kotCount" INTEGER NOT NULL DEFAULT 0,
    "billCount" INTEGER NOT NULL DEFAULT 0,
    "txnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voucherCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedRequest" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "orderId" TEXT,
    "restaurantId" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceId" TEXT,

    CONSTRAINT "ProcessedRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptainAssignment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "captainId" TEXT NOT NULL,
    "revenueTarget" DECIMAL(10,2) NOT NULL,
    "discountLimit" DECIMAL(10,2) NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaptainAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "unitOfMeasure" TEXT NOT NULL,
    "bottleSize" INTEGER NOT NULL,
    "openingStock" DECIMAL(10,2) NOT NULL,
    "currentStock" DECIMAL(10,2) NOT NULL,
    "reorderLevel" DECIMAL(10,2) NOT NULL,
    "costPerBottle" DECIMAL(10,2),
    "lastRestocked" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "quantityChange" DECIMAL(10,2) NOT NULL,
    "stockBefore" DECIMAL(10,2) NOT NULL,
    "stockAfter" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT,
    "transactionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_inventory_snapshots" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "openingStock" DECIMAL(10,2) NOT NULL,
    "purchased" DECIMAL(10,2) NOT NULL,
    "sold" DECIMAL(10,2) NOT NULL,
    "wastage" DECIMAL(10,2) NOT NULL,
    "adjusted" DECIMAL(10,2) NOT NULL,
    "closingStock" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenuePrice" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "restaurantId" TEXT NOT NULL,

    CONSTRAINT "VenuePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueMenuItemAvailability" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueMenuItemAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintQueue" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" TIMESTAMP(3),

    CONSTRAINT "PrintQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "age" INTEGER,
    "role" TEXT,
    "baseSalary" DECIMAL(10,2) NOT NULL,
    "joinDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT,
    "userId" TEXT,
    "staffCode" TEXT,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRecord" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "monthYear" TEXT NOT NULL,
    "baseSalary" DECIMAL(10,2) NOT NULL,
    "absentDays" INTEGER NOT NULL DEFAULT 0,
    "advanceAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "otDays" INTEGER NOT NULL DEFAULT 0,
    "otAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(10,2) NOT NULL,
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "manualAdvanceAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "periodEnd" TEXT,
    "periodStart" TEXT,
    "presentDays" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PayrollRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdvanceHistory" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payrollRecordId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "date" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollAdvanceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checkInTime" TIMESTAMP(3),
    "checkOutTime" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenInventoryItem" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "currentStock" DECIMAL(10,2) NOT NULL,
    "reorderLevel" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "image" TEXT,
    "category" TEXT,

    CONSTRAINT "KitchenInventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemRecipe" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "restaurantId" TEXT NOT NULL,

    CONSTRAINT "MenuItemRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryDailyEntry" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "entryDate" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "openingStock" DECIMAL(10,2) NOT NULL,
    "addedStock" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "consumedStock" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "closingStock" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryDailyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "restaurantId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "Voucher" (
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
    "category" TEXT,
    "approvedByName" TEXT,
    "payrollRecordId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction_backup_2026_07_03" (
    "id" TEXT,
    "restaurantId" TEXT,
    "orderId" TEXT,
    "tableNumber" INTEGER,
    "captainId" TEXT,
    "amount" DECIMAL(10,2),
    "method" TEXT,
    "itemCount" INTEGER,
    "items" JSONB,
    "sectionTag" TEXT,
    "txnNumber" INTEGER,
    "txnDate" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "subtotal" DECIMAL(10,2),
    "discountPercent" DECIMAL(5,2),
    "discountAmount" DECIMAL(10,2),
    "cgst" DECIMAL(10,2),
    "sgst" DECIMAL(10,2),
    "grandTotal" DECIMAL(10,2),
    "billNumber" TEXT,
    "tableLabel" TEXT,
    "sectionId" TEXT,
    "platform" TEXT
);

-- CreateTable
CREATE TABLE "Transaction_backup_2026_07_03_final" (
    "id" TEXT,
    "restaurantId" TEXT,
    "orderId" TEXT,
    "tableNumber" INTEGER,
    "captainId" TEXT,
    "amount" DECIMAL(10,2),
    "method" TEXT,
    "itemCount" INTEGER,
    "items" JSONB,
    "sectionTag" TEXT,
    "txnNumber" INTEGER,
    "txnDate" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "subtotal" DECIMAL(10,2),
    "discountPercent" DECIMAL(5,2),
    "discountAmount" DECIMAL(10,2),
    "cgst" DECIMAL(10,2),
    "sgst" DECIMAL(10,2),
    "grandTotal" DECIMAL(10,2),
    "billNumber" TEXT,
    "tableLabel" TEXT,
    "sectionId" TEXT,
    "platform" TEXT
);

-- CreateTable
CREATE TABLE "Transaction_backup_cmqy60ci200027dscyj9ubg8h" (
    "id" TEXT,
    "restaurantId" TEXT,
    "orderId" TEXT,
    "tableNumber" INTEGER,
    "captainId" TEXT,
    "amount" DECIMAL(10,2),
    "method" TEXT,
    "itemCount" INTEGER,
    "items" JSONB,
    "sectionTag" TEXT,
    "txnNumber" INTEGER,
    "txnDate" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "subtotal" DECIMAL(10,2),
    "discountPercent" DECIMAL(5,2),
    "discountAmount" DECIMAL(10,2),
    "cgst" DECIMAL(10,2),
    "sgst" DECIMAL(10,2),
    "grandTotal" DECIMAL(10,2),
    "billNumber" TEXT,
    "tableLabel" TEXT,
    "sectionId" TEXT,
    "platform" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_slug_key" ON "Outlet"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_restaurantCode_key" ON "Outlet"("restaurantCode");

-- CreateIndex
CREATE INDEX "Outlet_parentRestaurantId_idx" ON "Outlet"("parentRestaurantId");

-- CreateIndex
CREATE INDEX "Outlet_organizationId_idx" ON "Outlet"("organizationId");

-- CreateIndex
CREATE INDEX "Outlet_sharedKitchenOutletId_idx" ON "Outlet"("sharedKitchenOutletId");

-- CreateIndex
CREATE INDEX "OnboardingPayment_sessionId_idx" ON "OnboardingPayment"("sessionId");

-- CreateIndex
CREATE INDEX "OnboardingPayment_restaurantId_idx" ON "OnboardingPayment"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_outletId_idx" ON "User"("outletId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_outletId_email_key" ON "User"("outletId", "email");

-- CreateIndex
CREATE INDEX "OutletAccess_userId_idx" ON "OutletAccess"("userId");

-- CreateIndex
CREATE INDEX "OutletAccess_outletId_idx" ON "OutletAccess"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletAccess_userId_outletId_key" ON "OutletAccess"("userId", "outletId");

-- CreateIndex
CREATE INDEX "Category_restaurantId_idx" ON "Category"("restaurantId");

-- CreateIndex
CREATE INDEX "Category_restaurantId_isActive_sortOrder_idx" ON "Category"("restaurantId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");

-- CreateIndex
CREATE INDEX "MenuItem_restaurantId_idx" ON "MenuItem"("restaurantId");

-- CreateIndex
CREATE INDEX "MenuItem_restaurantId_isAvailable_isDeleted_idx" ON "MenuItem"("restaurantId", "isAvailable", "isDeleted");

-- CreateIndex
CREATE INDEX "MenuItemVariant_menuItemId_idx" ON "MenuItemVariant"("menuItemId");

-- CreateIndex
CREATE INDEX "MenuItemVariant_restaurantId_idx" ON "MenuItemVariant"("restaurantId");

-- CreateIndex
CREATE INDEX "MenuItemAddon_menuItemId_idx" ON "MenuItemAddon"("menuItemId");

-- CreateIndex
CREATE INDEX "MenuItemAddon_restaurantId_idx" ON "MenuItemAddon"("restaurantId");

-- CreateIndex
CREATE INDEX "Section_restaurantId_idx" ON "Section"("restaurantId");

-- CreateIndex
CREATE INDEX "Section_venueId_idx" ON "Section"("venueId");

-- CreateIndex
CREATE INDEX "Section_floorId_idx" ON "Section"("floorId");

-- CreateIndex
CREATE INDEX "Table_restaurantId_status_idx" ON "Table"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Table_restaurantId_sectionId_number_key" ON "Table"("restaurantId", "sectionId", "number");

-- CreateIndex
CREATE INDEX "TaxProfile_restaurantId_idx" ON "TaxProfile"("restaurantId");

-- CreateIndex
CREATE INDEX "PriceProfile_restaurantId_idx" ON "PriceProfile"("restaurantId");

-- CreateIndex
CREATE INDEX "PriceProfileItem_priceProfileId_idx" ON "PriceProfileItem"("priceProfileId");

-- CreateIndex
CREATE INDEX "PriceProfileItem_menuItemId_idx" ON "PriceProfileItem"("menuItemId");

-- CreateIndex
CREATE INDEX "PriceProfileItem_restaurantId_idx" ON "PriceProfileItem"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceProfileItem_priceProfileId_menuItemId_key" ON "PriceProfileItem"("priceProfileId", "menuItemId");

-- CreateIndex
CREATE INDEX "Venue_restaurantId_idx" ON "Venue"("restaurantId");

-- CreateIndex
CREATE INDEX "Floor_venueId_idx" ON "Floor"("venueId");

-- CreateIndex
CREATE INDEX "Floor_restaurantId_idx" ON "Floor"("restaurantId");

-- CreateIndex
CREATE INDEX "Order_restaurantId_status_idx" ON "Order"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Order_tableId_status_idx" ON "Order"("tableId", "status");

-- CreateIndex
CREATE INDEX "Order_restaurantId_isDeleted_idx" ON "Order"("restaurantId", "isDeleted");

-- CreateIndex
CREATE INDEX "Order_restaurantId_status_paidAt_idx" ON "Order"("restaurantId", "status", "paidAt" DESC);

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_menuItemId_idx" ON "OrderItem"("menuItemId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_removedFromBill_idx" ON "OrderItem"("orderId", "removedFromBill");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_orderId_key" ON "Transaction"("orderId");

-- CreateIndex
CREATE INDEX "Transaction_restaurantId_idx" ON "Transaction"("restaurantId");

-- CreateIndex
CREATE INDEX "Transaction_restaurantId_paidAt_idx" ON "Transaction"("restaurantId", "paidAt" DESC);

-- CreateIndex
CREATE INDEX "Transaction_restaurantId_txnDate_idx" ON "Transaction"("restaurantId", "txnDate");

-- CreateIndex
CREATE INDEX "Transaction_restaurantId_sectionId_idx" ON "Transaction"("restaurantId", "sectionId");

-- CreateIndex
CREATE INDEX "DailyCounter_restaurantId_counterDate_idx" ON "DailyCounter"("restaurantId", "counterDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyCounter_restaurantId_counterDate_key" ON "DailyCounter"("restaurantId", "counterDate");

-- CreateIndex
CREATE INDEX "ProcessedRequest_restaurantId_createdAt_idx" ON "ProcessedRequest"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessedRequest_deviceId_restaurantId_idx" ON "ProcessedRequest"("deviceId", "restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedRequest_requestId_actionType_restaurantId_key" ON "ProcessedRequest"("requestId", "actionType", "restaurantId");

-- CreateIndex
CREATE INDEX "CaptainAssignment_restaurantId_idx" ON "CaptainAssignment"("restaurantId");

-- CreateIndex
CREATE INDEX "CaptainAssignment_captainId_idx" ON "CaptainAssignment"("captainId");

-- CreateIndex
CREATE UNIQUE INDEX "CaptainAssignment_restaurantId_captainId_key" ON "CaptainAssignment"("restaurantId", "captainId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_menuItemId_key" ON "inventory_items"("menuItemId");

-- CreateIndex
CREATE INDEX "inventory_items_restaurantId_idx" ON "inventory_items"("restaurantId");

-- CreateIndex
CREATE INDEX "inventory_items_menuItemId_idx" ON "inventory_items"("menuItemId");

-- CreateIndex
CREATE INDEX "inventory_items_currentStock_idx" ON "inventory_items"("currentStock");

-- CreateIndex
CREATE INDEX "inventory_transactions_restaurantId_transactionDate_idx" ON "inventory_transactions"("restaurantId", "transactionDate");

-- CreateIndex
CREATE INDEX "inventory_transactions_itemId_idx" ON "inventory_transactions"("itemId");

-- CreateIndex
CREATE INDEX "inventory_transactions_orderId_idx" ON "inventory_transactions"("orderId");

-- CreateIndex
CREATE INDEX "inventory_transactions_type_idx" ON "inventory_transactions"("type");

-- CreateIndex
CREATE INDEX "daily_inventory_snapshots_restaurantId_snapshotDate_idx" ON "daily_inventory_snapshots"("restaurantId", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "daily_inventory_snapshots_restaurantId_snapshotDate_itemId_key" ON "daily_inventory_snapshots"("restaurantId", "snapshotDate", "itemId");

-- CreateIndex
CREATE INDEX "VenuePrice_venueId_idx" ON "VenuePrice"("venueId");

-- CreateIndex
CREATE INDEX "VenuePrice_menuItemId_idx" ON "VenuePrice"("menuItemId");

-- CreateIndex
CREATE INDEX "VenuePrice_restaurantId_idx" ON "VenuePrice"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "VenuePrice_venueId_menuItemId_key" ON "VenuePrice"("venueId", "menuItemId");

-- CreateIndex
CREATE INDEX "VenueMenuItemAvailability_venueId_idx" ON "VenueMenuItemAvailability"("venueId");

-- CreateIndex
CREATE INDEX "VenueMenuItemAvailability_menuItemId_idx" ON "VenueMenuItemAvailability"("menuItemId");

-- CreateIndex
CREATE INDEX "VenueMenuItemAvailability_restaurantId_idx" ON "VenueMenuItemAvailability"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueMenuItemAvailability_venueId_menuItemId_key" ON "VenueMenuItemAvailability"("venueId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintQueue_eventId_key" ON "PrintQueue"("eventId");

-- CreateIndex
CREATE INDEX "PrintQueue_restaurantId_status_idx" ON "PrintQueue"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "PrintQueue_createdAt_idx" ON "PrintQueue"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_restaurantId_idx" ON "Employee"("restaurantId");

-- CreateIndex
CREATE INDEX "Employee_idempotencyKey_restaurantId_idx" ON "Employee"("idempotencyKey", "restaurantId");

-- CreateIndex
CREATE INDEX "Employee_userId_idx" ON "Employee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_restaurantId_staffCode_key" ON "Employee"("restaurantId", "staffCode");

-- CreateIndex
CREATE INDEX "PayrollRecord_restaurantId_monthYear_idx" ON "PayrollRecord"("restaurantId", "monthYear");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRecord_employeeId_monthYear_key" ON "PayrollRecord"("employeeId", "monthYear");

-- CreateIndex
CREATE INDEX "PayrollAdvanceHistory_restaurantId_idx" ON "PayrollAdvanceHistory"("restaurantId");

-- CreateIndex
CREATE INDEX "PayrollAdvanceHistory_employeeId_idx" ON "PayrollAdvanceHistory"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollAdvanceHistory_payrollRecordId_idx" ON "PayrollAdvanceHistory"("payrollRecordId");

-- CreateIndex
CREATE INDEX "PayrollAdvanceHistory_createdById_idx" ON "PayrollAdvanceHistory"("createdById");

-- CreateIndex
CREATE INDEX "Attendance_restaurantId_date_idx" ON "Attendance"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "Attendance_employeeId_idx" ON "Attendance"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_employeeId_date_key" ON "Attendance"("employeeId", "date");

-- CreateIndex
CREATE INDEX "KitchenInventoryItem_restaurantId_idx" ON "KitchenInventoryItem"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenInventoryItem_restaurantId_name_key" ON "KitchenInventoryItem"("restaurantId", "name");

-- CreateIndex
CREATE INDEX "MenuItemRecipe_restaurantId_idx" ON "MenuItemRecipe"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemRecipe_menuItemId_ingredientId_key" ON "MenuItemRecipe"("menuItemId", "ingredientId");

-- CreateIndex
CREATE INDEX "InventoryDailyEntry_restaurantId_entryDate_idx" ON "InventoryDailyEntry"("restaurantId", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryDailyEntry_restaurantId_itemId_entryDate_key" ON "InventoryDailyEntry"("restaurantId", "itemId", "entryDate");

-- CreateIndex
CREATE INDEX "AuditLog_restaurantId_createdAt_idx" ON "AuditLog"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanConfig_planId_key" ON "PlanConfig"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "Announcement_isActive_activeFrom_activeUntil_idx" ON "Announcement"("isActive", "activeFrom", "activeUntil");

-- CreateIndex
CREATE INDEX "Voucher_restaurantId_voucherDate_idx" ON "Voucher"("restaurantId", "voucherDate");

-- CreateIndex
CREATE INDEX "Voucher_restaurantId_status_idx" ON "Voucher"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Voucher_employeeId_idx" ON "Voucher"("employeeId");

-- CreateIndex
CREATE INDEX "Voucher_idempotencyKey_restaurantId_idx" ON "Voucher"("idempotencyKey", "restaurantId");

-- AddForeignKey
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_parentRestaurantId_fkey" FOREIGN KEY ("parentRestaurantId") REFERENCES "Outlet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletAccess" ADD CONSTRAINT "OutletAccess_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletAccess" ADD CONSTRAINT "OutletAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemAddon" ADD CONSTRAINT "MenuItemAddon_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceProfileItem" ADD CONSTRAINT "PriceProfileItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceProfileItem" ADD CONSTRAINT "PriceProfileItem_priceProfileId_fkey" FOREIGN KEY ("priceProfileId") REFERENCES "PriceProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_priceProfileId_fkey" FOREIGN KEY ("priceProfileId") REFERENCES "PriceProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_taxProfileId_fkey" FOREIGN KEY ("taxProfileId") REFERENCES "TaxProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_inventory_snapshots" ADD CONSTRAINT "daily_inventory_snapshots_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenuePrice" ADD CONSTRAINT "VenuePrice_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenuePrice" ADD CONSTRAINT "VenuePrice_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueMenuItemAvailability" ADD CONSTRAINT "VenueMenuItemAvailability_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueMenuItemAvailability" ADD CONSTRAINT "VenueMenuItemAvailability_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdvanceHistory" ADD CONSTRAINT "PayrollAdvanceHistory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdvanceHistory" ADD CONSTRAINT "PayrollAdvanceHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdvanceHistory" ADD CONSTRAINT "PayrollAdvanceHistory_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "PayrollRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemRecipe" ADD CONSTRAINT "MenuItemRecipe_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "KitchenInventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemRecipe" ADD CONSTRAINT "MenuItemRecipe_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDailyEntry" ADD CONSTRAINT "InventoryDailyEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "KitchenInventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "PayrollRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

