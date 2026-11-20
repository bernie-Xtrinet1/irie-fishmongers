-- ============================================================================
-- Migration #64: WP4.3B.4F.7D.4B.5D
-- Disbursement Coverage, Allocation Reversal, Offset Solvency & Evidence Hardening
--
-- Fixes D.4B.5C blockers:
--   B5D-01: Disbursement coverage & upper limits against adjusted settlement entitlement
--   B5D-02: Allocation reversal blocked once referenced by a VendorReceivable
--   B5D-03: SETTLEMENT_OFFSET solvency & settlement status FAIL-transition protection
--   B5D-04: External recovery evidence (externalReference, collectedAt, durability, uniqueness)
--   B5D-05: chk_refund_adjustment_idempotency covering allocationId-only adjustments
-- ============================================================================

-- 0. Atomic Preflight Integrity Verification (ERRCODE '23514' aborts entire migration cleanly)
DO $$
DECLARE
  v_cnt BIGINT;
  v_has_ext_ref BOOLEAN;
BEGIN
  -- 1) Adjustment idempotency coverage (refundId OR allocationId non-null requires non-blank idempotencyKey)
  SELECT COUNT(*) INTO v_cnt
  FROM "vendor_settlement_adjustments"
  WHERE ("refundId" IS NOT NULL OR "allocationId" IS NOT NULL)
    AND ("idempotencyKey" IS NULL OR length(btrim("idempotencyKey")) = 0);
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % refund/allocation adjustment row(s) lack a non-empty idempotencyKey',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 2) Confirmed/IN_FLIGHT disbursement ceiling & evidence integrity
  SELECT COUNT(*) INTO v_cnt
  FROM "vendor_settlement_disbursements" vsd
  JOIN "vendor_settlements" vs ON vs."id" = vsd."settlementId"
  WHERE vsd."status"::text = 'CONFIRMED'
    AND (
      vsd."amount" <= 0
      OR vsd."externalReference" IS NULL
      OR length(btrim(vsd."externalReference")) = 0
      OR vsd."confirmedAt" IS NULL
      OR vs."status"::text <> 'PAID'
    );
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % CONFIRMED disbursement row(s) violate evidence or PAID settlement status requirements',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT
      vs."id",
      vs."netAmount" + COALESCE((SELECT SUM(vsa."amount") FROM "vendor_settlement_adjustments" vsa WHERE vsa."settlementId" = vs."id"), 0.00) AS adj_entitlement,
      COALESCE(SUM(CASE WHEN vsd."status"::text IN ('CONFIRMED', 'IN_FLIGHT') THEN vsd."amount" ELSE 0.00 END), 0.00) AS active_disb_sum
    FROM "vendor_settlements" vs
    JOIN "vendor_settlement_disbursements" vsd ON vsd."settlementId" = vs."id"
    WHERE vsd."status"::text IN ('CONFIRMED', 'IN_FLIGHT')
    GROUP BY vs."id", vs."netAmount"
  ) sub
  WHERE sub.adj_entitlement <= 0 OR sub.active_disb_sum > sub.adj_entitlement;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % settlement(s) have active/confirmed disbursements exceeding adjusted payable entitlement',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 3) Receivable total exposure must never exceed valid confirmed disbursements
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT
      vr."settlementId",
      SUM(vr."originalAmount") AS total_receivable,
      COALESCE((
        SELECT SUM(vsd."amount")
        FROM "vendor_settlement_disbursements" vsd
        WHERE vsd."settlementId" = vr."settlementId"
          AND vsd."status"::text = 'CONFIRMED'
          AND vsd."externalReference" IS NOT NULL
          AND length(btrim(vsd."externalReference")) > 0
          AND vsd."confirmedAt" IS NOT NULL
          AND vsd."amount" > 0
      ), 0.00) AS confirmed_disb
    FROM "vendor_receivables" vr
    GROUP BY vr."settlementId"
  ) rec_cov
  WHERE rec_cov.total_receivable > rec_cov.confirmed_disb;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % settlement(s) have cumulative VendorReceivable originalAmount exceeding confirmed disbursements',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 4) Allocation reversals must not coexist with a VendorReceivable referencing that allocation
  SELECT COUNT(*) INTO v_cnt
  FROM "refund_vendor_order_allocations" rev
  JOIN "vendor_receivables" vr ON vr."allocationId" = rev."reversesAllocationId"
  WHERE rev."entryKind"::text = 'REVERSAL';
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % REVERSAL allocation row(s) target allocations already referenced by a VendorReceivable',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 5) Manual recovery evidence & uniqueness
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vendor_receivable_recoveries'
      AND column_name = 'externalReference'
  ) INTO v_has_ext_ref;

  IF NOT v_has_ext_ref THEN
    SELECT COUNT(*) INTO v_cnt
    FROM "vendor_receivable_recoveries"
    WHERE "recoveryType"::text = 'MANUAL_PAYMENT';
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'Preflight failed: % pre-existing MANUAL_PAYMENT recovery row(s) lack externalReference and collectedAt evidence',
        v_cnt
        USING ERRCODE = '23514';
    END IF;
  ELSE
    EXECUTE '
      SELECT COUNT(*) FROM "vendor_receivable_recoveries"
      WHERE (
        "recoveryType"::text = ''MANUAL_PAYMENT''
        AND (
          "targetAdjustmentId" IS NOT NULL
          OR "externalReference" IS NULL
          OR length(btrim("externalReference")) = 0
          OR "collectedAt" IS NULL
          OR "idempotencyKey" IS NULL
          OR length(btrim("idempotencyKey")) = 0
        )
      ) OR (
        "recoveryType"::text = ''SETTLEMENT_OFFSET''
        AND (
          "targetAdjustmentId" IS NULL
          OR "externalReference" IS NOT NULL
          OR "collectedAt" IS NOT NULL
        )
      )'
    INTO v_cnt;
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'Preflight failed: % recovery row(s) violate recovery type evidence constraints',
        v_cnt
        USING ERRCODE = '23514';
    END IF;

    EXECUTE '
      SELECT COUNT(*) FROM (
        SELECT lower(btrim("externalReference")) AS norm_ref
        FROM "vendor_receivable_recoveries"
        WHERE "recoveryType"::text = ''MANUAL_PAYMENT'' AND "externalReference" IS NOT NULL
        GROUP BY lower(btrim("externalReference"))
        HAVING COUNT(*) > 1
      ) dup'
    INTO v_cnt;
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'Preflight failed: % duplicate MANUAL_PAYMENT externalReference value(s) detected',
        v_cnt
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 6) SETTLEMENT_OFFSET target settlement solvency & non-FAILED status
  SELECT COUNT(*) INTO v_cnt
  FROM "vendor_receivable_recoveries" vrr
  JOIN "vendor_settlement_adjustments" vsa ON vsa."id" = vrr."targetAdjustmentId"
  JOIN "vendor_settlements" vs ON vs."id" = vsa."settlementId"
  WHERE vrr."recoveryType"::text = 'SETTLEMENT_OFFSET'
    AND (
      vs."status"::text NOT IN ('PENDING', 'APPROVED')
      OR (
        vs."netAmount" + COALESCE(
          (SELECT SUM(a."amount") FROM "vendor_settlement_adjustments" a WHERE a."settlementId" = vs."id"),
          0.00
        )
      ) < 0
    );
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % SETTLEMENT_OFFSET recovery row(s) target FAILED, PAID, or negative adjusted-net settlements',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 7) General negative settlement adjustment solvency
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT
      vs."id",
      vs."netAmount" + SUM(vsa."amount") AS adjusted_net
    FROM "vendor_settlements" vs
    JOIN "vendor_settlement_adjustments" vsa ON vsa."settlementId" = vs."id"
    GROUP BY vs."id", vs."netAmount"
    HAVING SUM(vsa."amount") < 0 AND (vs."netAmount" + SUM(vsa."amount")) < 0
  ) neg_settle;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % settlement(s) have cumulative negative adjustments making adjusted net negative',
      v_cnt
      USING ERRCODE = '23514';
  END IF;
