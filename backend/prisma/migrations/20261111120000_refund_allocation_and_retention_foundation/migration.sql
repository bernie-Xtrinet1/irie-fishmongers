-- CreateEnum
CREATE TYPE "RefundAllocationType" AS ENUM ('CANCELLATION', 'ITEM_DEFECT', 'CUSTOMER_RETURN', 'MANUAL_SUPERVISOR_ADJUSTMENT');

-- CreateTable
CREATE TABLE "refund_vendor_order_allocations" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JMD',
    "allocationType" "RefundAllocationType" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_vendor_order_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_vendor_order_allocations_vendorOrderId_idx" ON "refund_vendor_order_allocations"("vendorOrderId");

-- CreateIndex
CREATE INDEX "refund_vendor_order_allocations_refundId_idx" ON "refund_vendor_order_allocations"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "refund_vendor_order_allocations_refundId_vendorOrderId_all_key" ON "refund_vendor_order_allocations"("refundId", "vendorOrderId", "allocationType");

-- AddForeignKey
ALTER TABLE "refund_vendor_order_allocations" ADD CONSTRAINT "refund_vendor_order_allocations_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_vendor_order_allocations" ADD CONSTRAINT "refund_vendor_order_allocations_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Update ForeignKey on vendor_settlement_adjustments to ON DELETE RESTRICT (F-01 resolution)
ALTER TABLE "vendor_settlement_adjustments" DROP CONSTRAINT "vendor_settlement_adjustments_refundId_fkey";

ALTER TABLE "vendor_settlement_adjustments" ADD CONSTRAINT "vendor_settlement_adjustments_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add Check Constraint on vendor_settlement_adjustments (F-03 resolution)
ALTER TABLE "vendor_settlement_adjustments" ADD CONSTRAINT "chk_refund_adjustment_idempotency" CHECK (("refundId" IS NULL) OR ("idempotencyKey" IS NOT NULL AND length(trim("idempotencyKey")) > 0));
