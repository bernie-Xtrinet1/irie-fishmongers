-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP4.1 GUARDED TRANSACTIONAL ROLLBACK
-- DEV / EMPTY CONTROLLED ENVIRONMENT ONLY - ABORTS ON NONEMPTY PROVENANCE
-- ============================================================================

BEGIN;

DO $$
DECLARE
    v_provenance_count INTEGER := 0;
BEGIN
    -- 1. Acquire ACCESS EXCLUSIVE table lock on order_items to serialize check & modification
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'order_items'
    ) THEN
        EXECUTE 'LOCK TABLE "order_items" IN ACCESS EXCLUSIVE MODE';

        -- 2. Check if any live records have purchase-time provenance populated
        SELECT count(*) INTO v_provenance_count
        FROM "order_items"
        WHERE "originalLotId" IS NOT NULL
           OR "originalListingId" IS NOT NULL
           OR "purchaseSnapshot" IS NOT NULL;
    END IF;

    -- 3. Explicitly abort if ANY live records contain purchase provenance
    -- Dropping columns with live data causes IRREVERSIBLE LOSS of legal catch-weight purchase audit trails.
    IF v_provenance_count > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED: order_items table contains % records with non-null purchase-time provenance. Dropping columns would cause irreversible data loss of legal purchase audit records. Perform audited archival migration.', v_provenance_count;
    END IF;

    -- 4. Cleanly drop trigger and trigger function
    IF EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_order_item_provenance_mutation'
    ) THEN
        DROP TRIGGER trg_prevent_order_item_provenance_mutation ON "order_items";
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'prevent_order_item_provenance_mutation'
    ) THEN
        DROP FUNCTION prevent_order_item_provenance_mutation();
    END IF;

    -- 5. Drop indexes
    IF EXISTS (
        SELECT FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_order_items_original_lot'
    ) THEN
        DROP INDEX "idx_order_items_original_lot";
    END IF;

    IF EXISTS (
        SELECT FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_order_items_original_listing'
    ) THEN
        DROP INDEX "idx_order_items_original_listing";
    END IF;

    -- 6. Drop foreign-key constraints
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_item_original_lot'
    ) THEN
        ALTER TABLE "order_items" DROP CONSTRAINT "fk_order_item_original_lot";
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_item_original_listing'
    ) THEN
        ALTER TABLE "order_items" DROP CONSTRAINT "fk_order_item_original_listing";
    END IF;

    -- 7. Drop columns
    ALTER TABLE "order_items"
        DROP COLUMN IF EXISTS "purchaseSnapshot",
        DROP COLUMN IF EXISTS "originalListingId",
        DROP COLUMN IF EXISTS "originalLotId";
END $$;

COMMIT;