END $$;

-- 1. Schema additions on vendor_receivable_recoveries
ALTER TABLE "vendor_receivable_recoveries"
  ADD COLUMN IF NOT EXISTS "externalReference" TEXT,
  ADD COLUMN IF NOT EXISTS "collectedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "vendor_receivable_recoveries_externalReference_idx"
  ON "vendor_receivable_recoveries"("externalReference");

-- 2. Extend chk_refund_adjustment_idempotency to cover allocationId-only adjustments
ALTER TABLE "vendor_settlement_adjustments"
  DROP CONSTRAINT IF EXISTS "chk_refund_adjustment_idempotency";

ALTER TABLE "vendor_settlement_adjustments"
  ADD CONSTRAINT "chk_refund_adjustment_idempotency"
  CHECK (
    ("refundId" IS NULL AND "allocationId" IS NULL)
    OR ("idempotencyKey" IS NOT NULL AND length(btrim("idempotencyKey")) > 0)
  );

-- 3. External recovery evidence & durable idempotency constraints + unique normalized ref
ALTER TABLE "vendor_receivable_recoveries"
  DROP CONSTRAINT IF EXISTS "chk_recovery_manual_payment_evidence";

ALTER TABLE "vendor_receivable_recoveries"
  ADD CONSTRAINT "chk_recovery_manual_payment_evidence"
  CHECK (
    (
      "recoveryType"::text = 'MANUAL_PAYMENT'
      AND "targetAdjustmentId" IS NULL
      AND "externalReference" IS NOT NULL
      AND length(btrim("externalReference")) > 0
      AND "collectedAt" IS NOT NULL
      AND "idempotencyKey" IS NOT NULL
      AND length(btrim("idempotencyKey")) > 0
    )
    OR (
      "recoveryType"::text = 'SETTLEMENT_OFFSET'
      AND "targetAdjustmentId" IS NOT NULL
      AND "externalReference" IS NULL
      AND "collectedAt" IS NULL
    )
  );

