-- AddColumn: pourFromInventoryItemId on OrderItem
-- Stores the captain/cashier's bottle selection for liquor pegs (30/60/90ml).
-- NULL = no selection (captain skipped) → falls back to largest-bottle-first logic.
-- Non-nullable guarantee is NOT enforced at the DB level so existing rows and
-- food/beer/full-bottle items remain unaffected.
ALTER TABLE "OrderItem" ADD COLUMN "pourFromInventoryItemId" TEXT;
