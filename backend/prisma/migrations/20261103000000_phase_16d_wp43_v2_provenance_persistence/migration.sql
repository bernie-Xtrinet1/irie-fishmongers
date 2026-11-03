-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP4.3B.4C V2 PROVENANCE & CONSENT PERSISTENCE
-- STRICTLY ADDITIVE SCHEMA MIGRATION WITH LOCK TIMEOUT SAFETY
-- ============================================================================

BEGIN;

-- 1. Enforce aggressive lock timeout to prevent head-of-line blocking
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- 2. Create PreparationChargeMethod Enum idempotently
DO $$ BEGIN
    CREATE TYPE "PreparationChargeMethod" AS ENUM (
        'FIXED_PER_FISH',
        'FIXED_PER_POUND',
        'NO_PREPARATION'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3. Add additive nullable columns on seafood_order_weight_adjustments
ALTER TABLE "seafood_order_weight_adjustments"
    ADD COLUMN IF NOT EXISTS "preparationChargeMethod" "PreparationChargeMethod",
    ADD COLUMN IF NOT EXISTS "fishCount" INTEGER,
    ADD COLUMN IF NOT EXISTS "originalWholeWeightLbs" DECIMAL(16, 8),
    ADD COLUMN IF NOT EXISTS "originalWholeWeightUnit" "WeightUnit";

-- 4. Add additive nullable quoteId and quotePayloadHash on customer_checkout_ceiling_consents
ALTER TABLE "customer_checkout_ceiling_consents"
    ADD COLUMN IF NOT EXISTS "quoteId" TEXT,
    ADD COLUMN IF NOT EXISTS "quotePayloadHash" TEXT;

-- 5. Fast lookup index for quote identity
CREATE INDEX IF NOT EXISTS "idx_ceiling_consents_quote_id" 
    ON "customer_checkout_ceiling_consents"("quoteId");

COMMIT;
