-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP3.1 GUARDED TRANSACTIONAL ROLLBACK
-- DEV / EMPTY CONTROLLED ENVIRONMENT ONLY - ABORTS ON NONEMPTY TABLES
-- ============================================================================

BEGIN;

DO $$
DECLARE
    v_challenge_count INTEGER := 0;
BEGIN
    -- 1. Acquire ACCESS EXCLUSIVE lock on WP3.1 table if it exists
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'customer_weight_approval_challenges'
    ) THEN
        EXECUTE 'LOCK TABLE "customer_weight_approval_challenges" IN ACCESS EXCLUSIVE MODE';
        SELECT count(*) INTO v_challenge_count FROM "customer_weight_approval_challenges";
    END IF;

    -- 2. Refuse rollback if operational records exist
    IF v_challenge_count > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED: customer_weight_approval_challenges table contains % operational records.', v_challenge_count;
    END IF;

    -- 3. Drop WP3.1 objects cleanly under RESTRICT semantics
    IF EXISTS (
        SELECT FROM pg_indexes
        WHERE schemaname = 'public'
        AND indexname = 'uq_open_challenge_per_rev'
    ) THEN
        EXECUTE 'DROP INDEX "uq_open_challenge_per_rev"';
    END IF;

    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'customer_weight_approval_challenges'
    ) THEN
        EXECUTE 'DROP TABLE "customer_weight_approval_challenges"';
    END IF;

    IF EXISTS (
        SELECT FROM pg_type
        WHERE typname = 'ApprovalChallengeStatus'
    ) THEN
        EXECUTE 'DROP TYPE "ApprovalChallengeStatus"';
    END IF;
END $$;

COMMIT;
