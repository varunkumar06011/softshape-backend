-- Manual migration for staff import identity columns
-- Run this against the database if `prisma migrate dev` fails due to the broken baseline.
-- Note: we do NOT add a unique index on (restaurantId, name, role) because existing
-- data already contains duplicate names/roles. Ambiguity is handled in the import code.

ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "staffCode" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
        AND tablename = 'Employee'
        AND indexname = 'Employee_restaurantId_staffCode_key'
    ) THEN
        CREATE UNIQUE INDEX "Employee_restaurantId_staffCode_key" ON "Employee"("restaurantId", "staffCode");
    END IF;
END $$;
