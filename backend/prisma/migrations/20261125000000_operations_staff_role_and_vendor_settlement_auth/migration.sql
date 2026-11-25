-- Migration #71: Add OPERATIONS_STAFF role, explicit primary-admin vendor
-- settlement authorization permission on users, paymentReference on
-- vendor_settlements, and append-only vendor_settlement_audit_logs table.

-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE IF NOT EXISTS 'OPERATIONS_STAFF';

-- CreateEnum
CREATE TYPE "VendorSettlementAuditAction" AS ENUM (
  'APPROVE_SETTLEMENT',
  'MARK_PAID',
  'MARK_FAILED',
  'UPDATE_PAYMENT_REFERENCE',
  'INITIATE_DISBURSEMENT',
  'RELEASE_DISBURSEMENT'
);

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "canAuthorizeVendorSettlements" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "vendor_settlements"
  ADD COLUMN IF NOT EXISTS "paymentReference" TEXT;

-- CreateTable
CREATE TABLE "vendor_settlement_audit_logs" (
  "id" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "action" "VendorSettlementAuditAction" NOT NULL,
  "previousStatus" "VendorSettlementStatus" NOT NULL,
  "newStatus" "VendorSettlementStatus" NOT NULL,
  "paymentReference" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "vendor_settlement_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_settlement_audit_logs_settlementId_idx"
  ON "vendor_settlement_audit_logs"("settlementId");
CREATE INDEX "vendor_settlement_audit_logs_actorUserId_idx"
  ON "vendor_settlement_audit_logs"("actorUserId");
CREATE INDEX "vendor_settlement_audit_logs_createdAt_idx"
  ON "vendor_settlement_audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "vendor_settlement_audit_logs"
  ADD CONSTRAINT "vendor_settlement_audit_logs_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "vendor_settlements"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_settlement_audit_logs"
  ADD CONSTRAINT "vendor_settlement_audit_logs_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce append-only immutability on vendor_settlement_audit_logs
CREATE OR REPLACE FUNCTION "guard_vendor_settlement_audit_logs_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vendor_settlement_audit_logs is append-only; % is prohibited', TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "vendor_settlement_audit_logs_immutable_guard"
  BEFORE UPDATE OR DELETE ON "vendor_settlement_audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_vendor_settlement_audit_logs_immutable"();

CREATE TRIGGER "zz_vendor_settlement_audit_logs_truncate_guard"
  BEFORE TRUNCATE ON "vendor_settlement_audit_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "guard_vendor_settlement_audit_logs_immutable"();
