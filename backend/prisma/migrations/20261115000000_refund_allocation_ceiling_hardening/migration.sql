-- ============================================================================
-- Migration #65: D.4B.6A Workstream B
-- Database-Enforced Refund Allocation Ceilings & Transaction-Safe Locking
--
-- Hardens refund_vendor_order_allocations against direct SQL & Prisma bypasses:
--   1) Preflight integrity gate (SQLSTATE 23514) verifying existing data respects
--      Refund, active VendorOrder, and active OrderItem allocation ceilings.
--   2) Canonical row locking (orders -> vendor_orders -> payments -> refunds ->
--      order_items / allocations) inside enforce_refund_allocation_reversal_integrity
--      to eliminate concurrent allocation & reversal race windows with zero deadlocks.
--   3) Strict database-enforced cumulative net allocation ceilings [0, ceiling]
--      with J$0.01 precision per Refund, per active VendorOrder, and per active OrderItem.
--   4) Preserves FAILED-refund terminality, allocation immutability, reversal
--      identity/amount/VendorReceivable restrictions, currency, and ownership guards.
-- ============================================================================

-- 0. Atomic Preflight Integrity Verification (ERRCODE '23514' aborts cleanly on violation)
DO $$
DECLARE
  v_cnt BIGINT;
BEGIN
  -- 1) Per-Refund cumulative net allocations must lie in [0, refund.amount]
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT r."id"
    FROM "refunds" r
    JOIN "refund_vendor_order_allocations" a ON a."refundId" = r."id"
    GROUP BY r."id", r."amount"
    HAVING SUM(a."amount") > r."amount" OR SUM(a."amount") < 0
  ) bad_refund_alloc;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % refund(s) have cumulative net allocations outside [0, refund.amount]',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 2) Per-VendorOrder active (non-FAILED refund) cumulative net allocations must lie in [0, vendor_order.subtotal]
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT vo."id"
    FROM "vendor_orders" vo
    JOIN "refund_vendor_order_allocations" a ON a."vendorOrderId" = vo."id"
    JOIN "refunds" r ON r."id" = a."refundId"
    WHERE r."status"::text <> 'FAILED'
    GROUP BY vo."id", vo."subtotal"
    HAVING SUM(a."amount") > vo."subtotal" OR SUM(a."amount") < 0
  ) bad_vo_alloc;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % vendor order(s) have active cumulative net allocations outside [0, vendorOrder.subtotal]',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 3) Per-OrderItem active (non-FAILED refund) cumulative net allocations must lie in [0, order_item.subtotal]
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT oi."id"
    FROM "order_items" oi
    JOIN "refund_vendor_order_allocations" a ON a."orderItemId" = oi."id"
    JOIN "refunds" r ON r."id" = a."refundId"
    WHERE r."status"::text <> 'FAILED'
    GROUP BY oi."id", oi."subtotal"
    HAVING SUM(a."amount") > oi."subtotal" OR SUM(a."amount") < 0
  ) bad_item_alloc;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % order item(s) have active cumulative net allocations outside [0, orderItem.subtotal]',
      v_cnt
      USING ERRCODE = '23514';
  END IF;
END $$;

