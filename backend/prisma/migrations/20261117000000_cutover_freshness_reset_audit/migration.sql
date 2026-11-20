-- ============================================================================
-- Migration #67: WP4.3B.4F.7D.4B.6K-M67
-- Dedicated Freshness-Reset Audit & Crash-Recovery Schema (`cutover_freshness_resets`)
--
-- Additive only:
--   - Does NOT modify any of Migrations #1-#66.
--   - Does NOT alter financial tables, financial triggers, or financial constraints.
--   - Records pre-execution authorization (`PREPARED`) and terminal outcomes
--     (`COMPLETED` | `ABORTED`) with strict idempotency, immutability, lease
--     bounds, and delete/truncate protection. A `PREPARED` row never by itself
--     authorizes an unrestricted Redis mutation.
-- ============================================================================

-- CreateEnum
CREATE TYPE "CutoverFreshnessResetStatus" AS ENUM ('PREPARED', 'COMPLETED', 'ABORTED');

-- CreateTable
CREATE TABLE "cutover_freshness_resets" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "cutoverRunId" UUID NOT NULL,
    "barrierRevision" INTEGER NOT NULL,
    "fenceTransitionId" UUID NOT NULL,
    "incarnation" UUID NOT NULL,
    "fenceEpoch" INTEGER NOT NULL,
    "fenceRevision" INTEGER NOT NULL,
    "modeRevision" INTEGER NOT NULL,
    "markerId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "holdInstanceId" UUID NOT NULL,
    "customerId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "operatorId" TEXT NOT NULL,
    "authorizationEffect" VARCHAR(32) NOT NULL DEFAULT 'FRESHNESS_SWEEP',
    "authorizationPhase" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "permitTtlMs" INTEGER NOT NULL DEFAULT 5000,
    "reason" VARCHAR(128) NOT NULL DEFAULT 'CUTOVER_FRESHNESS_SWEEP',
    "status" "CutoverFreshnessResetStatus" NOT NULL DEFAULT 'PREPARED',
    "anchorNowMs" BIGINT NOT NULL,
    "priorCreatedAtMs" BIGINT,
    "priorLastRenewedAtMs" BIGINT,
    "priorExpiresAtMs" BIGINT,
    "priorAbsoluteExpiresAtMs" BIGINT,
    "newCreatedAtMs" BIGINT,
    "newLastRenewedAtMs" BIGINT,
    "newExpiresAtMs" BIGINT,
    "newAbsoluteExpiresAtMs" BIGINT,
    "redisReceipt" TEXT,
    "redisReceiptHash" CHAR(64),
    "failureCode" VARCHAR(64),
    "failureDetail" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "cutover_freshness_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cutover_freshness_resets_requestId_key" ON "cutover_freshness_resets"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "cutover_freshness_resets_idempotency_key" ON "cutover_freshness_resets"("cutoverRunId", "barrierRevision", "markerId", "generation");

-- CreateIndex
CREATE INDEX "cutover_freshness_resets_status_createdAt_idx" ON "cutover_freshness_resets"("status", "createdAt");

-- CreateIndex
CREATE INDEX "cutover_freshness_resets_run_status_idx" ON "cutover_freshness_resets"("cutoverRunId", "status");

-- CreateIndex
CREATE INDEX "cutover_freshness_resets_cart_product_idx" ON "cutover_freshness_resets"("cartId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "cutover_freshness_resets_marker_gen_idx" ON "cutover_freshness_resets"("markerId", "generation");

-- AddForeignKey
ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_barrier_fkey"
    FOREIGN KEY ("barrierRevision") REFERENCES "cart_mutation_barrier_configs"("revision") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_fence_fkey"
    FOREIGN KEY ("fenceTransitionId", "incarnation", "fenceEpoch") REFERENCES "reservation_fence_transitions"("id", "incarnation", "epoch") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_marker_fkey"
    FOREIGN KEY ("markerId", "cartId", "productId") REFERENCES "cart_reservation_sync_states"("id", "cartId", "productId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_cart_fkey"
    FOREIGN KEY ("cartId", "customerId") REFERENCES "carts"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_product_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_operator_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Database CHECK Constraints (defense in depth independent of triggers)
ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_counters_chk" CHECK (
    "barrierRevision" > 0
    AND "fenceRevision" > 0
    AND "fenceEpoch" > 0
    AND "modeRevision" > 0
    AND "generation" >= 0
    AND "quantity" > 0
    AND "permitTtlMs" BETWEEN 1 AND 5000
);

ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_auth_chk" CHECK (
    "authorizationEffect" = 'FRESHNESS_SWEEP'
    AND "authorizationPhase" = 'OPEN'
    AND char_length(btrim("reason")) BETWEEN 1 AND 128
);

ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_identity_chk" CHECK (
    "markerId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "holdInstanceId"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND char_length("customerId") > 0
    AND char_length("cartId") > 0
    AND char_length("productId") > 0
    AND char_length("operatorId") > 0
);

ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_anchor_chk" CHECK (
    "anchorNowMs" > 0 AND "anchorNowMs" <= 9999999999999
);

ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_prior_lease_chk" CHECK (
    (("priorCreatedAtMs" IS NULL) = ("priorAbsoluteExpiresAtMs" IS NULL))
    AND ("priorCreatedAtMs" IS NULL OR (
        "priorCreatedAtMs" > 0
        AND "priorAbsoluteExpiresAtMs" >= "priorCreatedAtMs"
        AND "priorAbsoluteExpiresAtMs" <= 9999999999999
    ))
    AND ("priorExpiresAtMs" IS NULL OR (
        "priorCreatedAtMs" IS NOT NULL
        AND "priorExpiresAtMs" > 0
        AND "priorExpiresAtMs" <= "priorAbsoluteExpiresAtMs"
    ))
    AND ("priorLastRenewedAtMs" IS NULL OR (
        "priorCreatedAtMs" IS NOT NULL
        AND "priorLastRenewedAtMs" >= "priorCreatedAtMs"
        AND "priorLastRenewedAtMs" <= "priorAbsoluteExpiresAtMs"
    ))
);

ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_completion_chk" CHECK (
    (("status" = 'PREPARED') = ("completedAt" IS NULL))
    AND ("completedAt" IS NULL OR "completedAt" >= "createdAt")
    AND (("status" = 'ABORTED') = ("failureCode" IS NOT NULL))
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z0-9_]{1,64}$')
    AND ("status" <> 'PREPARED' OR "failureDetail" IS NULL)
    AND ("redisReceiptHash" IS NULL OR "redisReceiptHash" ~ '^[0-9a-f]{64}$')
    AND (("status" = 'COMPLETED') = (
        "priorCreatedAtMs" IS NOT NULL
        AND "priorAbsoluteExpiresAtMs" IS NOT NULL
        AND "newCreatedAtMs" IS NOT NULL
        AND "newLastRenewedAtMs" IS NOT NULL
        AND "newExpiresAtMs" IS NOT NULL
        AND "newAbsoluteExpiresAtMs" IS NOT NULL
        AND "redisReceipt" IS NOT NULL
        AND "redisReceiptHash" IS NOT NULL
    ))
    AND ("status" = 'COMPLETED' OR (
        "newCreatedAtMs" IS NULL
        AND "newLastRenewedAtMs" IS NULL
        AND "newExpiresAtMs" IS NULL
        AND "newAbsoluteExpiresAtMs" IS NULL
        AND "redisReceipt" IS NULL
        AND "redisReceiptHash" IS NULL
    ))
);

