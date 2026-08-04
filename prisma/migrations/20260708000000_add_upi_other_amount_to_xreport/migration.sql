-- AddColumn: XReport upiAmount and otherAmount
ALTER TABLE "XReport" ADD COLUMN "upiAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "XReport" ADD COLUMN "otherAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
