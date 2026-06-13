-- AddColumn: tableLabel String? to Transaction (additive, non-breaking)
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "tableLabel" TEXT;
