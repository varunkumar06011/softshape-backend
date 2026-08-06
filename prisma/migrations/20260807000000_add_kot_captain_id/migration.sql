-- Add captainId column to Kot to track which captain created the KOT.
ALTER TABLE "Kot" ADD COLUMN IF NOT EXISTS "captainId" TEXT;

-- Foreign key to User (optional). On user deletion, null out the captain reference.
DO $$ BEGIN ALTER TABLE "Kot" ADD CONSTRAINT "Kot_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "User"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN null; END $$;