-- CreateEnum
CREATE TYPE "OrdinaryProvenanceState" AS ENUM ('HISTORICAL_UNVERIFIED', 'NEW', 'TRACKED');

-- CreateEnum
CREATE TYPE "OrdinaryOwnerState" AS ENUM ('ISSUED', 'ACTIVE', 'RELEASE_PENDING', 'TRANSFER_PENDING', 'TRANSFERRED', 'CONSUMED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OrdinaryCommandEffect" AS ENUM ('W1', 'RELEASE', 'CANCEL_W1', 'CHECKOUT_COMPLETE');

-- CreateEnum
CREATE TYPE "OrdinaryCommandState" AS ENUM ('WAITING', 'PENDING', 'UNCERTAIN', 'REVOCATION_PENDING', 'ACKNOWLEDGED', 'CANCELLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OrdinaryCommandReason" AS ENUM ('CART_INTENT', 'CART_REMOVAL', 'COMPENSATION_ABSENCE', 'RECOVERY_ABSENCE', 'RETIREMENT', 'STALE_W1', 'CHECKOUT_SETTLED');

-- CreateEnum
CREATE TYPE "OrdinaryW1Transition" AS ENUM ('INITIAL', 'SAME_GENERATION', 'IMMEDIATE_PREDECESSOR', 'AFTER_CONSUMPTION');

-- AlterTable
ALTER TABLE "cart_reservation_sync_states" ADD COLUMN     "ordinaryAcknowledgedSequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ordinaryCommandSequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ordinaryEnqueueSequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ordinaryProvenanceState" "OrdinaryProvenanceState" NOT NULL DEFAULT 'HISTORICAL_UNVERIFIED';

-- CreateTable
CREATE TABLE "ordinary_reservation_owners" (
    "id" UUID NOT NULL,
    "markerId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "holdInstanceId" UUID NOT NULL,
    "customerId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "incarnation" UUID NOT NULL,
    "reservationExecutionEpoch" INTEGER NOT NULL,
    "issuanceTransitionId" UUID NOT NULL,
    "state" "OrdinaryOwnerState" NOT NULL DEFAULT 'ISSUED',
    "checkoutManifestId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ordinary_reservation_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordinary_reservation_commands" (
    "id" UUID NOT NULL,
    "markerId" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "sourceOwnerId" UUID,
    "effect" "OrdinaryCommandEffect" NOT NULL,
    "reason" "OrdinaryCommandReason" NOT NULL,
    "w1Transition" "OrdinaryW1Transition",
    "intentGeneration" INTEGER NOT NULL,
    "expectedMutationVersion" INTEGER NOT NULL,
    "authorizedQuantity" INTEGER,
    "queueOrdinal" INTEGER NOT NULL,
    "sequence" INTEGER,
    "expectedSequence" INTEGER,
    "replayId" UUID NOT NULL,
    "state" "OrdinaryCommandState" NOT NULL DEFAULT 'WAITING',
    "dependsOnCommandId" UUID,
    "cancelledCommandId" UUID,
    "checkoutManifestId" UUID,
    "settlementReceiptHash" CHAR(64),
    "causeTransitionId" UUID,
    "lastDispatchTransitionId" UUID,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "completionReceiptHash" CHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ordinary_reservation_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_reservation_owners_holdInstanceId_key" ON "ordinary_reservation_owners"("holdInstanceId");

-- CreateIndex
CREATE INDEX "ordinary_reservation_owners_markerId_state_generation_idx" ON "ordinary_reservation_owners"("markerId", "state", "generation");

-- CreateIndex
CREATE INDEX "ordinary_reservation_owners_state_id_idx" ON "ordinary_reservation_owners"("state", "id");

-- CreateIndex
CREATE INDEX "ordinary_reservation_owners_cartId_productId_state_idx" ON "ordinary_reservation_owners"("cartId", "productId", "state");

-- CreateIndex
CREATE INDEX "ordinary_reservation_owners_incarnation_reservationExecutio_idx" ON "ordinary_reservation_owners"("incarnation", "reservationExecutionEpoch", "state");

-- CreateIndex
CREATE INDEX "ordinary_reservation_owners_checkoutManifestId_idx" ON "ordinary_reservation_owners"("checkoutManifestId");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_reservation_owners_markerId_generation_key" ON "ordinary_reservation_owners"("markerId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_reservation_owners_id_markerId_key" ON "ordinary_reservation_owners"("id", "markerId");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_reservation_commands_replayId_key" ON "ordinary_reservation_commands"("replayId");

-- CreateIndex
CREATE INDEX "ordinary_reservation_commands_state_nextAttemptAt_queueOrdi_idx" ON "ordinary_reservation_commands"("state", "nextAttemptAt", "queueOrdinal", "id");

-- CreateIndex
CREATE INDEX "ordinary_reservation_commands_ownerId_effect_state_idx" ON "ordinary_reservation_commands"("ownerId", "effect", "state");

-- CreateIndex
CREATE INDEX "ordinary_reservation_commands_markerId_state_queueOrdinal_idx" ON "ordinary_reservation_commands"("markerId", "state", "queueOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_reservation_commands_markerId_queueOrdinal_key" ON "ordinary_reservation_commands"("markerId", "queueOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_reservation_commands_markerId_sequence_key" ON "ordinary_reservation_commands"("markerId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_reservation_commands_id_markerId_key" ON "ordinary_reservation_commands"("id", "markerId");

-- CreateIndex
CREATE UNIQUE INDEX "carts_id_customerId_key" ON "carts"("id", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_reservation_sync_states_id_cartId_productId_key" ON "cart_reservation_sync_states"("id", "cartId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_fence_transitions_id_incarnation_epoch_key" ON "reservation_fence_transitions"("id", "incarnation", "epoch");

-- AddForeignKey
ALTER TABLE "ordinary_reservation_owners" ADD CONSTRAINT "ordinary_reservation_owners_markerId_cartId_productId_fkey" FOREIGN KEY ("markerId", "cartId", "productId") REFERENCES "cart_reservation_sync_states"("id", "cartId", "productId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_owners" ADD CONSTRAINT "ordinary_reservation_owners_cartId_customerId_fkey" FOREIGN KEY ("cartId", "customerId") REFERENCES "carts"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_owners" ADD CONSTRAINT "ordinary_reservation_owners_issuanceTransitionId_incarnati_fkey" FOREIGN KEY ("issuanceTransitionId", "incarnation", "reservationExecutionEpoch") REFERENCES "reservation_fence_transitions"("id", "incarnation", "epoch") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_owners" ADD CONSTRAINT "ordinary_reservation_owners_checkoutManifestId_fkey" FOREIGN KEY ("checkoutManifestId") REFERENCES "checkout_reservation_settlements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_markerId_fkey" FOREIGN KEY ("markerId") REFERENCES "cart_reservation_sync_states"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_ownerId_markerId_fkey" FOREIGN KEY ("ownerId", "markerId") REFERENCES "ordinary_reservation_owners"("id", "markerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_sourceOwnerId_markerId_fkey" FOREIGN KEY ("sourceOwnerId", "markerId") REFERENCES "ordinary_reservation_owners"("id", "markerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_dependsOnCommandId_markerId_fkey" FOREIGN KEY ("dependsOnCommandId", "markerId") REFERENCES "ordinary_reservation_commands"("id", "markerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_cancelledCommandId_markerId_fkey" FOREIGN KEY ("cancelledCommandId", "markerId") REFERENCES "ordinary_reservation_commands"("id", "markerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_checkoutManifestId_fkey" FOREIGN KEY ("checkoutManifestId") REFERENCES "checkout_reservation_settlements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_causeTransitionId_fkey" FOREIGN KEY ("causeTransitionId") REFERENCES "reservation_fence_transitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_reservation_commands" ADD CONSTRAINT "ordinary_reservation_commands_lastDispatchTransitionId_fkey" FOREIGN KEY ("lastDispatchTransitionId") REFERENCES "reservation_fence_transitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Inert provenance: defaults deliberately classify old-code inserts as historical.
-- No backfill, inferred I/E, Redis calls, or production issuance is introduced.
ALTER TABLE cart_reservation_sync_states ADD CONSTRAINT ordinary_counter_bounds CHECK
 (0 <= "ordinaryAcknowledgedSequence" AND "ordinaryAcknowledgedSequence" <= "ordinaryCommandSequence"
 AND "ordinaryCommandSequence" <= "ordinaryEnqueueSequence");
ALTER TABLE ordinary_reservation_owners ADD CONSTRAINT ordinary_owner_shape CHECK
 (generation >= 0 AND "reservationExecutionEpoch" > 0
 AND "markerId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND "holdInstanceId"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND ((state IN ('CONSUMED','SUPERSEDED','REVOKED')) = ("closedAt" IS NOT NULL))
 AND (state NOT IN ('TRANSFER_PENDING','TRANSFERRED') OR "checkoutManifestId" IS NOT NULL));
ALTER TABLE ordinary_reservation_commands ADD CONSTRAINT ordinary_command_shape CHECK
 ("queueOrdinal" > 0 AND "intentGeneration" >= 0 AND "expectedMutationVersion" >= 0 AND "attemptCount" >= 0
 AND ((sequence IS NULL AND "expectedSequence" IS NULL) OR
      (sequence IS NOT NULL AND "expectedSequence" IS NOT NULL AND "expectedSequence" >= 0 AND sequence > "expectedSequence"))
 AND (state NOT IN ('WAITING') OR sequence IS NULL)
 AND (state NOT IN ('PENDING','UNCERTAIN','REVOCATION_PENDING','ACKNOWLEDGED','CANCELLED') OR sequence IS NOT NULL)
 AND ((effect = 'W1' AND "w1Transition" IS NOT NULL AND "authorizedQuantity" IS NOT NULL AND "authorizedQuantity" > 0)
   OR (effect <> 'W1' AND "w1Transition" IS NULL AND "authorizedQuantity" IS NULL))
 AND ((effect = 'CANCEL_W1') = ("cancelledCommandId" IS NOT NULL))
 AND ((effect = 'CHECKOUT_COMPLETE') = ("checkoutManifestId" IS NOT NULL))
 AND ((effect = 'CHECKOUT_COMPLETE') = ("settlementReceiptHash" IS NOT NULL))
 AND (reason <> 'RETIREMENT' OR "causeTransitionId" IS NOT NULL)
 AND ((effect='W1' AND reason='CART_INTENT') OR (effect='CANCEL_W1' AND reason='STALE_W1')
   OR (effect='CHECKOUT_COMPLETE' AND reason='CHECKOUT_SETTLED')
   OR (effect='RELEASE' AND reason IN ('CART_REMOVAL','COMPENSATION_ABSENCE','RECOVERY_ABSENCE','RETIREMENT')))
 AND ((state = 'ACKNOWLEDGED') = ("acknowledgedAt" IS NOT NULL))
 AND ((state = 'ACKNOWLEDGED') = ("completionReceiptHash" IS NOT NULL))
 AND ("completionReceiptHash" IS NULL OR "completionReceiptHash" ~ '^[0-9a-f]{64}$')
 AND ("settlementReceiptHash" IS NULL OR "settlementReceiptHash" ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX ordinary_one_release ON ordinary_reservation_commands ("ownerId") WHERE effect = 'RELEASE';
CREATE UNIQUE INDEX ordinary_one_cancellation ON ordinary_reservation_commands ("cancelledCommandId") WHERE effect = 'CANCEL_W1';
CREATE UNIQUE INDEX ordinary_one_bridge ON ordinary_reservation_commands ("ownerId", "checkoutManifestId") WHERE effect = 'CHECKOUT_COMPLETE';
CREATE UNIQUE INDEX ordinary_one_dispatcher ON ordinary_reservation_commands ("markerId") WHERE state IN ('PENDING','UNCERTAIN');

-- Triggers read referenced immutable identity only. They never lock ancestors,
-- allocate counters, update CartItem, or perform physical work.
CREATE FUNCTION ordinary_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m cart_reservation_sync_states%ROWTYPE; f reservation_fence_transitions%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ordinary owner deletion prohibited'; END IF;
 IF TG_OP = 'INSERT' THEN
  SELECT * INTO m FROM cart_reservation_sync_states WHERE id = NEW."markerId";
  SELECT * INTO f FROM reservation_fence_transitions WHERE id = NEW."issuanceTransitionId";
  IF NOT COALESCE(m."ordinaryProvenanceState" IN ('NEW','TRACKED') AND m.generation = NEW.generation
   AND f.status = 'ACKNOWLEDGED' AND f.phase = 'OPEN' AND NEW.state = 'ISSUED'
   AND NEW."checkoutManifestId" IS NULL, false) THEN RAISE EXCEPTION 'ordinary issuance provenance rejected'; END IF;
 ELSE
  IF (to_jsonb(NEW) - ARRAY['state','checkoutManifestId','updatedAt','closedAt'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','checkoutManifestId','updatedAt','closedAt'])
   THEN RAISE EXCEPTION 'ordinary owner identity immutable'; END IF;
  IF OLD."checkoutManifestId" IS NOT NULL AND NEW."checkoutManifestId" IS DISTINCT FROM OLD."checkoutManifestId"
   THEN RAISE EXCEPTION 'ordinary checkout link immutable'; END IF;
  IF NEW."checkoutManifestId" IS DISTINCT FROM OLD."checkoutManifestId"
   AND NOT (OLD.state = 'ACTIVE' AND NEW.state = 'TRANSFER_PENDING')
   THEN RAISE EXCEPTION 'ordinary checkout link requires transfer'; END IF;
  IF NEW."closedAt" IS DISTINCT FROM OLD."closedAt" AND NEW.state = OLD.state
   THEN RAISE EXCEPTION 'ordinary closure time immutable'; END IF;
  IF NEW.state <> OLD.state AND NOT (
   (OLD.state = 'ISSUED' AND NEW.state IN ('ACTIVE','RELEASE_PENDING','REVOKED')) OR
   (OLD.state = 'ACTIVE' AND NEW.state IN ('RELEASE_PENDING','SUPERSEDED','TRANSFER_PENDING')) OR
   (OLD.state = 'TRANSFER_PENDING' AND NEW.state = 'TRANSFERRED') OR
   (OLD.state IN ('RELEASE_PENDING','TRANSFERRED') AND NEW.state = 'CONSUMED'))
   THEN RAISE EXCEPTION 'illegal ordinary owner transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ordinary_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON ordinary_reservation_owners
 FOR EACH ROW EXECUTE FUNCTION ordinary_owner_guard();

CREATE FUNCTION ordinary_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o ordinary_reservation_owners%ROWTYPE; s ordinary_reservation_owners%ROWTYPE;
 d ordinary_reservation_commands%ROWTYPE; m cart_reservation_sync_states%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ordinary command deletion prohibited'; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.state <> 'WAITING' OR NEW.sequence IS NOT NULL OR NEW."attemptCount" <> 0
   OR NEW."lastDispatchTransitionId" IS NOT NULL OR NEW."nextAttemptAt" IS NOT NULL
   THEN RAISE EXCEPTION 'ordinary command must be inserted waiting'; END IF;
  SELECT * INTO o FROM ordinary_reservation_owners WHERE id = NEW."ownerId";
  SELECT * INTO m FROM cart_reservation_sync_states WHERE id = NEW."markerId";
  IF NOT COALESCE(m."ordinaryProvenanceState" IN ('NEW','TRACKED'),false)
   THEN RAISE EXCEPTION 'historical ordinary command prohibited'; END IF;
  IF NEW."sourceOwnerId" IS NOT NULL THEN SELECT * INTO s FROM ordinary_reservation_owners WHERE id = NEW."sourceOwnerId"; END IF;
  IF NEW.effect = 'W1' THEN
   IF NOT COALESCE(o.state IN ('ISSUED','ACTIVE') AND o.generation = NEW."intentGeneration"
    AND m.generation = NEW."intentGeneration" AND m."expectedMutationVersion" = NEW."expectedMutationVersion"
    AND m."expectedQuantity" = NEW."authorizedQuantity" AND
    CASE NEW."w1Transition"
     WHEN 'INITIAL' THEN NEW."sourceOwnerId" IS NULL AND NOT EXISTS
       (SELECT 1 FROM ordinary_reservation_owners WHERE "markerId"=NEW."markerId" AND id<>o.id)
     WHEN 'SAME_GENERATION' THEN s.id = o.id
     WHEN 'IMMEDIATE_PREDECESSOR' THEN s.generation::bigint + 1 = o.generation AND s.state = 'ACTIVE'
       AND s."incarnation" = o."incarnation" AND s."reservationExecutionEpoch" = o."reservationExecutionEpoch"
     WHEN 'AFTER_CONSUMPTION' THEN s.generation < o.generation AND s.state = 'CONSUMED'
     ELSE false END,false) THEN RAISE EXCEPTION 'ordinary W1 relationship rejected'; END IF;
  ELSIF NEW."sourceOwnerId" IS NOT NULL THEN RAISE EXCEPTION 'non-W1 source prohibited';
  END IF;
  IF NEW.effect = 'RELEASE' AND o.state NOT IN ('ISSUED','ACTIVE','RELEASE_PENDING')
   THEN RAISE EXCEPTION 'ordinary release owner rejected'; END IF;
  IF NEW.effect='RELEASE' AND NOT COALESCE(
   m.generation=NEW."intentGeneration" AND m."expectedMutationVersion"=NEW."expectedMutationVersion"
   AND (CASE WHEN NEW.reason='RETIREMENT' THEN EXISTS (
    SELECT 1 FROM reservation_fence_transitions cause WHERE cause.id=NEW."causeTransitionId"
     AND cause.incarnation=o.incarnation AND cause.epoch=o."reservationExecutionEpoch"
     AND cause.phase='DRAINING' AND cause.status='ACKNOWLEDGED')
    ELSE m."expectedQuantity" IS NULL END), false)
   THEN RAISE EXCEPTION 'ordinary release intent rejected'; END IF;
  IF NEW."dependsOnCommandId" IS NOT NULL THEN
   SELECT * INTO d FROM ordinary_reservation_commands WHERE id=NEW."dependsOnCommandId";
   IF NOT COALESCE(d."markerId"=NEW."markerId" AND d."queueOrdinal"<NEW."queueOrdinal",false)
    THEN RAISE EXCEPTION 'ordinary dependency rejected'; END IF;
  END IF;
  IF NEW.effect = 'CANCEL_W1' THEN
   SELECT * INTO d FROM ordinary_reservation_commands WHERE id=NEW."cancelledCommandId";
   IF NOT COALESCE(d."markerId"=NEW."markerId" AND d."ownerId"=NEW."ownerId" AND d.effect='W1'
    AND d.state IN ('PENDING','UNCERTAIN') AND d."queueOrdinal"<NEW."queueOrdinal",false)
    THEN RAISE EXCEPTION 'ordinary cancellation target rejected'; END IF;
  END IF;
  IF NEW.effect = 'CHECKOUT_COMPLETE' AND NOT EXISTS (
   SELECT 1 FROM checkout_reservation_settlements c JOIN checkout_reservation_resources r ON r."settlementId"=c.id
   WHERE c.id=NEW."checkoutManifestId" AND o."checkoutManifestId"=c.id AND o.state='TRANSFERRED'
    AND c.state='SETTLED' AND c.sealed AND c."settlementReplayId" IS NOT NULL
    AND c.effect IN ('CHECKOUT_REVERT_DELETE_ONLY','CHECKOUT_FINALIZE')
    AND c."completionReceiptHash"=NEW."settlementReceiptHash" AND c.incarnation=o.incarnation
    AND c."reservationExecutionEpoch"=o."reservationExecutionEpoch"
    AND r."markerId"=o."markerId" AND r.generation=o.generation AND r."holdInstanceId"=o."holdInstanceId"
    AND r."productId"=o."productId")
   THEN RAISE EXCEPTION 'ordinary checkout bridge provenance rejected'; END IF;
 ELSE
  IF (to_jsonb(NEW) - ARRAY['state','sequence','expectedSequence','lastDispatchTransitionId','attemptCount','nextAttemptAt','completionReceiptHash','acknowledgedAt','updatedAt'])
   IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','sequence','expectedSequence','lastDispatchTransitionId','attemptCount','nextAttemptAt','completionReceiptHash','acknowledgedAt','updatedAt'])
   THEN RAISE EXCEPTION 'ordinary command payload immutable'; END IF;
  IF ROW(NEW.sequence,NEW."expectedSequence") IS DISTINCT FROM ROW(OLD.sequence,OLD."expectedSequence")
   AND NOT (OLD.state='WAITING' AND NEW.state='PENDING' AND OLD.sequence IS NULL AND NEW.sequence IS NOT NULL)
   THEN RAISE EXCEPTION 'ordinary execution binding immutable'; END IF;
  IF NEW.state<>OLD.state AND NOT (
   (OLD.state='WAITING' AND NEW.state IN ('PENDING','REVOKED')) OR
   (OLD.state='PENDING' AND NEW.state IN ('UNCERTAIN','ACKNOWLEDGED','REVOCATION_PENDING')) OR
   (OLD.state='UNCERTAIN' AND NEW.state IN ('PENDING','ACKNOWLEDGED','REVOCATION_PENDING')) OR
   (OLD.state='REVOCATION_PENDING' AND NEW.state IN ('CANCELLED','ACKNOWLEDGED')) OR
   (OLD.state IN ('PENDING','UNCERTAIN') AND NEW.state='REVOKED' AND NEW.effect='CANCEL_W1'
    AND EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE id=NEW."cancelledCommandId" AND state='ACKNOWLEDGED')))
   THEN RAISE EXCEPTION 'illegal ordinary command transition'; END IF;
  IF NEW.state='REVOCATION_PENDING' AND NEW.effect<>'W1' THEN RAISE EXCEPTION 'only W1 may await cancellation'; END IF;
  IF NEW.state='REVOKED' AND NEW.state<>OLD.state AND NOT (
   (OLD.state='WAITING' AND NEW.effect='W1') OR
   (NEW.effect='CANCEL_W1' AND EXISTS (SELECT 1 FROM ordinary_reservation_commands
     WHERE id=NEW."cancelledCommandId" AND state='ACKNOWLEDGED')))
   THEN RAISE EXCEPTION 'ordinary revocation lacks durable closure'; END IF;
  IF NEW."lastDispatchTransitionId" IS DISTINCT FROM OLD."lastDispatchTransitionId" AND NOT EXISTS (
   SELECT 1 FROM reservation_fence_transitions f JOIN ordinary_reservation_owners dispatch_owner ON dispatch_owner.id=NEW."ownerId"
   WHERE f.id=NEW."lastDispatchTransitionId" AND f.incarnation=dispatch_owner.incarnation AND f.epoch=dispatch_owner."reservationExecutionEpoch"
     AND f.status='ACKNOWLEDGED' AND (f.phase='OPEN' OR (NEW.effect<>'W1' AND f.phase='DRAINING')))
   THEN RAISE EXCEPTION 'ordinary dispatch provenance rejected'; END IF;
  IF NEW.state=OLD.state AND ROW(NEW."completionReceiptHash",NEW."acknowledgedAt")
    IS DISTINCT FROM ROW(OLD."completionReceiptHash",OLD."acknowledgedAt")
   THEN RAISE EXCEPTION 'ordinary completion immutable'; END IF;
  IF NEW."attemptCount"<OLD."attemptCount" OR NEW."attemptCount"::bigint>OLD."attemptCount"::bigint+1
   OR (ROW(NEW."attemptCount",NEW."nextAttemptAt",NEW."lastDispatchTransitionId")
     IS DISTINCT FROM ROW(OLD."attemptCount",OLD."nextAttemptAt",OLD."lastDispatchTransitionId")
     AND NEW.state NOT IN ('PENDING','UNCERTAIN'))
   THEN RAISE EXCEPTION 'ordinary scheduling rejected'; END IF;
  IF OLD.state='WAITING' AND NEW.state='PENDING' THEN
   SELECT * INTO m FROM cart_reservation_sync_states WHERE id=NEW."markerId";
   IF NEW.sequence<>m."ordinaryCommandSequence" OR NEW."expectedSequence"<>m."ordinaryAcknowledgedSequence"
    THEN RAISE EXCEPTION 'ordinary promotion counter mismatch'; END IF;
   IF NEW."dependsOnCommandId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ordinary_reservation_commands WHERE id=NEW."dependsOnCommandId" AND state IN ('ACKNOWLEDGED','CANCELLED'))
    THEN RAISE EXCEPTION 'ordinary dependency unresolved'; END IF;
   IF NEW.effect='CANCEL_W1' THEN
    IF NOT EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE id=NEW."cancelledCommandId" AND state='REVOCATION_PENDING')
     THEN RAISE EXCEPTION 'ordinary cancellation lacks revoked dispatch slot'; END IF;
   ELSIF EXISTS (SELECT 1 FROM ordinary_reservation_commands c WHERE c."markerId"=NEW."markerId"
     AND c.state='WAITING' AND c."queueOrdinal"<NEW."queueOrdinal"
     AND (c."dependsOnCommandId" IS NULL OR EXISTS
      (SELECT 1 FROM ordinary_reservation_commands p WHERE p.id=c."dependsOnCommandId" AND p.state IN ('ACKNOWLEDGED','CANCELLED'))))
    THEN RAISE EXCEPTION 'ordinary queue order violated'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ordinary_command_guard BEFORE INSERT OR UPDATE OR DELETE ON ordinary_reservation_commands
 FOR EACH ROW EXECUTE FUNCTION ordinary_command_guard();

CREATE FUNCTION ordinary_marker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND (NEW."ordinaryEnqueueSequence"<>0 OR NEW."ordinaryCommandSequence"<>0 OR NEW."ordinaryAcknowledgedSequence"<>0)
  THEN RAISE EXCEPTION 'ordinary counters must start zero'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW."ordinaryEnqueueSequence"<OLD."ordinaryEnqueueSequence" OR NEW."ordinaryCommandSequence"<OLD."ordinaryCommandSequence"
   OR NEW."ordinaryAcknowledgedSequence"<OLD."ordinaryAcknowledgedSequence"
   THEN RAISE EXCEPTION 'ordinary counters cannot decrease'; END IF;
  IF NEW."ordinaryEnqueueSequence"::bigint>OLD."ordinaryEnqueueSequence"::bigint+1
   OR NEW."ordinaryCommandSequence"::bigint>OLD."ordinaryCommandSequence"::bigint+1
   THEN RAISE EXCEPTION 'ordinary allocation must increment once'; END IF;
  IF OLD."ordinaryProvenanceState"='TRACKED' AND NEW."ordinaryProvenanceState"<>'TRACKED'
   THEN RAISE EXCEPTION 'ordinary provenance cannot be downgraded'; END IF;
  IF OLD."ordinaryProvenanceState"='HISTORICAL_UNVERIFIED' AND NEW."ordinaryProvenanceState"<>'HISTORICAL_UNVERIFIED'
   THEN RAISE EXCEPTION 'historical ordinary provenance cannot be adopted'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ordinary_marker_guard BEFORE INSERT OR UPDATE ON cart_reservation_sync_states
 FOR EACH ROW EXECUTE FUNCTION ordinary_marker_guard();

-- Deferred checks see the transaction's final journal. MAX is verification only,
-- NEVER allocation. No ancestor locks/updates, so marker-first order is preserved.
CREATE FUNCTION ordinary_journal_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; m cart_reservation_sync_states%ROWTYPE; n bigint; s integer; a integer; q integer;
BEGIN
 IF TG_TABLE_NAME='cart_reservation_sync_states' THEN
  IF TG_OP='UPDATE' AND ROW(NEW."ordinaryEnqueueSequence",NEW."ordinaryCommandSequence",NEW."ordinaryAcknowledgedSequence")
   IS NOT DISTINCT FROM ROW(OLD."ordinaryEnqueueSequence",OLD."ordinaryCommandSequence",OLD."ordinaryAcknowledgedSequence") THEN RETURN NULL; END IF;
  k=NEW.id;
 ELSE k=NEW."markerId"; END IF;
 SELECT * INTO m FROM cart_reservation_sync_states WHERE id=k;
 SELECT count(*),COALESCE(max(sequence),0),COALESCE(max(sequence) FILTER (WHERE state='ACKNOWLEDGED'),0),COALESCE(max("queueOrdinal"),0)
  INTO n,s,a,q FROM ordinary_reservation_commands WHERE "markerId"=k;
 IF n<>m."ordinaryEnqueueSequence" OR q<>m."ordinaryEnqueueSequence" OR s<>m."ordinaryCommandSequence" OR a<>m."ordinaryAcknowledgedSequence"
  THEN RAISE EXCEPTION 'ordinary journal counter evidence mismatch'; END IF;
 -- Validate every acknowledged edge, not merely the final aggregate cursor.
 -- Allocated losing sequences remain gaps; only acknowledged rows are barriers.
 IF EXISTS (
  SELECT 1 FROM ordinary_reservation_commands c
  WHERE c."markerId"=k AND c.state='ACKNOWLEDGED'
   AND c."expectedSequence" IS DISTINCT FROM COALESCE((
    SELECT max(p.sequence) FROM ordinary_reservation_commands p
    WHERE p."markerId"=k AND p.state='ACKNOWLEDGED' AND p.sequence<c.sequence),0))
  THEN RAISE EXCEPTION 'ordinary acknowledgement predecessor mismatch'; END IF;
 -- Both directions are required: the winner must have its exact durable loser.
 -- This is final-state validation only; never select a winner or repair a row.
 IF EXISTS (
  SELECT 1 FROM ordinary_reservation_commands c
  JOIN ordinary_reservation_commands w ON w.id=c."cancelledCommandId"
  WHERE c."markerId"=k AND c.effect='CANCEL_W1' AND (
   (c.state='ACKNOWLEDGED' AND w.state<>'CANCELLED') OR
   (w.state='ACKNOWLEDGED' AND c.state<>'REVOKED')))
  THEN RAISE EXCEPTION 'ordinary competing acknowledgement outcome mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ordinary_marker_consistency AFTER INSERT OR UPDATE ON cart_reservation_sync_states
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_journal_consistency();
CREATE CONSTRAINT TRIGGER ordinary_command_consistency AFTER INSERT OR UPDATE ON ordinary_reservation_commands
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_journal_consistency();

CREATE FUNCTION ordinary_lifecycle_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o ordinary_reservation_owners%ROWTYPE; journal_row ordinary_reservation_commands%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='ordinary_reservation_owners' THEN
  SELECT * INTO o FROM ordinary_reservation_owners WHERE id=NEW.id;
  IF NOT EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE "ownerId"=o.id AND effect='W1')
   THEN RAISE EXCEPTION 'ordinary owner requires durable issuance command'; END IF;
  IF o.state='ACTIVE' AND NOT EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE "ownerId"=o.id AND effect='W1' AND state='ACKNOWLEDGED')
   THEN RAISE EXCEPTION 'ordinary activation lacks acknowledgement'; END IF;
  IF o.state='RELEASE_PENDING' AND NOT EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE "ownerId"=o.id AND effect='RELEASE')
   THEN RAISE EXCEPTION 'ordinary release intent missing'; END IF;
  IF o.state='SUPERSEDED' AND NOT EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE "sourceOwnerId"=o.id AND "w1Transition"='IMMEDIATE_PREDECESSOR' AND state='ACKNOWLEDGED')
   THEN RAISE EXCEPTION 'ordinary replacement acknowledgement missing'; END IF;
  IF o.state='REVOKED' AND EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE "ownerId"=o.id AND effect='W1' AND state NOT IN ('CANCELLED','REVOKED'))
   THEN RAISE EXCEPTION 'ordinary revocation unresolved'; END IF;
  IF o.state='CONSUMED' AND NOT EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE "ownerId"=o.id AND effect IN ('RELEASE','CHECKOUT_COMPLETE') AND state='ACKNOWLEDGED')
   THEN RAISE EXCEPTION 'ordinary consumption acknowledgement missing'; END IF;
  IF o."checkoutManifestId" IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM checkout_reservation_settlements c JOIN checkout_reservation_resources r ON r."settlementId"=c.id
    JOIN checkout_attempts a ON a.id=c."attemptId"
   WHERE c.id=o."checkoutManifestId" AND c.sealed AND c.incarnation=o.incarnation
    AND c."reservationExecutionEpoch"=o."reservationExecutionEpoch" AND a."cartId"=o."cartId" AND a."customerId"=o."customerId"
    AND r."markerId"=o."markerId" AND r.generation=o.generation AND r."holdInstanceId"=o."holdInstanceId" AND r."productId"=o."productId"
    AND (o.state<>'TRANSFERRED' OR c.state IN ('ACQUIRED','FINALIZE_PENDING','REVERT_PENDING','SETTLED')))
   THEN RAISE EXCEPTION 'ordinary transfer provenance rejected'; END IF;
 ELSE
  SELECT * INTO journal_row FROM ordinary_reservation_commands WHERE id=NEW.id;
  IF journal_row.state='REVOCATION_PENDING' AND NOT EXISTS (
   SELECT 1 FROM ordinary_reservation_commands WHERE "cancelledCommandId"=journal_row.id AND state IN ('PENDING','UNCERTAIN'))
   THEN RAISE EXCEPTION 'ordinary cancellation obligation missing'; END IF;
  IF journal_row.state='CANCELLED' AND NOT EXISTS (
   SELECT 1 FROM ordinary_reservation_commands WHERE "cancelledCommandId"=journal_row.id AND state='ACKNOWLEDGED')
   THEN RAISE EXCEPTION 'ordinary cancellation acknowledgement missing'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ordinary_owner_evidence AFTER INSERT OR UPDATE ON ordinary_reservation_owners
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_lifecycle_evidence();
CREATE CONSTRAINT TRIGGER ordinary_command_evidence AFTER INSERT OR UPDATE ON ordinary_reservation_commands
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_lifecycle_evidence();
