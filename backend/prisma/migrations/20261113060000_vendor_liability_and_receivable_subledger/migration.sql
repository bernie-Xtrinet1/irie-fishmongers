-- ============================================================================
-- WP4.3B.4F.7D.4B.5 — Vendor Liability Calculation, Historical Commission
-- Conservation and Passive Receivable Foundation
-- ============================================================================

-- 1. Create Enums for Vendor Receivables
CREATE TYPE "VendorReceivableStatus" AS ENUM ('OPEN', 'PARTIALLY_RECOVERED', 'RECOVERED', 'DISPUTED', 'WRITTEN_OFF');
CREATE TYPE "VendorReceivableRecoveryType" AS ENUM ('SETTLEMENT_OFFSET', 'MANUAL_PAYMENT', 'WRITE_OFF');

-- 2. Additive Nullable Audit Snapshots on vendor_settlements
ALTER TABLE "vendor_settlements" ADD COLUMN "commissionConfigId" TEXT;
ALTER TABLE "vendor_settlements" ADD COLUMN "commissionRateSnapshot" DECIMAL(5,4);

-- 3. Create Table vendor_receivables
CREATE TABLE "vendor_receivables" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JMD',
    "grossAllocatedAmount" DECIMAL(10,2) NOT NULL,
    "commissionReversedAmount" DECIMAL(10,2) NOT NULL,
    "originalAmount" DECIMAL(10,2) NOT NULL,
    "recoveredAmount" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "writtenOffAmount" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "status" "VendorReceivableStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_receivables_pkey" PRIMARY KEY ("id")
);

-- 4. Create Table vendor_receivable_recoveries
CREATE TABLE "vendor_receivable_recoveries" (
    "id" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "targetAdjustmentId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "recoveryType" "VendorReceivableRecoveryType" NOT NULL,
    "idempotencyKey" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_receivable_recoveries_pkey" PRIMARY KEY ("id")
);

-- 5. Indexes and Uniqueness
CREATE UNIQUE INDEX "vendor_receivables_allocationId_key" ON "vendor_receivables"("allocationId");
CREATE INDEX "vendor_receivables_vendorId_idx" ON "vendor_receivables"("vendorId");
CREATE INDEX "vendor_receivables_settlementId_idx" ON "vendor_receivables"("settlementId");
CREATE INDEX "vendor_receivables_status_idx" ON "vendor_receivables"("status");
CREATE INDEX "vendor_settlements_commissionConfigId_idx" ON "vendor_settlements"("commissionConfigId");

CREATE UNIQUE INDEX "vendor_receivable_recoveries_idempotencyKey_key" ON "vendor_receivable_recoveries"("idempotencyKey");
CREATE INDEX "vendor_receivable_recoveries_receivableId_idx" ON "vendor_receivable_recoveries"("receivableId");
CREATE INDEX "vendor_receivable_recoveries_targetAdjustmentId_idx" ON "vendor_receivable_recoveries"("targetAdjustmentId");

-- 6. Foreign Key Constraints (Strict RESTRICT for financial integrity)
ALTER TABLE "vendor_settlements" ADD CONSTRAINT "vendor_settlements_commissionConfigId_fkey"
    FOREIGN KEY ("commissionConfigId") REFERENCES "platform_commission_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vendor_receivables" ADD CONSTRAINT "vendor_receivables_allocationId_fkey"
    FOREIGN KEY ("allocationId") REFERENCES "refund_vendor_order_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_receivables" ADD CONSTRAINT "vendor_receivables_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_receivables" ADD CONSTRAINT "vendor_receivables_settlementId_fkey"
    FOREIGN KEY ("settlementId") REFERENCES "vendor_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_receivable_recoveries" ADD CONSTRAINT "vendor_receivable_recoveries_receivableId_fkey"
    FOREIGN KEY ("receivableId") REFERENCES "vendor_receivables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_receivable_recoveries" ADD CONSTRAINT "vendor_receivable_recoveries_targetAdjustmentId_fkey"
    FOREIGN KEY ("targetAdjustmentId") REFERENCES "vendor_settlement_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Mathematical & Non-Negative Conservation CHECK Constraints
ALTER TABLE "vendor_receivables" ADD CONSTRAINT "chk_vendor_receivable_amounts"
    CHECK ("originalAmount" > 0 AND "recoveredAmount" >= 0 AND "writtenOffAmount" >= 0 AND ("recoveredAmount" + "writtenOffAmount") <= "originalAmount");

ALTER TABLE "vendor_receivables" ADD CONSTRAINT "chk_vendor_receivable_math"
    CHECK ("originalAmount" = "grossAllocatedAmount" - "commissionReversedAmount" AND "grossAllocatedAmount" > 0 AND "commissionReversedAmount" >= 0);

ALTER TABLE "vendor_receivable_recoveries" ADD CONSTRAINT "chk_receivable_recovery_amount"
    CHECK ("amount" > 0);

-- 8. Immutability Triggers
-- 8.1 vendor_receivable_recoveries is strictly append-only
CREATE OR REPLACE FUNCTION "enforce_vendor_receivable_recoveries_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'vendor_receivable_recoveries records are append-only and cannot be updated or deleted (recoveryId=%)',
        OLD."id"
        USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "vendor_receivable_recoveries_immutable_guard" ON "vendor_receivable_recoveries";
CREATE TRIGGER "vendor_receivable_recoveries_immutable_guard"
BEFORE UPDATE OR DELETE ON "vendor_receivable_recoveries"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_receivable_recoveries_immutable"();

-- 8.2 vendor_receivables hard delete is prohibited and identity/monetary fields are immutable
CREATE OR REPLACE FUNCTION "enforce_vendor_receivables_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'vendor_receivables records are financially immutable and cannot be deleted (receivableId=%)',
            OLD."id"
            USING ERRCODE = '23514';
    END IF;

    -- TG_OP = 'UPDATE'
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

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "vendor_receivables_immutable_guard" ON "vendor_receivables";
CREATE TRIGGER "vendor_receivables_immutable_guard"
BEFORE UPDATE OR DELETE ON "vendor_receivables"
FOR EACH ROW
EXECUTE FUNCTION "enforce_vendor_receivables_immutable"();
