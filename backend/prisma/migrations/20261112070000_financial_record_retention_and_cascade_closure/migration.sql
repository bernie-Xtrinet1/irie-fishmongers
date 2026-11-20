-- ============================================================================
-- WP4.3B.4F.7D.4B.4 — Financial Record Retention, Cascade Closure and Immutability
-- ============================================================================

-- 1. Preflight Data Integrity Assertions
DO $$
DECLARE
  v_orphan_count INTEGER := 0;
  v_corrupt_settlement_count INTEGER := 0;
  v_invalid_adj_count INTEGER := 0;
BEGIN
  -- Assert zero orphaned records violating any of the 7 candidate RESTRICT foreign keys
  SELECT COUNT(*) INTO v_orphan_count
  FROM (
    SELECT o."id" FROM "orders" o LEFT JOIN "users" u ON u."id" = o."customerId" WHERE u."id" IS NULL
    UNION ALL
    SELECT vo."id" FROM "vendor_orders" vo LEFT JOIN "orders" o ON o."id" = vo."orderId" WHERE o."id" IS NULL
    UNION ALL
    SELECT oi."id" FROM "order_items" oi LEFT JOIN "vendor_orders" vo ON vo."id" = oi."vendorOrderId" WHERE vo."id" IS NULL
    UNION ALL
    SELECT p."id" FROM "payments" p LEFT JOIN "orders" o ON o."id" = p."orderId" WHERE o."id" IS NULL
    UNION ALL
    SELECT r."id" FROM "refunds" r LEFT JOIN "payments" p ON p."id" = r."paymentId" WHERE p."id" IS NULL
    UNION ALL
    SELECT vs."id" FROM "vendor_settlements" vs LEFT JOIN "vendor_orders" vo ON vo."id" = vs."vendorOrderId" WHERE vo."id" IS NULL
    UNION ALL
    SELECT vsa."id" FROM "vendor_settlement_adjustments" vsa LEFT JOIN "vendor_settlements" vs ON vs."id" = vsa."settlementId" WHERE vs."id" IS NULL
  ) orphans;

  IF v_orphan_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: found % orphaned financial records violating foreign keys', v_orphan_count
      USING ERRCODE = '23514';
  END IF;

  -- Assert all vendor settlements obey calculation integrity
  SELECT COUNT(*) INTO v_corrupt_settlement_count
  FROM "vendor_settlements"
  WHERE "grossAmount" < 0
     OR "platformFee" < 0
     OR "netAmount" <> ("grossAmount" - "platformFee");

  IF v_corrupt_settlement_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: found % corrupt vendor_settlement calculations', v_corrupt_settlement_count
      USING ERRCODE = '23514';
  END IF;

  -- Assert all refund-linked adjustments have valid non-empty idempotencyKey
  SELECT COUNT(*) INTO v_invalid_adj_count
  FROM "vendor_settlement_adjustments"
  WHERE "refundId" IS NOT NULL AND ("idempotencyKey" IS NULL OR length(trim("idempotencyKey")) = 0);

  IF v_invalid_adj_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: found % vendor_settlement_adjustments with missing idempotencyKey', v_invalid_adj_count
      USING ERRCODE = '23514';
  END IF;
END $$;

-- 2. Transition Seven Foreign Keys to ON DELETE RESTRICT

-- 2.1 orders.customerId -> users.id
ALTER TABLE "orders" DROP CONSTRAINT "orders_customerId_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2.2 vendor_orders.orderId -> orders.id
ALTER TABLE "vendor_orders" DROP CONSTRAINT "vendor_orders_orderId_fkey";
ALTER TABLE "vendor_orders" ADD CONSTRAINT "vendor_orders_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2.3 order_items.vendorOrderId -> vendor_orders.id
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_vendorOrderId_fkey";
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_vendorOrderId_fkey"
  FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2.4 payments.orderId -> orders.id
ALTER TABLE "payments" DROP CONSTRAINT "payments_orderId_fkey";
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2.5 refunds.paymentId -> payments.id
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_paymentId_fkey";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2.6 vendor_settlements.vendorOrderId -> vendor_orders.id
ALTER TABLE "vendor_settlements" DROP CONSTRAINT "vendor_settlements_vendorOrderId_fkey";
ALTER TABLE "vendor_settlements" ADD CONSTRAINT "vendor_settlements_vendorOrderId_fkey"
  FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2.7 vendor_settlement_adjustments.settlementId -> vendor_settlements.id
