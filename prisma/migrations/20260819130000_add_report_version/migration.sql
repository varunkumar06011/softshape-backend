-- Add reportVersion to XReport for tracking snapshot version across state transitions
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "reportVersion" INTEGER NOT NULL DEFAULT 1;