DROP INDEX IF EXISTS "uq_vendor_receivable_recoveries_manual_external_ref";
CREATE UNIQUE INDEX "uq_vendor_receivable_recoveries_manual_external_ref"
  ON "vendor_receivable_recoveries" (lower(btrim("externalReference")))
  WHERE "recoveryType" = 'MANUAL_PAYMENT'::"VendorReceivableRecoveryType" AND "externalReference" IS NOT NULL;

-- 4. Confirmed disbursement evidence constraint
ALTER TABLE "vendor_settlement_disbursements"
  DROP CONSTRAINT IF EXISTS "chk_disbursement_confirmed_evidence";

ALTER TABLE "vendor_settlement_disbursements"
  ADD CONSTRAINT "chk_disbursement_confirmed_evidence"
  CHECK (
    "status"::text <> 'CONFIRMED'
    OR (
      "amount" > 0
      AND "externalReference" IS NOT NULL
      AND length(btrim("externalReference")) > 0
      AND "confirmedAt" IS NOT NULL
    )
  );

-- 5. Hardened Trigger Functions (Canonical Lock Order Preserved)

-- 5A. Allocation Reversal Integrity: block reversal if VendorReceivable already exists for target allocation
CREATE OR REPLACE FUNCTION "enforce_refund_allocation_reversal_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_refund_status "RefundStatus";
  v_payment_order_id TEXT;
  v_payment_currency TEXT;
  v_vo_order_id TEXT;
  v_item_vo_id TEXT;
  v_orig "refund_vendor_order_allocations"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."refundId" IS DISTINCT FROM OLD."refundId"
      OR NEW."vendorOrderId" IS DISTINCT FROM OLD."vendorOrderId"
      OR NEW."orderItemId" IS DISTINCT FROM OLD."orderItemId"
      OR NEW."componentKey" IS DISTINCT FROM OLD."componentKey"
      OR NEW."entryKind" IS DISTINCT FROM OLD."entryKind"
      OR NEW."reversesAllocationId" IS DISTINCT FROM OLD."reversesAllocationId"
      OR NEW."amount" IS DISTINCT FROM OLD."amount"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."allocationType" IS DISTINCT FROM OLD."allocationType"
    THEN
      RAISE EXCEPTION 'Allocation financial identity and amount fields are immutable after insertion (allocationId=%)',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  SELECT r."status", p."orderId", p."currency"
  INTO v_refund_status, v_payment_order_id, v_payment_currency
  FROM "refunds" r
  JOIN "payments" p ON p."id" = r."paymentId"
  WHERE r."id" = NEW."refundId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced refund % does not exist', NEW."refundId"
      USING ERRCODE = '23503';
  END IF;

  IF v_refund_status = 'FAILED' THEN
    RAISE EXCEPTION 'Cannot create allocation or reversal for FAILED refund %', NEW."refundId"
      USING ERRCODE = '23514';
  END IF;

  SELECT "orderId" INTO v_vo_order_id
  FROM "vendor_orders"
  WHERE "id" = NEW."vendorOrderId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced vendor order % does not exist', NEW."vendorOrderId"
      USING ERRCODE = '23503';
  END IF;

  IF v_vo_order_id IS DISTINCT FROM v_payment_order_id THEN
    RAISE EXCEPTION 'VendorOrder % (order %) does not belong to Refund % order (%)',
      NEW."vendorOrderId", v_vo_order_id, NEW."refundId", v_payment_order_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW."currency" IS DISTINCT FROM v_payment_currency THEN
    RAISE EXCEPTION 'Allocation currency % does not match payment currency %',
      NEW."currency", v_payment_currency
      USING ERRCODE = '23514';
  END IF;

  IF NEW."orderItemId" IS NOT NULL THEN
    SELECT "vendorOrderId" INTO v_item_vo_id
    FROM "order_items"
    WHERE "id" = NEW."orderItemId";

    IF NOT FOUND OR v_item_vo_id IS DISTINCT FROM NEW."vendorOrderId" THEN
      RAISE EXCEPTION 'OrderItem % does not belong to VendorOrder %',
        NEW."orderItemId", NEW."vendorOrderId"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."entryKind" = 'REVERSAL' THEN
    IF NEW."reversesAllocationId" IS NULL THEN
      RAISE EXCEPTION 'REVERSAL entry requires reversesAllocationId'
        USING ERRCODE = '23514';
    END IF;

    -- Lock target ALLOCATION row BEFORE checking/locking vendor_receivables (allocations -> vendor_receivables)
    SELECT *
    INTO v_orig
    FROM "refund_vendor_order_allocations"
    WHERE "id" = NEW."reversesAllocationId"
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Original allocation % does not exist', NEW."reversesAllocationId"
        USING ERRCODE = '23503';
    END IF;

    IF v_orig."entryKind" IS DISTINCT FROM 'ALLOCATION' THEN
      RAISE EXCEPTION 'REVERSAL % can only target an ALLOCATION row, got %',
        NEW."reversesAllocationId", v_orig."entryKind"
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "vendor_receivables" vr
      WHERE vr."allocationId" = NEW."reversesAllocationId"
      FOR UPDATE
    ) THEN
      RAISE EXCEPTION 'Cannot reverse allocation % because a VendorReceivable already references it',
        NEW."reversesAllocationId"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."refundId" IS DISTINCT FROM v_orig."refundId" THEN
      RAISE EXCEPTION 'REVERSAL refundId % does not match original refundId %',
        NEW."refundId", v_orig."refundId"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."vendorOrderId" IS DISTINCT FROM v_orig."vendorOrderId" THEN
      RAISE EXCEPTION 'REVERSAL vendorOrderId % does not match original vendorOrderId %',
        NEW."vendorOrderId", v_orig."vendorOrderId"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."orderItemId" IS DISTINCT FROM v_orig."orderItemId" THEN
      RAISE EXCEPTION 'REVERSAL orderItemId % does not match original orderItemId %',
        NEW."orderItemId", v_orig."orderItemId"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."allocationType" IS DISTINCT FROM v_orig."allocationType" THEN
      RAISE EXCEPTION 'REVERSAL allocationType % does not match original allocationType %',
        NEW."allocationType", v_orig."allocationType"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."currency" IS DISTINCT FROM v_orig."currency" THEN
      RAISE EXCEPTION 'REVERSAL currency % does not match original currency %',
        NEW."currency", v_orig."currency"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."amount" >= 0 OR (-NEW."amount") > v_orig."amount" THEN
      RAISE EXCEPTION 'REVERSAL magnitude (%) exceeds original allocation amount (%)',
        -NEW."amount", v_orig."amount"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5B. Settlement Immutability + Encumbered FAIL Block + PAID Solvency Check
