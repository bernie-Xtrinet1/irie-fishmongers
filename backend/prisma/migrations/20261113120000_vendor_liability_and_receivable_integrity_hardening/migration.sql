-- ============================================================================
-- WP4.3B.4F.7D.4B.5B — Vendor Liability and Receivable Integrity Hardening
-- Corrective database schema, constraints, append-only write-offs, evidence
-- tables, trigger synchronization, and double-recognition closure.
-- ============================================================================

-- 1. Preflight Data Integrity Checks (abort atomically on pre-existing corruption)
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- 1.1 Out-of-domain commission config rates
  SELECT COUNT(*) INTO v_count
  FROM "platform_commission_configs"
  WHERE "commissionRate" < 0 OR "commissionRate" > 1;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % platform_commission_configs rows have commissionRate outside [0, 1]', v_count
      USING ERRCODE = '23514';
  END IF;

  -- 1.2 Out-of-domain commissionRateSnapshot or broken math on vendor_settlements
  SELECT COUNT(*) INTO v_count
  FROM "vendor_settlements"
  WHERE ("commissionRateSnapshot" IS NOT NULL AND ("commissionRateSnapshot" < 0 OR "commissionRateSnapshot" > 1))
     OR "grossAmount" < 0
     OR "platformFee" < 0
     OR "netAmount" <> ("grossAmount" - "platformFee");
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % vendor_settlements rows violate rate bounds or non-negative math invariants', v_count
      USING ERRCODE = '23514';
  END IF;

  -- 1.3 Legacy WRITE_OFF rows in vendor_receivable_recoveries
  SELECT COUNT(*) INTO v_count
  FROM "vendor_receivable_recoveries"
  WHERE "recoveryType"::text = 'WRITE_OFF';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % vendor_receivable_recoveries rows carry disallowed recoveryType WRITE_OFF', v_count
      USING ERRCODE = '23514';
  END IF;

  -- 1.4 Invalid recoveryType <-> targetAdjustmentId linkage
  SELECT COUNT(*) INTO v_count
  FROM "vendor_receivable_recoveries"
  WHERE ("recoveryType"::text = 'SETTLEMENT_OFFSET' AND "targetAdjustmentId" IS NULL)
     OR ("recoveryType"::text = 'MANUAL_PAYMENT' AND "targetAdjustmentId" IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % vendor_receivable_recoveries rows have invalid targetAdjustmentId linkage', v_count
      USING ERRCODE = '23514';
  END IF;

  -- 1.5 Duplicate non-null targetAdjustmentId references
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT "targetAdjustmentId"
    FROM "vendor_receivable_recoveries"
    WHERE "targetAdjustmentId" IS NOT NULL
    GROUP BY "targetAdjustmentId"
    HAVING COUNT(*) > 1
  ) dup;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % duplicate targetAdjustmentId references in vendor_receivable_recoveries', v_count
      USING ERRCODE = '23514';
  END IF;

  -- 1.6 Receivable balance / ledger / status matrix mismatch
  SELECT COUNT(*) INTO v_count
  FROM "vendor_receivables" vr
  WHERE vr."writtenOffAmount" <> 0
     OR vr."recoveredAmount" <> COALESCE((
          SELECT SUM(r."amount")
          FROM "vendor_receivable_recoveries" r
          WHERE r."receivableId" = vr."id"
        ), 0.00)
     OR NOT (
          (vr."status" = 'OPEN' AND vr."recoveredAmount" = 0 AND vr."writtenOffAmount" = 0)
          OR (vr."status" = 'PARTIALLY_RECOVERED' AND (vr."recoveredAmount" + vr."writtenOffAmount") > 0 AND (vr."recoveredAmount" + vr."writtenOffAmount") < vr."originalAmount")
          OR (vr."status" = 'DISPUTED' AND (vr."recoveredAmount" + vr."writtenOffAmount") < vr."originalAmount")
          OR (vr."status" = 'RECOVERED' AND vr."writtenOffAmount" = 0 AND vr."recoveredAmount" = vr."originalAmount")
          OR (vr."status" = 'WRITTEN_OFF' AND vr."writtenOffAmount" > 0 AND (vr."recoveredAmount" + vr."writtenOffAmount") = vr."originalAmount")
        );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % vendor_receivables rows conflict with recovery ledger sums or status matrix', v_count
      USING ERRCODE = '23514';
  END IF;
END $$;

-- 2. New Enums and Hardened Recovery Enum
CREATE TYPE "VendorLiabilityDecision" AS ENUM ('VENDOR_RESPONSIBLE', 'PLATFORM_CONCESSION', 'UNRESOLVED');
CREATE TYPE "VendorLiabilityCategory" AS ENUM (
  'VENDOR_CANCELLED_ORDER',
  'VENDOR_ITEM_DEFECT',
  'VENDOR_FULFILLMENT_SHORTFALL',
  'CONTRACTUAL_VENDOR_RETURN',
  'PLATFORM_GOODWILL_CONCESSION',
  'PLATFORM_SYSTEM_ERROR',
  'PAYMENT_PROCESSING_FEE_ADJUSTMENT',
  'UNSPECIFIED'
);
CREATE TYPE "VendorSettlementDisbursementStatus" AS ENUM ('IN_FLIGHT', 'CONFIRMED', 'FAILED');

CREATE TYPE "VendorReceivableRecoveryType_new" AS ENUM ('SETTLEMENT_OFFSET', 'MANUAL_PAYMENT');
ALTER TABLE "vendor_receivable_recoveries"
  ALTER COLUMN "recoveryType" TYPE "VendorReceivableRecoveryType_new"
  USING ("recoveryType"::text::"VendorReceivableRecoveryType_new");
DROP TYPE "VendorReceivableRecoveryType";
ALTER TYPE "VendorReceivableRecoveryType_new" RENAME TO "VendorReceivableRecoveryType";

-- 3. Harden Commission FK Retention (ON DELETE SET NULL -> ON DELETE RESTRICT)
ALTER TABLE "vendor_settlements" DROP CONSTRAINT "vendor_settlements_commissionConfigId_fkey";
ALTER TABLE "vendor_settlements" ADD CONSTRAINT "vendor_settlements_commissionConfigId_fkey"
  FOREIGN KEY ("commissionConfigId") REFERENCES "platform_commission_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Allocation Link on VendorSettlementAdjustment for Explicit Double-Recognition Closure
ALTER TABLE "vendor_settlement_adjustments" ADD COLUMN "allocationId" TEXT;
CREATE INDEX "vendor_settlement_adjustments_allocationId_idx" ON "vendor_settlement_adjustments"("allocationId");
ALTER TABLE "vendor_settlement_adjustments" ADD CONSTRAINT "vendor_settlement_adjustments_allocationId_fkey"
  FOREIGN KEY ("allocationId") REFERENCES "refund_vendor_order_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Unique Offset Adjustment Binding & Recovery Constraints
