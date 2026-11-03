-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP4.3B.4C GUARDED TRANSACTIONAL ROLLBACK
-- DEV / EMPTY CONTROLLED ENVIRONMENT ONLY - REFUSES ROLLBACK IF V2 DATA EXISTS
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
    v_v2_snapshot_count INTEGER := 0;
    v_v2_adj_count INTEGER := 0;
    v_v2_consent_count INTEGER := 0;
BEGIN
    -- 1. Introspect order_items using safe, non-casting JSONB operators
    SELECT count(*) INTO v_v2_snapshot_count
    FROM "order_items"
    WHERE "purchaseSnapshot" IS NOT NULL
      AND jsonb_typeof("purchaseSnapshot") = 'object'
      AND "purchaseSnapshot" ? 'schemaVersion'
      AND ("purchaseSnapshot"->>'schemaVersion' = '2');

    IF v_v2_snapshot_count > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED: order_items contains % records with V2 purchase snapshots (schemaVersion = 2). Dropping V2 columns would break purchase provenance integrity. Perform audited archival migration.', v_v2_snapshot_count;
    END IF;

    -- 2. Check all four V2 fields on seafood_order_weight_adjustments
    SELECT count(*) INTO v_v2_adj_count
    FROM "seafood_order_weight_adjustments"
    WHERE "preparationChargeMethod" IS NOT NULL
       OR "fishCount" IS NOT NULL
       OR "originalWholeWeightLbs" IS NOT NULL
       OR "originalWholeWeightUnit" IS NOT NULL;

    IF v_v2_adj_count > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED: seafood_order_weight_adjustments contains % records with populated V2 fields (preparationChargeMethod, fishCount, originalWholeWeightLbs, originalWholeWeightUnit). Dropping columns would cause irreversible data loss.', v_v2_adj_count;
    END IF;

    -- 3. Check both quote fields on customer_checkout_ceiling_consents
    SELECT count(*) INTO v_v2_consent_count
    FROM "customer_checkout_ceiling_consents"
    WHERE "quoteId" IS NOT NULL
       OR "quotePayloadHash" IS NOT NULL;

    IF v_v2_consent_count > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED: customer_checkout_ceiling_consents contains % records with populated quoteId or quotePayloadHash.', v_v2_consent_count;
    END IF;

    -- 4. Clean teardown if all guard assertions pass (0 records)
    DROP INDEX IF EXISTS "idx_ceiling_consents_quote_id";

    ALTER TABLE "customer_checkout_ceiling_consents"
        DROP COLUMN IF EXISTS "quotePayloadHash",
        DROP COLUMN IF EXISTS "quoteId";

    ALTER TABLE "seafood_order_weight_adjustments"
        DROP COLUMN IF EXISTS "originalWholeWeightUnit",
        DROP COLUMN IF EXISTS "originalWholeWeightLbs",
        DROP COLUMN IF EXISTS "fishCount",
        DROP COLUMN IF EXISTS "preparationChargeMethod";

    DROP TYPE IF EXISTS "PreparationChargeMethod";
END $$;

COMMIT;
