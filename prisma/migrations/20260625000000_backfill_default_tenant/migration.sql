-- Assign RESTAURANT-001 to the first (oldest) restaurant row that has null restaurantCode
UPDATE "Restaurant"
SET "restaurantCode" = 'RESTAURANT-001'
WHERE "restaurantCode" IS NULL
  AND "id" = (SELECT "id" FROM "Restaurant" ORDER BY "createdAt" ASC LIMIT 1);

-- For any other legacy null rows, assign sequential codes
DO $$
DECLARE
  rec RECORD;
  counter INT := 2;
BEGIN
  FOR rec IN
    SELECT id FROM "Restaurant"
    WHERE "restaurantCode" IS NULL
    ORDER BY "createdAt" ASC
  LOOP
    UPDATE "Restaurant"
    SET "restaurantCode" = 'RESTAURANT-' || LPAD(counter::TEXT, 3, '0')
    WHERE id = rec.id;
    counter := counter + 1;
  END LOOP;
END $$;