CREATE OR REPLACE FUNCTION "enforce_vendor_settlements_financial_immutable"()
RETURNS TRIGGER AS $$
DECLARE
  v_adj_sum DECIMAL(10,2);
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

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" = 'FAILED' THEN
    IF EXISTS (
      SELECT 1
      FROM "vendor_receivable_recoveries" vrr
      JOIN "vendor_settlement_adjustments" vsa ON vsa."id" = vrr."targetAdjustmentId"
      WHERE vsa."settlementId" = OLD."id"
        AND vrr."recoveryType"::text = 'SETTLEMENT_OFFSET'
    ) THEN
      RAISE EXCEPTION 'Cannot mark settlement % as FAILED because a committed SETTLEMENT_OFFSET recovery depends on it',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "vendor_settlement_disbursements" vsd
      WHERE vsd."settlementId" = OLD."id"
        AND vsd."status" IN ('IN_FLIGHT', 'CONFIRMED')
    ) THEN
      RAISE EXCEPTION 'Cannot mark settlement % as FAILED while IN_FLIGHT or CONFIRMED disbursements exist',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" = 'PAID' THEN
    SELECT COALESCE(SUM(vsa."amount"), 0.00) INTO v_adj_sum
    FROM "vendor_settlement_adjustments" vsa
    WHERE vsa."settlementId" = OLD."id";

    IF (OLD."netAmount" + v_adj_sum) < 0 THEN
      RAISE EXCEPTION 'Cannot mark settlement % as PAID with negative adjusted net (%)',
        OLD."id", (OLD."netAmount" + v_adj_sum)
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."status" = 'PAID' AND NEW."paymentDate" IS DISTINCT FROM OLD."paymentDate" THEN
    RAISE EXCEPTION 'paymentDate on PAID settlement is immutable (settlementId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5C. Disbursement Integrity: Adjusted Entitlement Ceiling + Evidence + Concurrency Locks
