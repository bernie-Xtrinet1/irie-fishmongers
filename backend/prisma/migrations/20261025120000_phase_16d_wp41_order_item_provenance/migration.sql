-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP4.1 HYBRID PURCHASE-TIME PROVENANCE
-- ADDITIVE ORDER_ITEMS SCHEMA MIGRATION & IMMUTABILITY TRIGGER
-- ============================================================================

-- 1. Additive columns to order_items (nullable for historical order compatibility)
ALTER TABLE "order_items"
    ADD COLUMN IF NOT EXISTS "originalLotId" TEXT,
    ADD COLUMN IF NOT EXISTS "originalListingId" TEXT,
    ADD COLUMN IF NOT EXISTS "purchaseSnapshot" JSONB;

-- 2. Foreign Key Constraints with ON DELETE RESTRICT (prohibits deleting historical catch lots or listings)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_item_original_lot'
    ) THEN
        ALTER TABLE "order_items"
            ADD CONSTRAINT "fk_order_item_original_lot"
            FOREIGN KEY ("originalLotId") REFERENCES "seafood_lots"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_item_original_listing'
    ) THEN
        ALTER TABLE "order_items"
            ADD CONSTRAINT "fk_order_item_original_listing"
            FOREIGN KEY ("originalListingId") REFERENCES "vendor_daily_listings"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- 3. Indexes for fast lookup and join performance
CREATE INDEX IF NOT EXISTS "idx_order_items_original_lot" ON "order_items"("originalLotId");
CREATE INDEX IF NOT EXISTS "idx_order_items_original_listing" ON "order_items"("originalListingId");

-- 4. Database-level immutability enforcement trigger
-- Rejects ANY update modifying purchase-time provenance (including NULL-to-non-NULL backfilling,
-- non-NULL-to-NULL clearing, or value alterations). Unchanged provenance on UPDATE is permitted.
CREATE OR REPLACE FUNCTION prevent_order_item_provenance_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."originalLotId" IS DISTINCT FROM OLD."originalLotId"
       OR NEW."originalListingId" IS DISTINCT FROM OLD."originalListingId"
       OR NEW."purchaseSnapshot"::text IS DISTINCT FROM OLD."purchaseSnapshot"::text
    THEN
        RAISE EXCEPTION 'Immutable purchase-time provenance cannot be updated (order_item: %)', OLD.id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_order_item_provenance_mutation ON "order_items";
CREATE TRIGGER trg_prevent_order_item_provenance_mutation
    BEFORE UPDATE ON "order_items"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_order_item_provenance_mutation();
