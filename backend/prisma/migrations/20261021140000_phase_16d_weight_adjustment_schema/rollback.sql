-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP2 GUARDED TRANSACTIONAL ROLLBACK
-- DEV / EMPTY CONTROLLED ENVIRONMENT ONLY - ABORTS ON NONEMPTY TABLES
-- ============================================================================

BEGIN;

DO $$
DECLARE
    v_adj_count INTEGER := 0;
    v_event_count INTEGER := 0;
    v_prep_count INTEGER := 0;
    v_consent_count INTEGER := 0;
    v_approval_count INTEGER := 0;
    v_obligation_count INTEGER := 0;
    v_settlement_count INTEGER := 0;
    v_total_records INTEGER := 0;
BEGIN
    -- 1. Acquire ACCESS EXCLUSIVE table locks in consistent dependency order to eliminate concurrent insert windows
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seafood_order_weight_adjustments') THEN
        EXECUTE 'LOCK TABLE "seafood_order_weight_adjustments" IN ACCESS EXCLUSIVE MODE';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_checkout_ceiling_consents') THEN
        EXECUTE 'LOCK TABLE "customer_checkout_ceiling_consents" IN ACCESS EXCLUSIVE MODE';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_weight_approval_records') THEN
        EXECUTE 'LOCK TABLE "customer_weight_approval_records" IN ACCESS EXCLUSIVE MODE';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seafood_weight_measurement_events') THEN
        EXECUTE 'LOCK TABLE "seafood_weight_measurement_events" IN ACCESS EXCLUSIVE MODE';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seafood_preparation_fulfillment_events') THEN
        EXECUTE 'LOCK TABLE "seafood_preparation_fulfillment_events" IN ACCESS EXCLUSIVE MODE';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weight_adjustment_obligations') THEN
        EXECUTE 'LOCK TABLE "weight_adjustment_obligations" IN ACCESS EXCLUSIVE MODE';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weight_adjustment_settlement_records') THEN
        EXECUTE 'LOCK TABLE "weight_adjustment_settlement_records" IN ACCESS EXCLUSIVE MODE';
    END IF;

    -- 2. Verify record counts while holding ACCESS EXCLUSIVE locks
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seafood_order_weight_adjustments') THEN
        SELECT count(*) INTO v_adj_count FROM "seafood_order_weight_adjustments";
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seafood_weight_measurement_events') THEN
        SELECT count(*) INTO v_event_count FROM "seafood_weight_measurement_events";
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seafood_preparation_fulfillment_events') THEN
        SELECT count(*) INTO v_prep_count FROM "seafood_preparation_fulfillment_events";
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_checkout_ceiling_consents') THEN
        SELECT count(*) INTO v_consent_count FROM "customer_checkout_ceiling_consents";
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_weight_approval_records') THEN
        SELECT count(*) INTO v_approval_count FROM "customer_weight_approval_records";
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weight_adjustment_obligations') THEN
        SELECT count(*) INTO v_obligation_count FROM "weight_adjustment_obligations";
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weight_adjustment_settlement_records') THEN
        SELECT count(*) INTO v_settlement_count FROM "weight_adjustment_settlement_records";
    END IF;

    v_total_records := v_adj_count + v_event_count + v_prep_count + v_consent_count + v_approval_count + v_obligation_count + v_settlement_count;

    -- 3. Explicitly abort if ANY data exists across any Phase 16D table
    IF v_total_records > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED: Phase 16D tables contain % live records (adj=%, meas=%, prep=%, consent=%, app=%, ob=%, settle=%). Destructive drop prohibited; perform audited data retention migration.',
            v_total_records, v_adj_count, v_event_count, v_prep_count, v_consent_count, v_approval_count, v_obligation_count, v_settlement_count;
    END IF;
END $$;

-- 4. Execute drops in strict reverse foreign-key dependency order (NO CASCADE)
DROP TABLE IF EXISTS "weight_adjustment_settlement_records";
DROP TABLE IF EXISTS "weight_adjustment_obligations";
DROP TABLE IF EXISTS "customer_weight_approval_records";
DROP TABLE IF EXISTS "customer_checkout_ceiling_consents";
DROP TABLE IF EXISTS "seafood_preparation_fulfillment_events";
DROP TABLE IF EXISTS "seafood_weight_measurement_events";
DROP TABLE IF EXISTS "seafood_order_weight_adjustments";

-- 5. Drop enum types
DROP TYPE IF EXISTS "PreparationFeeStructure";
DROP TYPE IF EXISTS "UsablePartsFulfillmentOutcome";
DROP TYPE IF EXISTS "UsablePartsPreference";
DROP TYPE IF EXISTS "SettlementChannel";
DROP TYPE IF EXISTS "ObligationStatus";
DROP TYPE IF EXISTS "PaymentObligationDirection";
DROP TYPE IF EXISTS "CustomerApprovalAction";
DROP TYPE IF EXISTS "CustomerWeightApprovalStatus";
DROP TYPE IF EXISTS "WeightMeasurementStatus";
DROP TYPE IF EXISTS "SeafoodPricingBasis";

COMMIT;
