-- ============================================================================
-- Migration #69: WP4.3B.4F.7D.4B.7B — F-D4B3A-03
-- Durable Provider Refund-Attempt Ledger, Obligation Correlation & Dispatch Guards
--
-- Preserves all existing Migrations #59-#68 financial triggers cleanly:
--   - trg_enforce_refund_failed_terminality (#61)
--   - refunds_financial_immutable_guard (#62/#66)
--   - refund_allocation_reversal_integrity_guard (#65)
--   - payments_financial_immutable_guard (#62/#66)
-- ============================================================================

-- 0. Preflight Integrity Gate (ERRCODE '23514' aborts on pre-existing corruption)
DO $$
DECLARE
  v_cnt BIGINT;
BEGIN
  -- 0.1 All existing refunds must have positive amount and valid payment/order links
  SELECT COUNT(*) INTO v_cnt
  FROM "refunds" r
  LEFT JOIN "payments" p ON p."id" = r."paymentId"
  WHERE r."amount" <= 0 OR p."id" IS NULL;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Migration #69 preflight failed: % refund(s) have non-positive amount or missing payment',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 0.2 Cumulative non-FAILED refunds per payment must not exceed payment.amount
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT p."id"
    FROM "payments" p
    JOIN "refunds" r ON r."paymentId" = p."id"
    WHERE r."status"::text <> 'FAILED'
    GROUP BY p."id", p."amount"
    HAVING SUM(r."amount") > p."amount"
  ) over_refunded;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Migration #69 preflight failed: % payment(s) have active refunds exceeding payment.amount',
      v_cnt
      USING ERRCODE = '23514';
  END IF;
END $$;

-- 1. Create Additive Enums
CREATE TYPE "RefundObligationType" AS ENUM (
  'ORDER_CANCELLATION',
  'VENDOR_ORDER_CANCELLATION',
  'VENDOR_ORDER_REJECTION',
  'SETTLED_AFTER_CANCELLATION',
  'ADMIN_EXCEPTIONAL_ADJUSTMENT'
);

CREATE TYPE "RefundObligationStatus" AS ENUM (
  'OPEN',
  'IN_FLIGHT',
  'PENDING_PROVIDER',
  'RECONCILE_REQUIRED',
  'FULFILLED',
  'CANCELLED_VOIDED'
);

CREATE TYPE "RefundHistoricalClassification" AS ENUM (
  'NATIVE',
  'LEGACY_CLEAN_OBLIGATION',
  'LEGACY_VERIFIED_COMPLETED',
  'LEGACY_COMPLETED_AMBIGUOUS_OR_MISSING_REF',
  'LEGACY_AMBIGUOUS_CHARGE_REF',
  'LEGACY_UNRESOLVED_IN_FLIGHT',
  'LEGACY_PENDING_VERIFIED',
  'LEGACY_PENDING_NO_REF',
  'LEGACY_PRE_OBLIGATION_TERMINAL_FAILED'
);

CREATE TYPE "RefundExecutionChannel" AS ENUM (
  'AUTOMATED_GATEWAY',
  'COD_INTERNAL',
  'MANUAL_PORTAL_SETTLEMENT',
  'LEGACY_BACKFILL'
);

CREATE TYPE "RefundAttemptStatus" AS ENUM (
  'PREPARED',
  'DISPATCHING',
  'PROVIDER_PENDING',
  'AMBIGUOUS_OUTCOME',
  'COMPLETED',
  'FAILED',
  'CANCELLED_BEFORE_DISPATCH'
);

CREATE TYPE "RefundAttemptFailureClass" AS ENUM (
  'NONE',
  'UNSUPPORTED_OPERATION',
  'VALIDATION_REJECTED_BEFORE_SEND',
  'PROVIDER_DEFINITIVE_DECLINE',
  'TRANSPORT_AMBIGUOUS',
  'PROCESS_CRASH_SUSPECTED',
  'EVIDENCE_CONTRADICTION',
  'LEGACY_REFERENCE_AMBIGUOUS',
  'POLICY_ABORTED'
);

CREATE TYPE "RefundAttemptEventType" AS ENUM (
  'ATTEMPT_PREPARED',
  'DISPATCH_CLAIMED',
  'DISPATCH_ABORTED_UNSUPPORTED',
  'DISPATCH_FAILED_PRE_SEND',
  'PROVIDER_SYNC_RESPONSE',
  'PROVIDER_TRANSPORT_TIMEOUT',
  'LEASE_EXPIRED_QUARANTINED',
  'WEBHOOK_OBSERVED',
  'STATUS_POLL_OBSERVED',
  'CONTRADICTION_QUARANTINED',
  'MANUAL_RECONCILIATION_APPLIED',
  'LEGACY_BACKFILL_RECORDED',
  'LEGACY_BACKFILL_QUARANTINED',
  'OUTBOX_EMITTED'
);

CREATE TYPE "RefundEvidenceProvenance" AS ENUM (
  'APPLICATION_SYNC_RESPONSE',
  'AUTHENTICATED_WEBHOOK',
  'VERIFIED_STATUS_POLL',
  'INTERNAL_COD_ADAPTER',
  'LEASE_TIMEOUT_SWEEPER',
  'DUAL_CONTROL_ADMIN_RECONCILIATION',
  'LEGACY_BACKFILL'
);

CREATE TYPE "RefundEvidenceDisposition" AS ENUM (
  'APPLIED',
  'DUPLICATE_IGNORED',
  'CONFLICT_REJECTED',
  'UNMATCHED_IGNORED',
  'SIGNATURE_REJECTED'
);

CREATE TYPE "RefundReconciliationActionType" AS ENUM (
  'MANUAL_OFFLINE_SETTLEMENT_COMPLETED',
  'RESOLVE_QUARANTINED_COMPLETED',
  'RESOLVE_QUARANTINED_DEFINITIVE_FAIL_NO_REMITTANCE',
  'VOID_OBLIGATION'
);

CREATE TYPE "RefundReconciliationApprovalStatus" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'APPLIED',
  'REJECTED'
);

-- 2. Create RefundObligation & Alter Refunds
CREATE TABLE "refund_obligations" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "vendorOrderId" TEXT,
  "obligationKey" TEXT NOT NULL,
  "obligationType" "RefundObligationType" NOT NULL,
  "authorizedAmount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'JMD',
  "reason" TEXT NOT NULL,
  "status" "RefundObligationStatus" NOT NULL DEFAULT 'OPEN',
  "historicalClassification" "RefundHistoricalClassification" NOT NULL DEFAULT 'NATIVE',
  "fulfilledRefundId" TEXT,
  "fulfilledAttemptId" TEXT,
  "voidApprovalId" TEXT,
  "createdByActorId" TEXT,
  "createdByRole" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_obligations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_refund_obligation_amount_positive" CHECK ("authorizedAmount" > 0),
  CONSTRAINT "chk_refund_obligation_key_non_empty" CHECK (length(btrim("obligationKey")) > 0),
  CONSTRAINT "chk_refund_obligation_currency_non_empty" CHECK (length(btrim("currency")) > 0),
  CONSTRAINT "chk_refund_obligation_reason_non_empty" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "chk_refund_obligation_fulfilled_links" CHECK (
    "status"::text <> 'FULFILLED'
    OR (
      "fulfilledRefundId" IS NOT NULL
      AND (
        "fulfilledAttemptId" IS NOT NULL
        OR "historicalClassification"::text = 'LEGACY_COMPLETED_AMBIGUOUS_OR_MISSING_REF'
      )
    )
  ),
  CONSTRAINT "chk_refund_obligation_void_approval" CHECK (
    "status"::text <> 'CANCELLED_VOIDED'
    OR "voidApprovalId" IS NOT NULL
    OR "historicalClassification"::text <> 'NATIVE'
  )
);

CREATE UNIQUE INDEX "refund_obligations_obligationKey_key" ON "refund_obligations"("obligationKey");
CREATE UNIQUE INDEX "refund_obligations_fulfilledRefundId_key" ON "refund_obligations"("fulfilledRefundId");
CREATE UNIQUE INDEX "refund_obligations_fulfilledAttemptId_key" ON "refund_obligations"("fulfilledAttemptId");
CREATE UNIQUE INDEX "refund_obligations_voidApprovalId_key" ON "refund_obligations"("voidApprovalId");
CREATE INDEX "refund_obligations_paymentId_status_idx" ON "refund_obligations"("paymentId", "status");
CREATE INDEX "refund_obligations_orderId_idx" ON "refund_obligations"("orderId");
CREATE INDEX "refund_obligations_vendorOrderId_idx" ON "refund_obligations"("vendorOrderId");

ALTER TABLE "refunds"
  ADD COLUMN "obligationId" TEXT,
  ADD COLUMN "supersedesRefundId" TEXT;

CREATE UNIQUE INDEX "refunds_supersedesRefundId_key" ON "refunds"("supersedesRefundId");
CREATE INDEX "refunds_obligationId_idx" ON "refunds"("obligationId");
CREATE UNIQUE INDEX "uq_refunds_one_active_per_obligation"
  ON "refunds"("obligationId")
  WHERE "obligationId" IS NOT NULL AND "status" <> 'FAILED'::"RefundStatus";

ALTER TABLE "refund_obligations"
  ADD CONSTRAINT "refund_obligations_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_obligations"
  ADD CONSTRAINT "refund_obligations_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_obligations"
  ADD CONSTRAINT "refund_obligations_vendorOrderId_fkey"
  FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_obligations"
  ADD CONSTRAINT "refund_obligations_fulfilledRefundId_fkey"
  FOREIGN KEY ("fulfilledRefundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_obligationId_fkey"
  FOREIGN KEY ("obligationId") REFERENCES "refund_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_supersedesRefundId_fkey"
  FOREIGN KEY ("supersedesRefundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Create Reconciliation Approvals, Attempts, Attempt Events & Evidence Receipts
CREATE TABLE "refund_reconciliation_approvals" (
  "id" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "refundId" TEXT,
  "attemptId" TEXT,
  "actionType" "RefundReconciliationActionType" NOT NULL,
  "evidenceType" TEXT NOT NULL,
  "externalSettlementReference" TEXT,
  "evidenceDigest" CHAR(64) NOT NULL,
  "rationale" TEXT NOT NULL,
  "requestedByActorId" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedByActorId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "status" "RefundReconciliationApprovalStatus" NOT NULL DEFAULT 'REQUESTED',

  CONSTRAINT "refund_reconciliation_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_refund_reconcil_evidence_type" CHECK (length(btrim("evidenceType")) > 0),
  CONSTRAINT "chk_refund_reconcil_digest_hex" CHECK ("evidenceDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_refund_reconcil_rationale" CHECK (length(btrim("rationale")) >= 10),
  CONSTRAINT "chk_refund_reconcil_requester" CHECK (length(btrim("requestedByActorId")) > 0),
  CONSTRAINT "chk_refund_reconcil_dual_control" CHECK (
    "approvedByActorId" IS NULL OR "requestedByActorId" <> "approvedByActorId"
  ),
  CONSTRAINT "chk_refund_reconcil_approved_fields" CHECK (
    "status"::text NOT IN ('APPROVED', 'APPLIED')
    OR ("approvedByActorId" IS NOT NULL AND "approvedAt" IS NOT NULL)
  ),
  CONSTRAINT "chk_refund_reconcil_applied_at" CHECK (
    "status"::text <> 'APPLIED' OR "appliedAt" IS NOT NULL
  )
);

CREATE INDEX "refund_reconciliation_approvals_obligationId_status_idx"
  ON "refund_reconciliation_approvals"("obligationId", "status");
CREATE INDEX "refund_reconciliation_approvals_refundId_idx"
  ON "refund_reconciliation_approvals"("refundId");
CREATE INDEX "refund_reconciliation_approvals_attemptId_idx"
  ON "refund_reconciliation_approvals"("attemptId");
CREATE UNIQUE INDEX "uq_refund_reconcil_ext_ref"
  ON "refund_reconciliation_approvals"(lower(btrim("externalSettlementReference")))
  WHERE "externalSettlementReference" IS NOT NULL
    AND length(btrim("externalSettlementReference")) > 0
    AND "status" IN (
      'APPROVED'::"RefundReconciliationApprovalStatus",
      'APPLIED'::"RefundReconciliationApprovalStatus"
    );
CREATE UNIQUE INDEX "uq_refund_reconcil_active_per_obligation"
  ON "refund_reconciliation_approvals"("obligationId")
  WHERE "status" IN (
    'REQUESTED'::"RefundReconciliationApprovalStatus",
    'APPROVED'::"RefundReconciliationApprovalStatus"
  );

CREATE TABLE "refund_provider_attempts" (
  "id" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "provider" "PaymentProviderName" NOT NULL,
  "merchantAccountId" TEXT NOT NULL DEFAULT 'default',
  "attemptSequence" INTEGER NOT NULL,
  "providerIdempotencyKey" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'JMD',
  "executionChannel" "RefundExecutionChannel" NOT NULL,
  "parentPaymentReference" TEXT,
  "providerRefundReference" TEXT,
  "status" "RefundAttemptStatus" NOT NULL DEFAULT 'PREPARED',
  "failureClassification" "RefundAttemptFailureClass" NOT NULL DEFAULT 'NONE',
  "retryEligible" BOOLEAN NOT NULL DEFAULT false,
  "historicalClassification" "RefundHistoricalClassification" NOT NULL DEFAULT 'NATIVE',
  "requestDigest" CHAR(64) NOT NULL,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchStartedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "providerRespondedAt" TIMESTAMP(3),
  "quarantinedAt" TIMESTAMP(3),
  "terminalizedAt" TIMESTAMP(3),
  "pollLockUntil" TIMESTAMP(3),
  "pollAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "resolvedByProvenance" "RefundEvidenceProvenance",
  "resolvedByEventId" TEXT,
  "reconciliationApprovalId" TEXT,
  "initiatedByActorId" TEXT,
  "initiatedByRole" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_provider_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_refund_attempt_seq_positive" CHECK ("attemptSequence" >= 1),
  CONSTRAINT "chk_refund_attempt_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "chk_refund_attempt_idem_non_empty" CHECK (length(btrim("providerIdempotencyKey")) > 0),
  CONSTRAINT "chk_refund_attempt_request_digest_hex" CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_refund_attempt_poll_count" CHECK ("pollAttemptCount" >= 0),
  CONSTRAINT "chk_refund_attempt_retry_eligible_guard" CHECK (
    "status"::text NOT IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'AMBIGUOUS_OUTCOME', 'COMPLETED')
    OR "retryEligible" = false
  ),
  CONSTRAINT "chk_refund_attempt_completed_evidence" CHECK (
    "status"::text <> 'COMPLETED'
    OR (
      "terminalizedAt" IS NOT NULL
      AND "resolvedByProvenance" IS NOT NULL
      AND "providerRefundReference" IS NOT NULL
      AND length(btrim("providerRefundReference")) > 0
      AND "retryEligible" = false
    )
  ),
  CONSTRAINT "chk_refund_attempt_terminal_timestamps" CHECK (
    "status"::text NOT IN ('FAILED', 'CANCELLED_BEFORE_DISPATCH')
    OR "terminalizedAt" IS NOT NULL
  ),
  CONSTRAINT "chk_refund_attempt_quarantine_timestamp" CHECK (
    "status"::text <> 'AMBIGUOUS_OUTCOME'
    OR "quarantinedAt" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "refund_provider_attempts_providerIdempotencyKey_key"
  ON "refund_provider_attempts"("providerIdempotencyKey");
CREATE UNIQUE INDEX "refund_provider_attempts_obligationId_attemptSequence_key"
  ON "refund_provider_attempts"("obligationId", "attemptSequence");
CREATE UNIQUE INDEX "refund_provider_attempts_refundId_attemptSequence_key"
  ON "refund_provider_attempts"("refundId", "attemptSequence");
CREATE INDEX "refund_provider_attempts_paymentId_status_idx"
  ON "refund_provider_attempts"("paymentId", "status");
CREATE INDEX "refund_provider_attempts_status_leaseExpiresAt_idx"
  ON "refund_provider_attempts"("status", "leaseExpiresAt");

CREATE UNIQUE INDEX "uq_refund_attempt_one_non_terminal_per_obligation"
  ON "refund_provider_attempts"("obligationId")
  WHERE "status" IN (
    'PREPARED'::"RefundAttemptStatus",
    'DISPATCHING'::"RefundAttemptStatus",
    'PROVIDER_PENDING'::"RefundAttemptStatus",
    'AMBIGUOUS_OUTCOME'::"RefundAttemptStatus"
  );
CREATE UNIQUE INDEX "uq_refund_attempt_one_non_terminal_per_refund"
  ON "refund_provider_attempts"("refundId")
  WHERE "status" IN (
    'PREPARED'::"RefundAttemptStatus",
    'DISPATCHING'::"RefundAttemptStatus",
    'PROVIDER_PENDING'::"RefundAttemptStatus",
    'AMBIGUOUS_OUTCOME'::"RefundAttemptStatus"
  );
CREATE UNIQUE INDEX "uq_refund_attempt_one_completed_per_obligation"
  ON "refund_provider_attempts"("obligationId")
  WHERE "status" = 'COMPLETED'::"RefundAttemptStatus";
CREATE UNIQUE INDEX "uq_refund_attempt_one_completed_per_refund"
  ON "refund_provider_attempts"("refundId")
  WHERE "status" = 'COMPLETED'::"RefundAttemptStatus";
CREATE UNIQUE INDEX "uq_refund_attempt_provider_refund_ref"
  ON "refund_provider_attempts"("provider", "merchantAccountId", lower(btrim("providerRefundReference")))
  WHERE "providerRefundReference" IS NOT NULL AND length(btrim("providerRefundReference")) > 0;

CREATE TABLE "refund_provider_attempt_events" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "eventSequence" INTEGER NOT NULL,
  "eventType" "RefundAttemptEventType" NOT NULL,
  "previousAttemptStatus" "RefundAttemptStatus",
  "resultingAttemptStatus" "RefundAttemptStatus" NOT NULL,
  "provenance" "RefundEvidenceProvenance" NOT NULL,
  "provider" "PaymentProviderName" NOT NULL,
  "merchantAccountId" TEXT NOT NULL,
  "providerEventId" TEXT,
  "providerRefundReference" TEXT,
  "httpStatusCode" INTEGER,
  "evidenceDigest" CHAR(64) NOT NULL,
  "sanitizedPayload" JSONB,
  "actorId" TEXT,
  "actorRole" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_provider_attempt_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_refund_attempt_event_seq_positive" CHECK ("eventSequence" >= 1),
  CONSTRAINT "chk_refund_attempt_event_digest_hex" CHECK ("evidenceDigest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "refund_provider_attempt_events_attemptId_eventSequence_key"
  ON "refund_provider_attempt_events"("attemptId", "eventSequence");
CREATE INDEX "refund_provider_attempt_events_refundId_idx"
  ON "refund_provider_attempt_events"("refundId");
CREATE INDEX "refund_provider_attempt_events_obligationId_idx"
  ON "refund_provider_attempt_events"("obligationId");
CREATE INDEX "refund_provider_attempt_events_provider_merchantAccountId_p_idx"
  ON "refund_provider_attempt_events"("provider", "merchantAccountId", "providerRefundReference");
CREATE UNIQUE INDEX "uq_refund_attempt_event_external"
  ON "refund_provider_attempt_events"("provider", "merchantAccountId", "providerEventId")
  WHERE "providerEventId" IS NOT NULL;

CREATE TABLE "refund_evidence_receipts" (
  "id" TEXT NOT NULL,
  "provider" "PaymentProviderName" NOT NULL,
  "merchantAccountId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "providerRefundReference" TEXT,
  "attemptId" TEXT,
  "refundId" TEXT,
  "obligationId" TEXT,
  "provenance" "RefundEvidenceProvenance" NOT NULL,
  "disposition" "RefundEvidenceDisposition" NOT NULL,
  "signatureValid" BOOLEAN NOT NULL DEFAULT false,
  "evidenceDigest" CHAR(64) NOT NULL,
  "sourceIp" TEXT,
  "rejectionReason" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_evidence_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_refund_evidence_receipt_digest_hex" CHECK ("evidenceDigest" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "refund_evidence_receipts_provider_merchantAccountId_eventId_idx"
  ON "refund_evidence_receipts"("provider", "merchantAccountId", "eventId");
CREATE INDEX "refund_evidence_receipts_attemptId_idx" ON "refund_evidence_receipts"("attemptId");
CREATE INDEX "refund_evidence_receipts_refundId_idx" ON "refund_evidence_receipts"("refundId");
CREATE INDEX "refund_evidence_receipts_obligationId_idx" ON "refund_evidence_receipts"("obligationId");

-- Foreign Keys Across Ledger Tables
ALTER TABLE "refund_reconciliation_approvals"
  ADD CONSTRAINT "refund_reconciliation_approvals_obligationId_fkey"
  FOREIGN KEY ("obligationId") REFERENCES "refund_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_reconciliation_approvals"
  ADD CONSTRAINT "refund_reconciliation_approvals_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_reconciliation_approvals"
  ADD CONSTRAINT "refund_reconciliation_approvals_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "refund_provider_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_provider_attempts"
  ADD CONSTRAINT "refund_provider_attempts_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_provider_attempts"
  ADD CONSTRAINT "refund_provider_attempts_obligationId_fkey"
  FOREIGN KEY ("obligationId") REFERENCES "refund_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_provider_attempts"
  ADD CONSTRAINT "refund_provider_attempts_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_provider_attempts"
  ADD CONSTRAINT "refund_provider_attempts_reconciliationApprovalId_fkey"
  FOREIGN KEY ("reconciliationApprovalId") REFERENCES "refund_reconciliation_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_provider_attempt_events"
  ADD CONSTRAINT "refund_provider_attempt_events_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "refund_provider_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_provider_attempt_events"
  ADD CONSTRAINT "refund_provider_attempt_events_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_provider_attempt_events"
  ADD CONSTRAINT "refund_provider_attempt_events_obligationId_fkey"
  FOREIGN KEY ("obligationId") REFERENCES "refund_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_evidence_receipts"
  ADD CONSTRAINT "refund_evidence_receipts_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "refund_provider_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_evidence_receipts"
  ADD CONSTRAINT "refund_evidence_receipts_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_evidence_receipts"
  ADD CONSTRAINT "refund_evidence_receipts_obligationId_fkey"
  FOREIGN KEY ("obligationId") REFERENCES "refund_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Deterministic Historical Backfill (Zero Fabricated Provider Evidence)
DO $$
DECLARE
  rec RECORD;
  v_digest TEXT;
  v_attempt_digest TEXT;
  v_evt_digest TEXT;
  v_rec_digest TEXT;
  v_obligation_id TEXT;
  v_attempt_id TEXT;
  v_event_id TEXT;
  v_receipt_id TEXT;
  v_obligation_key TEXT;
  v_obligation_type "RefundObligationType";
  v_vendor_order_id TEXT;
  v_trimmed_ref TEXT;
  v_matches_payment_ref BOOLEAN;
  v_ref_collision BOOLEAN;
  v_hist_class "RefundHistoricalClassification";
  v_obl_status "RefundObligationStatus";
  v_req_digest TEXT;
  v_ev_digest TEXT;
  v_exec_channel "RefundExecutionChannel";
BEGIN
  FOR rec IN
    SELECT
      r."id",
      r."idempotencyKey",
      r."paymentId",
      r."amount",
      r."reason",
      r."status"::text AS "refundStatus",
      r."providerReference" AS "refundRef",
      r."createdAt",
      r."updatedAt",
      p."orderId",
      p."provider",
      p."merchantAccountId",
      p."currency",
      p."providerReference" AS "paymentRef"
    FROM "refunds" r
    JOIN "payments" p ON p."id" = r."paymentId"
    WHERE r."obligationId" IS NULL
    ORDER BY r."createdAt" ASC, r."id" ASC
  LOOP
    v_digest := md5('m69_obl:' || rec."id");
    v_obligation_id := substr(v_digest,1,8)||'-'||substr(v_digest,9,4)||'-4'||substr(v_digest,14,3)||'-a'||substr(v_digest,18,3)||'-'||substr(v_digest,21,12);

    v_attempt_digest := md5('m69_att:' || rec."id");
    v_attempt_id := substr(v_attempt_digest,1,8)||'-'||substr(v_attempt_digest,9,4)||'-4'||substr(v_attempt_digest,14,3)||'-a'||substr(v_attempt_digest,18,3)||'-'||substr(v_attempt_digest,21,12);

    v_evt_digest := md5('m69_evt:' || rec."id");
    v_event_id := substr(v_evt_digest,1,8)||'-'||substr(v_evt_digest,9,4)||'-4'||substr(v_evt_digest,14,3)||'-a'||substr(v_evt_digest,18,3)||'-'||substr(v_evt_digest,21,12);

    v_rec_digest := md5('m69_rcpt:' || rec."id");
    v_receipt_id := substr(v_rec_digest,1,8)||'-'||substr(v_rec_digest,9,4)||'-4'||substr(v_rec_digest,14,3)||'-a'||substr(v_rec_digest,18,3)||'-'||substr(v_rec_digest,21,12);

    v_obligation_key := CASE
      WHEN rec."idempotencyKey" IS NOT NULL AND length(btrim(rec."idempotencyKey")) > 0 THEN btrim(rec."idempotencyKey")
      ELSE 'legacy_refund:' || rec."id"
    END;

    v_vendor_order_id := NULL;
    IF rec."idempotencyKey" LIKE 'refund_order_cancel_%' THEN
      v_obligation_type := 'ORDER_CANCELLATION';
    ELSIF rec."idempotencyKey" LIKE 'refund_vendor_order_cancel_%' THEN
      v_obligation_type := 'VENDOR_ORDER_CANCELLATION';
      SELECT vo."id" INTO v_vendor_order_id
      FROM "vendor_orders" vo
      WHERE vo."orderId" = rec."orderId"
        AND vo."id" = substring(rec."idempotencyKey" FROM length('refund_vendor_order_cancel_' || rec."paymentId" || '_') + 1)
      LIMIT 1;
    ELSIF rec."idempotencyKey" LIKE 'refund_vendor_order_reject_%' THEN
      v_obligation_type := 'VENDOR_ORDER_REJECTION';
      SELECT vo."id" INTO v_vendor_order_id
      FROM "vendor_orders" vo
      WHERE vo."orderId" = rec."orderId"
        AND vo."id" = substring(rec."idempotencyKey" FROM length('refund_vendor_order_reject_' || rec."paymentId" || '_') + 1)
      LIMIT 1;
    ELSIF rec."idempotencyKey" LIKE 'refund_post_cancel_%' THEN
      v_obligation_type := 'SETTLED_AFTER_CANCELLATION';
    ELSE
      v_obligation_type := 'ADMIN_EXCEPTIONAL_ADJUSTMENT';
    END IF;

    v_trimmed_ref := NULLIF(btrim(rec."refundRef"), '');
    v_matches_payment_ref := (
      v_trimmed_ref IS NOT NULL
      AND rec."paymentRef" IS NOT NULL
      AND lower(v_trimmed_ref) = lower(btrim(rec."paymentRef"))
    );
    v_ref_collision := (
      v_trimmed_ref IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "refund_provider_attempts" existing_att
        WHERE existing_att."provider" = rec."provider"
          AND existing_att."merchantAccountId" = rec."merchantAccountId"
          AND existing_att."providerRefundReference" IS NOT NULL
          AND lower(btrim(existing_att."providerRefundReference")) = lower(v_trimmed_ref)
      )
    );

    v_req_digest := encode(
      sha256(convert_to(rec."paymentId" || '|' || rec."id" || '|' || rec."amount"::text || '|' || rec."currency", 'UTF8')),
      'hex'
    );
    v_ev_digest := encode(
      sha256(convert_to(rec."id" || '|' || rec."refundStatus" || '|' || COALESCE(v_trimmed_ref, 'NULL'), 'UTF8')),
      'hex'
    );
    v_exec_channel := CASE
      WHEN rec."provider" = 'CASH_ON_DELIVERY'::"PaymentProviderName" THEN 'COD_INTERNAL'::"RefundExecutionChannel"
      ELSE 'LEGACY_BACKFILL'::"RefundExecutionChannel"
    END;

    -- Insert initial OPEN obligation before linking refund & attempts
    INSERT INTO "refund_obligations" (
      "id", "paymentId", "orderId", "vendorOrderId", "obligationKey", "obligationType",
      "authorizedAmount", "currency", "reason", "status", "historicalClassification",
      "createdAt", "updatedAt"
    ) VALUES (
      v_obligation_id, rec."paymentId", rec."orderId", v_vendor_order_id, v_obligation_key, v_obligation_type,
      rec."amount", rec."currency", rec."reason", 'OPEN', 'LEGACY_CLEAN_OBLIGATION',
      rec."createdAt", rec."updatedAt"
    );

    UPDATE "refunds"
    SET "obligationId" = v_obligation_id
    WHERE "id" = rec."id";

    IF rec."refundStatus" = 'REQUIRED' THEN
      IF v_trimmed_ref IS NULL THEN
        -- Clean un-dispatched obligation; stays OPEN with zero attempts
        NULL;
      ELSE
        -- REQUIRED row already carried a reference (e.g. legacy post-cancel charge ref) -> Quarantine!
        v_hist_class := 'LEGACY_AMBIGUOUS_CHARGE_REF';
        INSERT INTO "refund_provider_attempts" (
          "id", "refundId", "obligationId", "paymentId", "provider", "merchantAccountId",
          "attemptSequence", "providerIdempotencyKey", "amount", "currency", "executionChannel",
          "parentPaymentReference", "providerRefundReference", "status", "failureClassification",
          "retryEligible", "historicalClassification", "requestDigest",
          "preparedAt", "quarantinedAt", "createdAt", "updatedAt"
        ) VALUES (
          v_attempt_id, rec."id", v_obligation_id, rec."paymentId", rec."provider", rec."merchantAccountId",
          1, 'legacy_att:' || rec."id" || ':1', rec."amount", rec."currency", 'LEGACY_BACKFILL',
          rec."paymentRef", NULL, 'AMBIGUOUS_OUTCOME', 'LEGACY_REFERENCE_AMBIGUOUS',
          false, v_hist_class, v_req_digest,
          rec."createdAt", rec."updatedAt", rec."createdAt", rec."updatedAt"
        );
        INSERT INTO "refund_provider_attempt_events" (
          "id", "attemptId", "refundId", "obligationId", "eventSequence", "eventType",
          "previousAttemptStatus", "resultingAttemptStatus", "provenance", "provider", "merchantAccountId",
          "providerRefundReference", "evidenceDigest", "sanitizedPayload", "occurredAt", "recordedAt"
        ) VALUES (
          v_event_id, v_attempt_id, rec."id", v_obligation_id, 1, 'LEGACY_BACKFILL_QUARANTINED',
          NULL, 'AMBIGUOUS_OUTCOME', 'LEGACY_BACKFILL', rec."provider", rec."merchantAccountId",
          NULL, v_ev_digest,
          jsonb_build_object(
            'legacyRefundId', rec."id",
            'legacyStatus', rec."refundStatus",
            'legacyProviderReference', v_trimmed_ref,
            'matchesParentPaymentReference', v_matches_payment_ref
          ),
          rec."updatedAt", rec."updatedAt"
        );
        UPDATE "refund_obligations"
        SET "status" = 'RECONCILE_REQUIRED',
            "historicalClassification" = v_hist_class,
            "updatedAt" = rec."updatedAt"
        WHERE "id" = v_obligation_id;
      END IF;

    ELSIF rec."refundStatus" = 'PENDING' THEN
      IF v_trimmed_ref IS NOT NULL AND NOT v_matches_payment_ref AND NOT v_ref_collision THEN
        v_hist_class := 'LEGACY_PENDING_VERIFIED';
        INSERT INTO "refund_provider_attempts" (
          "id", "refundId", "obligationId", "paymentId", "provider", "merchantAccountId",
          "attemptSequence", "providerIdempotencyKey", "amount", "currency", "executionChannel",
          "parentPaymentReference", "providerRefundReference", "status", "failureClassification",
          "retryEligible", "historicalClassification", "requestDigest",
          "preparedAt", "dispatchStartedAt", "providerRespondedAt", "createdAt", "updatedAt"
        ) VALUES (
          v_attempt_id, rec."id", v_obligation_id, rec."paymentId", rec."provider", rec."merchantAccountId",
          1, 'legacy_att:' || rec."id" || ':1', rec."amount", rec."currency", v_exec_channel,
          rec."paymentRef", v_trimmed_ref, 'PROVIDER_PENDING', 'NONE',
          false, v_hist_class, v_req_digest,
          rec."createdAt", rec."createdAt", rec."updatedAt", rec."createdAt", rec."updatedAt"
        );
        INSERT INTO "refund_provider_attempt_events" (
          "id", "attemptId", "refundId", "obligationId", "eventSequence", "eventType",
          "previousAttemptStatus", "resultingAttemptStatus", "provenance", "provider", "merchantAccountId",
          "providerRefundReference", "evidenceDigest", "sanitizedPayload", "occurredAt", "recordedAt"
        ) VALUES (
          v_event_id, v_attempt_id, rec."id", v_obligation_id, 1, 'LEGACY_BACKFILL_RECORDED',
          NULL, 'PROVIDER_PENDING', 'LEGACY_BACKFILL', rec."provider", rec."merchantAccountId",
          v_trimmed_ref, v_ev_digest,
          jsonb_build_object('legacyRefundId', rec."id", 'legacyStatus', rec."refundStatus"),
          rec."updatedAt", rec."updatedAt"
        );
        UPDATE "refund_obligations"
        SET "status" = 'PENDING_PROVIDER',
            "historicalClassification" = v_hist_class,
            "updatedAt" = rec."updatedAt"
        WHERE "id" = v_obligation_id;
      ELSE
        v_hist_class := CASE
          WHEN v_trimmed_ref IS NULL THEN 'LEGACY_PENDING_NO_REF'::"RefundHistoricalClassification"
          ELSE 'LEGACY_AMBIGUOUS_CHARGE_REF'::"RefundHistoricalClassification"
        END;
        INSERT INTO "refund_provider_attempts" (
          "id", "refundId", "obligationId", "paymentId", "provider", "merchantAccountId",
          "attemptSequence", "providerIdempotencyKey", "amount", "currency", "executionChannel",
          "parentPaymentReference", "providerRefundReference", "status", "failureClassification",
          "retryEligible", "historicalClassification", "requestDigest",
          "preparedAt", "quarantinedAt", "createdAt", "updatedAt"
        ) VALUES (
          v_attempt_id, rec."id", v_obligation_id, rec."paymentId", rec."provider", rec."merchantAccountId",
          1, 'legacy_att:' || rec."id" || ':1', rec."amount", rec."currency", 'LEGACY_BACKFILL',
          rec."paymentRef", NULL, 'AMBIGUOUS_OUTCOME', 'LEGACY_REFERENCE_AMBIGUOUS',
          false, v_hist_class, v_req_digest,
          rec."createdAt", rec."updatedAt", rec."createdAt", rec."updatedAt"
        );
        INSERT INTO "refund_provider_attempt_events" (
          "id", "attemptId", "refundId", "obligationId", "eventSequence", "eventType",
          "previousAttemptStatus", "resultingAttemptStatus", "provenance", "provider", "merchantAccountId",
          "providerRefundReference", "evidenceDigest", "sanitizedPayload", "occurredAt", "recordedAt"
        ) VALUES (
          v_event_id, v_attempt_id, rec."id", v_obligation_id, 1, 'LEGACY_BACKFILL_QUARANTINED',
          NULL, 'AMBIGUOUS_OUTCOME', 'LEGACY_BACKFILL', rec."provider", rec."merchantAccountId",
          NULL, v_ev_digest,
          jsonb_build_object(
            'legacyRefundId', rec."id",
            'legacyStatus', rec."refundStatus",
            'legacyProviderReference', v_trimmed_ref,
            'matchesParentPaymentReference', v_matches_payment_ref
          ),
          rec."updatedAt", rec."updatedAt"
        );
        UPDATE "refund_obligations"
        SET "status" = 'RECONCILE_REQUIRED',
            "historicalClassification" = v_hist_class,
            "updatedAt" = rec."updatedAt"
        WHERE "id" = v_obligation_id;
      END IF;

    ELSIF rec."refundStatus" IN ('PROCESSING', 'RECONCILE_REQUIRED') THEN
      v_hist_class := CASE
        WHEN v_matches_payment_ref THEN 'LEGACY_AMBIGUOUS_CHARGE_REF'::"RefundHistoricalClassification"
        ELSE 'LEGACY_UNRESOLVED_IN_FLIGHT'::"RefundHistoricalClassification"
      END;
      INSERT INTO "refund_provider_attempts" (
        "id", "refundId", "obligationId", "paymentId", "provider", "merchantAccountId",
        "attemptSequence", "providerIdempotencyKey", "amount", "currency", "executionChannel",
        "parentPaymentReference", "providerRefundReference", "status", "failureClassification",
        "retryEligible", "historicalClassification", "requestDigest",
        "preparedAt", "quarantinedAt", "createdAt", "updatedAt"
      ) VALUES (
        v_attempt_id, rec."id", v_obligation_id, rec."paymentId", rec."provider", rec."merchantAccountId",
        1, 'legacy_att:' || rec."id" || ':1', rec."amount", rec."currency", 'LEGACY_BACKFILL',
        rec."paymentRef",
        CASE WHEN v_trimmed_ref IS NOT NULL AND NOT v_matches_payment_ref AND NOT v_ref_collision THEN v_trimmed_ref ELSE NULL END,
        'AMBIGUOUS_OUTCOME',
        CASE WHEN v_matches_payment_ref THEN 'LEGACY_REFERENCE_AMBIGUOUS'::"RefundAttemptFailureClass" ELSE 'TRANSPORT_AMBIGUOUS'::"RefundAttemptFailureClass" END,
        false, v_hist_class, v_req_digest,
        rec."createdAt", rec."updatedAt", rec."createdAt", rec."updatedAt"
      );
      INSERT INTO "refund_provider_attempt_events" (
        "id", "attemptId", "refundId", "obligationId", "eventSequence", "eventType",
        "previousAttemptStatus", "resultingAttemptStatus", "provenance", "provider", "merchantAccountId",
        "providerRefundReference", "evidenceDigest", "sanitizedPayload", "occurredAt", "recordedAt"
      ) VALUES (
        v_event_id, v_attempt_id, rec."id", v_obligation_id, 1, 'LEGACY_BACKFILL_QUARANTINED',
        NULL, 'AMBIGUOUS_OUTCOME', 'LEGACY_BACKFILL', rec."provider", rec."merchantAccountId",
        NULL, v_ev_digest,
        jsonb_build_object(
          'legacyRefundId', rec."id",
          'legacyStatus', rec."refundStatus",
          'legacyProviderReference', v_trimmed_ref,
          'matchesParentPaymentReference', v_matches_payment_ref
        ),
        rec."updatedAt", rec."updatedAt"
      );
      UPDATE "refund_obligations"
      SET "status" = 'RECONCILE_REQUIRED',
          "historicalClassification" = v_hist_class,
          "updatedAt" = rec."updatedAt"
      WHERE "id" = v_obligation_id;

    ELSIF rec."refundStatus" = 'COMPLETED' THEN
      IF v_trimmed_ref IS NOT NULL AND NOT v_matches_payment_ref AND NOT v_ref_collision THEN
        v_hist_class := 'LEGACY_VERIFIED_COMPLETED';
        INSERT INTO "refund_provider_attempts" (
          "id", "refundId", "obligationId", "paymentId", "provider", "merchantAccountId",
          "attemptSequence", "providerIdempotencyKey", "amount", "currency", "executionChannel",
          "parentPaymentReference", "providerRefundReference", "status", "failureClassification",
          "retryEligible", "historicalClassification", "requestDigest",
          "preparedAt", "providerRespondedAt", "terminalizedAt", "resolvedByProvenance",
          "createdAt", "updatedAt"
        ) VALUES (
          v_attempt_id, rec."id", v_obligation_id, rec."paymentId", rec."provider", rec."merchantAccountId",
          1, 'legacy_att:' || rec."id" || ':1', rec."amount", rec."currency", v_exec_channel,
          rec."paymentRef", v_trimmed_ref, 'COMPLETED', 'NONE',
          false, v_hist_class, v_req_digest,
          rec."createdAt", rec."updatedAt", rec."updatedAt", 'LEGACY_BACKFILL',
          rec."createdAt", rec."updatedAt"
        );
        INSERT INTO "refund_provider_attempt_events" (
          "id", "attemptId", "refundId", "obligationId", "eventSequence", "eventType",
          "previousAttemptStatus", "resultingAttemptStatus", "provenance", "provider", "merchantAccountId",
          "providerRefundReference", "evidenceDigest", "sanitizedPayload", "occurredAt", "recordedAt"
        ) VALUES (
          v_event_id, v_attempt_id, rec."id", v_obligation_id, 1, 'LEGACY_BACKFILL_RECORDED',
          NULL, 'COMPLETED', 'LEGACY_BACKFILL', rec."provider", rec."merchantAccountId",
          v_trimmed_ref, v_ev_digest,
          jsonb_build_object('legacyRefundId', rec."id", 'legacyStatus', rec."refundStatus"),
          rec."updatedAt", rec."updatedAt"
        );
        UPDATE "refund_obligations"
        SET "status" = 'FULFILLED',
            "historicalClassification" = v_hist_class,
            "fulfilledRefundId" = rec."id",
            "fulfilledAttemptId" = v_attempt_id,
            "updatedAt" = rec."updatedAt"
        WHERE "id" = v_obligation_id;
      ELSE
        -- Never invent provider refund evidence for legacy COMPLETED rows lacking unique non-charge ref
        v_hist_class := 'LEGACY_COMPLETED_AMBIGUOUS_OR_MISSING_REF';
        UPDATE "refund_obligations"
        SET "status" = 'FULFILLED',
            "historicalClassification" = v_hist_class,
            "fulfilledRefundId" = rec."id",
            "fulfilledAttemptId" = NULL,
            "updatedAt" = rec."updatedAt"
        WHERE "id" = v_obligation_id;
        INSERT INTO "refund_evidence_receipts" (
          "id", "provider", "merchantAccountId", "eventId", "providerRefundReference",
          "attemptId", "refundId", "obligationId", "provenance", "disposition",
          "signatureValid", "evidenceDigest", "rejectionReason", "receivedAt"
        ) VALUES (
          v_receipt_id, rec."provider", rec."merchantAccountId", 'legacy_backfill:' || rec."id", v_trimmed_ref,
          NULL, rec."id", v_obligation_id, 'LEGACY_BACKFILL', 'CONFLICT_REJECTED',
          false, v_ev_digest,
          CASE
            WHEN v_trimmed_ref IS NULL THEN 'Historical COMPLETED refund lacked providerReference'
            WHEN v_matches_payment_ref THEN 'Historical COMPLETED refund providerReference matched parent payment charge reference'
            ELSE 'Historical COMPLETED refund providerReference duplicated an existing attempt reference'
          END,
          rec."updatedAt"
        );
      END IF;

    ELSIF rec."refundStatus" = 'FAILED' THEN
      v_hist_class := 'LEGACY_PRE_OBLIGATION_TERMINAL_FAILED';
      INSERT INTO "refund_provider_attempts" (
        "id", "refundId", "obligationId", "paymentId", "provider", "merchantAccountId",
        "attemptSequence", "providerIdempotencyKey", "amount", "currency", "executionChannel",
        "parentPaymentReference", "providerRefundReference", "status", "failureClassification",
        "retryEligible", "historicalClassification", "requestDigest",
        "preparedAt", "terminalizedAt", "resolvedByProvenance", "createdAt", "updatedAt"
      ) VALUES (
        v_attempt_id, rec."id", v_obligation_id, rec."paymentId", rec."provider", rec."merchantAccountId",
        1, 'legacy_att:' || rec."id" || ':1', rec."amount", rec."currency", 'LEGACY_BACKFILL',
        rec."paymentRef",
        CASE WHEN v_trimmed_ref IS NOT NULL AND NOT v_matches_payment_ref AND NOT v_ref_collision THEN v_trimmed_ref ELSE NULL END,
        'FAILED', 'PROVIDER_DEFINITIVE_DECLINE',
        false, v_hist_class, v_req_digest,
        rec."createdAt", rec."updatedAt", 'LEGACY_BACKFILL', rec."createdAt", rec."updatedAt"
      );
      INSERT INTO "refund_provider_attempt_events" (
        "id", "attemptId", "refundId", "obligationId", "eventSequence", "eventType",
        "previousAttemptStatus", "resultingAttemptStatus", "provenance", "provider", "merchantAccountId",
        "providerRefundReference", "evidenceDigest", "sanitizedPayload", "occurredAt", "recordedAt"
      ) VALUES (
        v_event_id, v_attempt_id, rec."id", v_obligation_id, 1, 'LEGACY_BACKFILL_RECORDED',
        NULL, 'FAILED', 'LEGACY_BACKFILL', rec."provider", rec."merchantAccountId",
        NULL, v_ev_digest,
        jsonb_build_object(
          'legacyRefundId', rec."id",
          'legacyStatus', rec."refundStatus",
          'legacyProviderReference', v_trimmed_ref
        ),
        rec."updatedAt", rec."updatedAt"
      );
      UPDATE "refund_obligations"
      SET "status" = 'CANCELLED_VOIDED',
          "historicalClassification" = v_hist_class,
          "updatedAt" = rec."updatedAt"
      WHERE "id" = v_obligation_id;
    END IF;
  END LOOP;
END $$;

-- 5. Runtime Database Triggers & Hardened Invariants

-- 5A. Append-Only Immutability for refund_provider_attempt_events
CREATE OR REPLACE FUNCTION "enforce_refund_attempt_events_immutable"()
RETURNS TRIGGER AS $$
DECLARE
  v_att "refund_provider_attempts"%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'refund_provider_attempt_events table is strictly append-only: % is forbidden (eventId=%)',
      TG_OP, OLD."id"
      USING ERRCODE = '55000';
  END IF;

  -- TG_OP = 'INSERT'
  SELECT * INTO v_att FROM "refund_provider_attempts" WHERE "id" = NEW."attemptId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced refund_provider_attempts % does not exist', NEW."attemptId"
      USING ERRCODE = '23503';
  END IF;

  IF NEW."refundId" IS DISTINCT FROM v_att."refundId"
    OR NEW."obligationId" IS DISTINCT FROM v_att."obligationId"
    OR NEW."provider" IS DISTINCT FROM v_att."provider"
    OR NEW."merchantAccountId" IS DISTINCT FROM v_att."merchantAccountId"
  THEN
    RAISE EXCEPTION 'Attempt event identity fields must match parent attempt %', NEW."attemptId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_provider_attempt_events_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_provider_attempt_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_refund_attempt_events_immutable"();

-- 5B. Append-Only Immutability for refund_evidence_receipts
CREATE OR REPLACE FUNCTION "enforce_refund_evidence_receipts_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'refund_evidence_receipts table is strictly append-only: % is forbidden (receiptId=%)',
    TG_OP, OLD."id"
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_evidence_receipts_immutable_guard"
BEFORE UPDATE OR DELETE ON "refund_evidence_receipts"
FOR EACH ROW EXECUTE FUNCTION "enforce_refund_evidence_receipts_immutable"();

-- 5C. Reconciliation Approvals Integrity Guard
CREATE OR REPLACE FUNCTION "enforce_refund_reconciliation_approvals_integrity"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund_reconciliation_approvals records cannot be deleted (approvalId=%)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."obligationId" IS DISTINCT FROM OLD."obligationId"
    OR NEW."refundId" IS DISTINCT FROM OLD."refundId"
    OR NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
    OR NEW."actionType" IS DISTINCT FROM OLD."actionType"
    OR NEW."evidenceType" IS DISTINCT FROM OLD."evidenceType"
    OR NEW."externalSettlementReference" IS DISTINCT FROM OLD."externalSettlementReference"
    OR NEW."evidenceDigest" IS DISTINCT FROM OLD."evidenceDigest"
    OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
    OR NEW."requestedByActorId" IS DISTINCT FROM OLD."requestedByActorId"
    OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
  THEN
    RAISE EXCEPTION 'Approval request identity and evidence fields are immutable (approvalId=%)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status"::text IN ('APPLIED', 'REJECTED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Terminal approval status % cannot transition to % (approvalId=%)',
      OLD."status", NEW."status", OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_reconciliation_approvals_guard"
BEFORE UPDATE OR DELETE ON "refund_reconciliation_approvals"
FOR EACH ROW EXECUTE FUNCTION "enforce_refund_reconciliation_approvals_integrity"();

-- 5D. RefundObligation Integrity & Capacity Guard (Canonical Top-Down Locks)
CREATE OR REPLACE FUNCTION "enforce_refund_obligations_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_payment "payments"%ROWTYPE;
  v_vo_order_id TEXT;
  v_total_obligated NUMERIC;
  v_unlinked_refunds NUMERIC;
  v_approval "refund_reconciliation_approvals"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund_obligations records cannot be deleted (obligationId=%)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- Lock canonical hierarchy: orders -> vendor_orders ASC -> payments
  PERFORM 1 FROM "orders" WHERE "id" = NEW."orderId" FOR UPDATE;
  PERFORM 1 FROM "vendor_orders" WHERE "orderId" = NEW."orderId" ORDER BY "id" ASC FOR UPDATE;
  SELECT * INTO v_payment FROM "payments" WHERE "id" = NEW."paymentId" FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced payment % does not exist', NEW."paymentId"
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."orderId" IS DISTINCT FROM v_payment."orderId" THEN
      RAISE EXCEPTION 'Obligation orderId % does not match payment orderId %', NEW."orderId", v_payment."orderId"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."currency" IS DISTINCT FROM v_payment."currency" THEN
      RAISE EXCEPTION 'Obligation currency % does not match payment currency %', NEW."currency", v_payment."currency"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."vendorOrderId" IS NOT NULL THEN
      SELECT "orderId" INTO v_vo_order_id FROM "vendor_orders" WHERE "id" = NEW."vendorOrderId";
      IF NOT FOUND OR v_vo_order_id IS DISTINCT FROM NEW."orderId" THEN
        RAISE EXCEPTION 'VendorOrder % does not belong to Order %', NEW."vendorOrderId", NEW."orderId"
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."historicalClassification" = 'NATIVE'::"RefundHistoricalClassification"
      AND v_payment."status"::text NOT IN ('PAID', 'PARTIALLY_REFUNDED')
    THEN
      RAISE EXCEPTION 'Cannot create NATIVE refund obligation for payment % in status %', NEW."paymentId", v_payment."status"
        USING ERRCODE = '23514';
    END IF;
  ELSE
    -- TG_OP = 'UPDATE'
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
      OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
      OR NEW."vendorOrderId" IS DISTINCT FROM OLD."vendorOrderId"
      OR NEW."obligationKey" IS DISTINCT FROM OLD."obligationKey"
      OR NEW."obligationType" IS DISTINCT FROM OLD."obligationType"
      OR NEW."authorizedAmount" IS DISTINCT FROM OLD."authorizedAmount"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."reason" IS DISTINCT FROM OLD."reason"
      OR NEW."historicalClassification" IS DISTINCT FROM OLD."historicalClassification"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR (OLD."fulfilledRefundId" IS NOT NULL AND NEW."fulfilledRefundId" IS DISTINCT FROM OLD."fulfilledRefundId")
      OR (OLD."fulfilledAttemptId" IS NOT NULL AND NEW."fulfilledAttemptId" IS DISTINCT FROM OLD."fulfilledAttemptId")
      OR (OLD."voidApprovalId" IS NOT NULL AND NEW."voidApprovalId" IS DISTINCT FROM OLD."voidApprovalId")
    THEN
      RAISE EXCEPTION 'Financial and identity fields on refund_obligations are immutable (obligationId=%)', OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF OLD."status"::text = 'FULFILLED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'Terminal obligation status FULFILLED cannot transition to % (obligationId=%)',
        NEW."status", OLD."id"
        USING ERRCODE = '23514';
    END IF;
    IF OLD."status"::text = 'CANCELLED_VOIDED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'Terminal obligation status CANCELLED_VOIDED cannot transition to % (obligationId=%)',
        NEW."status", OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF OLD."status"::text IN ('IN_FLIGHT', 'PENDING_PROVIDER', 'RECONCILE_REQUIRED')
      AND NEW."status"::text = 'OPEN'
    THEN
      IF EXISTS (
        SELECT 1 FROM "refund_provider_attempts" a
        WHERE a."obligationId" = OLD."id"
          AND a."status"::text IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'AMBIGUOUS_OUTCOME')
      ) THEN
        RAISE EXCEPTION 'Cannot reopen obligation % from % while non-terminal provider attempt remains',
          OLD."id", OLD."status"
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW."status"::text = 'CANCELLED_VOIDED' AND OLD."status"::text <> 'CANCELLED_VOIDED' THEN
      IF EXISTS (
        SELECT 1 FROM "refund_provider_attempts" a
        WHERE a."obligationId" = OLD."id"
          AND a."status"::text IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'AMBIGUOUS_OUTCOME', 'COMPLETED')
      ) THEN
        RAISE EXCEPTION 'Cannot void obligation % while active, quarantined, or completed attempt exists',
          OLD."id"
          USING ERRCODE = '23514';
      END IF;
      IF NEW."historicalClassification" = 'NATIVE'::"RefundHistoricalClassification" THEN
        IF NEW."voidApprovalId" IS NULL THEN
          RAISE EXCEPTION 'Voiding NATIVE obligation % requires dual-control voidApprovalId', OLD."id"
            USING ERRCODE = '23514';
        END IF;
        SELECT * INTO v_approval FROM "refund_reconciliation_approvals" WHERE "id" = NEW."voidApprovalId";
        IF NOT FOUND
          OR v_approval."obligationId" IS DISTINCT FROM OLD."id"
          OR v_approval."actionType" <> 'VOID_OBLIGATION'::"RefundReconciliationActionType"
          OR v_approval."status"::text NOT IN ('APPROVED', 'APPLIED')
          OR v_approval."approvedByActorId" IS NULL
          OR v_approval."requestedByActorId" = v_approval."approvedByActorId"
        THEN
          RAISE EXCEPTION 'Invalid voidApprovalId % for obligation %', NEW."voidApprovalId", OLD."id"
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;

  -- Enforce Payment capacity invariant across ALL non-voided obligations + unlinked legacy refunds
  IF NEW."status"::text <> 'CANCELLED_VOIDED' THEN
    SELECT COALESCE(SUM(o."authorizedAmount"), 0.00) INTO v_total_obligated
    FROM "refund_obligations" o
    WHERE o."paymentId" = NEW."paymentId"
      AND o."status"::text <> 'CANCELLED_VOIDED'
      AND o."id" IS DISTINCT FROM NEW."id";

    SELECT COALESCE(SUM(r."amount"), 0.00) INTO v_unlinked_refunds
    FROM "refunds" r
    WHERE r."paymentId" = NEW."paymentId"
      AND r."obligationId" IS NULL
      AND r."status"::text <> 'FAILED';

    IF (v_total_obligated + v_unlinked_refunds + NEW."authorizedAmount") > v_payment."amount" THEN
      RAISE EXCEPTION 'Obligated refund total (%) exceeds payment % amount (%)',
        (v_total_obligated + v_unlinked_refunds + NEW."authorizedAmount"), NEW."paymentId", v_payment."amount"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_obligations_integrity_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_obligations"
FOR EACH ROW EXECUTE FUNCTION "enforce_refund_obligations_integrity"();

-- 5E. Refund Provider Attempt State Machine & Evidence Guard
CREATE OR REPLACE FUNCTION "enforce_refund_provider_attempts_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_payment "payments"%ROWTYPE;
  v_obligation "refund_obligations"%ROWTYPE;
  v_refund "refunds"%ROWTYPE;
  v_approval "refund_reconciliation_approvals"%ROWTYPE;
  v_event "refund_provider_attempt_events"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund_provider_attempts records cannot be deleted (attemptId=%)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_payment FROM "payments" WHERE "id" = NEW."paymentId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced payment % does not exist', NEW."paymentId"
      USING ERRCODE = '23503';
  END IF;
  SELECT * INTO v_obligation FROM "refund_obligations" WHERE "id" = NEW."obligationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced obligation % does not exist', NEW."obligationId"
      USING ERRCODE = '23503';
  END IF;
  SELECT * INTO v_refund FROM "refunds" WHERE "id" = NEW."refundId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced refund % does not exist', NEW."refundId"
      USING ERRCODE = '23503';
  END IF;

  IF NEW."historicalClassification" = 'NATIVE'::"RefundHistoricalClassification"
    AND NEW."providerRefundReference" IS NOT NULL
    AND v_payment."providerReference" IS NOT NULL
    AND lower(btrim(NEW."providerRefundReference")) = lower(btrim(v_payment."providerReference"))
  THEN
    RAISE EXCEPTION 'Attempt providerRefundReference % cannot equal parent payment charge reference %',
      NEW."providerRefundReference", v_payment."providerReference"
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_refund."paymentId" IS DISTINCT FROM NEW."paymentId"
      OR v_refund."obligationId" IS DISTINCT FROM NEW."obligationId"
      OR v_obligation."paymentId" IS DISTINCT FROM NEW."paymentId"
      OR NEW."amount" IS DISTINCT FROM v_refund."amount"
      OR NEW."amount" IS DISTINCT FROM v_obligation."authorizedAmount"
      OR NEW."currency" IS DISTINCT FROM v_payment."currency"
      OR NEW."provider" IS DISTINCT FROM v_payment."provider"
      OR NEW."merchantAccountId" IS DISTINCT FROM v_payment."merchantAccountId"
    THEN
      RAISE EXCEPTION 'Attempt identity/amount/currency/provider mismatch on attempt %', NEW."id"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."historicalClassification" = 'NATIVE'::"RefundHistoricalClassification" THEN
      IF NEW."executionChannel" = 'MANUAL_PORTAL_SETTLEMENT'::"RefundExecutionChannel" THEN
        IF NEW."status"::text <> 'COMPLETED' OR NEW."reconciliationApprovalId" IS NULL THEN
          RAISE EXCEPTION 'Manual portal settlement attempt % must start COMPLETED with reconciliationApprovalId', NEW."id"
            USING ERRCODE = '23514';
        END IF;
        SELECT * INTO v_approval FROM "refund_reconciliation_approvals" WHERE "id" = NEW."reconciliationApprovalId";
        IF NOT FOUND
          OR v_approval."obligationId" IS DISTINCT FROM NEW."obligationId"
          OR v_approval."actionType" <> 'MANUAL_OFFLINE_SETTLEMENT_COMPLETED'::"RefundReconciliationActionType"
          OR v_approval."status"::text NOT IN ('APPROVED', 'APPLIED')
          OR v_approval."approvedByActorId" IS NULL
          OR v_approval."requestedByActorId" = v_approval."approvedByActorId"
        THEN
          RAISE EXCEPTION 'Invalid dual-control approval % on manual attempt %', NEW."reconciliationApprovalId", NEW."id"
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW."status"::text NOT IN ('PREPARED', 'DISPATCHING') THEN
        RAISE EXCEPTION 'NATIVE attempt % cannot be inserted directly in status %', NEW."id", NEW."status"
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."refundId" IS DISTINCT FROM OLD."refundId"
    OR NEW."obligationId" IS DISTINCT FROM OLD."obligationId"
    OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."merchantAccountId" IS DISTINCT FROM OLD."merchantAccountId"
    OR NEW."attemptSequence" IS DISTINCT FROM OLD."attemptSequence"
    OR NEW."providerIdempotencyKey" IS DISTINCT FROM OLD."providerIdempotencyKey"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."executionChannel" IS DISTINCT FROM OLD."executionChannel"
    OR NEW."parentPaymentReference" IS DISTINCT FROM OLD."parentPaymentReference"
    OR NEW."requestDigest" IS DISTINCT FROM OLD."requestDigest"
    OR NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt"
    OR NEW."historicalClassification" IS DISTINCT FROM OLD."historicalClassification"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Attempt identity and request fields are immutable (attemptId=%)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status"::text IN ('COMPLETED', 'FAILED', 'CANCELLED_BEFORE_DISPATCH')
    AND NEW."status" IS DISTINCT FROM OLD."status"
  THEN
    RAISE EXCEPTION 'Terminal attempt status % cannot transition to % (attemptId=%)',
      OLD."status", NEW."status", OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status"::text IN ('COMPLETED', 'FAILED')
    AND OLD."providerRefundReference" IS NOT NULL
    AND NEW."providerRefundReference" IS DISTINCT FROM OLD."providerRefundReference"
  THEN
    RAISE EXCEPTION 'providerRefundReference on terminal attempt % cannot change once set', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status"::text = 'DISPATCHING' AND NEW."status"::text = 'PREPARED' THEN
    RAISE EXCEPTION 'Attempt % cannot regress from DISPATCHING to PREPARED', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status"::text = 'PROVIDER_PENDING'
    AND NEW."status"::text IN ('PREPARED', 'DISPATCHING', 'CANCELLED_BEFORE_DISPATCH')
  THEN
    RAISE EXCEPTION 'Attempt % cannot regress from PROVIDER_PENDING to %', OLD."id", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status"::text = 'AMBIGUOUS_OUTCOME' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status"::text NOT IN ('COMPLETED', 'FAILED') THEN
      RAISE EXCEPTION 'Quarantined attempt % cannot transition from AMBIGUOUS_OUTCOME to %',
        OLD."id", NEW."status"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."resolvedByProvenance" IS NULL
      OR NEW."resolvedByProvenance"::text NOT IN ('AUTHENTICATED_WEBHOOK', 'VERIFIED_STATUS_POLL', 'DUAL_CONTROL_ADMIN_RECONCILIATION')
    THEN
      RAISE EXCEPTION 'Exiting AMBIGUOUS_OUTCOME on attempt % requires verified webhook, poll, or dual-control provenance',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."resolvedByProvenance"::text = 'DUAL_CONTROL_ADMIN_RECONCILIATION' THEN
      IF NEW."reconciliationApprovalId" IS NULL THEN
        RAISE EXCEPTION 'Manual resolution of attempt % requires reconciliationApprovalId', OLD."id"
          USING ERRCODE = '23514';
      END IF;
      SELECT * INTO v_approval FROM "refund_reconciliation_approvals" WHERE "id" = NEW."reconciliationApprovalId";
      IF NOT FOUND
        OR v_approval."obligationId" IS DISTINCT FROM OLD."obligationId"
        OR v_approval."status"::text NOT IN ('APPROVED', 'APPLIED')
        OR v_approval."approvedByActorId" IS NULL
        OR v_approval."requestedByActorId" = v_approval."approvedByActorId"
        OR (NEW."status"::text = 'COMPLETED' AND v_approval."actionType" <> 'RESOLVE_QUARANTINED_COMPLETED'::"RefundReconciliationActionType")
        OR (NEW."status"::text = 'FAILED' AND v_approval."actionType" <> 'RESOLVE_QUARANTINED_DEFINITIVE_FAIL_NO_REMITTANCE'::"RefundReconciliationActionType")
      THEN
        RAISE EXCEPTION 'Invalid dual-control reconciliation approval % for attempt %',
          NEW."reconciliationApprovalId", OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW."resolvedByEventId" IS NULL THEN
        RAISE EXCEPTION 'Webhook/poll resolution of attempt % requires resolvedByEventId', OLD."id"
          USING ERRCODE = '23514';
      END IF;
      SELECT * INTO v_event FROM "refund_provider_attempt_events" WHERE "id" = NEW."resolvedByEventId";
      IF NOT FOUND
        OR v_event."attemptId" IS DISTINCT FROM OLD."id"
        OR v_event."provenance" IS DISTINCT FROM NEW."resolvedByProvenance"
        OR v_event."resultingAttemptStatus" IS DISTINCT FROM NEW."status"
      THEN
        RAISE EXCEPTION 'Invalid resolvedByEventId % for attempt %', NEW."resolvedByEventId", OLD."id"
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_provider_attempts_integrity_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_provider_attempts"
FOR EACH ROW EXECUTE FUNCTION "enforce_refund_provider_attempts_integrity"();

-- 5F. Secondary Obligation/Supersession Link Guard on Refunds (Preserves #61/#62/#66 triggers)
CREATE OR REPLACE FUNCTION "enforce_refunds_obligation_link_guard"()
RETURNS TRIGGER AS $$
DECLARE
  v_obligation "refund_obligations"%ROWTYPE;
  v_superseded "refunds"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."obligationId" IS NOT NULL AND NEW."obligationId" IS DISTINCT FROM OLD."obligationId" THEN
      RAISE EXCEPTION 'Refund obligationId is immutable once linked (refundId=%)', OLD."id"
        USING ERRCODE = '23514';
    END IF;
    IF OLD."supersedesRefundId" IS NOT NULL AND NEW."supersedesRefundId" IS DISTINCT FROM OLD."supersedesRefundId" THEN
      RAISE EXCEPTION 'Refund supersedesRefundId is immutable once set (refundId=%)', OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IS DISTINCT FROM NEW."status"
      AND EXISTS (
        SELECT 1 FROM "refund_provider_attempts" a
        WHERE a."refundId" = OLD."id"
          AND a."historicalClassification" = 'NATIVE'::"RefundHistoricalClassification"
      )
    THEN
      IF NEW."status"::text = 'COMPLETED' AND NOT EXISTS (
        SELECT 1 FROM "refund_provider_attempts" a
        WHERE a."refundId" = OLD."id" AND a."status"::text = 'COMPLETED'
      ) THEN
        RAISE EXCEPTION 'Refund % cannot transition to COMPLETED without a COMPLETED attempt', OLD."id"
          USING ERRCODE = '23514';
      END IF;
      IF NEW."status"::text = 'FAILED' AND (
        NOT EXISTS (SELECT 1 FROM "refund_provider_attempts" a WHERE a."refundId" = OLD."id" AND a."status"::text = 'FAILED')
        OR EXISTS (
          SELECT 1 FROM "refund_provider_attempts" a
          WHERE a."refundId" = OLD."id"
            AND a."status"::text IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'AMBIGUOUS_OUTCOME', 'COMPLETED')
        )
      ) THEN
        RAISE EXCEPTION 'Refund % cannot transition to FAILED while active or unfailed native attempts exist', OLD."id"
          USING ERRCODE = '23514';
      END IF;
      IF NEW."status"::text = 'PENDING' AND NOT EXISTS (
        SELECT 1 FROM "refund_provider_attempts" a
        WHERE a."refundId" = OLD."id" AND a."status"::text = 'PROVIDER_PENDING'
      ) THEN
        RAISE EXCEPTION 'Refund % cannot transition to PENDING without a PROVIDER_PENDING attempt', OLD."id"
          USING ERRCODE = '23514';
      END IF;
      IF NEW."status"::text = 'PROCESSING' AND NOT EXISTS (
        SELECT 1 FROM "refund_provider_attempts" a
        WHERE a."refundId" = OLD."id" AND a."status"::text IN ('PREPARED', 'DISPATCHING')
      ) THEN
        RAISE EXCEPTION 'Refund % cannot transition to PROCESSING without an active PREPARED/DISPATCHING attempt', OLD."id"
          USING ERRCODE = '23514';
      END IF;
      IF NEW."status"::text = 'REQUIRED' AND EXISTS (
        SELECT 1 FROM "refund_provider_attempts" a
        WHERE a."refundId" = OLD."id"
          AND a."status"::text IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'AMBIGUOUS_OUTCOME', 'COMPLETED')
      ) THEN
        RAISE EXCEPTION 'Refund % cannot return to REQUIRED while non-aborted attempts exist', OLD."id"
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  IF NEW."obligationId" IS NOT NULL THEN
    SELECT * INTO v_obligation FROM "refund_obligations" WHERE "id" = NEW."obligationId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced obligation % does not exist', NEW."obligationId"
        USING ERRCODE = '23503';
    END IF;
    IF v_obligation."paymentId" IS DISTINCT FROM NEW."paymentId" THEN
      RAISE EXCEPTION 'Refund paymentId % does not match obligation paymentId %',
        NEW."paymentId", v_obligation."paymentId"
        USING ERRCODE = '23514';
    END IF;
    IF v_obligation."authorizedAmount" IS DISTINCT FROM NEW."amount" THEN
      RAISE EXCEPTION 'Refund amount % does not match obligation authorizedAmount %',
        NEW."amount", v_obligation."authorizedAmount"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."supersedesRefundId" IS NOT NULL THEN
    SELECT * INTO v_superseded FROM "refunds" WHERE "id" = NEW."supersedesRefundId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Superseded refund % does not exist', NEW."supersedesRefundId"
        USING ERRCODE = '23503';
    END IF;
    IF v_superseded."status"::text <> 'FAILED' THEN
      RAISE EXCEPTION 'Replacement refund can only supersede a FAILED refund, got % (refundId=%)',
        v_superseded."status", NEW."supersedesRefundId"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."obligationId" IS NULL OR v_superseded."obligationId" IS DISTINCT FROM NEW."obligationId" THEN
      RAISE EXCEPTION 'Replacement refund obligationId must match superseded refund obligationId'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "z_refunds_obligation_link_guard"
BEFORE INSERT OR UPDATE ON "refunds"
FOR EACH ROW EXECUTE FUNCTION "enforce_refunds_obligation_link_guard"();
