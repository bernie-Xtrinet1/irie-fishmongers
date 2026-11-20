-- AlterTable
ALTER TABLE "vendor_settlement_adjustments" ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "refundId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "vendor_settlement_adjustments_idempotencyKey_key" ON "vendor_settlement_adjustments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "vendor_settlement_adjustments_refundId_idx" ON "vendor_settlement_adjustments"("refundId");

-- AddForeignKey
ALTER TABLE "vendor_settlement_adjustments" ADD CONSTRAINT "vendor_settlement_adjustments_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