-- 1. Hardened Allocation Integrity & Cumulative Ceiling Trigger Function
CREATE OR REPLACE FUNCTION "enforce_refund_allocation_reversal_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  v_refund_meta RECORD;
  v_vo_meta RECORD;
  v_vo "vendor_orders"%ROWTYPE;
  v_payment "payments"%ROWTYPE;
  v_refund "refunds"%ROWTYPE;
  v_item_vo_id TEXT;
  v_item_subtotal DECIMAL(10,2);
  v_orig "refund_vendor_order_allocations"%ROWTYPE;
  v_refund_other_net NUMERIC;
  v_refund_new_net NUMERIC;
  v_vo_other_net NUMERIC;
  v_vo_new_net NUMERIC;
  v_item_other_net NUMERIC;
  v_item_new_net NUMERIC;
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
  END IF;

  -- Unlocked metadata lookup to validate FK targets & order ownership prior to canonical locking
  SELECT r."id", r."paymentId", p."orderId"
  INTO v_refund_meta
  FROM "refunds" r
  JOIN "payments" p ON p."id" = r."paymentId"
  WHERE r."id" = NEW."refundId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced refund % does not exist', NEW."refundId"
      USING ERRCODE = '23503';
  END IF;

  SELECT vo."id", vo."orderId"
  INTO v_vo_meta
  FROM "vendor_orders" vo
  WHERE vo."id" = NEW."vendorOrderId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced vendor order % does not exist', NEW."vendorOrderId"
      USING ERRCODE = '23503';
  END IF;

  IF v_vo_meta."orderId" IS DISTINCT FROM v_refund_meta."orderId" THEN
    RAISE EXCEPTION 'VendorOrder % (order %) does not belong to Refund % order (%)',
      NEW."vendorOrderId", v_vo_meta."orderId", NEW."refundId", v_refund_meta."orderId"
      USING ERRCODE = '23514';
  END IF;

  -- Canonical row locking: orders -> vendor_orders -> payments -> refunds
  PERFORM 1 FROM "orders" WHERE "id" = v_refund_meta."orderId" FOR UPDATE;
  SELECT * INTO v_vo FROM "vendor_orders" WHERE "id" = NEW."vendorOrderId" FOR UPDATE;
  SELECT * INTO v_payment FROM "payments" WHERE "id" = v_refund_meta."paymentId" FOR UPDATE;
  SELECT * INTO v_refund FROM "refunds" WHERE "id" = NEW."refundId" FOR UPDATE;

  IF TG_OP = 'INSERT' AND v_refund."status" = 'FAILED' THEN
    RAISE EXCEPTION 'Cannot create allocation or reversal for FAILED refund %', NEW."refundId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."currency" IS DISTINCT FROM v_payment."currency" THEN
    RAISE EXCEPTION 'Allocation currency % does not match payment currency %',
      NEW."currency", v_payment."currency"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."orderItemId" IS NOT NULL THEN
    SELECT oi."vendorOrderId", oi."subtotal"
    INTO v_item_vo_id, v_item_subtotal
    FROM "order_items" oi
    WHERE oi."id" = NEW."orderItemId"
    FOR UPDATE;

    IF NOT FOUND OR v_item_vo_id IS DISTINCT FROM NEW."vendorOrderId" THEN
      RAISE EXCEPTION 'OrderItem % does not belong to VendorOrder %',
        NEW."orderItemId", NEW."vendorOrderId"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW."entryKind" = 'REVERSAL' THEN
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

    -- Preserve native SQLSTATE 23505 (Prisma P2002) from reversesAllocationId unique index
    -- rather than masking a duplicate REVERSAL behind a cumulative-negative 23514 exception.
    IF EXISTS (
      SELECT 1
      FROM "refund_vendor_order_allocations" rev_exist
      WHERE rev_exist."reversesAllocationId" = NEW."reversesAllocationId"
        AND rev_exist."id" IS DISTINCT FROM NEW."id"
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Aggregate ceiling checks under canonical locks (reject even J$0.01 over-allocation or negative balance)
  -- 1) Per-Refund ceiling
  SELECT COALESCE(SUM(a."amount"), 0.00)
  INTO v_refund_other_net
  FROM "refund_vendor_order_allocations" a
  WHERE a."refundId" = NEW."refundId"
    AND a."id" IS DISTINCT FROM NEW."id";

  v_refund_new_net := v_refund_other_net + NEW."amount";
  IF v_refund_new_net < 0 THEN
    RAISE EXCEPTION 'Allocation change (%) causes negative cumulative net allocated balance (%) for refund %',
      NEW."amount", v_refund_new_net, NEW."refundId"
      USING ERRCODE = '23514';
  END IF;

  IF v_refund_new_net > v_refund."amount" THEN
    RAISE EXCEPTION 'Cumulative net allocated amount (%) exceeds refund % amount (%)',
      v_refund_new_net, NEW."refundId", v_refund."amount"
      USING ERRCODE = '23514';
  END IF;

  -- 2) Per-VendorOrder active ceiling (excluding FAILED refunds)
  SELECT COALESCE(SUM(a."amount"), 0.00)
  INTO v_vo_other_net
  FROM "refund_vendor_order_allocations" a
  JOIN "refunds" r ON r."id" = a."refundId"
  WHERE a."vendorOrderId" = NEW."vendorOrderId"
    AND r."status" <> 'FAILED'
    AND a."id" IS DISTINCT FROM NEW."id";

  IF v_refund."status" <> 'FAILED' THEN
    v_vo_new_net := v_vo_other_net + NEW."amount";
  ELSE
    v_vo_new_net := v_vo_other_net;
  END IF;

  IF v_vo_new_net < 0 THEN
    RAISE EXCEPTION 'Allocation change (%) causes negative cumulative net liability (%) for vendor order %',
      NEW."amount", v_vo_new_net, NEW."vendorOrderId"
      USING ERRCODE = '23514';
  END IF;

  IF v_vo_new_net > v_vo."subtotal" THEN
    RAISE EXCEPTION 'Cumulative active allocated amount (%) exceeds vendor order % subtotal (%)',
      v_vo_new_net, NEW."vendorOrderId", v_vo."subtotal"
      USING ERRCODE = '23514';
  END IF;

  -- 3) Per-OrderItem active ceiling (when orderItemId is set, excluding FAILED refunds)
  IF NEW."orderItemId" IS NOT NULL THEN
    SELECT COALESCE(SUM(a."amount"), 0.00)
    INTO v_item_other_net
    FROM "refund_vendor_order_allocations" a
    JOIN "refunds" r ON r."id" = a."refundId"
    WHERE a."orderItemId" = NEW."orderItemId"
      AND r."status" <> 'FAILED'
      AND a."id" IS DISTINCT FROM NEW."id";

    IF v_refund."status" <> 'FAILED' THEN
      v_item_new_net := v_item_other_net + NEW."amount";
    ELSE
      v_item_new_net := v_item_other_net;
    END IF;

    IF v_item_new_net < 0 THEN
      RAISE EXCEPTION 'Allocation change (%) causes negative cumulative net liability (%) for order item %',
        NEW."amount", v_item_new_net, NEW."orderItemId"
        USING ERRCODE = '23514';
    END IF;

    IF v_item_new_net > v_item_subtotal THEN
      RAISE EXCEPTION 'Cumulative active allocated amount (%) exceeds order item % subtotal (%)',
        v_item_new_net, NEW."orderItemId", v_item_subtotal
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure trigger fires BEFORE INSERT OR UPDATE on refund_vendor_order_allocations
DROP TRIGGER IF EXISTS "refund_allocation_reversal_integrity_guard" ON "refund_vendor_order_allocations";
CREATE TRIGGER "refund_allocation_reversal_integrity_guard"
BEFORE INSERT OR UPDATE ON "refund_vendor_order_allocations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_refund_allocation_reversal_integrity"();
