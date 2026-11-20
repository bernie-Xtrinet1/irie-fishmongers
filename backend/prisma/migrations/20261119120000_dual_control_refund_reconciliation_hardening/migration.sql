-- WP4.3B.4F.7D.4B.7D: Migration #70 — Dual-Control Refund Reconciliation Hardening
-- Additive schema evolution on refund_reconciliation_approvals + append-only
-- refund_reconciliation_approval_events + trigger enforcement of active
-- administrators, approval expiration, atomic EXECUTING claims, outcome
-- correlation, and CONTINUE_QUARANTINE. Preserves all #59-#69 triggers intact.

-- 1. Drop dependent triggers, constraints, and indexes before enum replacement
DROP TRIGGER IF EXISTS "refund_reconciliation_approvals_guard" ON "refund_reconciliation_approvals";
DROP TRIGGER IF EXISTS "zz_refund_reconciliation_approvals_truncate_guard" ON "refund_reconciliation_approvals";

DROP INDEX IF EXISTS "uq_refund_reconcil_ext_ref";
DROP INDEX IF EXISTS "uq_refund_reconcil_active_per_obligation";
DROP INDEX IF EXISTS "refund_reconciliation_approvals_obligationId_status_idx";

ALTER TABLE "refund_reconciliation_approvals"
  DROP CONSTRAINT IF EXISTS "chk_refund_reconcil_dual_control",
  DROP CONSTRAINT IF EXISTS "chk_refund_reconcil_approved_fields",
  DROP CONSTRAINT IF EXISTS "chk_refund_reconcil_applied_at",
  DROP CONSTRAINT IF EXISTS "chk_refund_reconcil_evidence_type",
  DROP CONSTRAINT IF EXISTS "chk_refund_reconcil_digest_hex",
  DROP CONSTRAINT IF EXISTS "chk_refund_reconcil_rationale",
  DROP CONSTRAINT IF EXISTS "chk_refund_reconcil_requester";

-- 2. Safely replace existing reconciliation enums + add new enums (avoid PG 55P04)
ALTER TYPE "RefundReconciliationActionType" RENAME TO "RefundReconciliationActionType_old";
CREATE TYPE "RefundReconciliationActionType" AS ENUM (
  'MANUAL_OFFLINE_SETTLEMENT_COMPLETED',
  'RESOLVE_QUARANTINED_COMPLETED',
  'RESOLVE_QUARANTINED_DEFINITIVE_FAIL_NO_REMITTANCE',
  'CONTINUE_QUARANTINE',
  'VOID_OBLIGATION'
);
ALTER TABLE "refund_reconciliation_approvals"
  ALTER COLUMN "actionType" TYPE "RefundReconciliationActionType"
  USING ("actionType"::text::"RefundReconciliationActionType");
DROP TYPE "RefundReconciliationActionType_old";

ALTER TABLE "refund_reconciliation_approvals" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RefundReconciliationApprovalStatus" RENAME TO "RefundReconciliationApprovalStatus_old";
CREATE TYPE "RefundReconciliationApprovalStatus" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'EXECUTING',
  'APPLIED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
  'QUARANTINED'
);
ALTER TABLE "refund_reconciliation_approvals"
  ALTER COLUMN "status" TYPE "RefundReconciliationApprovalStatus"
  USING ("status"::text::"RefundReconciliationApprovalStatus");
ALTER TABLE "refund_reconciliation_approvals"
  ALTER COLUMN "status" SET DEFAULT 'REQUESTED'::"RefundReconciliationApprovalStatus";
DROP TYPE "RefundReconciliationApprovalStatus_old";

CREATE TYPE "RefundReconciliationOutcome" AS ENUM (
  'VERIFIED_COMPLETED',
  'VERIFIED_FAILED',
  'CONTINUE_QUARANTINE',
  'VOID_OBLIGATION'
);

CREATE TYPE "RefundReconciliationApprovalEventType" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
  'EXECUTION_CLAIMED',
  'APPLIED',
  'QUARANTINED'
);

