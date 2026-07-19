-- CreateEnum
CREATE TYPE "LandingSiteStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SiteInspectionStatus" AS ENUM ('NOT_INSPECTED', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "FishermanStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RegulatoryStatus" AS ENUM ('UNRESTRICTED', 'RESTRICTED', 'PROHIBITED');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'OFFLINE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "ComplianceDocumentType" AS ENUM ('INSPECTION_REPORT', 'RECALL_NOTICE', 'TEMPERATURE_REPORT', 'AUDIT_REPORT');

-- AlterEnum
ALTER TYPE "NotificationEventType" ADD VALUE 'COLD_CHAIN_ALERT_RAISED';

-- AlterTable
ALTER TABLE "seafood_lots" ADD COLUMN     "catchId" TEXT,
ADD COLUMN     "speciesId" TEXT;

-- AlterTable
ALTER TABLE "temperature_readings" ADD COLUMN     "deviceId" TEXT;

-- CreateTable
CREATE TABLE "landing_sites" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parish" "Parish" NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "status" "LandingSiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "inspectionStatus" "SiteInspectionStatus" NOT NULL DEFAULT 'NOT_INSPECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fishermen" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT,
    "fullName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT,
    "vesselName" TEXT,
    "vesselRegistrationNumber" TEXT,
    "fishingLicenseNumber" TEXT,
    "landingSiteId" TEXT,
    "bankAccountName" TEXT,
    "bankAccountNumber" TEXT,
    "status" "FishermanStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fishermen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "species" (
    "id" TEXT NOT NULL,
    "scientificName" TEXT NOT NULL,
    "commercialName" TEXT NOT NULL,
    "regulatoryStatus" "RegulatoryStatus" NOT NULL DEFAULT 'UNRESTRICTED',
    "seasonalStartMonth" INTEGER,
    "seasonalEndMonth" INTEGER,
    "minimumSizeCm" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "species_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catches" (
    "id" TEXT NOT NULL,
    "catchNumber" TEXT NOT NULL,
    "fishermanId" TEXT NOT NULL,
    "landingSiteId" TEXT NOT NULL,
    "speciesId" TEXT NOT NULL,
    "weight" DECIMAL(10,2) NOT NULL,
    "weightUnit" "WeightUnit" NOT NULL,
    "catchDate" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "fishingArea" TEXT,
    "photos" TEXT[],
    "estimatedFreshness" "FreshnessGrade",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperature_devices" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "temperature_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperature_thresholds" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT,
    "storageType" "SeafoodStorageType" NOT NULL,
    "minC" DECIMAL(5,2) NOT NULL,
    "maxC" DECIMAL(5,2) NOT NULL,
    "warningBandC" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "temperature_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "ipAddress" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_documents" (
    "id" TEXT NOT NULL,
    "documentType" "ComplianceDocumentType" NOT NULL,
    "relatedLotId" TEXT,
    "relatedRecallId" TEXT,
    "fileUrl" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fishermen_vendorId_idx" ON "fishermen"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "species_scientificName_key" ON "species"("scientificName");

-- CreateIndex
CREATE UNIQUE INDEX "catches_catchNumber_key" ON "catches"("catchNumber");

-- CreateIndex
CREATE INDEX "catches_fishermanId_idx" ON "catches"("fishermanId");

-- CreateIndex
CREATE INDEX "catches_landingSiteId_idx" ON "catches"("landingSiteId");

-- CreateIndex
CREATE UNIQUE INDEX "temperature_devices_deviceCode_key" ON "temperature_devices"("deviceCode");

-- CreateIndex
CREATE INDEX "temperature_devices_vendorId_idx" ON "temperature_devices"("vendorId");

-- CreateIndex
CREATE INDEX "compliance_audit_logs_entityType_entityId_idx" ON "compliance_audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "compliance_documents_relatedLotId_idx" ON "compliance_documents"("relatedLotId");

-- CreateIndex
CREATE INDEX "compliance_documents_relatedRecallId_idx" ON "compliance_documents"("relatedRecallId");

-- CreateIndex
CREATE INDEX "seafood_lots_catchId_idx" ON "seafood_lots"("catchId");

-- CreateIndex
CREATE INDEX "seafood_lots_speciesId_idx" ON "seafood_lots"("speciesId");

-- CreateIndex
CREATE INDEX "temperature_readings_deviceId_idx" ON "temperature_readings"("deviceId");

-- AddForeignKey
ALTER TABLE "seafood_lots" ADD CONSTRAINT "seafood_lots_catchId_fkey" FOREIGN KEY ("catchId") REFERENCES "catches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seafood_lots" ADD CONSTRAINT "seafood_lots_speciesId_fkey" FOREIGN KEY ("speciesId") REFERENCES "species"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "temperature_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fishermen" ADD CONSTRAINT "fishermen_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fishermen" ADD CONSTRAINT "fishermen_landingSiteId_fkey" FOREIGN KEY ("landingSiteId") REFERENCES "landing_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catches" ADD CONSTRAINT "catches_fishermanId_fkey" FOREIGN KEY ("fishermanId") REFERENCES "fishermen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catches" ADD CONSTRAINT "catches_landingSiteId_fkey" FOREIGN KEY ("landingSiteId") REFERENCES "landing_sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catches" ADD CONSTRAINT "catches_speciesId_fkey" FOREIGN KEY ("speciesId") REFERENCES "species"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_devices" ADD CONSTRAINT "temperature_devices_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_thresholds" ADD CONSTRAINT "temperature_thresholds_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "temperature_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_audit_logs" ADD CONSTRAINT "compliance_audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_relatedLotId_fkey" FOREIGN KEY ("relatedLotId") REFERENCES "seafood_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_relatedRecallId_fkey" FOREIGN KEY ("relatedRecallId") REFERENCES "recalls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
