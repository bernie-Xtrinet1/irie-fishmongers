-- CreateEnum
CREATE TYPE "SeafoodStorageType" AS ENUM ('FRESH', 'FROZEN');

-- CreateEnum
CREATE TYPE "WeightUnit" AS ENUM ('POUNDS', 'KILOGRAMS');

-- CreateEnum
CREATE TYPE "FoodSafetyStatus" AS ENUM ('SAFE', 'UNDER_REVIEW', 'SAFETY_HOLD', 'QUARANTINED', 'RECALLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FreshnessGrade" AS ENUM ('GRADE_A', 'GRADE_B', 'GRADE_C', 'REJECTED');

-- CreateEnum
CREATE TYPE "TemperatureCheckpoint" AS ENUM ('VENDOR_STORAGE', 'PACKING', 'DISPATCH', 'DRIVER_PICKUP', 'IN_TRANSIT', 'DELIVERY');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('WARNING', 'CRITICAL', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PASSED', 'CONDITIONAL', 'REJECTED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RecallSeverityClass" AS ENUM ('CLASS_I', 'CLASS_II', 'CLASS_III');

-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INVESTIGATING', 'RESOLVED', 'CLOSED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "lotId" TEXT;

-- CreateTable
CREATE TABLE "seafood_lots" (
    "id" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "species" TEXT NOT NULL,
    "storageType" "SeafoodStorageType" NOT NULL,
    "catchDate" TIMESTAMP(3) NOT NULL,
    "catchLocation" TEXT,
    "landingSite" TEXT,
    "weight" DECIMAL(10,2) NOT NULL,
    "weightUnit" "WeightUnit" NOT NULL,
    "freshnessGrade" "FreshnessGrade",
    "qualityScore" INTEGER,
    "foodSafetyStatus" "FoodSafetyStatus" NOT NULL DEFAULT 'SAFE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seafood_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperature_readings" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "checkpoint" "TemperatureCheckpoint" NOT NULL,
    "temperatureC" DECIMAL(5,2) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "photoUrl" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temperature_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperature_alerts" (
    "id" TEXT NOT NULL,
    "readingId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "actualC" DECIMAL(5,2) NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temperature_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_inspections" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "inspectorId" TEXT NOT NULL,
    "result" "InspectionResult" NOT NULL,
    "freshnessGrade" "FreshnessGrade" NOT NULL,
    "qualityScore" INTEGER NOT NULL,
    "notes" TEXT,
    "photoUrl" TEXT,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_safety_incidents" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "photoUrl" TEXT,
    "correctiveAction" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_safety_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recalls" (
    "id" TEXT NOT NULL,
    "severityClass" "RecallSeverityClass" NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT NOT NULL,
    "rootCause" TEXT,
    "resolutionNotes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_lots" (
    "id" TEXT NOT NULL,
    "recallId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,

    CONSTRAINT "recall_lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seafood_lots_lotNumber_key" ON "seafood_lots"("lotNumber");

-- CreateIndex
CREATE INDEX "seafood_lots_vendorId_idx" ON "seafood_lots"("vendorId");

-- CreateIndex
CREATE INDEX "temperature_readings_lotId_idx" ON "temperature_readings"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "temperature_alerts_readingId_key" ON "temperature_alerts"("readingId");

-- CreateIndex
CREATE INDEX "temperature_alerts_lotId_idx" ON "temperature_alerts"("lotId");

-- CreateIndex
CREATE INDEX "quality_inspections_lotId_idx" ON "quality_inspections"("lotId");

-- CreateIndex
CREATE INDEX "food_safety_incidents_lotId_idx" ON "food_safety_incidents"("lotId");

-- CreateIndex
CREATE INDEX "recall_lots_lotId_idx" ON "recall_lots"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "recall_lots_recallId_lotId_key" ON "recall_lots"("recallId", "lotId");

-- CreateIndex
CREATE INDEX "products_lotId_idx" ON "products"("lotId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seafood_lots" ADD CONSTRAINT "seafood_lots_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_alerts" ADD CONSTRAINT "temperature_alerts_readingId_fkey" FOREIGN KEY ("readingId") REFERENCES "temperature_readings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_alerts" ADD CONSTRAINT "temperature_alerts_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_inspectorId_fkey" FOREIGN KEY ("inspectorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_safety_incidents" ADD CONSTRAINT "food_safety_incidents_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_safety_incidents" ADD CONSTRAINT "food_safety_incidents_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_lots" ADD CONSTRAINT "recall_lots_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "recalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_lots" ADD CONSTRAINT "recall_lots_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
