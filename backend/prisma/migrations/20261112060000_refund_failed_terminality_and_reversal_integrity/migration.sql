-- WP4.3B.4F.7D.4B.3B: Narrowly scoped FAILED terminality and cross-row REVERSAL integrity guards.
-- Does not add unrelated D.4B.4 immutability or FK cascade triggers.

-- 1. Preflight verification: abort if pre-existing data contains any corrupted REVERSAL rows.
DO $$
DECLARE
  v_corrupt_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_corrupt_count
  FROM "refund_vendor_order_allocations" rev
  LEFT JOIN "refund_vendor_order_allocations" orig
    ON orig."id" = rev."reversesAllocationId"
  WHERE rev."entryKind" = 'REVERSAL'
    AND (
      orig."id" IS NULL
      OR orig."entryKind" <> 'ALLOCATION'
      OR rev."refundId" <> orig."refundId"
      OR rev."vendorOrderId" <> orig."vendorOrderId"
      OR rev."orderItemId" IS DISTINCT FROM orig."orderItemId"
      OR rev."allocationType" <> orig."allocationType"
      OR rev."currency" <> orig."currency"
      OR (-rev."amount") > orig."amount"
    );

  IF v_corrupt_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % existing REVERSAL rows violate cross-row integrity', v_corrupt_count
      USING ERRCODE = '23514';
  END IF;
END $$;

-- 2. F-D4B3A-01: Enforce terminal FAILED invariant on refunds table against direct Prisma/SQL updates.
CREATE OR REPLACE FUNCTION "enforce_refund_failed_terminality"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'FAILED' AND NEW."status" IS DISTINCT FROM 'FAILED' THEN
    RAISE EXCEPTION 'Terminal refund status FAILED cannot transition to % (refundId=%)',
      NEW."status", OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_enforce_refund_failed_terminality"
BEFORE UPDATE OF "status" ON "refunds"
FOR EACH ROW
EXECUTE FUNCTION "enforce_refund_failed_terminality"();

-- 3. F-D4B3A-02: Enforce cross-row reversal, refund eligibility, and post-insert identity immutability on refund_vendor_order_allocations.
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

    -- Lock target ALLOCATION row to serialize concurrent direct SQL reversal attempts cleanly.
    -- Refund row is NOT locked after Allocation to preserve canonical Order -> VendorOrder -> Refund -> Allocation order.
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

CREATE TRIGGER "trg_enforce_refund_allocation_reversal_integrity"
BEFORE INSERT OR UPDATE ON "refund_vendor_order_allocations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_refund_allocation_reversal_integrity"();
