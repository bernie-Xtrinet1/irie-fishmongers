-- ============================================================================
-- IRIE FISHMONGERS: PHASE 16D WP2 ADDITIVE WEIGHT ADJUSTMENT SCHEMA MIGRATION
-- ============================================================================

-- 1. Create Enums
DO $$ BEGIN
    CREATE TYPE "SeafoodPricingBasis" AS ENUM ('WHOLE_RAW', 'DRESSED', 'FINISHED_PRODUCT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "WeightMeasurementStatus" AS ENUM ('PENDING_MEASUREMENT', 'MEASURED_WITHIN_CEILING', 'MEASURED_EXCEEDS_CEILING', 'DISPUTED', 'SETTLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "CustomerWeightApprovalStatus" AS ENUM ('NOT_REQUIRED', 'AWAITING_APPROVAL', 'APPROVED_BY_CUSTOMER', 'REJECTED_BY_CUSTOMER', 'AUTO_EXPIRED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "CustomerApprovalAction" AS ENUM ('APPROVED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "PaymentObligationDirection" AS ENUM ('NONE', 'CREDIT_DUE_CUSTOMER', 'SUPPLEMENTAL_PAYMENT_DUE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'SETTLED', 'WAIVED', 'DISPUTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "SettlementChannel" AS ENUM ('COD_DOORSTEP_RECEIPT', 'WIPAY_SECONDARY_PAYMENT_CONFIRMED', 'ADMIN_CREDIT_MEMO_ISSUED', 'VENDOR_ABSORPTION');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "UsablePartsPreference" AS ENUM ('RETURN_USABLE_PARTS', 'DO_NOT_RETURN_USABLE_PARTS');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "UsablePartsFulfillmentOutcome" AS ENUM ('RETURNED_AVAILABLE_PARTS', 'PARTIALLY_RETURNED', 'NO_SUITABLE_PARTS_AVAILABLE', 'CUSTOMER_DECLINED_PARTS');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "PreparationFeeStructure" AS ENUM ('FLAT_FEE', 'PER_UNIT_WEIGHT', 'INCLUDED_IN_PRICE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. Create Active Adjustment Table
CREATE TABLE IF NOT EXISTS "seafood_order_weight_adjustments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderItemId" TEXT NOT NULL UNIQUE,
    "pricingBasis" "SeafoodPricingBasis" NOT NULL,
    "unit" "WeightUnit" NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "pieceCount" INTEGER NOT NULL DEFAULT 1,
    "estimatedBillableWeight" DECIMAL(8,3) NOT NULL,
    "verifiedBillableWeight" DECIMAL(8,3),
    "preparedNetWeight" DECIMAL(8,3),
    "weightDifference" DECIMAL(8,3),
    "yieldLossWeight" DECIMAL(8,3),
    "yieldLossPercent" DECIMAL(5,2),
    "preparationServiceName" TEXT,
    "usablePartsPreference" "UsablePartsPreference" NOT NULL DEFAULT 'RETURN_USABLE_PARTS',
    "usablePartsOutcome" "UsablePartsFulfillmentOutcome",
    "preparationFeeStructure" "PreparationFeeStructure" NOT NULL DEFAULT 'FLAT_FEE',
    "preparationFeeRate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "estimatedPreparationFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "finalPreparationFee" DECIMAL(10,2),
    "preparationFeeDifference" DECIMAL(10,2),
    "estimatedProductSubtotal" DECIMAL(10,2) NOT NULL,
    "finalProductSubtotal" DECIMAL(10,2),
    "productSubtotalDifference" DECIMAL(10,2),
    "estimatedItemTotal" DECIMAL(10,2) NOT NULL,
    "finalItemTotal" DECIMAL(10,2),
    "totalAdjustmentAmount" DECIMAL(10,2),
    "customerAuthorizedCeilingJmd" DECIMAL(10,2) NOT NULL,
    "customerApprovalStatus" "CustomerWeightApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "boundApprovalRevision" INTEGER,
    "approvalReason" TEXT,
    "measurementStatus" "WeightMeasurementStatus" NOT NULL DEFAULT 'PENDING_MEASUREMENT',
    "activeMeasurementRevision" INTEGER,
    "activePreparationRevision" INTEGER,
    "foodSafetyStatus" "FoodSafetyStatus" NOT NULL DEFAULT 'SAFE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_weight_adj_order_item" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_seafood_weight_adj_status" ON "seafood_order_weight_adjustments"("measurementStatus");
CREATE INDEX IF NOT EXISTS "idx_seafood_weight_adj_approval" ON "seafood_order_weight_adjustments"("customerApprovalStatus");
CREATE INDEX IF NOT EXISTS "idx_seafood_weight_adj_safety" ON "seafood_order_weight_adjustments"("foodSafetyStatus");

-- 3. Create Strictly Append-Only Measurement Audit Log Table
CREATE TABLE IF NOT EXISTS "seafood_weight_measurement_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weightAdjustmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL UNIQUE,
    "payloadHash" TEXT NOT NULL,
    "pricingBasis" "SeafoodPricingBasis" NOT NULL,
    "unit" "WeightUnit" NOT NULL,
    "measuredWeight" DECIMAL(8,3) NOT NULL,
    "scalePhotoUrl" TEXT NOT NULL,
    "scaleDeviceIdentifier" TEXT,
    "scaleCalibrationDate" TIMESTAMP(3),
    "operatorUserId" TEXT NOT NULL,
    "correctionReason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_weight_event_adj" FOREIGN KEY ("weightAdjustmentId") REFERENCES "seafood_order_weight_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_weight_event_operator" FOREIGN KEY ("operatorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "uq_weight_adj_revision" UNIQUE ("weightAdjustmentId", "revision")
);

CREATE INDEX IF NOT EXISTS "idx_weight_event_time" ON "seafood_weight_measurement_events"("weightAdjustmentId", "recordedAt");
CREATE INDEX IF NOT EXISTS "idx_weight_event_operator" ON "seafood_weight_measurement_events"("operatorUserId");

-- 4. Create Strictly Append-Only Preparation Fulfillment Audit Log Table
CREATE TABLE IF NOT EXISTS "seafood_preparation_fulfillment_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weightAdjustmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL UNIQUE,
    "payloadHash" TEXT NOT NULL,
    "preparedNetWeight" DECIMAL(8,3),
    "partsOutcome" "UsablePartsFulfillmentOutcome" NOT NULL,
    "partsDisposalReason" TEXT,
    "preparedPhotoUrl" TEXT,
    "operatorUserId" TEXT NOT NULL,
    "correctionReason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_prep_event_adj" FOREIGN KEY ("weightAdjustmentId") REFERENCES "seafood_order_weight_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_prep_event_operator" FOREIGN KEY ("operatorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "uq_prep_adj_revision" UNIQUE ("weightAdjustmentId", "revision")
);

CREATE INDEX IF NOT EXISTS "idx_prep_event_time" ON "seafood_preparation_fulfillment_events"("weightAdjustmentId", "recordedAt");
CREATE INDEX IF NOT EXISTS "idx_prep_event_operator" ON "seafood_preparation_fulfillment_events"("operatorUserId");

-- 5. Create Customer Checkout Ceiling Consents Table
CREATE TABLE IF NOT EXISTS "customer_checkout_ceiling_consents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weightAdjustmentId" TEXT NOT NULL UNIQUE,
    "authenticatedCustomerId" TEXT NOT NULL,
    "initialEstimatedWeight" DECIMAL(8,3) NOT NULL,
    "initialEstimatedTotal" DECIMAL(10,2) NOT NULL,
    "authorizedCeilingJmd" DECIMAL(10,2) NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "fk_ceiling_consent_adj" FOREIGN KEY ("weightAdjustmentId") REFERENCES "seafood_order_weight_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_ceiling_consent_customer" FOREIGN KEY ("authenticatedCustomerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 6. Create Customer Weight Approval Records Table
CREATE TABLE IF NOT EXISTS "customer_weight_approval_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weightAdjustmentId" TEXT NOT NULL,
    "measurementRevision" INTEGER NOT NULL,
    "authenticatedCustomerId" TEXT NOT NULL,
    "proposedTotalJmd" DECIMAL(10,2) NOT NULL,
    "authorizedCeilingJmd" DECIMAL(10,2) NOT NULL,
    "action" "CustomerApprovalAction" NOT NULL,
    "approvalTokenHash" TEXT NOT NULL UNIQUE,
    "payloadHash" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "rejectionReason" TEXT,
    CONSTRAINT "fk_approval_record_adj" FOREIGN KEY ("weightAdjustmentId") REFERENCES "seafood_order_weight_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_approval_record_customer" FOREIGN KEY ("authenticatedCustomerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "uq_approval_adj_revision" UNIQUE ("weightAdjustmentId", "measurementRevision")
);

CREATE INDEX IF NOT EXISTS "idx_approval_time" ON "customer_weight_approval_records"("weightAdjustmentId", "decidedAt");

-- 7. Create Financial Obligations Table
CREATE TABLE IF NOT EXISTS "weight_adjustment_obligations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weightAdjustmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL UNIQUE,
    "payloadHash" TEXT NOT NULL,
    "direction" "PaymentObligationDirection" NOT NULL,
    "amountJmd" DECIMAL(10,2) NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_obligation_adj" FOREIGN KEY ("weightAdjustmentId") REFERENCES "seafood_order_weight_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "uq_obligation_adj_revision" UNIQUE ("weightAdjustmentId", "revision")
);

CREATE INDEX IF NOT EXISTS "idx_obligation_dir_status" ON "weight_adjustment_obligations"("direction", "status");

-- 8. Create Physical Settlement Records Table
CREATE TABLE IF NOT EXISTS "weight_adjustment_settlement_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL UNIQUE,
    "payloadHash" TEXT NOT NULL,
    "settlementChannel" "SettlementChannel" NOT NULL,
    "amountSettled" DECIMAL(10,2) NOT NULL,
    "externalReference" TEXT,
    "evidenceDocumentUrl" TEXT,
    "settledByUserId" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_settlement_obligation" FOREIGN KEY ("obligationId") REFERENCES "weight_adjustment_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_settlement_user" FOREIGN KEY ("settledByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_settlement_time" ON "weight_adjustment_settlement_records"("obligationId", "settledAt");
CREATE INDEX IF NOT EXISTS "idx_settlement_channel" ON "weight_adjustment_settlement_records"("settlementChannel");
