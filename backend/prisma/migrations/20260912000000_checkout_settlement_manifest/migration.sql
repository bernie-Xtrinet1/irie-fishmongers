-- CreateEnum
CREATE TYPE "CheckoutSettlementState" AS ENUM ('PREPARED', 'ACQUIRED', 'FINALIZE_PENDING', 'REVERT_PENDING', 'SETTLED');

-- CreateEnum
CREATE TYPE "CheckoutSettlementEffect" AS ENUM ('CHECKOUT_FINALIZE', 'CHECKOUT_REVERT_DELETE_ONLY', 'CHECKOUT_REVERT_RESTORE_ACTIVE');

-- CreateTable
CREATE TABLE "checkout_reservation_settlements" (
    "id" UUID NOT NULL,
    "attemptId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "incarnation" UUID NOT NULL,
    "reservationExecutionEpoch" INTEGER NOT NULL,
    "captureTransitionId" UUID NOT NULL,
    "state" "CheckoutSettlementState" NOT NULL DEFAULT 'PREPARED',
    "effect" "CheckoutSettlementEffect",
    "acquisitionReplayId" UUID NOT NULL,
    "settlementReplayId" UUID,
    "completionReceiptHash" VARCHAR(64),
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_reservation_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_reservation_resources" (
    "id" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "productId" TEXT NOT NULL,
    "markerId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "holdInstanceId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "checkout_reservation_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_reservation_settlements_attemptId_key" ON "checkout_reservation_settlements"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_reservation_settlements_settlementReplayId_key" ON "checkout_reservation_settlements"("settlementReplayId");
CREATE UNIQUE INDEX "checkout_reservation_settlements_acquisitionReplayId_key" ON "checkout_reservation_settlements"("acquisitionReplayId");

-- CreateIndex
CREATE INDEX "checkout_reservation_settlements_state_id_idx" ON "checkout_reservation_settlements"("state", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_reservation_resources_holdInstanceId_key" ON "checkout_reservation_resources"("holdInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_reservation_resources_settlementId_productId_key" ON "checkout_reservation_resources"("settlementId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_reservation_resources_settlementId_markerId_key" ON "checkout_reservation_resources"("settlementId", "markerId");

-- AddForeignKey
ALTER TABLE "checkout_reservation_settlements" ADD CONSTRAINT "checkout_reservation_settlements_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "checkout_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_reservation_settlements" ADD CONSTRAINT "checkout_reservation_settlements_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "checkout_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_reservation_settlements" ADD CONSTRAINT "checkout_reservation_settlements_captureTransitionId_fkey" FOREIGN KEY ("captureTransitionId") REFERENCES "reservation_fence_transitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_reservation_resources" ADD CONSTRAINT "checkout_reservation_resources_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "checkout_reservation_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additive only: no UPDATE/backfill of any historical record.
ALTER TABLE "checkout_reservation_resources" ADD CONSTRAINT settlement_resource_bounds
  CHECK (generation >= 0 AND quantity > 0);
CREATE FUNCTION checkout_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op checkout_operations%ROWTYPE; a checkout_attempts%ROWTYPE;
  f reservation_fence_transitions%ROWTYPE; n INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement evidence is retained' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO op FROM checkout_operations WHERE id = NEW."operationId" FOR UPDATE;
  SELECT * INTO a FROM checkout_attempts WHERE id = NEW."attemptId" FOR UPDATE;
  SELECT * INTO f FROM reservation_fence_transitions WHERE id = NEW."captureTransitionId";
  IF op."selectedPath" IS DISTINCT FROM 'CART_SCOPED' OR a."selectedPath" IS DISTINCT FROM 'CART_SCOPED'
    OR op."reservationExecutionEpoch" IS DISTINCT FROM NEW."reservationExecutionEpoch"
    OR a."reservationExecutionEpoch" IS DISTINCT FROM NEW."reservationExecutionEpoch"
    OR NEW."reservationExecutionEpoch" <= 0 OR a."idempotencyKey" IS DISTINCT FROM op."operationKey"
    OR a."cartId" IS DISTINCT FROM op."cartId" OR a."customerId" IS DISTINCT FROM op."customerId"
    OR f.incarnation IS DISTINCT FROM NEW.incarnation OR f.epoch IS DISTINCT FROM NEW."reservationExecutionEpoch"
    OR f.status IS DISTINCT FROM 'ACKNOWLEDGED' THEN
    RAISE EXCEPTION 'invalid settlement provenance' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PREPARED' OR NEW.effect IS NOT NULL OR NEW.sealed OR a.status <> 'PROCESSING'
      OR op."reservationCapabilityState" IS DISTINCT FROM 'ACTIVE' OR f.phase <> 'OPEN' THEN
      RAISE EXCEPTION 'invalid initial settlement' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.id, NEW."attemptId", NEW."operationId", NEW.incarnation, NEW."reservationExecutionEpoch",
        NEW."captureTransitionId", NEW."acquisitionReplayId", NEW."createdAt") IS DISTINCT FROM
       (OLD.id, OLD."attemptId", OLD."operationId", OLD.incarnation, OLD."reservationExecutionEpoch",
        OLD."captureTransitionId", OLD."acquisitionReplayId", OLD."createdAt") OR
       (OLD."settlementReplayId" IS NOT NULL AND NEW."settlementReplayId" IS DISTINCT FROM OLD."settlementReplayId") OR
       (OLD."completionReceiptHash" IS NOT NULL AND NEW."completionReceiptHash" IS DISTINCT FROM OLD."completionReceiptHash") OR
       (OLD.sealed AND NOT NEW.sealed) OR (OLD.effect IS NOT NULL AND NEW.effect IS DISTINCT FROM OLD.effect) THEN
      RAISE EXCEPTION 'immutable settlement identity' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state = 'PREPARED' AND NEW.state IN ('ACQUIRED','REVERT_PENDING')) OR
      (OLD.state = 'ACQUIRED' AND NEW.state IN ('FINALIZE_PENDING','REVERT_PENDING')) OR
      (OLD.state IN ('FINALIZE_PENDING','REVERT_PENDING') AND NEW.state = 'SETTLED')) THEN
      RAISE EXCEPTION 'invalid settlement transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW.effect IS NULL) <> (NEW."settlementReplayId" IS NULL) OR
     NEW."settlementReplayId" = NEW."acquisitionReplayId" OR
     (NEW.state = 'SETTLED') <> (NEW."completionReceiptHash" IS NOT NULL) OR
     (NEW."completionReceiptHash" IS NOT NULL AND NEW."completionReceiptHash" !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'invalid action-bound completion evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('PREPARED','ACQUIRED') AND NEW.effect IS NOT NULL OR
     NEW.state = 'FINALIZE_PENDING' AND (NEW.effect IS DISTINCT FROM 'CHECKOUT_FINALIZE' OR
       a.status <> 'COMMITTED' OR a."orderId" IS NULL) OR
     NEW.state = 'REVERT_PENDING' AND (NEW.effect IS NULL OR NEW.effect = 'CHECKOUT_FINALIZE' OR
       a.status <> 'FAILED' OR a."orderId" IS NOT NULL) OR
     NEW.state = 'SETTLED' AND NEW.effect IS NULL THEN
    RAISE EXCEPTION 'invalid settlement outcome' USING ERRCODE = '23514';
  END IF;
  IF NEW.sealed THEN
    SELECT count(*) INTO n FROM checkout_reservation_resources WHERE "settlementId" = NEW.id;
    IF n < 1 OR n > 100 THEN RAISE EXCEPTION 'invalid resource count' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER checkout_settlement_guard BEFORE INSERT OR UPDATE OR DELETE ON checkout_reservation_settlements
  FOR EACH ROW EXECUTE FUNCTION checkout_settlement_guard();

CREATE FUNCTION checkout_settlement_resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s checkout_reservation_settlements%ROWTYPE; op checkout_operations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'immutable settlement resource' USING ERRCODE = '23514'; END IF;
  SELECT * INTO s FROM checkout_reservation_settlements WHERE id = NEW."settlementId" FOR UPDATE;
  SELECT * INTO op FROM checkout_operations WHERE id = s."operationId";
  IF s.sealed OR s.state <> 'PREPARED' OR NOT EXISTS (
    SELECT 1 FROM cart_reservation_sync_states WHERE id = NEW."markerId" AND "cartId" = op."cartId"
      AND "productId" = NEW."productId" AND generation = NEW.generation AND "expectedQuantity" = NEW.quantity)
    OR (SELECT count(*) FROM checkout_reservation_resources WHERE "settlementId" = s.id) >= 100 THEN
    RAISE EXCEPTION 'invalid resource capture' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER checkout_settlement_resource_guard BEFORE INSERT OR UPDATE OR DELETE ON checkout_reservation_resources
  FOR EACH ROW EXECUTE FUNCTION checkout_settlement_resource_guard();

-- A construction transaction may insert rows then seal, but cannot commit an
-- incomplete manifest. Deferred check reads the final row, not the old event.
CREATE FUNCTION checkout_settlement_sealed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM checkout_reservation_settlements WHERE id = NEW.id AND NOT sealed) THEN
    RAISE EXCEPTION 'manifest must be sealed before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER checkout_settlement_sealed_guard AFTER INSERT OR UPDATE ON checkout_reservation_settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION checkout_settlement_sealed_guard();
