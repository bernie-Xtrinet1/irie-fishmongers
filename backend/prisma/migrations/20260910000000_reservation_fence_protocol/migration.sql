-- Additive, inactive protocol. Historical capabilities intentionally stay NULL.
CREATE TYPE "ReservationCapabilityState" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "ReservationFencePhase" AS ENUM ('OPEN', 'DRAINING', 'FROZEN', 'RETIRED');
CREATE TYPE "ReservationFenceStatus" AS ENUM ('PREPARED', 'ACKNOWLEDGED');
ALTER TABLE "checkout_operations"
  ADD COLUMN "reservationExecutionEpoch" INTEGER,
  ADD COLUMN "reservationCapabilityState" "ReservationCapabilityState",
  ADD CONSTRAINT "operation_capability_shape" CHECK (
    ("reservationExecutionEpoch" IS NULL AND "reservationCapabilityState" IS NULL) OR
    ("reservationExecutionEpoch" > 0 AND "reservationExecutionEpoch" IS NOT NULL AND
     "reservationCapabilityState" IS NOT NULL AND "selectedPath" IS NOT NULL AND "selectedPath" = 'CART_SCOPED'));
ALTER TABLE "checkout_attempts" ADD COLUMN "reservationExecutionEpoch" INTEGER,
  ADD CONSTRAINT "attempt_epoch_shape" CHECK ("reservationExecutionEpoch" IS NULL OR
    ("reservationExecutionEpoch" > 0 AND "selectedPath" IS NOT NULL AND "selectedPath" = 'CART_SCOPED'));

CREATE TABLE "reservation_fence_transitions" (
  "id" UUID PRIMARY KEY,
  "revision" INTEGER NOT NULL UNIQUE CHECK ("revision" > 0),
  "incarnation" UUID NOT NULL,
  "epoch" INTEGER NOT NULL CHECK ("epoch" > 0),
  "phase" "ReservationFencePhase" NOT NULL,
  "protocol" INTEGER NOT NULL CHECK ("protocol" = 1),
  "predecessor" JSONB,
  "mode" "ReservationEngineMode" NOT NULL,
  "modeRevision" INTEGER,
  "status" "ReservationFenceStatus" NOT NULL DEFAULT 'PREPARED',
  "bootstrap" BOOLEAN NOT NULL DEFAULT false,
  "endpointAcknowledgement" UUID,
  "reason" VARCHAR(32) NOT NULL CHECK ("reason" IN ('BOOTSTRAP', 'RESTRICT', 'OPEN', 'ABORT_FREEZE', 'RETIRE')),
  "actorId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  CONSTRAINT "fence_ack_shape" CHECK (("status" = 'PREPARED' AND "acknowledgedAt" IS NULL) OR
    ("status" = 'ACKNOWLEDGED' AND "acknowledgedAt" IS NOT NULL)),
  CONSTRAINT "closed_bootstrap" CHECK (NOT "bootstrap" OR
    ("phase" = 'FROZEN' AND "endpointAcknowledgement" IS NOT NULL))
);
CREATE INDEX "reservation_fence_transitions_incarnation_epoch_idx"
  ON "reservation_fence_transitions" ("incarnation", "epoch");

-- Guard only capability-bound paths; pre-protocol NULL rows retain their
-- existing behavior. A bound operation cannot change identity or provenance.
CREATE FUNCTION reservation_operation_capability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."reservationExecutionEpoch" IS NULL AND NEW."reservationExecutionEpoch" IS NOT NULL AND
    (OLD."selectedPath" IS NOT NULL OR EXISTS (SELECT 1 FROM "checkout_attempts"
      WHERE "idempotencyKey" = OLD."operationKey")) THEN
    RAISE EXCEPTION 'historical capability remains unknown' USING ERRCODE = '23514';
  END IF;
  IF OLD."reservationExecutionEpoch" IS NOT NULL AND (
    NEW."reservationExecutionEpoch" IS DISTINCT FROM OLD."reservationExecutionEpoch" OR
    NEW."selectedPath" IS DISTINCT FROM OLD."selectedPath" OR
    NEW."operationKey" IS DISTINCT FROM OLD."operationKey" OR
    NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
    NEW."cartId" IS DISTINCT FROM OLD."cartId" OR
    (OLD."reservationCapabilityState" = 'REVOKED' AND NEW."reservationCapabilityState" IS DISTINCT FROM 'REVOKED')
  ) THEN RAISE EXCEPTION 'immutable reservation capability' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_operation_capability_guard BEFORE UPDATE ON "checkout_operations"
  FOR EACH ROW EXECUTE FUNCTION reservation_operation_capability_guard();

CREATE FUNCTION reservation_attempt_capability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation "checkout_operations"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."reservationExecutionEpoch" IS DISTINCT FROM OLD."reservationExecutionEpoch" OR
      (OLD."reservationExecutionEpoch" IS NOT NULL AND (
        NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
        NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."cartId" IS DISTINCT FROM OLD."cartId" OR
        NEW."selectedPath" IS DISTINCT FROM OLD."selectedPath")) THEN
      RAISE EXCEPTION 'immutable inherited reservation epoch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW; -- Revocation never blocks heartbeat/terminal updates to an existing attempt.
  END IF;
  -- Serialize inheritance against first binding and revocation, including a
  -- concurrent NULL -> bound operation. Existing NULL rows remain valid.
  SELECT * INTO operation FROM "checkout_operations" WHERE "operationKey" = NEW."idempotencyKey" FOR UPDATE;
  IF operation."reservationExecutionEpoch" IS NOT NULL OR NEW."reservationExecutionEpoch" IS NOT NULL THEN
    IF operation."reservationCapabilityState" IS DISTINCT FROM 'ACTIVE' OR
      operation."reservationExecutionEpoch" IS DISTINCT FROM NEW."reservationExecutionEpoch" OR
      operation."customerId" IS DISTINCT FROM NEW."customerId" OR operation."cartId" IS DISTINCT FROM NEW."cartId" OR
      NEW."selectedPath" IS DISTINCT FROM 'CART_SCOPED' THEN
      RAISE EXCEPTION 'invalid inherited reservation capability' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_attempt_capability_guard BEFORE INSERT OR UPDATE ON "checkout_attempts"
  FOR EACH ROW EXECUTE FUNCTION reservation_attempt_capability_guard();
