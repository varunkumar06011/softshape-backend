-- CreateTable
CREATE TABLE "ProcessedRequest" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "orderId" TEXT,
    "restaurantId" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessedRequest_restaurantId_createdAt_idx" ON "ProcessedRequest"("restaurantId", "createdAt");

-- CreateUniqueConstraint
CREATE UNIQUE INDEX "ProcessedRequest_requestId_actionType_restaurantId_key" ON "ProcessedRequest"("requestId", "actionType", "restaurantId");