CREATE OR REPLACE FUNCTION "enforce_vendor_settlement_disbursement_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_vo_id TEXT;
  v_order_id TEXT;
  v_payment_currency TEXT;
  v_order_currency TEXT;
  v_settlement "vendor_settlements"%ROWTYPE;
  v_adj_sum DECIMAL(10,2);
  v_adjusted_entitlement DECIMAL(10,2);
  v_other_active_disb DECIMAL(10,2);
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
      SELECT vs."vendorOrderId", vo."orderId"
      INTO v_vo_id, v_order_id
      FROM "vendor_settlements" vs
      JOIN "vendor_orders" vo ON vo."id" = vs."vendorOrderId"
      WHERE vs."id" = OLD."settlementId";

      -- Canonical lock order: orders -> vendor_orders -> payments -> vendor_settlements
      PERFORM 1 FROM "orders" WHERE "id" = v_order_id FOR UPDATE;
      PERFORM 1 FROM "vendor_orders" WHERE "id" = v_vo_id FOR UPDATE;
      PERFORM 1 FROM "payments" WHERE "orderId" = v_order_id FOR UPDATE;
      SELECT * INTO v_settlement FROM "vendor_settlements" WHERE "id" = OLD."settlementId" FOR UPDATE;

      IF v_settlement."status" <> 'PAID' THEN
        RAISE EXCEPTION 'Cannot confirm disbursement while parent settlement % has status % (expected PAID)',
          OLD."settlementId", v_settlement."status"
          USING ERRCODE = '23514';
      END IF;

      IF NEW."amount" <= 0 OR NEW."externalReference" IS NULL OR length(btrim(NEW."externalReference")) = 0 OR NEW."confirmedAt" IS NULL THEN
        RAISE EXCEPTION 'CONFIRMED disbursement % requires positive amount, non-empty externalReference, and confirmedAt',
          OLD."id"
          USING ERRCODE = '23514';
      END IF;

      SELECT COALESCE(SUM(vsa."amount"), 0.00) INTO v_adj_sum
      FROM "vendor_settlement_adjustments" vsa
      WHERE vsa."settlementId" = OLD."settlementId";

      v_adjusted_entitlement := v_settlement."netAmount" + v_adj_sum;
      IF v_adjusted_entitlement <= 0 THEN
        RAISE EXCEPTION 'Zero or negative adjusted settlement entitlement (%) blocks confirmed disbursement (settlementId=%)',
          v_adjusted_entitlement, OLD."settlementId"
          USING ERRCODE = '23514';
      END IF;

      SELECT COALESCE(SUM(vsd."amount"), 0.00) INTO v_other_active_disb
      FROM "vendor_settlement_disbursements" vsd
      WHERE vsd."settlementId" = OLD."settlementId"
        AND vsd."status" IN ('CONFIRMED', 'IN_FLIGHT')
        AND vsd."id" <> OLD."id";

      IF (v_other_active_disb + NEW."amount") > v_adjusted_entitlement THEN
        RAISE EXCEPTION 'Cumulative active/confirmed disbursements (%) exceed adjusted settlement entitlement (%) for settlement %',
          (v_other_active_disb + NEW."amount"), v_adjusted_entitlement, OLD."settlementId"
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  IF NEW."amount" <= 0 THEN
    RAISE EXCEPTION 'Disbursement amount must be strictly positive, got %', NEW."amount"
      USING ERRCODE = '23514';
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

  IF NEW."status" = 'CONFIRMED' THEN
    IF v_settlement."status" <> 'PAID' THEN
      RAISE EXCEPTION 'Cannot record CONFIRMED disbursement for settlement % with status % (expected PAID)',
        v_settlement."id", v_settlement."status"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."externalReference" IS NULL OR length(btrim(NEW."externalReference")) = 0 OR NEW."confirmedAt" IS NULL THEN
      RAISE EXCEPTION 'CONFIRMED disbursement requires non-empty externalReference and confirmedAt'
        USING ERRCODE = '23514';
    END IF;
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

  IF NEW."status" IN ('CONFIRMED', 'IN_FLIGHT') THEN
    SELECT COALESCE(SUM(vsa."amount"), 0.00) INTO v_adj_sum
    FROM "vendor_settlement_adjustments" vsa
    WHERE vsa."settlementId" = NEW."settlementId";

    v_adjusted_entitlement := v_settlement."netAmount" + v_adj_sum;
    IF v_adjusted_entitlement <= 0 THEN
      RAISE EXCEPTION 'Zero or negative adjusted settlement entitlement (%) prevents % disbursement for settlement %',
        v_adjusted_entitlement, NEW."status", v_settlement."id"
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(vsd."amount"), 0.00) INTO v_other_active_disb
    FROM "vendor_settlement_disbursements" vsd
    WHERE vsd."settlementId" = NEW."settlementId"
      AND vsd."status" IN ('CONFIRMED', 'IN_FLIGHT');

    IF (v_other_active_disb + NEW."amount") > v_adjusted_entitlement THEN
      RAISE EXCEPTION 'Cumulative active/confirmed disbursements (%) exceed adjusted settlement entitlement (%) for settlement %',
        (v_other_active_disb + NEW."amount"), v_adjusted_entitlement, v_settlement."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5D. Settlement Adjustment Integrity: Lock, Double-Recognition & Negative Solvency Cap
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
  v_existing_adj_sum DECIMAL(10,2);
  v_active_disb_sum DECIMAL(10,2);
  v_adjusted_after DECIMAL(10,2);
