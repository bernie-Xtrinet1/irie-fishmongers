-- CreateEnum
CREATE TYPE "VendorSettlementStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "platform_commission_configs" (
    "id" TEXT NOT NULL,
    "commissionRate" DECIMAL(5,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_commission_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_settlements" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "grossAmount" DECIMAL(10,2) NOT NULL,
    "platformFee" DECIMAL(10,2) NOT NULL,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "status" "VendorSettlementStatus" NOT NULL DEFAULT 'PENDING',
    "paymentDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_settlement_adjustments" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_settlement_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_settlements_vendorOrderId_key" ON "vendor_settlements"("vendorOrderId");

-- CreateIndex
CREATE INDEX "vendor_settlements_vendorId_idx" ON "vendor_settlements"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_settlement_adjustments_settlementId_idx" ON "vendor_settlement_adjustments"("settlementId");

-- AddForeignKey
ALTER TABLE "vendor_settlements" ADD CONSTRAINT "vendor_settlements_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_settlements" ADD CONSTRAINT "vendor_settlements_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_settlement_adjustments" ADD CONSTRAINT "vendor_settlement_adjustments_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "vendor_settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
