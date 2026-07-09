-- CreateEnum
CREATE TYPE "FishingMethod" AS ENUM ('TRAP', 'NET', 'LINE', 'SPEARFISHING', 'POT', 'TROLLING', 'DIVING', 'LONGLINE', 'OTHER');

-- CreateEnum
CREATE TYPE "VesselRegistrationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "CustodyEventType" AS ENUM ('LANDING', 'STORAGE_ENTRY', 'STORAGE_EXIT', 'PACKING', 'DISPATCH', 'PICKUP', 'TRANSIT', 'DELIVERY', 'INSPECTION', 'DISPOSAL');

-- CreateEnum
CREATE TYPE "CertificationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EmergencyResponseStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'CONTAINED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "WasteReason" AS ENUM ('SPOILAGE', 'RECALL_DESTRUCTION', 'EXPIRED', 'DAMAGED', 'QUALITY_REJECTION', 'OTHER');

-- AlterEnum
ALTER TYPE "InventoryEventType" ADD VALUE 'DISPOSED';

-- AlterEnum
ALTER TYPE "NotificationEventType" ADD VALUE 'RECALL_ISSUED';

-- DropForeignKey
ALTER TABLE "catches" DROP CONSTRAINT "catches_speciesId_fkey";

-- DropForeignKey
ALTER TABLE "seafood_lots" DROP CONSTRAINT "seafood_lots_catchId_fkey";

-- DropIndex
DROP INDEX "seafood_lots_catchId_idx";

-- AlterTable
ALTER TABLE "catches" DROP COLUMN "estimatedFreshness",
DROP COLUMN "speciesId",
DROP COLUMN "weight",
DROP COLUMN "weightUnit",
ADD COLUMN     "vesselId" TEXT;

-- AlterTable
ALTER TABLE "seafood_lots" DROP COLUMN "catchId",
ADD COLUMN     "catchItemId" TEXT,
ADD COLUMN     "publicTraceToken" TEXT;

-- Backfill: publicTraceToken has no data-level default (Prisma's
-- @default(uuid()) is enforced client-side only), so existing rows need a
-- generated value before the column can become NOT NULL. gen_random_uuid()
-- is built into PostgreSQL 13+ core, no extension required.
UPDATE "seafood_lots" SET "publicTraceToken" = gen_random_uuid()::text WHERE "publicTraceToken" IS NULL;

ALTER TABLE "seafood_lots" ALTER COLUMN "publicTraceToken" SET NOT NULL;