BEGIN
  SELECT vs."vendorOrderId", vo."orderId"
  INTO v_vo_id, v_order_id
  FROM "vendor_settlements" vs
  JOIN "vendor_orders" vo ON vo."id" = vs."vendorOrderId"
  WHERE vs."id" = NEW."settlementId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced settlement % does not exist', NEW."settlementId"
      USING ERRCODE = '23503';
  END IF;

  -- Determine refund & payment IDs for canonical locking when refund/allocation linked
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
    RAISE EXCEPTION 'Cannot post adjustment against FAILED settlement %', NEW."settlementId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."amount" < 0 THEN
    -- Negative entitlement adjustments cannot apply to PAID or CONFIRMED-disbursed settlements
    IF v_settlement."status" = 'PAID' OR EXISTS (
      SELECT 1 FROM "vendor_settlement_disbursements" vsd
      WHERE vsd."settlementId" = NEW."settlementId" AND vsd."status" = 'CONFIRMED'
    ) THEN
      RAISE EXCEPTION 'Cannot post negative settlement adjustment on disbursed or PAID settlement %',
        NEW."settlementId"
        USING ERRCODE = '23514';
    END IF;

    -- Refund/allocation negative adjustments additionally blocked if payout is IN_FLIGHT
    IF (NEW."refundId" IS NOT NULL OR NEW."allocationId" IS NOT NULL) AND EXISTS (
      SELECT 1 FROM "vendor_settlement_disbursements" vsd
      WHERE vsd."settlementId" = NEW."settlementId" AND vsd."status" = 'IN_FLIGHT'
    ) THEN
      RAISE EXCEPTION 'Cannot post negative refund/allocation entitlement adjustment on IN_FLIGHT settlement %',
        NEW."settlementId"
        USING ERRCODE = '23514';
    END IF;

    -- Negative adjustments may never push adjusted net below 0 or below active IN_FLIGHT disbursements
    SELECT COALESCE(SUM(vsa."amount"), 0.00) INTO v_existing_adj_sum
    FROM "vendor_settlement_adjustments" vsa
    WHERE vsa."settlementId" = NEW."settlementId";

    SELECT COALESCE(SUM(vsd."amount"), 0.00) INTO v_active_disb_sum
    FROM "vendor_settlement_disbursements" vsd
    WHERE vsd."settlementId" = NEW."settlementId"
      AND vsd."status" IN ('IN_FLIGHT', 'CONFIRMED');

    v_adjusted_after := v_settlement."netAmount" + v_existing_adj_sum + NEW."amount";
    IF v_adjusted_after < 0 THEN
      RAISE EXCEPTION 'Negative adjustment (%) makes settlement % adjusted net negative (%)',
        NEW."amount", NEW."settlementId", v_adjusted_after
        USING ERRCODE = '23514';
    END IF;

    IF v_adjusted_after < v_active_disb_sum THEN
      RAISE EXCEPTION 'Negative adjustment (%) reduces settlement % adjusted net (%) below active disbursements (%)',
        NEW."amount", NEW."settlementId", v_adjusted_after, v_active_disb_sum
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

