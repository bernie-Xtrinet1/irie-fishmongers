-- WP4.3B.4F.7D.4B.6M-R1: Migration #68 — Coordinated Product-Suspect Recovery Foundation
-- Additive audit ledger + coordinated evolution of ProductReservationRestriction
-- Preserves all existing 67 migrations, existing RESTRICTED (PREPARED/ENFORCED) rows,
-- and never auto-clears or auto-authorizes any restricted product.

-- 1. Drop legacy triggers and constraints on restriction tables before enum replacement
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT t.tgname, c.relname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND NOT t.tgisinternal
          AND c.relname IN ('reservation_product_restrictions', 'reservation_product_restriction_installations')
    LOOP
        EXECUTE format('DROP TRIGGER %I ON %I', r.tgname, r.relname);
    END LOOP;

    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = 'reservation_product_restrictions'
          AND con.contype = 'c'
    LOOP
        EXECUTE format('ALTER TABLE "reservation_product_restrictions" DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE "reservation_product_restrictions" DROP CONSTRAINT IF EXISTS "reservation_product_restrictions_productId_key";
DROP INDEX IF EXISTS "reservation_product_restrictions_productId_key";

-- 2. Safely recreate ProductReservationRestrictionState enum (avoid PostgreSQL 55P04)
ALTER TABLE "reservation_product_restrictions" ALTER COLUMN "state" DROP DEFAULT;
ALTER TYPE "ProductReservationRestrictionState" RENAME TO "ProductReservationRestrictionState_old";
CREATE TYPE "ProductReservationRestrictionState" AS ENUM ('PREPARED', 'ENFORCED', 'CLEARING', 'CLEARED');
ALTER TABLE "reservation_product_restrictions"
    ALTER COLUMN "state" TYPE "ProductReservationRestrictionState"
    USING ("state"::text::"ProductReservationRestrictionState");
ALTER TABLE "reservation_product_restrictions"
    ALTER COLUMN "state" SET DEFAULT 'PREPARED'::"ProductReservationRestrictionState";
DROP TYPE "ProductReservationRestrictionState_old";

-- 3. Evolve reservation_product_restrictions columns, active uniqueness, and monotonic odd revisions
ALTER TABLE "reservation_product_restrictions"
    ADD COLUMN "clearedAt" TIMESTAMPTZ(3),
    ADD COLUMN "clearedByRecoveryId" UUID;

CREATE UNIQUE INDEX "reservation_product_restrictions_active_productId_key"
    ON "reservation_product_restrictions"("productId")
    WHERE "state" IN ('PREPARED', 'ENFORCED', 'CLEARING');

CREATE UNIQUE INDEX "reservation_product_restrictions_productId_restrictionRevision_key"
    ON "reservation_product_restrictions"("productId", "restrictionRevision");

CREATE UNIQUE INDEX "reservation_product_restrictions_id_productId_restrictionRevision_key"
    ON "reservation_product_restrictions"("id", "productId", "restrictionRevision");

CREATE INDEX "reservation_product_restrictions_productId_state_idx"
    ON "reservation_product_restrictions"("productId", "state");

ALTER TABLE "reservation_product_restrictions"
    ADD CONSTRAINT "reservation_product_restrictions_odd_revision_chk"
        CHECK ("restrictionRevision" >= 1 AND ("restrictionRevision" % 2) = 1),
    ADD CONSTRAINT "reservation_product_restrictions_state_clearance_chk"
        CHECK (
            ("state" IN ('PREPARED', 'ENFORCED') AND "clearedAt" IS NULL AND "clearedByRecoveryId" IS NULL)
            OR ("state" = 'CLEARING' AND "clearedAt" IS NULL AND "clearedByRecoveryId" IS NOT NULL)
            OR ("state" = 'CLEARED' AND "clearedAt" IS NOT NULL AND "clearedByRecoveryId" IS NOT NULL)
        );

-- 4. Create ProductSuspectRecovery enums & audit ledger
CREATE TYPE "ProductSuspectRecoveryStatus" AS ENUM (
    'REQUESTED',
    'APPROVED',
    'EXECUTING',
    'AMBIGUOUS_QUARANTINED',
    'COMPLETED',
    'ABORTED',
    'EXPIRED',
    'REJECTED'
);

CREATE TYPE "ProductSuspectExecutionEvidence" AS ENUM (
    'APPLIED',
    'NOT_APPLIED',
    'UNKNOWN',
    'AMBIGUOUS'
);

CREATE TYPE "ProductSuspectRecoveryTargetKind" AS ENUM (
    'COMPENSATION',
    'SYNC_STATE'
);

CREATE TABLE "product_suspect_recoveries" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "productId" TEXT NOT NULL,
    "restrictionId" UUID,
    "targetRestrictionRevision" INTEGER NOT NULL DEFAULT 0,
    "clearedControlRevision" INTEGER NOT NULL,
    "status" "ProductSuspectRecoveryStatus" NOT NULL DEFAULT 'REQUESTED',
    "modeRevision" INTEGER NOT NULL,
    "fenceTransitionId" UUID NOT NULL,
    "incarnation" UUID NOT NULL,
    "fenceEpoch" INTEGER NOT NULL,
    "fenceRevision" INTEGER NOT NULL,
    "authorizationPhase" "ReservationFencePhase" NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestReason" VARCHAR(256) NOT NULL,
    "observationDigest" CHAR(64) NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "approvalExpiresAt" TIMESTAMPTZ(3),
    "approvalDigest" CHAR(64),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectionReason" VARCHAR(256),
    "reconciliationSnapshot" JSONB NOT NULL,
    "reconciliationDigest" CHAR(64) NOT NULL,
    "priorStoredTotal" INTEGER,
    "targetReconciledTotal" INTEGER NOT NULL,
    "priorSuspectPresent" BOOLEAN NOT NULL,
    "affectedMarkerCount" INTEGER NOT NULL DEFAULT 0,
    "affectedCompensationCount" INTEGER NOT NULL DEFAULT 0,
    "permitTtlMs" INTEGER NOT NULL DEFAULT 5000,
    "stagedControlRevision" INTEGER,
    "executingAt" TIMESTAMPTZ(3),
    "executionEvidence" "ProductSuspectExecutionEvidence",
    "evidenceEvaluatedAt" TIMESTAMPTZ(3),
    "evidenceDetail" JSONB,
    "quarantinedAt" TIMESTAMPTZ(3),
    "quarantineReason" VARCHAR(128),
    "redisReceipt" TEXT,
    "redisReceiptHash" CHAR(64),
    "failureCode" VARCHAR(64),
    "failureDetail" VARCHAR(500),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_suspect_recoveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_suspect_recoveries_requestId_key"
    ON "product_suspect_recoveries"("requestId");

CREATE UNIQUE INDEX "product_suspect_recoveries_id_productId_key"
    ON "product_suspect_recoveries"("id", "productId");

CREATE UNIQUE INDEX "product_suspect_recoveries_active_productId_key"
    ON "product_suspect_recoveries"("productId")
    WHERE "status" IN ('REQUESTED', 'APPROVED', 'EXECUTING', 'AMBIGUOUS_QUARANTINED');

CREATE INDEX "product_suspect_recoveries_product_status_idx"
    ON "product_suspect_recoveries"("productId", "status");

CREATE INDEX "product_suspect_recoveries_status_createdAt_idx"
    ON "product_suspect_recoveries"("status", "createdAt");

ALTER TABLE "product_suspect_recoveries"
    ADD CONSTRAINT "product_suspect_recoveries_revisions_chk" CHECK (
        "targetRestrictionRevision" >= 0
        AND "clearedControlRevision" >= 2
        AND ("clearedControlRevision" % 2) = 0
        AND "clearedControlRevision" > "targetRestrictionRevision"
        AND (
            ("restrictionId" IS NULL AND "targetRestrictionRevision" = 0)
            OR ("restrictionId" IS NOT NULL AND "targetRestrictionRevision" >= 1 AND ("targetRestrictionRevision" % 2) = 1)
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_fence_phase_chk" CHECK (
        "authorizationPhase" IN ('OPEN', 'DRAINING')
        AND "modeRevision" >= 1
        AND "fenceEpoch" >= 1
        AND "fenceRevision" >= 1
        AND "permitTtlMs" BETWEEN 1 AND 5000
    ),
    ADD CONSTRAINT "product_suspect_recoveries_counters_chk" CHECK (
        ("priorStoredTotal" IS NULL OR "priorStoredTotal" >= 0)
        AND "targetReconciledTotal" >= 0
        AND "affectedMarkerCount" >= 0
        AND "affectedCompensationCount" >= 0
    ),
    ADD CONSTRAINT "product_suspect_recoveries_digests_chk" CHECK (
        "observationDigest" ~ '^[0-9a-f]{64}$'
        AND "reconciliationDigest" ~ '^[0-9a-f]{64}$'
        AND ("approvalDigest" IS NULL OR "approvalDigest" ~ '^[0-9a-f]{64}$')
        AND ("redisReceiptHash" IS NULL OR "redisReceiptHash" ~ '^[0-9a-f]{64}$')
    ),
    ADD CONSTRAINT "product_suspect_recoveries_dual_control_chk" CHECK (
        ("approvedById" IS NULL OR "approvedById" <> "requestedById")
        AND ("approvedById" IS NULL) = ("approvedAt" IS NULL)
        AND ("approvedById" IS NULL) = ("approvalExpiresAt" IS NULL)
        AND ("approvedById" IS NULL) = ("approvalDigest" IS NULL)
        AND ("approvedAt" IS NULL OR "approvalExpiresAt" > "approvedAt")
    ),
    ADD CONSTRAINT "product_suspect_recoveries_approval_required_chk" CHECK (
        "status" NOT IN ('APPROVED', 'EXECUTING', 'COMPLETED', 'AMBIGUOUS_QUARANTINED')
        OR (
            "approvedById" IS NOT NULL
            AND "approvedAt" IS NOT NULL
            AND "approvalExpiresAt" IS NOT NULL
            AND "approvalDigest" IS NOT NULL
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_executing_chk" CHECK (
        "status" <> 'EXECUTING'
        OR (
            "executingAt" IS NOT NULL
            AND "completedAt" IS NULL
            AND "quarantinedAt" IS NULL
            AND "redisReceipt" IS NULL
            AND "redisReceiptHash" IS NULL
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_completed_chk" CHECK (
        "status" <> 'COMPLETED'
        OR (
            "executingAt" IS NOT NULL
            AND "executionEvidence" = 'APPLIED'
            AND "evidenceEvaluatedAt" IS NOT NULL
            AND "redisReceipt" IS NOT NULL
            AND "redisReceiptHash" IS NOT NULL
            AND "completedAt" IS NOT NULL
            AND "quarantinedAt" IS NULL
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_quarantine_chk" CHECK (
        "status" <> 'AMBIGUOUS_QUARANTINED'
        OR (
            "executingAt" IS NOT NULL
            AND "executionEvidence" IN ('UNKNOWN', 'AMBIGUOUS')
            AND "evidenceEvaluatedAt" IS NOT NULL
            AND "quarantinedAt" IS NOT NULL
            AND "quarantineReason" IS NOT NULL
            AND "completedAt" IS NULL
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_rejected_chk" CHECK (
        "status" <> 'REJECTED'
        OR (
            "approvedById" IS NULL
            AND "rejectedById" IS NOT NULL
            AND "rejectedAt" IS NOT NULL
            AND "executingAt" IS NULL
            AND "completedAt" IS NULL
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_aborted_chk" CHECK (
        "status" <> 'ABORTED'
        OR (
            "completedAt" IS NULL
            AND "quarantinedAt" IS NULL
            AND "failureCode" IS NOT NULL
            AND ("executionEvidence" IS NULL OR "executionEvidence" = 'NOT_APPLIED')
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_staged_revision_chk" CHECK (
        "stagedControlRevision" IS NULL
        OR (
            "stagedControlRevision" >= 1
            AND "stagedControlRevision" < "clearedControlRevision"
            AND "stagedControlRevision" >= "targetRestrictionRevision"
        )
    ),
    ADD CONSTRAINT "product_suspect_recoveries_product_fkey"
        FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "product_suspect_recoveries_restriction_fkey"
        FOREIGN KEY ("restrictionId", "productId", "targetRestrictionRevision")
        REFERENCES "reservation_product_restrictions"("id", "productId", "restrictionRevision")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "product_suspect_recoveries_fence_fkey"
        FOREIGN KEY ("fenceTransitionId", "incarnation", "fenceEpoch")
        REFERENCES "reservation_fence_transitions"("id", "incarnation", "epoch")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "product_suspect_recoveries_requester_fkey"
        FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "product_suspect_recoveries_approver_fkey"
        FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "product_suspect_recoveries_rejector_fkey"
        FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "reservation_product_restrictions"
    ADD CONSTRAINT "reservation_product_restrictions_clearedByRecoveryId_fkey"
        FOREIGN KEY ("clearedByRecoveryId") REFERENCES "product_suspect_recoveries"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 5. Target manifest & attribution foreign keys
CREATE TABLE "product_suspect_recovery_targets" (
    "id" UUID NOT NULL,
    "recoveryId" UUID NOT NULL,
    "productId" TEXT NOT NULL,
    "targetKind" "ProductSuspectRecoveryTargetKind" NOT NULL,
    "compensationId" TEXT,
    "syncStateId" TEXT,
    "expectedGeneration" INTEGER NOT NULL,
    "priorStatus" TEXT NOT NULL,
    "priorBlockReason" TEXT NOT NULL,
    "unblockedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_suspect_recovery_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_suspect_recovery_targets_recoveryId_compensationId_key"
    ON "product_suspect_recovery_targets"("recoveryId", "compensationId");

CREATE UNIQUE INDEX "product_suspect_recovery_targets_recoveryId_syncStateId_key"
    ON "product_suspect_recovery_targets"("recoveryId", "syncStateId");

CREATE INDEX "product_suspect_recovery_targets_product_recovery_idx"
    ON "product_suspect_recovery_targets"("productId", "recoveryId");

ALTER TABLE "product_suspect_recovery_targets"
    ADD CONSTRAINT "product_suspect_recovery_targets_shape_chk" CHECK (
        (
            ("targetKind" = 'COMPENSATION' AND "compensationId" IS NOT NULL AND "syncStateId" IS NULL)
            OR ("targetKind" = 'SYNC_STATE' AND "syncStateId" IS NOT NULL AND "compensationId" IS NULL)
        )
        AND "expectedGeneration" >= 0
        AND "priorStatus" = 'BLOCKED'
        AND "priorBlockReason" = 'PRODUCT_SUSPECT'
    ),
    ADD CONSTRAINT "product_suspect_recovery_targets_recovery_fkey"
        FOREIGN KEY ("recoveryId", "productId")
        REFERENCES "product_suspect_recoveries"("id", "productId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "product_suspect_recovery_targets_compensation_fkey"
        FOREIGN KEY ("compensationId") REFERENCES "cart_reservation_compensations"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "product_suspect_recovery_targets_sync_state_fkey"
        FOREIGN KEY ("syncStateId") REFERENCES "cart_reservation_sync_states"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 6. Guard functions & triggers (strictly preserving W3-P, W1, and Cutover Freshness safety)
CREATE OR REPLACE FUNCTION "product_restriction_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
    v_max_rev INTEGER;
    v_max_cleared INTEGER;
    v_floor INTEGER;
    v_expected_rev INTEGER;
    v_rec "product_suspect_recoveries"%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'product reservation restriction cannot be deleted' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'PREPARED'
            OR NEW."firstEnforcedAt" IS NOT NULL
            OR NEW."clearedAt" IS NOT NULL
            OR NEW."clearedByRecoveryId" IS NOT NULL
            OR NEW."physicalProtocolVersion" <> 1
            OR NEW."observationDigest" !~ '^[0-9a-f]{64}$' THEN
            RAISE EXCEPTION 'invalid initial product reservation restriction state' USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(MAX("restrictionRevision"), 0)
        INTO v_max_rev
        FROM "reservation_product_restrictions"
        WHERE "productId" = NEW."productId";

        SELECT COALESCE(MAX("clearedControlRevision"), 0)
        INTO v_max_cleared
        FROM "product_suspect_recoveries"
        WHERE "productId" = NEW."productId" AND "status" = 'COMPLETED';

        v_floor := GREATEST(v_max_rev, v_max_cleared);
        v_expected_rev := CASE WHEN (v_floor % 2) = 0 THEN v_floor + 1 ELSE v_floor + 2 END;

        IF NEW."restrictionRevision" IS DISTINCT FROM v_expected_rev THEN
            RAISE EXCEPTION 'monotonic odd restrictionRevision % required (got %)', v_expected_rev, NEW."restrictionRevision"
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    -- TG_OP = 'UPDATE'
    IF (to_jsonb(NEW) - ARRAY['state', 'firstEnforcedAt', 'clearedAt', 'clearedByRecoveryId'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state', 'firstEnforcedAt', 'clearedAt', 'clearedByRecoveryId']) THEN
        RAISE EXCEPTION 'immutable product reservation restriction identity cannot be modified' USING ERRCODE = '23514';
    END IF;

    IF OLD."state" = 'CLEARED' THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'cleared product reservation restriction is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."state" = 'PREPARED' AND NEW."state" = 'ENFORCED' THEN
        IF NEW."firstEnforcedAt" IS NULL OR NEW."clearedAt" IS NOT NULL OR NEW."clearedByRecoveryId" IS NOT NULL THEN
            RAISE EXCEPTION 'ENFORCED restriction requires firstEnforcedAt and no clearance attribution' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM "reservation_product_restriction_installations" WHERE "restrictionId" = OLD."id"
        ) THEN
            RAISE EXCEPTION 'ENFORCED restriction requires confirmed Redis installation' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."state" IN ('CLEARING', 'CLEARED') THEN
        IF NEW."firstEnforcedAt" IS DISTINCT FROM OLD."firstEnforcedAt" THEN
            RAISE EXCEPTION 'firstEnforcedAt cannot change during recovery clearance' USING ERRCODE = '23514';
        END IF;
        IF NEW."clearedByRecoveryId" IS NULL THEN
            RAISE EXCEPTION 'CLEARING/CLEARED restriction requires clearedByRecoveryId' USING ERRCODE = '23514';
        END IF;
        IF OLD."clearedByRecoveryId" IS NOT NULL AND NEW."clearedByRecoveryId" IS DISTINCT FROM OLD."clearedByRecoveryId" THEN
            RAISE EXCEPTION 'clearedByRecoveryId cannot be reassigned' USING ERRCODE = '23514';
        END IF;

        SELECT * INTO v_rec FROM "product_suspect_recoveries" WHERE "id" = NEW."clearedByRecoveryId";
        IF v_rec."id" IS NULL
            OR v_rec."productId" IS DISTINCT FROM OLD."productId"
            OR v_rec."restrictionId" IS DISTINCT FROM OLD."id"
            OR v_rec."targetRestrictionRevision" IS DISTINCT FROM OLD."restrictionRevision" THEN
            RAISE EXCEPTION 'recovery audit record does not match restriction identity' USING ERRCODE = '23514';
        END IF;

        IF NEW."state" = 'CLEARING' THEN
            IF OLD."state" NOT IN ('PREPARED', 'ENFORCED')
                OR v_rec."status" <> 'EXECUTING'
                OR NEW."clearedAt" IS NOT NULL THEN
                RAISE EXCEPTION 'CLEARING restriction requires EXECUTING recovery and null clearedAt' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END IF;

        -- NEW."state" = 'CLEARED'
        IF v_rec."status" <> 'COMPLETED'
            OR v_rec."executionEvidence" <> 'APPLIED'
            OR v_rec."redisReceiptHash" IS NULL
            OR v_rec."completedAt" IS NULL
            OR NEW."clearedAt" IS NULL THEN
            RAISE EXCEPTION 'CLEARED restriction requires COMPLETED APPLIED recovery with verified receipt' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'illegal product reservation restriction transition from % to %', OLD."state", NEW."state" USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION "zz_product_restriction_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
    RAISE EXCEPTION 'product reservation restriction cannot be truncated' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "product_restriction_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "reservation_product_restrictions"
    FOR EACH ROW EXECUTE FUNCTION "product_restriction_guard"();

CREATE TRIGGER "zz_product_restriction_truncate_guard"
    BEFORE TRUNCATE ON "reservation_product_restrictions"
    FOR EACH STATEMENT EXECUTE FUNCTION "zz_product_restriction_truncate_guard"();

CREATE OR REPLACE FUNCTION "product_restriction_installation_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
    v_restriction "reservation_product_restrictions"%ROWTYPE;
    v_expected TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION 'product restriction installation evidence is append-only' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_restriction
    FROM "reservation_product_restrictions"
    WHERE "id" = NEW."restrictionId";

    IF v_restriction."id" IS NULL OR v_restriction."state" NOT IN ('PREPARED', 'ENFORCED') THEN
        RAISE EXCEPTION 'active PREPARED or ENFORCED restriction required for installation' USING ERRCODE = '23514';
    END IF;

    IF NEW."protocolVersion" <> v_restriction."physicalProtocolVersion" THEN
        RAISE EXCEPTION 'matching protocolVersion required' USING ERRCODE = '23514';
    END IF;

    v_expected := format(
        '{"version":1,"productId":%s,"state":"RESTRICTED","restrictionId":%s,"restrictionRevision":%s,"incarnation":%s,"epoch":%s}',
        to_json(v_restriction."productId")::text,
        to_json(v_restriction."id"::text)::text,
        v_restriction."restrictionRevision"::text,
        to_json(NEW."incarnation"::text)::text,
        NEW."epoch"::text
    );

    IF NEW."acknowledgement" IS DISTINCT FROM v_expected
        OR NEW."acknowledgementHash" IS DISTINCT FROM encode(sha256(convert_to(v_expected, 'UTF8')), 'hex') THEN
        RAISE EXCEPTION 'canonical restriction installation acknowledgement and SHA-256 required' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "zz_product_restriction_installation_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
    RAISE EXCEPTION 'product restriction installation evidence cannot be truncated' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "product_restriction_installation_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "reservation_product_restriction_installations"
    FOR EACH ROW EXECUTE FUNCTION "product_restriction_installation_guard"();

CREATE TRIGGER "zz_product_restriction_installation_truncate_guard"
    BEFORE TRUNCATE ON "reservation_product_restriction_installations"
    FOR EACH STATEMENT EXECUTE FUNCTION "zz_product_restriction_installation_truncate_guard"();

CREATE OR REPLACE FUNCTION "product_restriction_w1_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
    v_marker "cart_reservation_sync_states"%ROWTYPE;
    v_blocked BOOLEAN;
BEGIN
    IF NEW."effect" <> 'W1' THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_marker FROM "cart_reservation_sync_states" WHERE "id" = NEW."markerId";
    IF v_marker."id" IS NULL THEN
        RETURN NEW;
    END IF;

    v_blocked := EXISTS (
        SELECT 1 FROM "reservation_product_restrictions" r
        WHERE r."productId" = v_marker."productId"
          AND r."state" IN ('PREPARED', 'ENFORCED', 'CLEARING')
    ) OR EXISTS (
        SELECT 1 FROM "product_suspect_recoveries" rec
        WHERE rec."productId" = v_marker."productId"
          AND rec."status" IN ('REQUESTED', 'APPROVED', 'EXECUTING', 'AMBIGUOUS_QUARANTINED')
    );

    IF NOT v_blocked THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'restricted or quarantined product cannot admit W1 command' USING ERRCODE = '23514';
    END IF;

    -- Allow pure W1 cancellation/revocation transitions while denying any attempt/dispatch/promotion
    IF NEW."state" IN ('REVOCATION_PENDING', 'CANCELLED')
        AND NEW."attemptCount" = OLD."attemptCount"
        AND NEW."lastDispatchTransitionId" IS NOT DISTINCT FROM OLD."lastDispatchTransitionId"
        AND NEW."completionReceiptHash" IS NOT DISTINCT FROM OLD."completionReceiptHash" THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'restricted or quarantined product blocks W1 execution and dispatch' USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION "cutover_freshness_reset_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
    v_barrier "cart_mutation_barrier_configs"%ROWTYPE;
    v_latest_barrier_rev INTEGER;
    v_mode "reservation_engine_mode_configs"%ROWTYPE;
    v_fence "reservation_fence_transitions"%ROWTYPE;
    v_latest_fence_rev INTEGER;
    v_marker "cart_reservation_sync_states"%ROWTYPE;
    v_cart_item "cart_items"%ROWTYPE;
    v_receipt JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'cutover freshness audit history cannot be deleted' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'PREPARED'
            OR NEW."completedAt" IS NOT NULL
            OR NEW."failureCode" IS NOT NULL
            OR NEW."failureDetail" IS NOT NULL
            OR NEW."redisReceipt" IS NOT NULL
            OR NEW."redisReceiptHash" IS NOT NULL
            OR NEW."newCreatedAtMs" IS NOT NULL
            OR NEW."newLastRenewedAtMs" IS NOT NULL
            OR NEW."newExpiresAtMs" IS NOT NULL
            OR NEW."newAbsoluteExpiresAtMs" IS NOT NULL THEN
            RAISE EXCEPTION 'cutover freshness audit record must start in PREPARED state with no outcome evidence' USING ERRCODE = '23514';
        END IF;

        SELECT MAX("revision") INTO v_latest_barrier_rev FROM "cart_mutation_barrier_configs";
        SELECT * INTO v_barrier FROM "cart_mutation_barrier_configs" WHERE "revision" = NEW."barrierRevision";
        IF v_barrier."id" IS NULL OR NOT v_barrier."active" OR v_latest_barrier_rev IS DISTINCT FROM NEW."barrierRevision" THEN
            RAISE EXCEPTION 'active latest cart mutation barrier revision required for PREPARED freshness authorization' USING ERRCODE = '23514';
        END IF;

        SELECT * INTO v_mode FROM "reservation_engine_mode_configs" ORDER BY "revision" DESC LIMIT 1;
        IF v_mode."id" IS NULL OR v_mode."revision" IS DISTINCT FROM NEW."modeRevision" OR v_mode."mode" <> 'MIRROR' THEN
            RAISE EXCEPTION 'latest MIRROR mode revision required for PREPARED freshness authorization' USING ERRCODE = '23514';
        END IF;

        SELECT MAX("revision") INTO v_latest_fence_rev FROM "reservation_fence_transitions";
        SELECT * INTO v_fence FROM "reservation_fence_transitions" WHERE "id" = NEW."fenceTransitionId";
        IF v_fence."id" IS NULL
            OR v_latest_fence_rev IS DISTINCT FROM NEW."fenceRevision"
            OR v_fence."revision" IS DISTINCT FROM NEW."fenceRevision"
            OR v_fence."status" <> 'ACKNOWLEDGED'
            OR v_fence."phase" <> 'OPEN'
            OR v_fence."mode" <> 'MIRROR'
            OR v_fence."modeRevision" IS DISTINCT FROM NEW."modeRevision"
            OR v_fence."incarnation" IS DISTINCT FROM NEW."incarnation"
            OR v_fence."epoch" IS DISTINCT FROM NEW."fenceEpoch" THEN
            RAISE EXCEPTION 'latest ACKNOWLEDGED MIRROR/OPEN fence authority required for PREPARED freshness authorization' USING ERRCODE = '23514';
        END IF;

        SELECT * INTO v_marker FROM "cart_reservation_sync_states" WHERE "id" = NEW."markerId";
        IF v_marker."id" IS NULL
            OR v_marker."cartId" IS DISTINCT FROM NEW."cartId"
            OR v_marker."productId" IS DISTINCT FROM NEW."productId"
            OR v_marker."generation" IS DISTINCT FROM NEW."generation"
            OR v_marker."expectedQuantity" IS DISTINCT FROM NEW."quantity"
            OR v_marker."resolvedAt" IS NULL THEN
            RAISE EXCEPTION 'resolved CartReservationSyncState matching generation and quantity required' USING ERRCODE = '23514';
        END IF;

        SELECT * INTO v_cart_item FROM "cart_items" WHERE "cartId" = NEW."cartId" AND "productId" = NEW."productId";
        IF v_cart_item."id" IS NULL OR v_cart_item."quantity" IS DISTINCT FROM NEW."quantity" OR v_cart_item."quantity" <= 0 THEN
            RAISE EXCEPTION 'matching positive CartItem quantity required for PREPARED freshness authorization' USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1 FROM "reservation_product_restrictions"
            WHERE "productId" = NEW."productId" AND "state" IN ('PREPARED', 'ENFORCED', 'CLEARING')
        ) OR EXISTS (
            SELECT 1 FROM "product_suspect_recoveries"
            WHERE "productId" = NEW."productId"
              AND "status" IN ('REQUESTED', 'APPROVED', 'EXECUTING', 'AMBIGUOUS_QUARANTINED')
        ) THEN
            RAISE EXCEPTION 'restricted or quarantined product cannot be authorized for freshness reset' USING ERRCODE = '23514';
        END IF;

        NEW."createdAt" := CURRENT_TIMESTAMP;
        NEW."updatedAt" := NEW."createdAt";
        RETURN NEW;
    END IF;

    IF OLD."status" IN ('COMPLETED', 'ABORTED') THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal cutover freshness audit record is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."status" NOT IN ('COMPLETED', 'ABORTED') THEN
        RAISE EXCEPTION 'PREPARED cutover freshness audit record may only transition to COMPLETED or ABORTED' USING ERRCODE = '23514';
    END IF;

    IF (to_jsonb(NEW) - ARRAY[
        'status', 'priorCreatedAtMs', 'priorLastRenewedAtMs', 'priorExpiresAtMs', 'priorAbsoluteExpiresAtMs',
        'newCreatedAtMs', 'newLastRenewedAtMs', 'newExpiresAtMs', 'newAbsoluteExpiresAtMs',
        'redisReceipt', 'redisReceiptHash', 'failureCode', 'failureDetail', 'completedAt', 'updatedAt'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'status', 'priorCreatedAtMs', 'priorLastRenewedAtMs', 'priorExpiresAtMs', 'priorAbsoluteExpiresAtMs',
        'newCreatedAtMs', 'newLastRenewedAtMs', 'newExpiresAtMs', 'newAbsoluteExpiresAtMs',
        'redisReceipt', 'redisReceiptHash', 'failureCode', 'failureDetail', 'completedAt', 'updatedAt'
    ]) THEN
        RAISE EXCEPTION 'immutable cutover freshness request and reservation identity cannot be modified' USING ERRCODE = '23514';
    END IF;

    IF OLD."priorCreatedAtMs" IS NOT NULL AND (
        NEW."priorCreatedAtMs" IS DISTINCT FROM OLD."priorCreatedAtMs"
        OR NEW."priorLastRenewedAtMs" IS DISTINCT FROM OLD."priorLastRenewedAtMs"
        OR NEW."priorExpiresAtMs" IS DISTINCT FROM OLD."priorExpiresAtMs"
        OR NEW."priorAbsoluteExpiresAtMs" IS DISTINCT FROM OLD."priorAbsoluteExpiresAtMs"
    ) THEN
        RAISE EXCEPTION 'immutable prior lease snapshot cannot be modified' USING ERRCODE = '23514';
    END IF;

    IF NEW."status" = 'COMPLETED' THEN
        IF NEW."redisReceipt" IS NULL
            OR NEW."redisReceiptHash" IS NULL
            OR NEW."redisReceiptHash" <> encode(sha256(convert_to(NEW."redisReceipt", 'UTF8')), 'hex') THEN
            RAISE EXCEPTION 'COMPLETED freshness audit record requires matching SHA-256 redisReceiptHash' USING ERRCODE = '23514';
        END IF;
        BEGIN
            v_receipt := NEW."redisReceipt"::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'COMPLETED redisReceipt must be valid JSON' USING ERRCODE = '23514';
        END;
        IF jsonb_typeof(v_receipt) <> 'object' OR (v_receipt ->> 'requestId') IS DISTINCT FROM NEW."requestId"::text THEN
            RAISE EXCEPTION 'COMPLETED redisReceipt JSON must bind exact requestId' USING ERRCODE = '23514';
        END IF;
    END IF;

    NEW."completedAt" := GREATEST(CURRENT_TIMESTAMP, OLD."createdAt");
    NEW."updatedAt" := NEW."completedAt";
    RETURN NEW;
END $$;

CREATE FUNCTION "product_suspect_recovery_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
    v_fence "reservation_fence_transitions"%ROWTYPE;
    v_restriction "reservation_product_restrictions"%ROWTYPE;
    v_max_rev INTEGER;
    v_max_cleared INTEGER;
    v_floor INTEGER;
    v_expected_cleared INTEGER;
    v_receipt JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'product suspect recovery audit history cannot be deleted' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'REQUESTED'
            OR NEW."approvedById" IS NOT NULL
            OR NEW."approvedAt" IS NOT NULL
            OR NEW."approvalExpiresAt" IS NOT NULL
            OR NEW."approvalDigest" IS NOT NULL
            OR NEW."rejectedById" IS NOT NULL
            OR NEW."rejectedAt" IS NOT NULL
            OR NEW."executingAt" IS NOT NULL
            OR NEW."executionEvidence" IS NOT NULL
            OR NEW."evidenceEvaluatedAt" IS NOT NULL
            OR NEW."quarantinedAt" IS NOT NULL
            OR NEW."redisReceipt" IS NOT NULL
            OR NEW."redisReceiptHash" IS NOT NULL
            OR NEW."completedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'product suspect recovery must start in REQUESTED state with no approval or outcome' USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM "users" u
            JOIN "user_roles" ur ON ur."userId" = u."id"
            JOIN "roles" r ON r."id" = ur."roleId"
            WHERE u."id" = NEW."requestedById"
              AND u."status" = 'ACTIVE'
              AND r."name" = 'ADMINISTRATOR'
        ) THEN
            RAISE EXCEPTION 'requestedById must be an ACTIVE ADMINISTRATOR' USING ERRCODE = '23514';
        END IF;

        SELECT * INTO v_fence FROM "reservation_fence_transitions" WHERE "id" = NEW."fenceTransitionId";
        IF v_fence."id" IS NULL
            OR v_fence."status" <> 'ACKNOWLEDGED'
            OR v_fence."revision" IS DISTINCT FROM NEW."fenceRevision"
            OR v_fence."incarnation" IS DISTINCT FROM NEW."incarnation"
            OR v_fence."epoch" IS DISTINCT FROM NEW."fenceEpoch" THEN
            RAISE EXCEPTION 'acknowledged ReservationFenceTransition required for product suspect recovery' USING ERRCODE = '23514';
        END IF;

        IF NEW."restrictionId" IS NOT NULL THEN
            SELECT * INTO v_restriction FROM "reservation_product_restrictions" WHERE "id" = NEW."restrictionId";
            IF v_restriction."id" IS NULL
                OR v_restriction."productId" IS DISTINCT FROM NEW."productId"
                OR v_restriction."restrictionRevision" IS DISTINCT FROM NEW."targetRestrictionRevision"
                OR v_restriction."state" NOT IN ('PREPARED', 'ENFORCED') THEN
                RAISE EXCEPTION 'active restriction matching targetRestrictionRevision required' USING ERRCODE = '23514';
            END IF;
        ELSE
            IF NEW."targetRestrictionRevision" <> 0 OR EXISTS (
                SELECT 1 FROM "reservation_product_restrictions"
                WHERE "productId" = NEW."productId" AND "state" IN ('PREPARED', 'ENFORCED', 'CLEARING')
            ) THEN
                RAISE EXCEPTION 'restrictionId required when active durable restriction exists' USING ERRCODE = '23514';
            END IF;
        END IF;

        SELECT COALESCE(MAX("restrictionRevision"), 0) INTO v_max_rev
        FROM "reservation_product_restrictions" WHERE "productId" = NEW."productId";

        SELECT COALESCE(MAX("clearedControlRevision"), 0) INTO v_max_cleared
        FROM "product_suspect_recoveries" WHERE "productId" = NEW."productId" AND "status" = 'COMPLETED';

        v_floor := GREATEST(v_max_rev, v_max_cleared, NEW."targetRestrictionRevision");
        v_expected_cleared := CASE WHEN (v_floor % 2) = 0 THEN v_floor + 2 ELSE v_floor + 1 END;
        IF NEW."clearedControlRevision" IS DISTINCT FROM v_expected_cleared THEN
            RAISE EXCEPTION 'monotonic even clearedControlRevision % required (got %)', v_expected_cleared, NEW."clearedControlRevision"
                USING ERRCODE = '23514';
        END IF;

        NEW."createdAt" := CURRENT_TIMESTAMP;
        NEW."updatedAt" := NEW."createdAt";
        RETURN NEW;
    END IF;

    -- TG_OP = 'UPDATE'
    IF OLD."status" IN ('COMPLETED', 'ABORTED', 'EXPIRED', 'REJECTED', 'AMBIGUOUS_QUARANTINED') THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal or quarantined recovery audit record is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - ARRAY[
        'status', 'approvedById', 'approvedAt', 'approvalExpiresAt', 'approvalDigest',
        'rejectedById', 'rejectedAt', 'rejectionReason',
        'stagedControlRevision', 'executingAt', 'executionEvidence', 'evidenceEvaluatedAt',
        'evidenceDetail', 'quarantinedAt', 'quarantineReason',
        'redisReceipt', 'redisReceiptHash', 'failureCode', 'failureDetail', 'completedAt', 'updatedAt'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'status', 'approvedById', 'approvedAt', 'approvalExpiresAt', 'approvalDigest',
        'rejectedById', 'rejectedAt', 'rejectionReason',
        'stagedControlRevision', 'executingAt', 'executionEvidence', 'evidenceEvaluatedAt',
        'evidenceDetail', 'quarantinedAt', 'quarantineReason',
        'redisReceipt', 'redisReceiptHash', 'failureCode', 'failureDetail', 'completedAt', 'updatedAt'
    ]) THEN
        RAISE EXCEPTION 'immutable recovery identity and reconciliation evidence cannot be modified' USING ERRCODE = '23514';
    END IF;

    IF NEW."status" = OLD."status" THEN
        RAISE EXCEPTION 'recovery transition must advance status (stayed %)', OLD."status" USING ERRCODE = '23514';
    END IF;

    IF OLD."status" = 'REQUESTED' THEN
        IF NEW."status" = 'APPROVED' THEN
            IF NEW."approvedById" IS NULL
                OR NEW."approvedById" = OLD."requestedById"
                OR NOT EXISTS (
                    SELECT 1 FROM "users" u
                    JOIN "user_roles" ur ON ur."userId" = u."id"
                    JOIN "roles" r ON r."id" = ur."roleId"
                    WHERE u."id" = NEW."approvedById"
                      AND u."status" = 'ACTIVE'
                      AND r."name" = 'ADMINISTRATOR'
                )
                OR NEW."approvedAt" IS NULL
                OR NEW."approvalExpiresAt" IS NULL
                OR NEW."approvalExpiresAt" <= NEW."approvedAt"
                OR NEW."approvalDigest" IS NULL THEN
                RAISE EXCEPTION 'APPROVED transition requires distinct ACTIVE ADMINISTRATOR approver and digest' USING ERRCODE = '23514';
            END IF;
        ELSIF NEW."status" = 'REJECTED' THEN
            IF NEW."rejectedById" IS NULL
                OR NOT EXISTS (
                    SELECT 1 FROM "users" u
                    JOIN "user_roles" ur ON ur."userId" = u."id"
                    JOIN "roles" r ON r."id" = ur."roleId"
                    WHERE u."id" = NEW."rejectedById"
                      AND u."status" = 'ACTIVE'
                      AND r."name" = 'ADMINISTRATOR'
                )
                OR NEW."rejectedAt" IS NULL THEN
                RAISE EXCEPTION 'REJECTED transition requires ACTIVE ADMINISTRATOR actor' USING ERRCODE = '23514';
            END IF;
        ELSE
            RAISE EXCEPTION 'REQUESTED recovery may only transition to APPROVED or REJECTED' USING ERRCODE = '23514';
        END IF;

        NEW."updatedAt" := GREATEST(CURRENT_TIMESTAMP, OLD."createdAt");
        RETURN NEW;
    END IF;

    -- Immutable approval decision once granted
    IF NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
        OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
        OR NEW."approvalExpiresAt" IS DISTINCT FROM OLD."approvalExpiresAt"
        OR NEW."approvalDigest" IS DISTINCT FROM OLD."approvalDigest"
        OR NEW."rejectedById" IS DISTINCT FROM OLD."rejectedById"
        OR NEW."rejectedAt" IS DISTINCT FROM OLD."rejectedAt" THEN
        RAISE EXCEPTION 'approval decision cannot be altered after grant' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" = 'APPROVED' THEN
        IF NEW."status" = 'EXECUTING' THEN
            IF NEW."executingAt" IS NULL
                OR NEW."executingAt" < OLD."approvedAt"
                OR NEW."executingAt" > OLD."approvalExpiresAt" THEN
                RAISE EXCEPTION 'EXECUTING requires executingAt within approval window' USING ERRCODE = '23514';
            END IF;
        ELSIF NEW."status" NOT IN ('EXPIRED', 'ABORTED') THEN
            RAISE EXCEPTION 'APPROVED recovery may only transition to EXECUTING, EXPIRED, or ABORTED' USING ERRCODE = '23514';
        END IF;

        NEW."updatedAt" := GREATEST(CURRENT_TIMESTAMP, OLD."updatedAt");
        RETURN NEW;
    END IF;

    -- OLD.status = 'EXECUTING'
    IF NEW."executingAt" IS DISTINCT FROM OLD."executingAt" THEN
        RAISE EXCEPTION 'executingAt timestamp is immutable once ENTERED' USING ERRCODE = '23514';
    END IF;

    IF NEW."status" = 'COMPLETED' THEN
        IF NEW."executionEvidence" <> 'APPLIED'
            OR NEW."evidenceEvaluatedAt" IS NULL
            OR NEW."redisReceipt" IS NULL
            OR NEW."redisReceiptHash" IS NULL
            OR NEW."redisReceiptHash" <> encode(sha256(convert_to(NEW."redisReceipt", 'UTF8')), 'hex')
            OR NEW."completedAt" IS NULL
            OR NEW."completedAt" < OLD."executingAt" THEN
            RAISE EXCEPTION 'COMPLETED recovery requires APPLIED evidence and matching SHA-256 receipt' USING ERRCODE = '23514';
        END IF;
        BEGIN
            v_receipt := NEW."redisReceipt"::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'COMPLETED redisReceipt must be valid JSON' USING ERRCODE = '23514';
        END;
        IF jsonb_typeof(v_receipt) <> 'object'
            OR (v_receipt ->> 'requestId') IS DISTINCT FROM NEW."requestId"::text
            OR (v_receipt ->> 'productId') IS DISTINCT FROM NEW."productId" THEN
            RAISE EXCEPTION 'COMPLETED redisReceipt JSON must bind exact requestId and productId' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."status" = 'AMBIGUOUS_QUARANTINED' THEN
        IF NEW."executionEvidence" NOT IN ('UNKNOWN', 'AMBIGUOUS')
            OR NEW."evidenceEvaluatedAt" IS NULL
            OR NEW."quarantinedAt" IS NULL
            OR NEW."quarantineReason" IS NULL THEN
            RAISE EXCEPTION 'AMBIGUOUS_QUARANTINED requires UNKNOWN/AMBIGUOUS evidence and quarantine attribution' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."status" = 'ABORTED' THEN
        IF (NEW."executionEvidence" IS NOT NULL AND NEW."executionEvidence" <> 'NOT_APPLIED')
            OR NEW."failureCode" IS NULL THEN
            RAISE EXCEPTION 'ABORTED from EXECUTING requires NOT_APPLIED or pre-write failureCode' USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'EXECUTING recovery may only transition to COMPLETED, ABORTED, or AMBIGUOUS_QUARANTINED' USING ERRCODE = '23514';
    END IF;

    NEW."updatedAt" := GREATEST(CURRENT_TIMESTAMP, OLD."updatedAt");
    RETURN NEW;
END $$;

CREATE FUNCTION "zz_product_suspect_recovery_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
    RAISE EXCEPTION 'product suspect recovery audit history cannot be truncated' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "product_suspect_recovery_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "product_suspect_recoveries"
    FOR EACH ROW EXECUTE FUNCTION "product_suspect_recovery_guard"();

CREATE TRIGGER "zz_product_suspect_recovery_truncate_guard"
    BEFORE TRUNCATE ON "product_suspect_recoveries"
    FOR EACH STATEMENT EXECUTE FUNCTION "zz_product_suspect_recovery_truncate_guard"();

CREATE FUNCTION "product_suspect_recovery_target_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
    v_rec "product_suspect_recoveries"%ROWTYPE;
    v_comp_product TEXT;
    v_sync_product TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'product suspect recovery targets cannot be deleted' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_rec FROM "product_suspect_recoveries" WHERE "id" = NEW."recoveryId";
    IF v_rec."id" IS NULL THEN
        RAISE EXCEPTION 'valid recovery required' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF v_rec."status" NOT IN ('REQUESTED', 'APPROVED', 'EXECUTING') OR NEW."unblockedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'targets can only be registered while recovery is active and unblockedAt is null' USING ERRCODE = '23514';
        END IF;

        IF NEW."targetKind" = 'COMPENSATION' THEN
            SELECT "productId" INTO v_comp_product FROM "cart_reservation_compensations" WHERE "id" = NEW."compensationId";
            IF v_comp_product IS DISTINCT FROM NEW."productId" THEN
                RAISE EXCEPTION 'compensation product mismatch' USING ERRCODE = '23514';
            END IF;
        ELSE
            SELECT "productId" INTO v_sync_product FROM "cart_reservation_sync_states" WHERE "id" = NEW."syncStateId";
            IF v_sync_product IS DISTINCT FROM NEW."productId" THEN
                RAISE EXCEPTION 'sync state product mismatch' USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    -- TG_OP = 'UPDATE'
    IF OLD."unblockedAt" IS NOT NULL THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'unblocked recovery target record is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - ARRAY['unblockedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['unblockedAt'])
        OR NEW."unblockedAt" IS NULL
        OR v_rec."status" <> 'COMPLETED' THEN
        RAISE EXCEPTION 'target unblockedAt can only be stamped once COMPLETED recovery commits' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END $$;

CREATE FUNCTION "zz_product_suspect_recovery_target_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
    RAISE EXCEPTION 'product suspect recovery targets cannot be truncated' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "product_suspect_recovery_target_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "product_suspect_recovery_targets"
    FOR EACH ROW EXECUTE FUNCTION "product_suspect_recovery_target_guard"();

CREATE TRIGGER "zz_product_suspect_recovery_target_truncate_guard"
    BEFORE TRUNCATE ON "product_suspect_recovery_targets"
    FOR EACH STATEMENT EXECUTE FUNCTION "zz_product_suspect_recovery_target_truncate_guard"();

-- Retain disposable-schema portability (see Migration #49 and #67 convention)
DO $$
DECLARE fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'product_restriction_guard',
        'zz_product_restriction_truncate_guard',
        'product_restriction_installation_guard',
        'zz_product_restriction_installation_truncate_guard',
        'product_restriction_w1_guard',
        'cutover_freshness_reset_guard',
        'product_suspect_recovery_guard',
        'zz_product_suspect_recovery_truncate_guard',
        'product_suspect_recovery_target_guard',
        'zz_product_suspect_recovery_target_truncate_guard'
    ] LOOP
        EXECUTE format('ALTER FUNCTION %I.%I() SET search_path = pg_catalog, %I, pg_temp', current_schema(), fn, current_schema());
    END LOOP;
END $$;
