-- Add reportCategory column to Category for parent sales-category bucket (Food/Beverages/Liquor)
ALTER TABLE "Category" ADD COLUMN "reportCategory" TEXT;