-- 5E. Receivable Eligibility: Deterministic Partial-Disbursement Coverage Ceiling
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
  v_adj_sum DECIMAL(10,2);
  v_adjusted_entitlement DECIMAL(10,2);
  v_confirmed_disb_total DECIMAL(10,2);
  v_any_confirmed_count BIGINT;
  v_cum_gross DECIMAL(10,2);
  v_cum_fee DECIMAL(10,2);
  v_cum_original DECIMAL(10,2);
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

  -- Require settlement PAID AND valid CONFIRMED disbursement(s) covering cumulative receivables
  IF v_settlement."status" <> 'PAID' THEN
    RAISE EXCEPTION 'VendorReceivable requires PAID settlement, got % (settlementId=%)',
      v_settlement."status", v_settlement."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO v_any_confirmed_count
  FROM "vendor_settlement_disbursements" vsd
  WHERE vsd."settlementId" = NEW."settlementId"
    AND vsd."status" = 'CONFIRMED';

  IF v_any_confirmed_count = 0 THEN
    RAISE EXCEPTION 'VendorReceivable blocked: settlement % lacks a CONFIRMED VendorSettlementDisbursement',
      NEW."settlementId"
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(vsd."amount"), 0.00) INTO v_confirmed_disb_total
  FROM "vendor_settlement_disbursements" vsd
  WHERE vsd."settlementId" = NEW."settlementId"
    AND vsd."status" = 'CONFIRMED'
    AND vsd."vendorId" = v_settlement."vendorId"
    AND vsd."currency" = NEW."currency"
    AND vsd."amount" > 0
    AND vsd."externalReference" IS NOT NULL
    AND length(btrim(vsd."externalReference")) > 0
    AND vsd."confirmedAt" IS NOT NULL;

  IF v_confirmed_disb_total <= 0 THEN
    RAISE EXCEPTION 'VendorReceivable blocked: settlement % CONFIRMED disbursement lacks valid vendor/currency/evidence/positive amount',
      NEW."settlementId"
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(vsa."amount"), 0.00) INTO v_adj_sum
  FROM "vendor_settlement_adjustments" vsa
  WHERE vsa."settlementId" = NEW."settlementId";

  v_adjusted_entitlement := v_settlement."netAmount" + v_adj_sum;
  IF v_adjusted_entitlement <= 0 OR v_confirmed_disb_total > v_adjusted_entitlement THEN
    RAISE EXCEPTION 'VendorReceivable blocked: confirmed disbursement total (%) exceeds adjusted payable entitlement (%) for settlement %',
      v_confirmed_disb_total, v_adjusted_entitlement, NEW."settlementId"
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

  -- Cumulative mathematical ceilings (historical gross/fee AND confirmed disbursement coverage)
  SELECT
    COALESCE(SUM(vr."grossAllocatedAmount"), 0.00),
    COALESCE(SUM(vr."commissionReversedAmount"), 0.00),
    COALESCE(SUM(vr."originalAmount"), 0.00)
  INTO v_cum_gross, v_cum_fee, v_cum_original
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

  IF (v_cum_original + NEW."originalAmount") > v_confirmed_disb_total THEN
    RAISE EXCEPTION 'Cumulative receivable exposure (%) exceeds confirmed disbursement total (%) for settlement %',
      (v_cum_original + NEW."originalAmount"), v_confirmed_disb_total, NEW."settlementId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5F. Receivable Recovery Integrity: Offset Solvency + Manual Payment Evidence & Timestamp Guards