-- AlterTable
ALTER TABLE "temperature_devices" ADD COLUMN     "calibrationDueAt" TIMESTAMP(3),
ADD COLUMN     "lastCalibratedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "vessels" (
    "id" TEXT NOT NULL,
    "ownerFishermanId" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fishingMethod" "FishingMethod" NOT NULL,
    "capacityTons" DECIMAL(8,2),
    "status" "VesselRegistrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vessels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catch_items" (
    "id" TEXT NOT NULL,
    "catchId" TEXT NOT NULL,
    "speciesId" TEXT NOT NULL,
    "weight" DECIMAL(10,2) NOT NULL,
    "weightUnit" "WeightUnit" NOT NULL,
    "estimatedFreshness" "FreshnessGrade",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_of_custody_events" (
    "id" TEXT NOT NULL,
    "catchId" TEXT,
    "lotId" TEXT,
    "eventType" "CustodyEventType" NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "location" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "notes" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_of_custody_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_authorities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "website" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regulatory_authorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_certifications" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT,
    "fishermanId" TEXT,
    "landingSiteId" TEXT,
    "certificateType" TEXT NOT NULL,
    "certificateNumber" TEXT NOT NULL,
    "issuingAuthorityId" TEXT NOT NULL,
    "issuedDate" TIMESTAMP(3) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "status" "CertificationStatus" NOT NULL DEFAULT 'PENDING',
    "documentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regulatory_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_responses" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "status" "EmergencyResponseStatus" NOT NULL DEFAULT 'OPEN',
    "actionsTaken" TEXT,
    "rootCause" TEXT,
    "correctiveAction" TEXT,
    "preventiveAction" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emergency_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waste_disposal_records" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "productId" TEXT,
    "recallId" TEXT,
    "quantity" DECIMAL(10,2) NOT NULL,
    "weightUnit" "WeightUnit" NOT NULL,
    "reason" "WasteReason" NOT NULL,
    "disposalMethod" TEXT,
    "evidencePhotoUrls" TEXT[],
    "witnessName" TEXT,
    "witnessTitle" TEXT,
    "witnessSignatureUrl" TEXT,
    "recordedById" TEXT NOT NULL,
    "disposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waste_disposal_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vessels_registrationNumber_key" ON "vessels"("registrationNumber");

-- CreateIndex
CREATE INDEX "vessels_ownerFishermanId_idx" ON "vessels"("ownerFishermanId");

-- CreateIndex
CREATE INDEX "catch_items_catchId_idx" ON "catch_items"("catchId");

-- CreateIndex
CREATE INDEX "catch_items_speciesId_idx" ON "catch_items"("speciesId");

-- CreateIndex
CREATE INDEX "chain_of_custody_events_catchId_idx" ON "chain_of_custody_events"("catchId");

-- CreateIndex
CREATE INDEX "chain_of_custody_events_lotId_idx" ON "chain_of_custody_events"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_authorities_name_key" ON "regulatory_authorities"("name");

-- CreateIndex
CREATE INDEX "regulatory_certifications_vendorId_idx" ON "regulatory_certifications"("vendorId");

-- CreateIndex
CREATE INDEX "regulatory_certifications_fishermanId_idx" ON "regulatory_certifications"("fishermanId");

-- CreateIndex
CREATE INDEX "regulatory_certifications_landingSiteId_idx" ON "regulatory_certifications"("landingSiteId");

-- CreateIndex
CREATE INDEX "regulatory_certifications_issuingAuthorityId_idx" ON "regulatory_certifications"("issuingAuthorityId");

-- CreateIndex
CREATE UNIQUE INDEX "emergency_responses_alertId_key" ON "emergency_responses"("alertId");

-- CreateIndex
CREATE INDEX "waste_disposal_records_lotId_idx" ON "waste_disposal_records"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "seafood_lots_publicTraceToken_key" ON "seafood_lots"("publicTraceToken");

-- CreateIndex
CREATE INDEX "seafood_lots_catchItemId_idx" ON "seafood_lots"("catchItemId");

-- AddForeignKey
ALTER TABLE "seafood_lots" ADD CONSTRAINT "seafood_lots_catchItemId_fkey" FOREIGN KEY ("catchItemId") REFERENCES "catch_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vessels" ADD CONSTRAINT "vessels_ownerFishermanId_fkey" FOREIGN KEY ("ownerFishermanId") REFERENCES "fishermen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catches" ADD CONSTRAINT "catches_vesselId_fkey" FOREIGN KEY ("vesselId") REFERENCES "vessels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catch_items" ADD CONSTRAINT "catch_items_catchId_fkey" FOREIGN KEY ("catchId") REFERENCES "catches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catch_items" ADD CONSTRAINT "catch_items_speciesId_fkey" FOREIGN KEY ("speciesId") REFERENCES "species"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_of_custody_events" ADD CONSTRAINT "chain_of_custody_events_catchId_fkey" FOREIGN KEY ("catchId") REFERENCES "catches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_of_custody_events" ADD CONSTRAINT "chain_of_custody_events_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_of_custody_events" ADD CONSTRAINT "chain_of_custody_events_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_of_custody_events" ADD CONSTRAINT "chain_of_custody_events_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_certifications" ADD CONSTRAINT "regulatory_certifications_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_certifications" ADD CONSTRAINT "regulatory_certifications_fishermanId_fkey" FOREIGN KEY ("fishermanId") REFERENCES "fishermen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_certifications" ADD CONSTRAINT "regulatory_certifications_landingSiteId_fkey" FOREIGN KEY ("landingSiteId") REFERENCES "landing_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_certifications" ADD CONSTRAINT "regulatory_certifications_issuingAuthorityId_fkey" FOREIGN KEY ("issuingAuthorityId") REFERENCES "regulatory_authorities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_responses" ADD CONSTRAINT "emergency_responses_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "temperature_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_responses" ADD CONSTRAINT "emergency_responses_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_disposal_records" ADD CONSTRAINT "waste_disposal_records_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_disposal_records" ADD CONSTRAINT "waste_disposal_records_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_disposal_records" ADD CONSTRAINT "waste_disposal_records_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "recalls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_disposal_records" ADD CONSTRAINT "waste_disposal_records_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

