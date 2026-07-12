-- CreateEnum
CREATE TYPE "SanitationStatus" AS ENUM ('COMPLETED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "DriverCertificationStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "fleet_sanitation_records" (
    "id" TEXT NOT NULL,
    "fleetAssetId" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL,
    "performedBy" TEXT,
    "method" TEXT,
    "notes" TEXT,
    "nextDueAt" TIMESTAMP(3),
    "status" "SanitationStatus" NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_sanitation_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_cold_chain_certifications" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "DriverCertificationStatus" NOT NULL DEFAULT 'ACTIVE',
    "documentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_cold_chain_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_sanitation_records_fleetAssetId_idx" ON "fleet_sanitation_records"("fleetAssetId");

-- CreateIndex
CREATE INDEX "driver_cold_chain_certifications_driverId_idx" ON "driver_cold_chain_certifications"("driverId");

-- AddForeignKey
ALTER TABLE "fleet_sanitation_records" ADD CONSTRAINT "fleet_sanitation_records_fleetAssetId_fkey" FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_cold_chain_certifications" ADD CONSTRAINT "driver_cold_chain_certifications_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
