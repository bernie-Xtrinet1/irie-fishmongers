-- Phase E.1: durable payment-provider initiation lifecycle.
-- PaymentStatus remains the authoritative financial state.

CREATE TYPE "PaymentInitiationStatus" AS ENUM (
  'NOT_STARTED',
  'INITIATING',
  'ESTABLISHED',
  'RECONCILE_REQUIRED',
  'FAILED'
);

ALTER TABLE "payments"
ADD COLUMN "initiationStatus" "PaymentInitiationStatus" NOT NULL DEFAULT 'NOT_STARTED';

-- Existing payments created by the pre-Phase-E flow only persisted after a
-- provider result was obtained. A stored provider reference therefore means
-- that provider initiation had already been established.
UPDATE "payments"
SET "initiationStatus" = 'ESTABLISHED'
WHERE "providerReference" IS NOT NULL;
