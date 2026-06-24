-- AddColumn
ALTER TABLE "Restaurant" ADD COLUMN "restaurantCode" TEXT;
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_restaurantCode_key" UNIQUE ("restaurantCode");
