-- S2: Set GSTIN on default tenant rows
UPDATE "Restaurant" SET "gstin" = '37AEXPT1195E1ZU'
  WHERE "gstin" IS NULL
  AND ("id" = 'bar-001' OR "slug" = 'bar-001');

UPDATE "Restaurant" SET "gstin" = '37AEXPT1195E1ZU'
  WHERE "gstin" IS NULL
  AND ("id" IN ('restaurant-001', 'venue-001') OR "slug" IN ('restaurant-001', 'venue-001'));
