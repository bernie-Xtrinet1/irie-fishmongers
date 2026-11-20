-- ============================================================================
-- Migration #66: WP4.3B.4F.7D.4B.6C Phase 1
-- Parent-Mutation Financial Integrity & Duplicate Trigger Cleanup
--
-- Fixes D.4B.6B / D.4B.6C Phase 1 parent-mutation & catalog findings:
--   1) Preflight integrity gate (ERRCODE '23514') verifying active OrderItem
--      ceilings, OrderItem->VendorOrder ownership parity across allocations,
--      and zero FAILED refunds bound to VendorSettlementAdjustment/VendorReceivable.
--   2) Removes duplicate BEFORE INSERT OR UPDATE trigger
--      `trg_enforce_refund_allocation_reversal_integrity` on
--      `refund_vendor_order_allocations` while retaining
--      `refund_allocation_reversal_integrity_guard` and
--      `refund_allocations_immutable_guard`.
--   3) Installs `order_items_financial_immutable_guard` blocking mutation of
--      `subtotal`, `vendorOrderId`, `unitPrice`, `productId`, `currency`,
--      `id`, `createdAt`, paid/allocated `quantity`, and financial deletes.
--   4) Installs `orders_financial_immutable_guard` blocking mutation of `id`,
--      `customerId`, `currency`, `createdAt`, and financial deletes.
--   5) Hardens `enforce_refunds_financial_immutable()` to block transitions to
--      `FAILED` when downstream `vendor_settlement_adjustments` or
--      `vendor_receivables` reference the refund or its allocations (while
--      preserving provisional non-terminal -> FAILED lifecycle), and hardens
--      `enforce_payments_financial_immutable()` against reverting settled
--      payments back to `PENDING` or `FAILED`.
-- ============================================================================

-- 0. Atomic Preflight Integrity Verification (ERRCODE '23514' aborts on corruption)
DO $$
DECLARE
  v_cnt BIGINT;
BEGIN
  -- 0.1 Per-Refund cumulative net allocations must lie in [0, refund.amount]
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT r."id"
    FROM "refunds" r
    JOIN "refund_vendor_order_allocations" a ON a."refundId" = r."id"
    GROUP BY r."id", r."amount"
    HAVING SUM(a."amount") > r."amount" OR SUM(a."amount") < 0
  ) bad_refund;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % refund(s) have cumulative net allocations outside [0, refund.amount]',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 0.2 Per-VendorOrder active cumulative net allocations must lie in [0, vendor_order.subtotal]
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT vo."id"
    FROM "vendor_orders" vo
    JOIN "refund_vendor_order_allocations" a ON a."vendorOrderId" = vo."id"
    JOIN "refunds" r ON r."id" = a."refundId"
    WHERE r."status"::text <> 'FAILED'
    GROUP BY vo."id", vo."subtotal"
    HAVING SUM(a."amount") > vo."subtotal" OR SUM(a."amount") < 0
  ) bad_vo;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % vendor order(s) have active cumulative net allocations outside [0, vendorOrder.subtotal]',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 0.3 Per-OrderItem active cumulative net allocations must lie in [0, order_item.subtotal]
  SELECT COUNT(*) INTO v_cnt
  FROM (
    SELECT oi."id"
    FROM "order_items" oi
    JOIN "refund_vendor_order_allocations" a ON a."orderItemId" = oi."id"
    JOIN "refunds" r ON r."id" = a."refundId"
    WHERE r."status"::text <> 'FAILED'
    GROUP BY oi."id", oi."subtotal"
    HAVING SUM(a."amount") > oi."subtotal" OR SUM(a."amount") < 0
  ) bad_oi;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % order item(s) have active cumulative net allocations outside [0, orderItem.subtotal]',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 0.4 Allocation OrderItem must belong to Allocation VendorOrder
  SELECT COUNT(*) INTO v_cnt
  FROM "refund_vendor_order_allocations" a
  JOIN "order_items" oi ON oi."id" = a."orderItemId"
  WHERE oi."vendorOrderId" IS DISTINCT FROM a."vendorOrderId";
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % refund allocation(s) reference an order item from a different vendor order',
      v_cnt
      USING ERRCODE = '23514';
  END IF;

  -- 0.5 FAILED refunds must not retain downstream settlement adjustments or receivables
  SELECT COUNT(*) INTO v_cnt
  FROM "refunds" r
  WHERE r."status"::text = 'FAILED'
    AND (
      EXISTS (
        SELECT 1
        FROM "vendor_settlement_adjustments" vsa
        WHERE vsa."refundId" = r."id"
           OR vsa."allocationId" IN (
             SELECT a."id" FROM "refund_vendor_order_allocations" a WHERE a."refundId" = r."id"
           )
      )
      OR EXISTS (
        SELECT 1
        FROM "vendor_receivables" vr
        JOIN "refund_vendor_order_allocations" a ON a."id" = vr."allocationId"
        WHERE a."refundId" = r."id"
      )
    );
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'Preflight failed: % FAILED refund(s) have downstream settlement adjustment or receivable references',
      v_cnt
      USING ERRCODE = '23514';
  END IF;
