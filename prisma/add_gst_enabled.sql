-- Add gstEnabled column to MenuItem table
-- Default true so all existing items remain GST-enabled
ALTER TABLE "MenuItem" ADD COLUMN "gstEnabled" BOOLEAN NOT NULL DEFAULT true;
