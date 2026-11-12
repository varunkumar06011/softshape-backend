-- Per-outlet list of names for the expenditure/voucher "Approved by" dropdown.
-- Previously hardcoded in the frontend for every restaurant.
ALTER TABLE "Outlet" ADD COLUMN "expenditureApprovers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Keep Vgrand Lounge + Vgrand Family Restaurant on the names they used before.
UPDATE "Outlet"
SET "expenditureApprovers" = ARRAY['Vinod sir', 'Chandra sir', 'BVL Srinu sir']
WHERE "id" IN ('cmqy60ci200027dscyj9ubg8h', 'cmr03m0fa00015ot8jh16grhn');
