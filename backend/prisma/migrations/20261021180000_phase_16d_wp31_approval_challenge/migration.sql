-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP3.1 ADDITIVE APPROVAL CHALLENGE SCHEMA
-- ============================================================================

-- 1. Create ApprovalChallengeStatus Enum
DO $$ BEGIN
    CREATE TYPE "ApprovalChallengeStatus" AS ENUM ('OPEN', 'CONSUMED', 'REVOKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. Create customer_weight_approval_challenges Table
CREATE TABLE IF NOT EXISTS "customer_weight_approval_challenges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weightAdjustmentId" TEXT NOT NULL,
    "measurementRevision" INTEGER NOT NULL,
    "challengeSequence" INTEGER NOT NULL DEFAULT 1,
    "authenticatedCustomerId" TEXT NOT NULL,
    "proposedTotalJmd" DECIMAL(10, 2) NOT NULL,
    "authorizedCeilingJmd" DECIMAL(10, 2) NOT NULL,
    "differenceAmountJmd" DECIMAL(10, 2) NOT NULL,
    "approvalTokenHash" TEXT NOT NULL UNIQUE,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "ApprovalChallengeStatus" NOT NULL DEFAULT 'OPEN',
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fk_challenge_weight_adjustment" FOREIGN KEY ("weightAdjustmentId") REFERENCES "seafood_order_weight_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_challenge_customer" FOREIGN KEY ("authenticatedCustomerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 3. Unique & Index Constraints
CREATE UNIQUE INDEX IF NOT EXISTS "uq_challenge_adj_rev_seq" ON "customer_weight_approval_challenges"("weightAdjustmentId", "measurementRevision", "challengeSequence");
CREATE INDEX IF NOT EXISTS "idx_challenge_adj_rev_status" ON "customer_weight_approval_challenges"("weightAdjustmentId", "measurementRevision", "status");
CREATE INDEX IF NOT EXISTS "idx_challenge_status_expiry" ON "customer_weight_approval_challenges"("status", "expiresAt");

-- 4. Database-level partial unique index: guarantees at most ONE 'OPEN' challenge per adjustment revision
CREATE UNIQUE INDEX IF NOT EXISTS "uq_open_challenge_per_rev" ON "customer_weight_approval_challenges"("weightAdjustmentId", "measurementRevision") WHERE "status" = 'OPEN';
