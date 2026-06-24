CREATE TABLE IF NOT EXISTS "GlobalCounter" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "nextVal" INTEGER NOT NULL DEFAULT 2,
  CONSTRAINT "GlobalCounter_pkey" PRIMARY KEY ("id")
);

INSERT INTO "GlobalCounter" ("id", "nextVal")
VALUES ('global', (SELECT COUNT(*) + 1 FROM "Restaurant"))
ON CONFLICT ("id") DO NOTHING;