ALTER TABLE "vendor_settlement_adjustments" DROP CONSTRAINT "vendor_settlement_adjustments_settlementId_fkey";
ALTER TABLE "vendor_settlement_adjustments" ADD CONSTRAINT "vendor_settlement_adjustments_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "vendor_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Install Six Financial Immutability Triggers

-- 3.1 refund_allocations_immutable_guard on refund_vendor_order_allocations
CREATE OR REPLACE FUNCTION "enforce_refund_allocations_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund_vendor_order_allocations records are append-only and cannot be deleted (allocationId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- TG_OP = 'UPDATE'
  RAISE EXCEPTION 'refund_vendor_order_allocations records are immutable and cannot be updated (allocationId=%)',
    OLD."id"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "refund_allocations_immutable_guard" ON "refund_vendor_order_allocations";
CREATE TRIGGER "refund_allocations_immutable_guard"
BEFORE UPDATE OR DELETE ON "refund_vendor_order_allocations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_refund_allocations_immutable"();

-- 3.2 vendor_settlement_adjustments_immutable_guard on vendor_settlement_adjustments
CREATE OR REPLACE FUNCTION "enforce_vendor_settlement_adjustments_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendor_settlement_adjustments records are append-only and cannot be deleted (adjustmentId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- TG_OP = 'UPDATE'
  RAISE EXCEPTION 'vendor_settlement_adjustments records are immutable and cannot be updated (adjustmentId=%)',
    OLD."id"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "vendor_settlement_adjustments_immutable_guard" ON "vendor_settlement_adjustments";
CREATE TRIGGER "vendor_settlement_adjustments_immutable_guard"
BEFORE UPDATE OR DELETE ON "vendor_settlement_adjustments"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_settlement_adjustments_immutable"();

-- 3.3 refunds_financial_immutable_guard on refunds
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "refunds_financial_immutable_guard" ON "refunds";
CREATE TRIGGER "refunds_financial_immutable_guard"
BEFORE UPDATE OR DELETE ON "refunds"
FOR EACH ROW
EXECUTE FUNCTION "enforce_refunds_financial_immutable"();

-- 3.4 vendor_settlements_financial_immutable_guard on vendor_settlements
CREATE OR REPLACE FUNCTION "enforce_vendor_settlements_financial_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendor_settlements records are financially immutable and cannot be deleted (settlementId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId"
    OR NEW."vendorOrderId" IS DISTINCT FROM OLD."vendorOrderId"
    OR NEW."grossAmount" IS DISTINCT FROM OLD."grossAmount"
    OR NEW."platformFee" IS DISTINCT FROM OLD."platformFee"
    OR NEW."netAmount" IS DISTINCT FROM OLD."netAmount"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Financial and identity fields on vendor_settlements are immutable (settlementId=%)',
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

DROP TRIGGER IF EXISTS "vendor_settlements_financial_immutable_guard" ON "vendor_settlements";
CREATE TRIGGER "vendor_settlements_financial_immutable_guard"
BEFORE UPDATE OR DELETE ON "vendor_settlements"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_settlements_financial_immutable"();

-- 3.5 payments_financial_immutable_guard on payments
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "payments_financial_immutable_guard" ON "payments";
CREATE TRIGGER "payments_financial_immutable_guard"
BEFORE UPDATE OR DELETE ON "payments"
FOR EACH ROW
EXECUTE FUNCTION "enforce_payments_financial_immutable"();

-- 3.6 vendor_orders_financial_immutable_guard on vendor_orders
CREATE OR REPLACE FUNCTION "enforce_vendor_orders_financial_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "payments" p WHERE p."orderId" = OLD."orderId"
    ) OR EXISTS (
      SELECT 1 FROM "vendor_settlements" vs WHERE vs."vendorOrderId" = OLD."id"
    ) OR EXISTS (
      SELECT 1 FROM "refund_vendor_order_allocations" rvoa WHERE rvoa."vendorOrderId" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'vendor_orders records with associated payment, settlement, or allocation cannot be deleted (vendorOrderId=%)',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId"
    OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Financial and identity fields on vendor_orders are immutable (vendorOrderId=%)',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "vendor_orders_financial_immutable_guard" ON "vendor_orders";
CREATE TRIGGER "vendor_orders_financial_immutable_guard"
BEFORE UPDATE OR DELETE ON "vendor_orders"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_orders_financial_immutable"();