CREATE OR REPLACE FUNCTION "enforce_vendor_receivable_recovery_before_insert"()
RETURNS TRIGGER AS $$
DECLARE
  v_adj "vendor_settlement_adjustments"%ROWTYPE;
  v_adj_settlement "vendor_settlements"%ROWTYPE;
  v_adj_order_currency TEXT;
  v_adj_payment_currency TEXT;
  v_target_adj_sum DECIMAL(10,2);
  v_target_adjusted_net DECIMAL(10,2);
  v_target_active_disb DECIMAL(10,2);
  v_rec "vendor_receivables"%ROWTYPE;
  v_sum_recoveries DECIMAL(10,2);
  v_sum_write_offs DECIMAL(10,2);
  v_remaining DECIMAL(10,2);
BEGIN
  IF NEW."recoveryType"::text = 'MANUAL_PAYMENT' THEN
    IF NEW."targetAdjustmentId" IS NOT NULL THEN
      RAISE EXCEPTION 'MANUAL_PAYMENT recovery must not specify targetAdjustmentId'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."externalReference" IS NULL OR length(btrim(NEW."externalReference")) = 0 THEN
      RAISE EXCEPTION 'MANUAL_PAYMENT recovery requires a non-empty externalReference'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."collectedAt" IS NULL THEN
      RAISE EXCEPTION 'MANUAL_PAYMENT recovery requires collectedAt timestamp'
        USING ERRCODE = '23514';
    END IF;
    IF (NEW."collectedAt" AT TIME ZONE 'UTC') > (CURRENT_TIMESTAMP + interval '5 minutes') THEN
      RAISE EXCEPTION 'MANUAL_PAYMENT collectedAt (%) cannot be in the future',
        NEW."collectedAt"
        USING ERRCODE = '23514';
    END IF;
    IF NEW."idempotencyKey" IS NULL OR length(btrim(NEW."idempotencyKey")) = 0 THEN
      RAISE EXCEPTION 'MANUAL_PAYMENT recovery requires a non-empty idempotencyKey'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."recoveryType"::text = 'SETTLEMENT_OFFSET' THEN
    IF NEW."targetAdjustmentId" IS NULL THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET recovery requires non-null targetAdjustmentId'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."externalReference" IS NOT NULL OR NEW."collectedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET recovery must not specify externalReference or collectedAt'
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

    SELECT COALESCE(SUM(a."amount"), 0.00) INTO v_target_adj_sum
    FROM "vendor_settlement_adjustments" a
    WHERE a."settlementId" = v_adj."settlementId";

    SELECT COALESCE(SUM(vsd."amount"), 0.00) INTO v_target_active_disb
    FROM "vendor_settlement_disbursements" vsd
    WHERE vsd."settlementId" = v_adj."settlementId"
      AND vsd."status" IN ('IN_FLIGHT', 'CONFIRMED');

    v_target_adjusted_net := v_adj_settlement."netAmount" + v_target_adj_sum;
    IF v_target_adjusted_net < 0 OR v_target_adjusted_net < v_target_active_disb THEN
      RAISE EXCEPTION 'SETTLEMENT_OFFSET target settlement % lacks sufficient payable balance (adjustedNet=%, activeDisbursements=%)',
        v_adj."settlementId", v_target_adjusted_net, v_target_active_disb
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