ALTER TABLE "cutover_freshness_resets" ADD CONSTRAINT "cutover_freshness_resets_new_lease_chk" CHECK (
    "status" <> 'COMPLETED' OR (
        "newCreatedAtMs" = "anchorNowMs"
        AND "newLastRenewedAtMs" = "anchorNowMs"
        AND "newExpiresAtMs" > "anchorNowMs"
        AND "newExpiresAtMs" <= "anchorNowMs" + 900000
        AND "newAbsoluteExpiresAtMs" > "anchorNowMs"
        AND "newAbsoluteExpiresAtMs" <= "anchorNowMs" + 3600000
        AND "newExpiresAtMs" <= "newAbsoluteExpiresAtMs"
        AND "newAbsoluteExpiresAtMs" <= 9999999999999
    )
);

-- Lifecycle, Provenance, and Immutability Triggers
CREATE FUNCTION "cutover_freshness_reset_guard"() RETURNS trigger
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

        -- Verify active latest barrier revision
        SELECT MAX("revision") INTO v_latest_barrier_rev FROM "cart_mutation_barrier_configs";
        SELECT * INTO v_barrier FROM "cart_mutation_barrier_configs" WHERE "revision" = NEW."barrierRevision";
        IF v_barrier."id" IS NULL OR NOT v_barrier."active" OR v_latest_barrier_rev IS DISTINCT FROM NEW."barrierRevision" THEN
            RAISE EXCEPTION 'active latest cart mutation barrier revision required for PREPARED freshness authorization' USING ERRCODE = '23514';
        END IF;

        -- Verify latest durable engine mode is MIRROR at NEW.modeRevision
        SELECT * INTO v_mode FROM "reservation_engine_mode_configs" ORDER BY "revision" DESC LIMIT 1;
        IF v_mode."id" IS NULL OR v_mode."revision" IS DISTINCT FROM NEW."modeRevision" OR v_mode."mode" <> 'MIRROR' THEN
            RAISE EXCEPTION 'latest MIRROR mode revision required for PREPARED freshness authorization' USING ERRCODE = '23514';
        END IF;

        -- Verify latest acknowledged OPEN/MIRROR fence transition
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

        -- Verify durable marker provenance, positive CartItem quantity parity, and no product restriction
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

        IF EXISTS (SELECT 1 FROM "reservation_product_restrictions" WHERE "productId" = NEW."productId") THEN
            RAISE EXCEPTION 'restricted product cannot be authorized for freshness reset' USING ERRCODE = '23514';
        END IF;

        NEW."createdAt" := CURRENT_TIMESTAMP;
        NEW."updatedAt" := NEW."createdAt";
        RETURN NEW;
    END IF;

    -- TG_OP = 'UPDATE'
    IF OLD."status" IN ('COMPLETED', 'ABORTED') THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal cutover freshness audit record is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    -- OLD.status = 'PREPARED'
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

CREATE FUNCTION "cutover_freshness_reset_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
    RAISE EXCEPTION 'cutover freshness audit history cannot be truncated' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "cutover_freshness_reset_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "cutover_freshness_resets"
    FOR EACH ROW EXECUTE FUNCTION "cutover_freshness_reset_guard"();

CREATE TRIGGER "zz_cutover_freshness_reset_truncate_guard"
    BEFORE TRUNCATE ON "cutover_freshness_resets"
    FOR EACH STATEMENT EXECUTE FUNCTION "cutover_freshness_reset_truncate_guard"();

-- Retain disposable-schema portability (see Migration #49 convention)
DO $$
DECLARE fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['cutover_freshness_reset_guard', 'cutover_freshness_reset_truncate_guard'] LOOP
        EXECUTE format('ALTER FUNCTION %I.%I() SET search_path = pg_catalog, %I, pg_temp', current_schema(), fn, current_schema());
    END LOOP;
END $$;