-- 3. Add additive financial binding, expiration, execution-claim, and outcome columns
ALTER TABLE "refund_reconciliation_approvals"
  ADD COLUMN "paymentId" TEXT,
  ADD COLUMN "provider" "PaymentProviderName",
  ADD COLUMN "merchantAccountId" TEXT,
  ADD COLUMN "amount" DECIMAL(10, 2),
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "requestedOutcome" "RefundReconciliationOutcome",
  ADD COLUMN "evidenceReceiptIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "requestDigest" CHAR(64),
  ADD COLUMN "approvalDigest" CHAR(64),
  ADD COLUMN "authorizationRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "rejectedByActorId" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "revokedByActorId" TEXT,
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revocationReason" TEXT,
  ADD COLUMN "executedByActorId" TEXT,
  ADD COLUMN "executingAt" TIMESTAMP(3),
  ADD COLUMN "executionClaimToken" TEXT,
  ADD COLUMN "quarantinedAt" TIMESTAMP(3),
  ADD COLUMN "quarantineReason" TEXT,
  ADD COLUMN "resultingAttemptEventId" TEXT,
  ADD COLUMN "resultingOutboxId" TEXT,
  ADD COLUMN "resultingAttemptStatus" "RefundAttemptStatus",
  ADD COLUMN "resultingRefundStatus" "RefundStatus",
  ADD COLUMN "resultingObligationStatus" "RefundObligationStatus";