END $$;

-- 1. Drop redundant duplicate trigger from Migration #60 (Migration #65 owns refund_allocation_reversal_integrity_guard)
DROP TRIGGER IF EXISTS "trg_enforce_refund_allocation_reversal_integrity" ON "refund_vendor_order_allocations";

-- 2. OrderItem Financial Identity & Parent Relationship Immutability Guard
CREATE OR REPLACE FUNCTION "enforce_order_items_financial_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM "refund_vendor_order_allocations" rvoa
      WHERE rvoa."orderItemId" = OLD."id"
         OR rvoa."vendorOrderId" = OLD."vendorOrderId"
    ) OR EXISTS (
      SELECT 1
      FROM "vendor_settlements" vs
      WHERE vs."vendorOrderId" = OLD."vendorOrderId"
    ) OR EXISTS (
      SELECT 1
      FROM "vendor_orders" vo
      JOIN "payments" p ON p."orderId" = vo."orderId"
      WHERE vo."id" = OLD."vendorOrderId"
    ) THEN
      RAISE EXCEPTION 'order_items records with associated payment, settlement, or allocation cannot be deleted (orderItemId=%)',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."vendorOrderId" IS DISTINCT FROM OLD."vendorOrderId"
    OR NEW."productId" IS DISTINCT FROM OLD."productId"
    OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
    OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Financial and identity fields on order_items are immutable (orderItemId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."quantity" IS DISTINCT FROM OLD."quantity" THEN
    IF EXISTS (
      SELECT 1
      FROM "refund_vendor_order_allocations" rvoa
      WHERE rvoa."orderItemId" = OLD."id"
         OR rvoa."vendorOrderId" = OLD."vendorOrderId"
    ) OR EXISTS (
      SELECT 1
      FROM "vendor_settlements" vs
      WHERE vs."vendorOrderId" = OLD."vendorOrderId"
    ) OR EXISTS (
      SELECT 1
      FROM "vendor_orders" vo
      JOIN "payments" p ON p."orderId" = vo."orderId"
      WHERE vo."id" = OLD."vendorOrderId"
    ) THEN
      RAISE EXCEPTION 'order_items quantity cannot be altered once payment, settlement, or allocation exists (orderItemId=%)',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "order_items_financial_immutable_guard" ON "order_items";
CREATE TRIGGER "order_items_financial_immutable_guard"
BEFORE UPDATE OR DELETE ON "order_items"
FOR EACH ROW
EXECUTE FUNCTION "enforce_order_items_financial_immutable"();

-- 3. Order Financial Ownership & Deletion Guard
CREATE OR REPLACE FUNCTION "enforce_orders_financial_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "payments" p WHERE p."orderId" = OLD."id"
    ) OR EXISTS (
      SELECT 1
      FROM "vendor_orders" vo
      JOIN "vendor_settlements" vs ON vs."vendorOrderId" = vo."id"
      WHERE vo."orderId" = OLD."id"
    ) OR EXISTS (
      SELECT 1
      FROM "vendor_orders" vo
      JOIN "refund_vendor_order_allocations" rvoa ON rvoa."vendorOrderId" = vo."id"
      WHERE vo."orderId" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'orders records with associated payment, settlement, or allocation cannot be deleted (orderId=%)',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Financial and ownership fields on orders are immutable (orderId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "orders_financial_immutable_guard" ON "orders";
CREATE TRIGGER "orders_financial_immutable_guard"
BEFORE UPDATE OR DELETE ON "orders"
FOR EACH ROW
EXECUTE FUNCTION "enforce_orders_financial_immutable"();

-- 4. Harden enforce_refunds_financial_immutable() against invalid FAILED transitions
--    that would orphan downstream settlement adjustments or receivables.
CREATE OR REPLACE FUNCTION "enforce_refunds_financial_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds records are financially immutable and cannot be deleted (refundId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR (OLD."idempotencyKey" IS NOT NULL AND NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey")
  THEN
    RAISE EXCEPTION 'Financial and identity fields on refunds are immutable (refundId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'COMPLETED' AND NEW."status" IS DISTINCT FROM 'COMPLETED' THEN
    RAISE EXCEPTION 'Terminal refund status COMPLETED cannot transition to % (refundId=%)',
      NEW."status", OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('COMPLETED', 'FAILED')
    AND OLD."providerReference" IS NOT NULL
    AND NEW."providerReference" IS DISTINCT FROM OLD."providerReference"
  THEN
    RAISE EXCEPTION 'providerReference on terminal refund (%) cannot be altered once set (existing=%, incoming=%)',
      OLD."status", OLD."providerReference", NEW."providerReference"
      USING ERRCODE = '23514';
  END IF;

  -- Serialize downward (refunds -> allocations -> downstream adjustments/receivables) before allowing transition to FAILED
  IF OLD."status" IS DISTINCT FROM 'FAILED' AND NEW."status" = 'FAILED' THEN
    PERFORM 1
    FROM "refund_vendor_order_allocations" a
    WHERE a."refundId" = OLD."id"
    ORDER BY a."id" ASC
    FOR UPDATE;

    IF EXISTS (
      SELECT 1
      FROM "vendor_settlement_adjustments" vsa
      WHERE vsa."refundId" = OLD."id"
         OR vsa."allocationId" IN (
           SELECT a."id" FROM "refund_vendor_order_allocations" a WHERE a."refundId" = OLD."id"
         )
    ) THEN
      RAISE EXCEPTION 'Cannot transition refund % to FAILED while downstream vendor_settlement_adjustments reference this refund or its allocations',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "vendor_receivables" vr
      JOIN "refund_vendor_order_allocations" a ON a."id" = vr."allocationId"
      WHERE a."refundId" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'Cannot transition refund % to FAILED while downstream vendor_receivables reference its allocations',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Harden enforce_payments_financial_immutable() against reverting settled payments to PENDING/FAILED
CREATE OR REPLACE FUNCTION "enforce_payments_financial_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
      OR EXISTS (SELECT 1 FROM "refunds" r WHERE r."paymentId" = OLD."id")
    THEN
      RAISE EXCEPTION 'payments with status % or with associated refunds cannot be deleted (paymentId=%)',
        OLD."status", OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."merchantAccountId" IS DISTINCT FROM OLD."merchantAccountId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Financial and identity fields on payments are immutable (paymentId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
    AND NEW."status" IN ('PENDING', 'FAILED')
  THEN
    RAISE EXCEPTION 'Settled payment status % cannot revert to % (paymentId=%)',
      OLD."status", NEW."status", OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
