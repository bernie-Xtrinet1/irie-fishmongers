-- CreateEnum
CREATE TYPE "SettlementEvidenceProvenance" AS ENUM ('AUTHENTICATED_WEBHOOK', 'VERIFIED_STATUS_POLL', 'PROVISIONAL_BROWSER_RETURN', 'ADMIN_OVERRIDE', 'TRUSTED_TEST_SIMULATOR');

-- CreateEnum
CREATE TYPE "SettlementDisposition" AS ENUM ('APPLIED', 'DUPLICATE_IGNORED', 'CONFLICT_REJECTED', 'SETTLED_AFTER_CANCELLATION', 'PROVISIONAL_RECORDED');

-- AlterEnum
ALTER TYPE "RefundStatus" ADD VALUE 'REQUIRED';
ALTER TYPE "RefundStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "RefundStatus" ADD VALUE 'RECONCILE_REQUIRED';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "merchantAccountId" TEXT NOT NULL DEFAULT 'default';

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN "idempotencyKey" TEXT;

-- CreateTable
CREATE TABLE "payment_settlement_events" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProviderName" NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "checkoutAttemptId" TEXT,
    "gatewayTxnId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JMD',
    "outcome" "PaymentStatus" NOT NULL,
    "provenance" "SettlementEvidenceProvenance" NOT NULL,
    "disposition" "SettlementDisposition" NOT NULL,
    "evidenceDigest" TEXT NOT NULL,
    "sanitizedPayload" JSONB,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_settlement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_settlement_receipts" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProviderName" NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "gatewayTxnId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disposition" "SettlementDisposition" NOT NULL,
    "sourceIp" TEXT,
    "signatureValid" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "payment_settlement_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_outbox" (
    "id" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_settlement_events_paymentId_idx" ON "payment_settlement_events"("paymentId");

-- CreateIndex
CREATE INDEX "payment_settlement_events_orderId_idx" ON "payment_settlement_events"("orderId");

-- CreateIndex
CREATE INDEX "payment_settlement_events_gatewayTxnId_idx" ON "payment_settlement_events"("gatewayTxnId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_settlement_events_provider_merchantAccountId_eventI_key" ON "payment_settlement_events"("provider", "merchantAccountId", "eventId");

-- CreateIndex
CREATE INDEX "payment_settlement_receipts_provider_merchantAccountId_even_idx" ON "payment_settlement_receipts"("provider", "merchantAccountId", "eventId");

-- CreateIndex
CREATE INDEX "payment_settlement_receipts_gatewayTxnId_idx" ON "payment_settlement_receipts"("gatewayTxnId");

-- CreateIndex
CREATE INDEX "payment_outbox_published_createdAt_idx" ON "payment_outbox"("published", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_merchantAccountId_providerReference_key" ON "payments"("provider", "merchantAccountId", "providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotencyKey_key" ON "refunds"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "payment_settlement_events" ADD CONSTRAINT "payment_settlement_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_settlement_events" ADD CONSTRAINT "payment_settlement_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTriggerFunction
CREATE OR REPLACE FUNCTION prevent_payment_settlement_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'payment_settlement_events table is append-only: % operation is forbidden.', TG_OP
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER payment_settlement_events_immutable_guard
BEFORE UPDATE OR DELETE ON "payment_settlement_events"
FOR EACH ROW EXECUTE FUNCTION prevent_payment_settlement_event_mutation();