ALTER TABLE "refund_reconciliation_approvals"
  ADD CONSTRAINT "refund_reconciliation_approvals_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_reconciliation_approvals"
  ADD CONSTRAINT "refund_reconciliation_approvals_resultingAttemptEventId_fkey"
  FOREIGN KEY ("resultingAttemptEventId") REFERENCES "refund_provider_attempt_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_reconciliation_approvals"
  ADD CONSTRAINT "chk_refund_reconcil_evidence_type" CHECK (length(btrim("evidenceType")) > 0),
  ADD CONSTRAINT "chk_refund_reconcil_digest_hex" CHECK ("evidenceDigest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "chk_refund_reconcil_rationale" CHECK (length(btrim("rationale")) >= 10),
  ADD CONSTRAINT "chk_refund_reconcil_requester" CHECK (length(btrim("requestedByActorId")) > 0),
  ADD CONSTRAINT "chk_refund_reconcil_evidence_receipt_ids_array" CHECK (jsonb_typeof("evidenceReceiptIds") = 'array'),
  ADD CONSTRAINT "chk_refund_reconcil_req_digest_hex" CHECK ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "chk_refund_reconcil_app_digest_hex" CHECK ("approvalDigest" IS NULL OR "approvalDigest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "chk_refund_reconcil_auth_rev_positive" CHECK ("authorizationRevision" >= 1),
  ADD CONSTRAINT "chk_refund_reconcil_expiry_window" CHECK ("expiresAt" IS NULL OR "expiresAt" > "requestedAt"),
  ADD CONSTRAINT "chk_refund_reconcil_approved_expiry" CHECK ("approvedAt" IS NULL OR "expiresAt" IS NULL OR "expiresAt" > "approvedAt"),
  ADD CONSTRAINT "chk_refund_reconcil_dual_control" CHECK (
    "approvedByActorId" IS NULL OR "requestedByActorId" <> "approvedByActorId"
  ),
  ADD CONSTRAINT "chk_refund_reconcil_executor_distinct" CHECK (
    "executedByActorId" IS NULL OR "requestedByActorId" <> "executedByActorId"
  ),
  ADD CONSTRAINT "chk_refund_reconcil_approved_fields" CHECK (
    "status"::text NOT IN ('APPROVED', 'EXECUTING', 'APPLIED')
    OR ("approvedByActorId" IS NOT NULL AND "approvedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "chk_refund_reconcil_executing_fields" CHECK (
    "status"::text <> 'EXECUTING'
    OR (
      "approvedByActorId" IS NOT NULL
      AND "approvedAt" IS NOT NULL
      AND "executedByActorId" IS NOT NULL
      AND "executingAt" IS NOT NULL
      AND "executionClaimToken" IS NOT NULL
      AND length(btrim("executionClaimToken")) > 0
    )
  ),
  ADD CONSTRAINT "chk_refund_reconcil_applied_at" CHECK (
    "status"::text <> 'APPLIED' OR "appliedAt" IS NOT NULL
  ),
  ADD CONSTRAINT "chk_refund_reconcil_rejected_fields" CHECK (
    "status"::text <> 'REJECTED' OR ("rejectedByActorId" IS NOT NULL AND "rejectedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "chk_refund_reconcil_revoked_fields" CHECK (
    "status"::text <> 'REVOKED' OR ("revokedByActorId" IS NOT NULL AND "revokedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "chk_refund_reconcil_quarantined_fields" CHECK (
    "status"::text <> 'QUARANTINED' OR (
      "quarantinedAt" IS NOT NULL
      AND "quarantineReason" IS NOT NULL
      AND length(btrim("quarantineReason")) > 0
    )
  ),
  ADD CONSTRAINT "chk_refund_reconcil_outcome_action_compat" CHECK (
    "requestedOutcome" IS NULL
    OR ("requestedOutcome"::text = 'VERIFIED_COMPLETED' AND "actionType"::text IN ('MANUAL_OFFLINE_SETTLEMENT_COMPLETED', 'RESOLVE_QUARANTINED_COMPLETED'))
    OR ("requestedOutcome"::text = 'VERIFIED_FAILED' AND "actionType"::text = 'RESOLVE_QUARANTINED_DEFINITIVE_FAIL_NO_REMITTANCE')
    OR ("requestedOutcome"::text = 'CONTINUE_QUARANTINE' AND "actionType"::text = 'CONTINUE_QUARANTINE')
    OR ("requestedOutcome"::text = 'VOID_OBLIGATION' AND "actionType"::text = 'VOID_OBLIGATION')
  );

CREATE INDEX "refund_reconciliation_approvals_obligationId_status_idx"
  ON "refund_reconciliation_approvals"("obligationId", "status");
CREATE INDEX "refund_reconciliation_approvals_paymentId_idx"
  ON "refund_reconciliation_approvals"("paymentId");
CREATE INDEX "refund_reconciliation_approvals_status_expiresAt_idx"
  ON "refund_reconciliation_approvals"("status", "expiresAt");

CREATE UNIQUE INDEX "uq_refund_reconcil_ext_ref"
  ON "refund_reconciliation_approvals"(lower(btrim("externalSettlementReference")))
  WHERE "externalSettlementReference" IS NOT NULL
    AND length(btrim("externalSettlementReference")) > 0
    AND "status" IN (
      'APPROVED'::"RefundReconciliationApprovalStatus",
      'EXECUTING'::"RefundReconciliationApprovalStatus",
      'APPLIED'::"RefundReconciliationApprovalStatus"
    );

CREATE UNIQUE INDEX "uq_refund_reconcil_active_per_obligation"
  ON "refund_reconciliation_approvals"("obligationId")
  WHERE "status" IN (
    'REQUESTED'::"RefundReconciliationApprovalStatus",
    'APPROVED'::"RefundReconciliationApprovalStatus",
    'EXECUTING'::"RefundReconciliationApprovalStatus"
  );

-- 4. Create strictly append-only approval lifecycle events table
CREATE TABLE "refund_reconciliation_approval_events" (
  "id" TEXT NOT NULL,
  "approvalId" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "eventSequence" INTEGER NOT NULL,
  "eventType" "RefundReconciliationApprovalEventType" NOT NULL,
  "previousStatus" "RefundReconciliationApprovalStatus",
  "resultingStatus" "RefundReconciliationApprovalStatus" NOT NULL,
  "authorizationRevision" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorRole" TEXT,
  "evidenceDigest" CHAR(64) NOT NULL,
  "sanitizedPayload" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_reconciliation_approval_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_refund_approval_event_seq_positive" CHECK ("eventSequence" >= 1),
  CONSTRAINT "chk_refund_approval_event_digest_hex" CHECK ("evidenceDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_refund_approval_event_rev_positive" CHECK ("authorizationRevision" >= 1)
);

ALTER TABLE "refund_reconciliation_approval_events"
  ADD CONSTRAINT "refund_reconciliation_approval_events_approvalId_fkey"
  FOREIGN KEY ("approvalId") REFERENCES "refund_reconciliation_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_reconciliation_approval_events"
  ADD CONSTRAINT "refund_reconciliation_approval_events_obligationId_fkey"
  FOREIGN KEY ("obligationId") REFERENCES "refund_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "refund_reconciliation_approval_events_approvalId_eventSequen_key"
  ON "refund_reconciliation_approval_events"("approvalId", "eventSequence");
CREATE UNIQUE INDEX "uq_refund_approval_events_approval_rev"
  ON "refund_reconciliation_approval_events"("approvalId", "authorizationRevision");
CREATE INDEX "refund_reconciliation_approval_events_obligationId_idx"
  ON "refund_reconciliation_approval_events"("obligationId");

-- 5. Append-only immutability trigger on refund_reconciliation_approval_events
CREATE OR REPLACE FUNCTION "enforce_refund_reconciliation_approval_events_immutable"()
RETURNS TRIGGER AS $$
DECLARE
  v_approval "refund_reconciliation_approvals"%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'refund_reconciliation_approval_events table is strictly append-only: % is forbidden (eventId=%)',
      TG_OP, OLD."id"
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_approval FROM "refund_reconciliation_approvals" WHERE "id" = NEW."approvalId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced refund_reconciliation_approvals % does not exist', NEW."approvalId"
      USING ERRCODE = '23503';
  END IF;

  IF NEW."obligationId" IS DISTINCT FROM v_approval."obligationId" THEN
    RAISE EXCEPTION 'Approval event obligationId % does not match approval obligationId %',
      NEW."obligationId", v_approval."obligationId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."resultingStatus" IS DISTINCT FROM v_approval."status"
    OR NEW."authorizationRevision" IS DISTINCT FROM v_approval."authorizationRevision"
    OR NEW."evidenceDigest" IS DISTINCT FROM v_approval."evidenceDigest"
  THEN
    RAISE EXCEPTION 'Approval event (%) must match live approval status %, revision %, and digest',
      NEW."id", v_approval."status", v_approval."authorizationRevision"
      USING ERRCODE = '23514';
  END IF;

  IF NOT "is_active_administrator_actor"(NEW."actorId") THEN
    RAISE EXCEPTION 'Approval event % actor % must be an ACTIVE ADMINISTRATOR',
      NEW."id", NEW."actorId"
      USING ERRCODE = '23514';
  END IF;

  IF (NEW."eventType"::text = 'REQUESTED' AND (NEW."resultingStatus"::text <> 'REQUESTED' OR NEW."actorId" IS DISTINCT FROM v_approval."requestedByActorId"))
    OR (NEW."eventType"::text = 'APPROVED' AND (NEW."resultingStatus"::text <> 'APPROVED' OR NEW."actorId" IS DISTINCT FROM v_approval."approvedByActorId"))
    OR (NEW."eventType"::text = 'REJECTED' AND (NEW."resultingStatus"::text <> 'REJECTED' OR NEW."actorId" IS DISTINCT FROM v_approval."rejectedByActorId"))
    OR (NEW."eventType"::text = 'REVOKED' AND (NEW."resultingStatus"::text <> 'REVOKED' OR NEW."actorId" IS DISTINCT FROM v_approval."revokedByActorId"))
    OR (NEW."eventType"::text = 'EXECUTION_CLAIMED' AND (NEW."resultingStatus"::text <> 'EXECUTING' OR NEW."actorId" IS DISTINCT FROM v_approval."executedByActorId"))
    OR (NEW."eventType"::text = 'APPLIED' AND (NEW."resultingStatus"::text <> 'APPLIED' OR NEW."actorId" IS DISTINCT FROM v_approval."executedByActorId"))
    OR (NEW."eventType"::text IN ('EXPIRED', 'QUARANTINED') AND NEW."resultingStatus"::text <> NEW."eventType"::text)
  THEN
    RAISE EXCEPTION 'Approval event % type % does not align with approval state or bound actor',
      NEW."id", NEW."eventType"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "zz_refund_reconciliation_approval_events_truncate_guard"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'refund_reconciliation_approval_events cannot be truncated'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_reconciliation_approval_events_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_reconciliation_approval_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_refund_reconciliation_approval_events_immutable"();

CREATE TRIGGER "zz_refund_reconciliation_approval_events_truncate_guard"
BEFORE TRUNCATE ON "refund_reconciliation_approval_events"
FOR EACH STATEMENT EXECUTE FUNCTION "zz_refund_reconciliation_approval_events_truncate_guard"();

-- 6. Hardened Dual-Control Trigger on refund_reconciliation_approvals
CREATE OR REPLACE FUNCTION "is_active_administrator_actor"(p_actor_id TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  IF p_actor_id IS NULL OR length(btrim(p_actor_id)) = 0 THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM "users" u
    JOIN "user_roles" ur ON ur."userId" = u."id"
    JOIN "roles" r ON r."id" = ur."roleId"
    WHERE u."id" = p_actor_id
      AND u."status" = 'ACTIVE'::"UserStatus"
      AND r."name" = 'ADMINISTRATOR'::"RoleName"
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "enforce_refund_reconciliation_approvals_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_obligation "refund_obligations"%ROWTYPE;
  v_payment "payments"%ROWTYPE;
  v_refund "refunds"%ROWTYPE;
  v_attempt "refund_provider_attempts"%ROWTYPE;
  v_receipt_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund_reconciliation_approvals records cannot be deleted (approvalId=%)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'REQUESTED'
      OR NEW."approvedByActorId" IS NOT NULL
      OR NEW."approvedAt" IS NOT NULL
      OR NEW."approvalDigest" IS NOT NULL
      OR NEW."rejectedByActorId" IS NOT NULL
      OR NEW."rejectedAt" IS NOT NULL
      OR NEW."revokedByActorId" IS NOT NULL
      OR NEW."revokedAt" IS NOT NULL
      OR NEW."executedByActorId" IS NOT NULL
      OR NEW."executingAt" IS NOT NULL
      OR NEW."executionClaimToken" IS NOT NULL
      OR NEW."appliedAt" IS NOT NULL
      OR NEW."quarantinedAt" IS NOT NULL
      OR NEW."resultingAttemptEventId" IS NOT NULL
      OR NEW."authorizationRevision" <> 1
    THEN
      RAISE EXCEPTION 'Approval % must start in REQUESTED state with revision=1 and no decision/execution fields',
        NEW."id"
        USING ERRCODE = '23514';
    END IF;

    IF NOT "is_active_administrator_actor"(NEW."requestedByActorId") THEN
      RAISE EXCEPTION 'Approval % requester % must be an ACTIVE ADMINISTRATOR',
        NEW."id", NEW."requestedByActorId"
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_obligation FROM "refund_obligations" WHERE "id" = NEW."obligationId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced refund obligation % does not exist', NEW."obligationId"
        USING ERRCODE = '23503';
    END IF;
    SELECT * INTO v_payment FROM "payments" WHERE "id" = v_obligation."paymentId";

    IF NEW."paymentId" IS NOT NULL AND NEW."paymentId" IS DISTINCT FROM v_obligation."paymentId" THEN
      RAISE EXCEPTION 'Approval paymentId % does not match obligation paymentId %',
        NEW."paymentId", v_obligation."paymentId"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."amount" IS NOT NULL AND NEW."amount" IS DISTINCT FROM v_obligation."authorizedAmount" THEN
      RAISE EXCEPTION 'Approval amount % does not match obligation authorizedAmount %',
        NEW."amount", v_obligation."authorizedAmount"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."currency" IS NOT NULL AND upper(btrim(NEW."currency")) IS DISTINCT FROM upper(btrim(v_obligation."currency")) THEN
      RAISE EXCEPTION 'Approval currency % does not match obligation currency %',
        NEW."currency", v_obligation."currency"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."provider" IS NOT NULL AND NEW."provider" IS DISTINCT FROM v_payment."provider" THEN
      RAISE EXCEPTION 'Approval provider % does not match payment provider %',
        NEW."provider", v_payment."provider"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."merchantAccountId" IS NOT NULL AND NEW."merchantAccountId" IS DISTINCT FROM v_payment."merchantAccountId" THEN
      RAISE EXCEPTION 'Approval merchantAccountId % does not match payment merchantAccountId %',
        NEW."merchantAccountId", v_payment."merchantAccountId"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."refundId" IS NOT NULL THEN
      SELECT * INTO v_refund FROM "refunds" WHERE "id" = NEW."refundId";
      IF NOT FOUND OR v_refund."obligationId" IS DISTINCT FROM NEW."obligationId" THEN
        RAISE EXCEPTION 'Approval refundId % does not belong to obligation %',
          NEW."refundId", NEW."obligationId"
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."attemptId" IS NOT NULL THEN
      SELECT * INTO v_attempt FROM "refund_provider_attempts" WHERE "id" = NEW."attemptId";
      IF NOT FOUND OR v_attempt."obligationId" IS DISTINCT FROM NEW."obligationId" THEN
        RAISE EXCEPTION 'Approval attemptId % does not belong to obligation %',
          NEW."attemptId", NEW."obligationId"
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW."evidenceReceiptIds" IS NOT NULL AND jsonb_array_length(NEW."evidenceReceiptIds") > 0 THEN
      FOR v_receipt_id IN SELECT jsonb_array_elements_text(NEW."evidenceReceiptIds")
      LOOP
        IF NOT EXISTS (SELECT 1 FROM "refund_evidence_receipts" r WHERE r."id" = v_receipt_id) THEN
          RAISE EXCEPTION 'Referenced evidence receipt % does not exist', v_receipt_id
            USING ERRCODE = '23514';
        END IF;
      END LOOP;
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD."status"::text IN ('APPLIED', 'REJECTED', 'REVOKED', 'EXPIRED', 'QUARANTINED') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Terminal/quarantined approval status % is immutable (approvalId=%)',
        OLD."status", OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."obligationId" IS DISTINCT FROM OLD."obligationId"
    OR NEW."refundId" IS DISTINCT FROM OLD."refundId"
    OR NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
    OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."merchantAccountId" IS DISTINCT FROM OLD."merchantAccountId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."actionType" IS DISTINCT FROM OLD."actionType"
    OR NEW."requestedOutcome" IS DISTINCT FROM OLD."requestedOutcome"
    OR NEW."evidenceType" IS DISTINCT FROM OLD."evidenceType"
    OR NEW."externalSettlementReference" IS DISTINCT FROM OLD."externalSettlementReference"
    OR NEW."evidenceDigest" IS DISTINCT FROM OLD."evidenceDigest"
    OR NEW."evidenceReceiptIds" IS DISTINCT FROM OLD."evidenceReceiptIds"
    OR NEW."requestDigest" IS DISTINCT FROM OLD."requestDigest"
    OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
    OR NEW."requestedByActorId" IS DISTINCT FROM OLD."requestedByActorId"
    OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
  THEN
    RAISE EXCEPTION 'Approval request identity, financial binding, and evidence fields are immutable (approvalId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status"
    OR NEW."authorizationRevision" IS DISTINCT FROM (OLD."authorizationRevision" + 1)
  THEN
    RAISE EXCEPTION 'Approval update must advance status cleanly and increment authorizationRevision (approvalId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status"::text IN ('APPROVED', 'EXECUTING') THEN
    IF NEW."approvedByActorId" IS DISTINCT FROM OLD."approvedByActorId"
      OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
      OR NEW."approvalDigest" IS DISTINCT FROM OLD."approvalDigest"
      OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    THEN
      RAISE EXCEPTION 'Approved decision fields cannot be altered after grant (approvalId=%)', OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."status"::text = 'EXECUTING' THEN
    IF NEW."executedByActorId" IS DISTINCT FROM OLD."executedByActorId"
      OR NEW."executingAt" IS DISTINCT FROM OLD."executingAt"
      OR NEW."executionClaimToken" IS DISTINCT FROM OLD."executionClaimToken"
    THEN
      RAISE EXCEPTION 'Execution claim fields cannot be altered after EXECUTING claim (approvalId=%)', OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."status"::text = 'REQUESTED' THEN
    IF NEW."status"::text = 'APPROVED' THEN
      IF NOT "is_active_administrator_actor"(NEW."approvedByActorId")
        OR NEW."approvedByActorId" = OLD."requestedByActorId"
        OR NEW."approvedAt" IS NULL
        OR (OLD."expiresAt" IS NOT NULL AND NEW."approvedAt" > OLD."expiresAt")
      THEN
        RAISE EXCEPTION 'APPROVED requires distinct ACTIVE ADMINISTRATOR and non-expired window (approvalId=%)',
          OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."status"::text = 'REJECTED' THEN
      IF NOT "is_active_administrator_actor"(NEW."rejectedByActorId")
        OR NEW."rejectedByActorId" = OLD."requestedByActorId"
        OR NEW."rejectedAt" IS NULL
      THEN
        RAISE EXCEPTION 'REJECTED requires distinct ACTIVE ADMINISTRATOR and timestamp (approvalId=%)', OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."status"::text = 'REVOKED' THEN
      IF NOT "is_active_administrator_actor"(NEW."revokedByActorId") OR NEW."revokedAt" IS NULL THEN
        RAISE EXCEPTION 'REVOKED requires ACTIVE ADMINISTRATOR and timestamp (approvalId=%)', OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."status"::text = 'EXPIRED' THEN
      IF OLD."expiresAt" IS NULL OR (clock_timestamp() AT TIME ZONE 'UTC') < OLD."expiresAt" THEN
        RAISE EXCEPTION 'EXPIRED requires expiresAt <= CURRENT_TIMESTAMP UTC (approvalId=%)', OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'REQUESTED approval % cannot transition to %', OLD."id", NEW."status"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status"::text = 'APPROVED' THEN
    IF NEW."status"::text = 'EXECUTING' THEN
      IF NOT "is_active_administrator_actor"(NEW."executedByActorId")
        OR NEW."executedByActorId" = OLD."requestedByActorId"
        OR NEW."executingAt" IS NULL
        OR NEW."executingAt" < OLD."approvedAt"
        OR (OLD."expiresAt" IS NOT NULL AND (NEW."executingAt" > OLD."expiresAt" OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') > OLD."expiresAt"))
      THEN
        RAISE EXCEPTION 'EXECUTING requires distinct ACTIVE ADMINISTRATOR within non-expired window (approvalId=%)',
          OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."status"::text = 'REVOKED' THEN
      IF NOT "is_active_administrator_actor"(NEW."revokedByActorId") OR NEW."revokedAt" IS NULL THEN
        RAISE EXCEPTION 'REVOKED requires ACTIVE ADMINISTRATOR and timestamp (approvalId=%)', OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."status"::text = 'EXPIRED' THEN
      IF OLD."expiresAt" IS NULL OR (clock_timestamp() AT TIME ZONE 'UTC') < OLD."expiresAt" THEN
        RAISE EXCEPTION 'EXPIRED requires expiresAt <= CURRENT_TIMESTAMP UTC (approvalId=%)', OLD."id"
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."status"::text <> 'QUARANTINED' THEN
      RAISE EXCEPTION 'APPROVED approval % cannot transition directly to % (must claim EXECUTING first)',
        OLD."id", NEW."status"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'EXECUTING'
  IF NEW."status"::text = 'APPLIED' THEN
    IF NEW."appliedAt" IS NULL OR NEW."appliedAt" < OLD."executingAt" THEN
      RAISE EXCEPTION 'APPLIED requires appliedAt >= executingAt (approvalId=%)', OLD."id"
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status"::text <> 'QUARANTINED' THEN
    RAISE EXCEPTION 'EXECUTING approval % cannot transition to %', OLD."id", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "zz_refund_reconciliation_approvals_truncate_guard"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'refund_reconciliation_approvals cannot be truncated'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_reconciliation_approvals_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_reconciliation_approvals"
FOR EACH ROW EXECUTE FUNCTION "enforce_refund_reconciliation_approvals_integrity"();

CREATE TRIGGER "zz_refund_reconciliation_approvals_truncate_guard"
BEFORE TRUNCATE ON "refund_reconciliation_approvals"
FOR EACH STATEMENT EXECUTE FUNCTION "zz_refund_reconciliation_approvals_truncate_guard"();

-- 7. Coordinate M69 obligation and attempt integrity functions with EXECUTING claim & expiration
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
          OR v_approval."paymentId" IS DISTINCT FROM v_payment."id"
          OR v_approval."amount" IS DISTINCT FROM OLD."authorizedAmount"
          OR v_approval."actionType" <> 'VOID_OBLIGATION'::"RefundReconciliationActionType"
          OR v_approval."status"::text <> 'EXECUTING'
          OR v_approval."executionClaimToken" IS NULL
          OR length(btrim(v_approval."executionClaimToken")) = 0
          OR v_approval."requestDigest" IS NULL
          OR v_approval."approvalDigest" IS NULL
          OR v_approval."expiresAt" IS NULL
          OR NOT "is_active_administrator_actor"(v_approval."approvedByActorId")
          OR NOT "is_active_administrator_actor"(v_approval."executedByActorId")
          OR v_approval."requestedByActorId" = v_approval."approvedByActorId"
          OR v_approval."requestedByActorId" = v_approval."executedByActorId"
          OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') > v_approval."expiresAt"
        THEN
          RAISE EXCEPTION 'Invalid voidApprovalId % for obligation %', NEW."voidApprovalId", OLD."id"
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;

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
          OR v_approval."paymentId" IS DISTINCT FROM v_payment."id"
          OR v_approval."amount" IS DISTINCT FROM v_obligation."authorizedAmount"
          OR v_approval."actionType" <> 'MANUAL_OFFLINE_SETTLEMENT_COMPLETED'::"RefundReconciliationActionType"
          OR v_approval."status"::text <> 'EXECUTING'
          OR v_approval."executionClaimToken" IS NULL
          OR length(btrim(v_approval."executionClaimToken")) = 0
          OR v_approval."requestDigest" IS NULL
          OR v_approval."approvalDigest" IS NULL
          OR v_approval."expiresAt" IS NULL
          OR NOT "is_active_administrator_actor"(v_approval."approvedByActorId")
          OR NOT "is_active_administrator_actor"(v_approval."executedByActorId")
          OR v_approval."requestedByActorId" = v_approval."approvedByActorId"
          OR v_approval."requestedByActorId" = v_approval."executedByActorId"
          OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') > v_approval."expiresAt"
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
        OR v_approval."paymentId" IS DISTINCT FROM v_payment."id"
        OR v_approval."amount" IS DISTINCT FROM v_obligation."authorizedAmount"
        OR v_approval."status"::text <> 'EXECUTING'
        OR v_approval."executionClaimToken" IS NULL
        OR length(btrim(v_approval."executionClaimToken")) = 0
        OR v_approval."requestDigest" IS NULL
        OR v_approval."approvalDigest" IS NULL
        OR v_approval."expiresAt" IS NULL
        OR NOT "is_active_administrator_actor"(v_approval."approvedByActorId")
        OR NOT "is_active_administrator_actor"(v_approval."executedByActorId")
        OR v_approval."requestedByActorId" = v_approval."approvedByActorId"
        OR v_approval."requestedByActorId" = v_approval."executedByActorId"
        OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') > v_approval."expiresAt"
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

  IF OLD."status"::text IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING')
    AND NEW."status" IS DISTINCT FROM OLD."status"
    AND NEW."resolvedByProvenance"::text = 'DUAL_CONTROL_ADMIN_RECONCILIATION'
  THEN
    IF NEW."reconciliationApprovalId" IS NULL THEN
      RAISE EXCEPTION 'Dual-control resolution of attempt % requires reconciliationApprovalId', OLD."id"
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_approval FROM "refund_reconciliation_approvals" WHERE "id" = NEW."reconciliationApprovalId";
    IF NOT FOUND
      OR v_approval."obligationId" IS DISTINCT FROM OLD."obligationId"
      OR v_approval."paymentId" IS DISTINCT FROM v_payment."id"
      OR v_approval."amount" IS DISTINCT FROM v_obligation."authorizedAmount"
      OR v_approval."status"::text <> 'EXECUTING'
      OR v_approval."executionClaimToken" IS NULL
      OR length(btrim(v_approval."executionClaimToken")) = 0
      OR v_approval."requestDigest" IS NULL
      OR v_approval."approvalDigest" IS NULL
      OR v_approval."expiresAt" IS NULL
      OR NOT "is_active_administrator_actor"(v_approval."approvedByActorId")
      OR NOT "is_active_administrator_actor"(v_approval."executedByActorId")
      OR v_approval."requestedByActorId" = v_approval."approvedByActorId"
      OR v_approval."requestedByActorId" = v_approval."executedByActorId"
      OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') > v_approval."expiresAt"
    THEN
      RAISE EXCEPTION 'Invalid dual-control reconciliation approval % for attempt %',
        NEW."reconciliationApprovalId", OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
