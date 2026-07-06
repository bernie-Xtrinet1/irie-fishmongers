-- CreateEnum
CREATE TYPE "VehicleOwnership" AS ENUM ('PERSONAL_VEHICLE', 'COMPANY_VEHICLE');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'FAILED', 'DISPUTED');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "vehicleOwnership" "VehicleOwnership" NOT NULL DEFAULT 'PERSONAL_VEHICLE';

-- CreateTable
CREATE TABLE "settlement_rate_configs" (
    "id" TEXT NOT NULL,
    "baseFee" DECIMAL(10,2) NOT NULL,
    "distanceCompensationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "distanceRatePerKm" DECIMAL(10,2) NOT NULL,
    "heavyLoadThresholdLbs" DECIMAL(10,2) NOT NULL,
    "heavyLoadBonus" DECIMAL(10,2) NOT NULL,
    "peakBonus" DECIMAL(10,2) NOT NULL,
    "volumeBonusTier1Threshold" INTEGER NOT NULL,
    "volumeBonusTier1Amount" DECIMAL(10,2) NOT NULL,
    "volumeBonusTier2Threshold" INTEGER NOT NULL,
    "volumeBonusTier2Amount" DECIMAL(10,2) NOT NULL,
    "volumeBonusTier3Threshold" INTEGER NOT NULL,
    "volumeBonusTier3Amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_rate_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_settlements" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "vehicleOwnership" "VehicleOwnership" NOT NULL,
    "baseFee" DECIMAL(10,2) NOT NULL,
    "distanceKm" DECIMAL(10,2) NOT NULL,
    "distanceFee" DECIMAL(10,2) NOT NULL,
    "heavyLoadBonus" DECIMAL(10,2) NOT NULL,
    "peakBonus" DECIMAL(10,2) NOT NULL,
    "volumeBonus" DECIMAL(10,2) NOT NULL,
    "totalPayout" DECIMAL(10,2) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settlementPeriodStart" TIMESTAMP(3) NOT NULL,
    "settlementPeriodEnd" TIMESTAMP(3) NOT NULL,
    "payoutDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_settlements_deliveryId_key" ON "driver_settlements"("deliveryId");

-- CreateIndex
CREATE INDEX "driver_settlements_driverId_idx" ON "driver_settlements"("driverId");

-- CreateIndex
CREATE INDEX "driver_settlements_settlementPeriodStart_settlementPeriodEn_idx" ON "driver_settlements"("settlementPeriodStart", "settlementPeriodEnd");

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
