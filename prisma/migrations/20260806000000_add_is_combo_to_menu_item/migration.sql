-- Add isCombo column to MenuItem
ALTER TABLE "MenuItem" ADD COLUMN "isCombo" BOOLEAN NOT NULL DEFAULT false;