DROP INDEX IF EXISTS "vendor_receivable_recoveries_targetAdjustmentId_idx";
CREATE UNIQUE INDEX "vendor_receivable_recoveries_targetAdjustmentId_key"
  ON "vendor_receivable_recoveries"("targetAdjustmentId");

ALTER TABLE "vendor_receivable_recoveries"
  ADD CONSTRAINT "chk_recovery_type_allowed"
  CHECK ("recoveryType"::text IN ('SETTLEMENT_OFFSET', 'MANUAL_PAYMENT'));

ALTER TABLE "vendor_receivable_recoveries"
  ADD CONSTRAINT "chk_recovery_type_adjustment_link"
  CHECK (
    ("recoveryType"::text = 'SETTLEMENT_OFFSET' AND "targetAdjustmentId" IS NOT NULL)
    OR ("recoveryType"::text = 'MANUAL_PAYMENT' AND "targetAdjustmentId" IS NULL)
  );

-- 6. Authoritative Evidence & Append-Only Write-Off Tables
CREATE TABLE "vendor_liability_determinations" (
  "id" TEXT NOT NULL,
  "allocationId" TEXT NOT NULL,
  "decision" "VendorLiabilityDecision" NOT NULL,
  "category" "VendorLiabilityCategory" NOT NULL,
  "rationale" TEXT NOT NULL,
  "evidenceReference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "vendor_liability_determinations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_liability_determinations_allocationId_key"
  ON "vendor_liability_determinations"("allocationId");
ALTER TABLE "vendor_liability_determinations"
  ADD CONSTRAINT "vendor_liability_determinations_allocationId_fkey"
  FOREIGN KEY ("allocationId") REFERENCES "refund_vendor_order_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_liability_determinations"
  ADD CONSTRAINT "chk_liability_determination_rationale_non_empty"
  CHECK (btrim("rationale") <> '');

ALTER TABLE "vendor_liability_determinations"
  ADD CONSTRAINT "chk_liability_determination_decision_category"
  CHECK (
    ("decision" = 'VENDOR_RESPONSIBLE' AND "category" IN ('VENDOR_CANCELLED_ORDER', 'VENDOR_ITEM_DEFECT', 'VENDOR_FULFILLMENT_SHORTFALL', 'CONTRACTUAL_VENDOR_RETURN'))
    OR ("decision" = 'PLATFORM_CONCESSION' AND "category" IN ('PLATFORM_GOODWILL_CONCESSION', 'PLATFORM_SYSTEM_ERROR', 'PAYMENT_PROCESSING_FEE_ADJUSTMENT'))
    OR ("decision" = 'UNRESOLVED' AND "category" = 'UNSPECIFIED')
  );

CREATE TABLE "vendor_settlement_disbursements" (
  "id" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'JMD',
  "status" "VendorSettlementDisbursementStatus" NOT NULL,
  "externalReference" TEXT,
  "notes" TEXT,
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "vendor_settlement_disbursements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendor_settlement_disbursements_settlementId_idx" ON "vendor_settlement_disbursements"("settlementId");
CREATE INDEX "vendor_settlement_disbursements_vendorId_idx" ON "vendor_settlement_disbursements"("vendorId");
CREATE INDEX "vendor_settlement_disbursements_status_idx" ON "vendor_settlement_disbursements"("status");
CREATE UNIQUE INDEX "uq_vendor_settlement_disbursements_confirmed_per_settlement"
  ON "vendor_settlement_disbursements"("settlementId") WHERE "status" = 'CONFIRMED';
CREATE UNIQUE INDEX "uq_vendor_settlement_disbursements_inflight_per_settlement"
  ON "vendor_settlement_disbursements"("settlementId") WHERE "status" = 'IN_FLIGHT';

ALTER TABLE "vendor_settlement_disbursements"
  ADD CONSTRAINT "vendor_settlement_disbursements_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "vendor_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_settlement_disbursements"
  ADD CONSTRAINT "vendor_settlement_disbursements_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_settlement_disbursements"
  ADD CONSTRAINT "chk_disbursement_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "vendor_settlement_disbursements"
  ADD CONSTRAINT "chk_disbursement_confirmed_evidence"
  CHECK ("status" <> 'CONFIRMED' OR ("externalReference" IS NOT NULL AND btrim("externalReference") <> '' AND "confirmedAt" IS NOT NULL));

CREATE TABLE "vendor_receivable_write_offs" (
  "id" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "vendor_receivable_write_offs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendor_receivable_write_offs_receivableId_idx" ON "vendor_receivable_write_offs"("receivableId");
CREATE UNIQUE INDEX "vendor_receivable_write_offs_idempotencyKey_key" ON "vendor_receivable_write_offs"("idempotencyKey");
ALTER TABLE "vendor_receivable_write_offs"
  ADD CONSTRAINT "vendor_receivable_write_offs_receivableId_fkey"
  FOREIGN KEY ("receivableId") REFERENCES "vendor_receivables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_receivable_write_offs"
  ADD CONSTRAINT "chk_receivable_write_off_amount" CHECK ("amount" > 0);
ALTER TABLE "vendor_receivable_write_offs"
  ADD CONSTRAINT "chk_receivable_write_off_reason_non_empty" CHECK (btrim("reason") <> '');

-- 7. Domain & Status-Matrix CHECK Constraints on Existing Tables
ALTER TABLE "platform_commission_configs"
  ADD CONSTRAINT "chk_commission_config_rate_bounds"
  CHECK ("commissionRate" >= 0 AND "commissionRate" <= 1);

ALTER TABLE "vendor_settlements"
  ADD CONSTRAINT "chk_vendor_settlement_rate_snapshot_bounds"
  CHECK ("commissionRateSnapshot" IS NULL OR ("commissionRateSnapshot" >= 0 AND "commissionRateSnapshot" <= 1));

ALTER TABLE "vendor_settlements"
  ADD CONSTRAINT "chk_vendor_settlement_math_non_negative"
  CHECK ("grossAmount" >= 0 AND "platformFee" >= 0 AND "netAmount" = ("grossAmount" - "platformFee"));

ALTER TABLE "vendor_receivables"
  ADD CONSTRAINT "chk_vendor_receivable_status_matrix"
  CHECK (
    (
      "status" = 'OPEN'
      AND "recoveredAmount" = 0
      AND "writtenOffAmount" = 0
    ) OR (
      "status" = 'PARTIALLY_RECOVERED'
      AND ("recoveredAmount" + "writtenOffAmount") > 0
      AND ("recoveredAmount" + "writtenOffAmount") < "originalAmount"
    ) OR (
      "status" = 'DISPUTED'
      AND ("recoveredAmount" + "writtenOffAmount") < "originalAmount"
    ) OR (
      "status" = 'RECOVERED'
      AND "writtenOffAmount" = 0
      AND "recoveredAmount" = "originalAmount"
    ) OR (
      "status" = 'WRITTEN_OFF'
      AND "writtenOffAmount" > 0
      AND ("recoveredAmount" + "writtenOffAmount") = "originalAmount"
    )
  );

-- 8. Commission Config & Settlement Snapshot Immutability
CREATE OR REPLACE FUNCTION "enforce_platform_commission_configs_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_commission_configs records are append-only and cannot be updated (configId=%)',
    OLD."id"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "platform_commission_configs_immutable_update_guard" ON "platform_commission_configs";
CREATE TRIGGER "platform_commission_configs_immutable_update_guard"
BEFORE UPDATE ON "platform_commission_configs"
FOR EACH ROW
EXECUTE FUNCTION "enforce_platform_commission_configs_immutable"();

CREATE OR REPLACE FUNCTION "enforce_vendor_settlements_insert_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_cfg "platform_commission_configs"%ROWTYPE;
BEGIN
  IF NEW."commissionConfigId" IS NOT NULL THEN
    SELECT * INTO v_cfg
    FROM "platform_commission_configs"
    WHERE "id" = NEW."commissionConfigId";

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced platform_commission_configs % does not exist', NEW."commissionConfigId"
        USING ERRCODE = '23503';
    END IF;

    IF NEW."commissionRateSnapshot" IS NULL OR NEW."commissionRateSnapshot" IS DISTINCT FROM v_cfg."commissionRate" THEN
      RAISE EXCEPTION 'vendor_settlements commissionRateSnapshot (%) must equal referenced config rate (%)',
        NEW."commissionRateSnapshot", v_cfg."commissionRate"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_enforce_vendor_settlements_insert_integrity" ON "vendor_settlements";
CREATE TRIGGER "trg_enforce_vendor_settlements_insert_integrity"
BEFORE INSERT ON "vendor_settlements"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_settlements_insert_integrity"();

CREATE OR REPLACE FUNCTION "enforce_vendor_settlements_financial_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendor_settlements records are financially immutable and cannot be deleted (settlementId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId"
    OR NEW."vendorOrderId" IS DISTINCT FROM OLD."vendorOrderId"
    OR NEW."grossAmount" IS DISTINCT FROM OLD."grossAmount"
    OR NEW."platformFee" IS DISTINCT FROM OLD."platformFee"
    OR NEW."netAmount" IS DISTINCT FROM OLD."netAmount"
    OR NEW."commissionConfigId" IS DISTINCT FROM OLD."commissionConfigId"
    OR NEW."commissionRateSnapshot" IS DISTINCT FROM OLD."commissionRateSnapshot"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Financial, identity, and commission snapshot fields on vendor_settlements are immutable (settlementId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('PAID', 'FAILED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Terminal settlement status % cannot transition to % (settlementId=%)',
      OLD."status", NEW."status", OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'PAID' AND NEW."paymentDate" IS DISTINCT FROM OLD."paymentDate" THEN
    RAISE EXCEPTION 'paymentDate on PAID settlement is immutable (settlementId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 9. Liability Determination & Settlement Disbursement Triggers
CREATE OR REPLACE FUNCTION "enforce_vendor_liability_determination_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_vo_id TEXT;
  v_order_id TEXT;
  v_refund_id TEXT;
  v_payment_id TEXT;
  v_refund "refunds"%ROWTYPE;
  v_alloc "refund_vendor_order_allocations"%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'vendor_liability_determinations records are append-only and cannot be modified or deleted (determinationId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT rvoa."vendorOrderId", vo."orderId", rvoa."refundId", r."paymentId"
  INTO v_vo_id, v_order_id, v_refund_id, v_payment_id
  FROM "refund_vendor_order_allocations" rvoa
  JOIN "vendor_orders" vo ON vo."id" = rvoa."vendorOrderId"
  JOIN "refunds" r ON r."id" = rvoa."refundId"
  WHERE rvoa."id" = NEW."allocationId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced allocation % does not exist', NEW."allocationId"
      USING ERRCODE = '23503';
  END IF;

  -- Canonical lock order: orders -> vendor_orders -> payments -> refunds -> allocations
  PERFORM 1 FROM "orders" WHERE "id" = v_order_id FOR UPDATE;
  PERFORM 1 FROM "vendor_orders" WHERE "id" = v_vo_id FOR UPDATE;
  PERFORM 1 FROM "payments" WHERE "id" = v_payment_id FOR UPDATE;
  SELECT * INTO v_refund FROM "refunds" WHERE "id" = v_refund_id FOR UPDATE;
  SELECT * INTO v_alloc FROM "refund_vendor_order_allocations" WHERE "id" = NEW."allocationId" FOR UPDATE;

  IF v_alloc."entryKind" <> 'ALLOCATION' THEN
    RAISE EXCEPTION 'Liability determination can only target an ALLOCATION row, got %', v_alloc."entryKind"
      USING ERRCODE = '23514';
  END IF;

  IF v_refund."status" = 'FAILED' THEN
    RAISE EXCEPTION 'Cannot record vendor liability determination for FAILED refund %', v_refund."id"
      USING ERRCODE = '23514';
  END IF;

  IF v_alloc."allocationType" = 'MANUAL_SUPERVISOR_ADJUSTMENT'
    AND NEW."decision" = 'VENDOR_RESPONSIBLE'
    AND (NEW."evidenceReference" IS NULL OR btrim(NEW."evidenceReference") = '')
  THEN
    RAISE EXCEPTION 'MANUAL_SUPERVISOR_ADJUSTMENT cannot be attributed to vendor without non-empty evidenceReference'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_vendor_liability_determinations_integrity" ON "vendor_liability_determinations";
CREATE TRIGGER "trg_vendor_liability_determinations_integrity"
BEFORE INSERT OR UPDATE OR DELETE ON "vendor_liability_determinations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_liability_determination_integrity"();

CREATE OR REPLACE FUNCTION "enforce_vendor_settlement_disbursement_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_vo_id TEXT;
  v_order_id TEXT;
  v_payment_currency TEXT;
  v_order_currency TEXT;
  v_settlement "vendor_settlements"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendor_settlement_disbursements records are audit evidence and cannot be deleted (disbursementId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."settlementId" IS DISTINCT FROM OLD."settlementId"
      OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId"
      OR NEW."amount" IS DISTINCT FROM OLD."amount"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."initiatedAt" IS DISTINCT FROM OLD."initiatedAt"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
      RAISE EXCEPTION 'Financial and identity fields on vendor_settlement_disbursements are immutable (disbursementId=%)',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IN ('CONFIRMED', 'FAILED') THEN
      RAISE EXCEPTION 'Terminal disbursement status % cannot be modified (disbursementId=%)',
        OLD."status", OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."status" NOT IN ('CONFIRMED', 'FAILED') THEN
      RAISE EXCEPTION 'IN_FLIGHT disbursement can only transition to CONFIRMED or FAILED, got %', NEW."status"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."status" = 'CONFIRMED' THEN
      SELECT * INTO v_settlement FROM "vendor_settlements" WHERE "id" = OLD."settlementId";
      IF v_settlement."status" <> 'PAID' THEN
        RAISE EXCEPTION 'Cannot confirm disbursement while parent settlement % has status % (expected PAID)',
          OLD."settlementId", v_settlement."status"
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  SELECT vs."vendorOrderId", vo."orderId"
  INTO v_vo_id, v_order_id
  FROM "vendor_settlements" vs
  JOIN "vendor_orders" vo ON vo."id" = vs."vendorOrderId"
  WHERE vs."id" = NEW."settlementId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced settlement % does not exist', NEW."settlementId"
      USING ERRCODE = '23503';
  END IF;

  -- Canonical lock order: orders -> vendor_orders -> payments -> vendor_settlements
  SELECT "currency" INTO v_order_currency FROM "orders" WHERE "id" = v_order_id FOR UPDATE;
  PERFORM 1 FROM "vendor_orders" WHERE "id" = v_vo_id FOR UPDATE;
  SELECT "currency" INTO v_payment_currency FROM "payments" WHERE "orderId" = v_order_id FOR UPDATE;
  SELECT * INTO v_settlement FROM "vendor_settlements" WHERE "id" = NEW."settlementId" FOR UPDATE;

  IF NEW."vendorId" IS DISTINCT FROM v_settlement."vendorId" THEN
    RAISE EXCEPTION 'Disbursement vendorId (%) does not match settlement vendorId (%)',
      NEW."vendorId", v_settlement."vendorId"
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(v_payment_currency, v_order_currency) IS NOT NULL
    AND NEW."currency" IS DISTINCT FROM COALESCE(v_payment_currency, v_order_currency)
  THEN
    RAISE EXCEPTION 'Disbursement currency (%) does not match settlement currency (%)',
      NEW."currency", COALESCE(v_payment_currency, v_order_currency)
      USING ERRCODE = '23514';
  END IF;

  IF v_settlement."status" = 'FAILED' THEN
    RAISE EXCEPTION 'Cannot record disbursement for FAILED settlement %', v_settlement."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'CONFIRMED' AND v_settlement."status" <> 'PAID' THEN
    RAISE EXCEPTION 'Cannot record CONFIRMED disbursement for settlement % with status % (expected PAID)',
      v_settlement."id", v_settlement."status"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'IN_FLIGHT' THEN
    IF v_settlement."status" NOT IN ('APPROVED', 'PAID') THEN
      RAISE EXCEPTION 'Cannot record IN_FLIGHT disbursement for settlement % with status %',
        v_settlement."id", v_settlement."status"
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "vendor_settlement_disbursements"
      WHERE "settlementId" = NEW."settlementId" AND "status" = 'CONFIRMED'
    ) THEN
      RAISE EXCEPTION 'Settlement % already has a CONFIRMED disbursement', NEW."settlementId"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_vendor_settlement_disbursements_integrity" ON "vendor_settlement_disbursements";
CREATE TRIGGER "trg_vendor_settlement_disbursements_integrity"
BEFORE INSERT OR UPDATE OR DELETE ON "vendor_settlement_disbursements"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_settlement_disbursement_integrity"();

-- 10. Adjustment <-> Receivable Double-Recognition Closure Trigger
CREATE OR REPLACE FUNCTION "enforce_vendor_settlement_adjustment_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_vo_id TEXT;
  v_order_id TEXT;
  v_pay_id TEXT;
  v_pay_order_id TEXT;
  v_refund_id_to_lock TEXT;
  v_refund "refunds"%ROWTYPE;
  v_alloc "refund_vendor_order_allocations"%ROWTYPE;
  v_rev_amt DECIMAL(10,2);
  v_settlement "vendor_settlements"%ROWTYPE;
BEGIN
  IF NEW."refundId" IS NULL AND NEW."allocationId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT vs."vendorOrderId", vo."orderId"
  INTO v_vo_id, v_order_id
  FROM "vendor_settlements" vs
  JOIN "vendor_orders" vo ON vo."id" = vs."vendorOrderId"
  WHERE vs."id" = NEW."settlementId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced settlement % does not exist', NEW."settlementId"
      USING ERRCODE = '23503';
  END IF;

  -- Determine refund & payment IDs for canonical locking
  IF NEW."refundId" IS NOT NULL THEN
    v_refund_id_to_lock := NEW."refundId";
  ELSIF NEW."allocationId" IS NOT NULL THEN
    SELECT "refundId" INTO v_refund_id_to_lock
    FROM "refund_vendor_order_allocations"
    WHERE "id" = NEW."allocationId";
  END IF;

  IF v_refund_id_to_lock IS NOT NULL THEN
    SELECT r."paymentId", p."orderId"
    INTO v_pay_id, v_pay_order_id
    FROM "refunds" r
    JOIN "payments" p ON p."id" = r."paymentId"
    WHERE r."id" = v_refund_id_to_lock;
  END IF;

  -- Canonical lock order: orders -> vendor_orders -> payments -> refunds -> allocations -> vendor_settlements
  PERFORM 1 FROM "orders" WHERE "id" = v_order_id FOR UPDATE;
  PERFORM 1 FROM "vendor_orders" WHERE "id" = v_vo_id FOR UPDATE;
  IF v_pay_id IS NOT NULL THEN
    PERFORM 1 FROM "payments" WHERE "id" = v_pay_id FOR UPDATE;
  END IF;
  IF v_refund_id_to_lock IS NOT NULL THEN
    SELECT * INTO v_refund FROM "refunds" WHERE "id" = v_refund_id_to_lock FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced refund % does not exist', v_refund_id_to_lock
        USING ERRCODE = '23503';
    END IF;
    IF v_pay_order_id IS DISTINCT FROM v_order_id THEN
      RAISE EXCEPTION 'Refund % belongs to order %, not settlement order %',
        v_refund_id_to_lock, v_pay_order_id, v_order_id
        USING ERRCODE = '23514';
    END IF;
    IF v_refund."status" = 'FAILED' THEN
      RAISE EXCEPTION 'Cannot create refund-linked settlement adjustment for FAILED refund %', v_refund_id_to_lock
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."allocationId" IS NOT NULL THEN
    SELECT * INTO v_alloc FROM "refund_vendor_order_allocations" WHERE "id" = NEW."allocationId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced allocation % does not exist', NEW."allocationId"
        USING ERRCODE = '23503';
    END IF;
    IF v_alloc."vendorOrderId" IS DISTINCT FROM v_vo_id THEN
      RAISE EXCEPTION 'Allocation % belongs to vendorOrder %, not settlement vendorOrder %',
        NEW."allocationId", v_alloc."vendorOrderId", v_vo_id
        USING ERRCODE = '23514';
    END IF;
    IF v_alloc."entryKind" <> 'ALLOCATION' THEN
      RAISE EXCEPTION 'Settlement adjustment allocationId must target an ALLOCATION row, got %', v_alloc."entryKind"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."refundId" IS NOT NULL AND NEW."refundId" IS DISTINCT FROM v_alloc."refundId" THEN
      RAISE EXCEPTION 'Adjustment refundId % does not match allocation refundId %',
        NEW."refundId", v_alloc."refundId"
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(rev."amount"), 0.00) INTO v_rev_amt
    FROM "refund_vendor_order_allocations" rev
    WHERE rev."reversesAllocationId" = v_alloc."id";
    IF (v_alloc."amount" + v_rev_amt) <= 0 THEN
      RAISE EXCEPTION 'Cannot bind settlement adjustment to fully reversed allocation %', NEW."allocationId"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT * INTO v_settlement FROM "vendor_settlements" WHERE "id" = NEW."settlementId" FOR UPDATE;

  IF v_settlement."status" = 'FAILED' THEN
    RAISE EXCEPTION 'Cannot post refund-linked adjustment against FAILED settlement %', NEW."settlementId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."amount" < 0 THEN
    -- Unpaid entitlement clawback cannot apply to PAID/disbursed/in-flight settlements or duplicate a VendorReceivable
    IF v_settlement."status" = 'PAID' OR EXISTS (
      SELECT 1 FROM "vendor_settlement_disbursements" vsd
      WHERE vsd."settlementId" = NEW."settlementId" AND vsd."status" IN ('IN_FLIGHT', 'CONFIRMED')
    ) THEN
      RAISE EXCEPTION 'Cannot post negative refund/allocation entitlement adjustment on disbursed or PAID settlement %',
        NEW."settlementId"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."allocationId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "vendor_receivables" vr WHERE vr."allocationId" = NEW."allocationId"
    ) THEN
      RAISE EXCEPTION 'Double-recognition blocked: allocation % already has a VendorReceivable', NEW."allocationId"
        USING ERRCODE = '23514';
    END IF;

    IF v_refund_id_to_lock IS NOT NULL AND EXISTS (
      SELECT 1
      FROM "vendor_receivables" vr
      JOIN "refund_vendor_order_allocations" rvoa ON rvoa."id" = vr."allocationId"
      WHERE vr."settlementId" = NEW."settlementId"
        AND rvoa."refundId" = v_refund_id_to_lock
        AND (NEW."allocationId" IS NULL OR vr."allocationId" = NEW."allocationId")
    ) THEN
      RAISE EXCEPTION 'Double-recognition blocked: settlement % and refund % already recognize a VendorReceivable',
        NEW."settlementId", v_refund_id_to_lock
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_vendor_settlement_adjustments_integrity" ON "vendor_settlement_adjustments";
CREATE TRIGGER "trg_vendor_settlement_adjustments_integrity"
BEFORE INSERT ON "vendor_settlement_adjustments"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_settlement_adjustment_integrity"();

-- 11. Receivable Eligibility & Double-Recognition Closure Trigger
CREATE OR REPLACE FUNCTION "enforce_vendor_receivable_eligibility"()
RETURNS TRIGGER AS $$
DECLARE
  v_alloc_vo_id TEXT;
  v_alloc_order_id TEXT;
  v_alloc_refund_id TEXT;
  v_pay_id TEXT;
  v_settlement_vo_id TEXT;
  v_settlement_order_id TEXT;
  v_order "orders"%ROWTYPE;
  v_vo "vendor_orders"%ROWTYPE;
  v_payment "payments"%ROWTYPE;
  v_refund "refunds"%ROWTYPE;
  v_alloc "refund_vendor_order_allocations"%ROWTYPE;
  v_rev_amt DECIMAL(10,2);
  v_net_alloc DECIMAL(10,2);
  v_settlement "vendor_settlements"%ROWTYPE;
  v_det "vendor_liability_determinations"%ROWTYPE;
  v_disb "vendor_settlement_disbursements"%ROWTYPE;
  v_cum_gross DECIMAL(10,2);
  v_cum_fee DECIMAL(10,2);
BEGIN
  IF NEW."recoveredAmount" <> 0 OR NEW."writtenOffAmount" <> 0 OR NEW."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'New VendorReceivable must start with OPEN status and zero recovered/writtenOff balances'
      USING ERRCODE = '23514';
  END IF;

  SELECT rvoa."vendorOrderId", vo."orderId", rvoa."refundId", r."paymentId"
  INTO v_alloc_vo_id, v_alloc_order_id, v_alloc_refund_id, v_pay_id
  FROM "refund_vendor_order_allocations" rvoa
  JOIN "vendor_orders" vo ON vo."id" = rvoa."vendorOrderId"
  JOIN "refunds" r ON r."id" = rvoa."refundId"
  WHERE rvoa."id" = NEW."allocationId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced allocation % does not exist', NEW."allocationId"
      USING ERRCODE = '23503';
  END IF;

  SELECT vs."vendorOrderId", vo."orderId"
  INTO v_settlement_vo_id, v_settlement_order_id
  FROM "vendor_settlements" vs
  JOIN "vendor_orders" vo ON vo."id" = vs."vendorOrderId"
  WHERE vs."id" = NEW."settlementId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced settlement % does not exist', NEW."settlementId"
      USING ERRCODE = '23503';
  END IF;

  IF v_alloc_vo_id IS DISTINCT FROM v_settlement_vo_id OR v_alloc_order_id IS DISTINCT FROM v_settlement_order_id THEN
    RAISE EXCEPTION 'Allocation % (vendorOrder=%) does not belong to settlement % (vendorOrder=%)',
      NEW."allocationId", v_alloc_vo_id, NEW."settlementId", v_settlement_vo_id
      USING ERRCODE = '23514';
  END IF;

  -- Canonical lock order: orders -> vendor_orders -> payments -> refunds -> allocations -> vendor_settlements
  SELECT * INTO v_order FROM "orders" WHERE "id" = v_alloc_order_id FOR UPDATE;
  SELECT * INTO v_vo FROM "vendor_orders" WHERE "id" = v_alloc_vo_id FOR UPDATE;
  SELECT * INTO v_payment FROM "payments" WHERE "id" = v_pay_id FOR UPDATE;
  SELECT * INTO v_refund FROM "refunds" WHERE "id" = v_alloc_refund_id FOR UPDATE;
  SELECT * INTO v_alloc FROM "refund_vendor_order_allocations" WHERE "id" = NEW."allocationId" FOR UPDATE;
  SELECT * INTO v_settlement FROM "vendor_settlements" WHERE "id" = NEW."settlementId" FOR UPDATE;

  IF NEW."vendorId" IS DISTINCT FROM v_settlement."vendorId" OR v_vo."vendorId" IS DISTINCT FROM v_settlement."vendorId" THEN
    RAISE EXCEPTION 'Receivable vendorId (%) must match settlement (%) and vendorOrder (%) vendor',
      NEW."vendorId", v_settlement."vendorId", v_vo."vendorId"
      USING ERRCODE = '23514';
  END IF;

  IF v_vo."orderId" IS DISTINCT FROM v_payment."orderId" OR v_refund."paymentId" IS DISTINCT FROM v_payment."id" THEN
    RAISE EXCEPTION 'Order/Payment/Refund ownership mismatch for receivable allocation %', NEW."allocationId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."currency" IS DISTINCT FROM v_alloc."currency" OR NEW."currency" IS DISTINCT FROM v_payment."currency" THEN
    RAISE EXCEPTION 'Receivable currency (%) must match allocation (%) and payment (%) currency',
      NEW."currency", v_alloc."currency", v_payment."currency"
      USING ERRCODE = '23514';
  END IF;

  IF v_refund."status" <> 'COMPLETED' THEN
    RAISE EXCEPTION 'VendorReceivable requires COMPLETED refund, got % (refundId=%)',
      v_refund."status", v_refund."id"
      USING ERRCODE = '23514';
  END IF;

  IF v_alloc."entryKind" <> 'ALLOCATION' OR v_alloc."amount" <= 0 THEN
    RAISE EXCEPTION 'VendorReceivable requires positive ALLOCATION entry, got entryKind=% amount=%',
      v_alloc."entryKind", v_alloc."amount"
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(rev."amount"), 0.00) INTO v_rev_amt
  FROM "refund_vendor_order_allocations" rev
  WHERE rev."reversesAllocationId" = v_alloc."id";

  v_net_alloc := v_alloc."amount" + v_rev_amt;
  IF v_net_alloc <= 0 THEN
    RAISE EXCEPTION 'Cannot create VendorReceivable for reversed allocation % (netRemaining=%)',
      NEW."allocationId", v_net_alloc
      USING ERRCODE = '23514';
  END IF;

  IF NEW."grossAllocatedAmount" IS DISTINCT FROM v_net_alloc THEN
    RAISE EXCEPTION 'Receivable grossAllocatedAmount (%) must match net active allocation amount (%)',
      NEW."grossAllocatedAmount", v_net_alloc
      USING ERRCODE = '23514';
  END IF;

  -- Require authoritative VENDOR_RESPONSIBLE determination
  SELECT * INTO v_det
  FROM "vendor_liability_determinations"
  WHERE "allocationId" = NEW."allocationId";

  IF NOT FOUND OR v_det."decision" <> 'VENDOR_RESPONSIBLE' THEN
    RAISE EXCEPTION 'VendorReceivable blocked: allocation % lacks VENDOR_RESPONSIBLE determination',
      NEW."allocationId"
      USING ERRCODE = '23514';
  END IF;

  IF v_alloc."allocationType" = 'MANUAL_SUPERVISOR_ADJUSTMENT'
    AND (v_det."evidenceReference" IS NULL OR btrim(v_det."evidenceReference") = '')
  THEN
    RAISE EXCEPTION 'VendorReceivable blocked: MANUAL_SUPERVISOR_ADJUSTMENT allocation % lacks evidenceReference',
      NEW."allocationId"
      USING ERRCODE = '23514';
  END IF;

  -- Require settlement PAID AND CONFIRMED external disbursement
  IF v_settlement."status" <> 'PAID' THEN
    RAISE EXCEPTION 'VendorReceivable requires PAID settlement, got % (settlementId=%)',
      v_settlement."status", v_settlement."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_disb
  FROM "vendor_settlement_disbursements"
  WHERE "settlementId" = NEW."settlementId"
    AND "status" = 'CONFIRMED'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VendorReceivable blocked: settlement % lacks a CONFIRMED VendorSettlementDisbursement',
      NEW."settlementId"
      USING ERRCODE = '23514';
  END IF;

  IF v_disb."vendorId" IS DISTINCT FROM v_settlement."vendorId"
    OR v_disb."currency" IS DISTINCT FROM NEW."currency"
    OR v_disb."amount" <= 0
  THEN
    RAISE EXCEPTION 'VendorReceivable blocked: CONFIRMED disbursement % does not match settlement vendor/currency/positive amount',
      v_disb."id"
      USING ERRCODE = '23514';
  END IF;

  -- Double-recognition closure against negative refund/allocation settlement adjustments
  IF EXISTS (
    SELECT 1 FROM "vendor_settlement_adjustments" vsa
    WHERE vsa."settlementId" = NEW."settlementId"
      AND vsa."amount" < 0
      AND (vsa."allocationId" = NEW."allocationId" OR vsa."refundId" = v_alloc."refundId")
  ) THEN
    RAISE EXCEPTION 'Double-recognition blocked: negative settlement adjustment already exists for settlement % / refund %',
      NEW."settlementId", v_alloc."refundId"
      USING ERRCODE = '23514';
  END IF;

  -- Cumulative mathematical ceiling on settlement historical gross and fee
  SELECT
    COALESCE(SUM(vr."grossAllocatedAmount"), 0.00),
    COALESCE(SUM(vr."commissionReversedAmount"), 0.00)
  INTO v_cum_gross, v_cum_fee
  FROM "vendor_receivables" vr
  WHERE vr."settlementId" = NEW."settlementId";

  IF (v_cum_gross + NEW."grossAllocatedAmount") > v_settlement."grossAmount" THEN
    RAISE EXCEPTION 'Cumulative receivable gross (%) exceeds settlement grossAmount (%)',
      (v_cum_gross + NEW."grossAllocatedAmount"), v_settlement."grossAmount"
      USING ERRCODE = '23514';
  END IF;

  IF (v_cum_fee + NEW."commissionReversedAmount") > v_settlement."platformFee" THEN
    RAISE EXCEPTION 'Cumulative receivable commission reversed (%) exceeds settlement platformFee (%)',
      (v_cum_fee + NEW."commissionReversedAmount"), v_settlement."platformFee"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_vendor_receivables_eligibility" ON "vendor_receivables";
CREATE TRIGGER "trg_vendor_receivables_eligibility"
BEFORE INSERT ON "vendor_receivables"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_receivable_eligibility"();

-- 12. Harden Receivable Immutability & Authoritative Ledger-Synced Totals
CREATE OR REPLACE FUNCTION "enforce_vendor_receivables_immutable"()
RETURNS TRIGGER AS $$
DECLARE
  v_sum_recoveries DECIMAL(10,2);
  v_sum_write_offs DECIMAL(10,2);
  v_expected_active_status "VendorReceivableStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendor_receivables records are financially immutable and cannot be deleted (receivableId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."allocationId" IS DISTINCT FROM OLD."allocationId"
    OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId"
    OR NEW."settlementId" IS DISTINCT FROM OLD."settlementId"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."grossAllocatedAmount" IS DISTINCT FROM OLD."grossAllocatedAmount"
    OR NEW."commissionReversedAmount" IS DISTINCT FROM OLD."commissionReversedAmount"
    OR NEW."originalAmount" IS DISTINCT FROM OLD."originalAmount"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Financial and identity fields on vendor_receivables are immutable (receivableId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('RECOVERED', 'WRITTEN_OFF') THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."recoveredAmount" IS DISTINCT FROM OLD."recoveredAmount"
      OR NEW."writtenOffAmount" IS DISTINCT FROM OLD."writtenOffAmount"
      OR NEW."notes" IS DISTINCT FROM OLD."notes"
    THEN
      RAISE EXCEPTION 'Terminal receivable status % cannot be mutated (receivableId=%)',
        OLD."status", OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_recoveries
  FROM "vendor_receivable_recoveries"
  WHERE "receivableId" = OLD."id";

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_write_offs
  FROM "vendor_receivable_write_offs"
  WHERE "receivableId" = OLD."id";

  IF NEW."recoveredAmount" IS DISTINCT FROM v_sum_recoveries
    OR NEW."writtenOffAmount" IS DISTINCT FROM v_sum_write_offs
  THEN
    RAISE EXCEPTION 'Direct balance mutation blocked: recoveredAmount (%) / writtenOffAmount (%) must match authoritative ledger sums (% / %)',
      NEW."recoveredAmount", NEW."writtenOffAmount", v_sum_recoveries, v_sum_write_offs
      USING ERRCODE = '23514';
  END IF;

  IF (NEW."recoveredAmount" IS DISTINCT FROM OLD."recoveredAmount"
    OR NEW."writtenOffAmount" IS DISTINCT FROM OLD."writtenOffAmount")
    AND pg_trigger_depth() < 2
  THEN
    RAISE EXCEPTION 'recoveredAmount and writtenOffAmount on vendor_receivables can only be updated by append-only child ledger triggers (receivableId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- Direct top-level status changes allowed strictly for DISPUTED <-> OPEN/PARTIALLY_RECOVERED
  IF pg_trigger_depth() < 2 AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF v_sum_recoveries + v_sum_write_offs = 0 THEN
      v_expected_active_status := 'OPEN';
    ELSE
      v_expected_active_status := 'PARTIALLY_RECOVERED';
    END IF;

    IF OLD."status" IN ('OPEN', 'PARTIALLY_RECOVERED') AND NEW."status" = 'DISPUTED' THEN
      RETURN NEW;
    ELSIF OLD."status" = 'DISPUTED' AND NEW."status" = v_expected_active_status THEN
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'Unauthorized direct status transition % -> % on vendor_receivables (receivableId=%)',
        OLD."status", NEW."status", OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 13. Recovery and Write-Off Append-Only Enforcement & Automatic Synchronization
CREATE OR REPLACE FUNCTION "enforce_vendor_receivable_write_offs_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vendor_receivable_write_offs records are append-only and cannot be updated or deleted (writeOffId=%)',
    OLD."id"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "vendor_receivable_write_offs_immutable_guard" ON "vendor_receivable_write_offs";
CREATE TRIGGER "vendor_receivable_write_offs_immutable_guard"
BEFORE UPDATE OR DELETE ON "vendor_receivable_write_offs"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_receivable_write_offs_immutable"();

CREATE OR REPLACE FUNCTION "enforce_vendor_receivable_recovery_before_insert"()
RETURNS TRIGGER AS $$
DECLARE
  v_adj "vendor_settlement_adjustments"%ROWTYPE;
  v_adj_settlement "vendor_settlements"%ROWTYPE;
  v_adj_order_currency TEXT;
  v_adj_payment_currency TEXT;
  v_rec "vendor_receivables"%ROWTYPE;
  v_sum_recoveries DECIMAL(10,2);
  v_sum_write_offs DECIMAL(10,2);
  v_remaining DECIMAL(10,2);
BEGIN
  IF NEW."recoveryType"::text = 'SETTLEMENT_OFFSET' THEN
    IF NEW."targetAdjustmentId" IS NULL THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET recovery requires non-null targetAdjustmentId'
        USING ERRCODE = '23514';
    END IF;

    -- Lock settlement -> adjustment before vendor_receivables (canonical lock order)
    PERFORM 1
    FROM "vendor_settlements" vs
    JOIN "vendor_settlement_adjustments" a ON a."settlementId" = vs."id"
    WHERE a."id" = NEW."targetAdjustmentId"
    FOR UPDATE OF vs;

    SELECT * INTO v_adj
    FROM "vendor_settlement_adjustments"
    WHERE "id" = NEW."targetAdjustmentId"
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced targetAdjustmentId % does not exist', NEW."targetAdjustmentId"
        USING ERRCODE = '23503';
    END IF;

    SELECT * INTO v_adj_settlement
    FROM "vendor_settlements"
    WHERE "id" = v_adj."settlementId";

    SELECT o."currency", p."currency"
    INTO v_adj_order_currency, v_adj_payment_currency
    FROM "vendor_orders" vo
    JOIN "orders" o ON o."id" = vo."orderId"
    LEFT JOIN "payments" p ON p."orderId" = o."id"
    WHERE vo."id" = v_adj_settlement."vendorOrderId";
  END IF;

  SELECT * INTO v_rec
  FROM "vendor_receivables"
  WHERE "id" = NEW."receivableId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced vendor_receivables % does not exist', NEW."receivableId"
      USING ERRCODE = '23503';
  END IF;

  IF v_rec."status" IN ('DISPUTED', 'RECOVERED', 'WRITTEN_OFF') THEN
    RAISE EXCEPTION 'Cannot record recovery against receivable % in status %',
      v_rec."id", v_rec."status"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."recoveryType"::text = 'SETTLEMENT_OFFSET' THEN
    IF v_adj."refundId" IS NOT NULL OR v_adj."allocationId" IS NOT NULL THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET target adjustment % must not be refund/allocation-linked',
        v_adj."id"
        USING ERRCODE = '23514';
    END IF;

    IF v_adj_settlement."vendorId" IS DISTINCT FROM v_rec."vendorId" THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET target adjustment vendor (%) does not match receivable vendor (%)',
        v_adj_settlement."vendorId", v_rec."vendorId"
        USING ERRCODE = '23514';
    END IF;

    IF v_adj."settlementId" = v_rec."settlementId" THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET target adjustment cannot reference origin settlement %',
        v_rec."settlementId"
        USING ERRCODE = '23514';
    END IF;

    IF v_adj_settlement."status" NOT IN ('PENDING', 'APPROVED') THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET target settlement % must be PENDING or APPROVED, got %',
        v_adj_settlement."id", v_adj_settlement."status"
        USING ERRCODE = '23514';
    END IF;

    IF COALESCE(v_adj_payment_currency, v_adj_order_currency) IS NOT NULL
      AND COALESCE(v_adj_payment_currency, v_adj_order_currency) IS DISTINCT FROM v_rec."currency"
    THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET target settlement currency (%) does not match receivable currency (%)',
        COALESCE(v_adj_payment_currency, v_adj_order_currency), v_rec."currency"
        USING ERRCODE = '23514';
    END IF;

    IF v_adj."amount" >= 0 OR (-v_adj."amount") <> NEW."amount" THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET recovery amount (%) must equal exact magnitude of negative target adjustment (%)',
        NEW."amount", v_adj."amount"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_recoveries
  FROM "vendor_receivable_recoveries"
  WHERE "receivableId" = NEW."receivableId";

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_write_offs
  FROM "vendor_receivable_write_offs"
  WHERE "receivableId" = NEW."receivableId";

  v_remaining := v_rec."originalAmount" - v_sum_recoveries - v_sum_write_offs;
  IF NEW."amount" > v_remaining THEN
    RAISE EXCEPTION 'Recovery amount (%) exceeds remaining receivable balance (%)',
      NEW."amount", v_remaining
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_vendor_receivable_recovery_before_insert" ON "vendor_receivable_recoveries";
CREATE TRIGGER "trg_vendor_receivable_recovery_before_insert"
BEFORE INSERT ON "vendor_receivable_recoveries"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_receivable_recovery_before_insert"();

CREATE OR REPLACE FUNCTION "enforce_vendor_receivable_write_off_before_insert"()
RETURNS TRIGGER AS $$
DECLARE
  v_rec "vendor_receivables"%ROWTYPE;
  v_sum_recoveries DECIMAL(10,2);
  v_sum_write_offs DECIMAL(10,2);
  v_remaining DECIMAL(10,2);
BEGIN
  SELECT * INTO v_rec
  FROM "vendor_receivables"
  WHERE "id" = NEW."receivableId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced vendor_receivables % does not exist', NEW."receivableId"
      USING ERRCODE = '23503';
  END IF;

  IF v_rec."status" IN ('DISPUTED', 'RECOVERED', 'WRITTEN_OFF') THEN
    RAISE EXCEPTION 'Cannot record write-off against receivable % in status %',
      v_rec."id", v_rec."status"
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_recoveries
  FROM "vendor_receivable_recoveries"
  WHERE "receivableId" = NEW."receivableId";

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_write_offs
  FROM "vendor_receivable_write_offs"
  WHERE "receivableId" = NEW."receivableId";

  v_remaining := v_rec."originalAmount" - v_sum_recoveries - v_sum_write_offs;
  IF NEW."amount" > v_remaining THEN
    RAISE EXCEPTION 'Write-off amount (%) exceeds remaining receivable balance (%)',
      NEW."amount", v_remaining
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_vendor_receivable_write_off_before_insert" ON "vendor_receivable_write_offs";
CREATE TRIGGER "trg_vendor_receivable_write_off_before_insert"
BEFORE INSERT ON "vendor_receivable_write_offs"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_receivable_write_off_before_insert"();

CREATE OR REPLACE FUNCTION "sync_vendor_receivable_from_children"()
RETURNS TRIGGER AS $$
DECLARE
  v_rec "vendor_receivables"%ROWTYPE;
  v_sum_recoveries DECIMAL(10,2);
  v_sum_write_offs DECIMAL(10,2);
  v_total_settled DECIMAL(10,2);
  v_next_status "VendorReceivableStatus";
BEGIN
  SELECT * INTO v_rec
  FROM "vendor_receivables"
  WHERE "id" = NEW."receivableId"
  FOR UPDATE;

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_recoveries
  FROM "vendor_receivable_recoveries"
  WHERE "receivableId" = NEW."receivableId";

  SELECT COALESCE(SUM("amount"), 0.00) INTO v_sum_write_offs
  FROM "vendor_receivable_write_offs"
  WHERE "receivableId" = NEW."receivableId";

  v_total_settled := v_sum_recoveries + v_sum_write_offs;

  IF v_total_settled = v_rec."originalAmount" THEN
    IF v_sum_write_offs > 0 THEN
      v_next_status := 'WRITTEN_OFF';
    ELSE
      v_next_status := 'RECOVERED';
    END IF;
  ELSIF v_total_settled > 0 THEN
    v_next_status := 'PARTIALLY_RECOVERED';
  ELSE
    v_next_status := 'OPEN';
  END IF;

  UPDATE "vendor_receivables"
  SET "recoveredAmount" = v_sum_recoveries,
      "writtenOffAmount" = v_sum_write_offs,
      "status" = v_next_status,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."receivableId";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_vendor_receivable_recovery_sync_after_insert" ON "vendor_receivable_recoveries";
CREATE TRIGGER "trg_vendor_receivable_recovery_sync_after_insert"
AFTER INSERT ON "vendor_receivable_recoveries"
FOR EACH ROW
EXECUTE FUNCTION "sync_vendor_receivable_from_children"();

DROP TRIGGER IF EXISTS "trg_vendor_receivable_write_off_sync_after_insert" ON "vendor_receivable_write_offs";
CREATE TRIGGER "trg_vendor_receivable_write_off_sync_after_insert"
AFTER INSERT ON "vendor_receivable_write_offs"
FOR EACH ROW
EXECUTE FUNCTION "sync_vendor_receivable_from_children"();
