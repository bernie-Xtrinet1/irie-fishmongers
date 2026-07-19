-- CreateEnum
CREATE TYPE "DriverAvailabilityStatus" AS ENUM ('ONLINE', 'OFFLINE', 'BUSY');

-- CreateEnum
CREATE TYPE "CustomerAcceptanceStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FleetAssetType" AS ENUM ('REFRIGERATED_TRUCK', 'TRUCK', 'VAN');

-- CreateEnum
CREATE TYPE "FleetOwnership" AS ENUM ('COMPANY_OWNED', 'RENTED');

-- CreateEnum
CREATE TYPE "FleetAssetStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "FleetMaintenanceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "DeliveryExceptionType" AS ENUM ('CUSTOMER_UNAVAILABLE', 'ADDRESS_ISSUE', 'VEHICLE_BREAKDOWN', 'TRAFFIC_DELAY', 'WEATHER_DELAY', 'PRODUCT_DAMAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "DeliveryRunStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TemperatureCheckpoint" ADD VALUE 'VEHICLE_LOADING';
ALTER TYPE "TemperatureCheckpoint" ADD VALUE 'CUSTOMER_ACCEPTANCE';

-- AlterEnum
ALTER TYPE "VehicleOwnership" ADD VALUE 'RENTED_VEHICLE';

-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "customerAcceptanceStatus" "CustomerAcceptanceStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "customerAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "customerDeliveryWindowEnd" TIMESTAMP(3),
ADD COLUMN     "customerDeliveryWindowStart" TIMESTAMP(3),
ADD COLUMN     "customerRejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "scheduledPickupWindowEnd" TIMESTAMP(3),
ADD COLUMN     "scheduledPickupWindowStart" TIMESTAMP(3),
ADD COLUMN     "vendorConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "vendorConfirmedById" TEXT;

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "assignedZoneId" TEXT,
ADD COLUMN     "availabilityStatus" "DriverAvailabilityStatus" NOT NULL DEFAULT 'OFFLINE',
ADD COLUMN     "capacityLbs" DECIMAL(10,2),
ADD COLUMN     "coldChainCapable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryZoneId" TEXT;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "primaryZoneId" TEXT;

-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_zone_parishes" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "parish" "Parish" NOT NULL,

    CONSTRAINT "delivery_zone_parishes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_zones" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "vendor_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_zones" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "driver_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_assets" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "assetType" "FleetAssetType" NOT NULL,
    "ownership" "FleetOwnership" NOT NULL,
    "licensePlate" TEXT NOT NULL,
    "capacityLbs" DECIMAL(10,2) NOT NULL,
    "coldChainCapable" BOOLEAN NOT NULL DEFAULT false,
    "status" "FleetAssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentDriverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_trips" (
    "id" TEXT NOT NULL,
    "fleetAssetId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "fuelCost" DECIMAL(10,2),
    "driverWage" DECIMAL(10,2),
    "maintenanceAllocation" DECIMAL(10,2),
    "insuranceAllocation" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_maintenance_records" (
    "id" TEXT NOT NULL,
    "fleetAssetId" TEXT NOT NULL,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "mileage" INTEGER,
    "technician" TEXT,
    "cost" DECIMAL(10,2),
    "nextServiceDue" TIMESTAMP(3),
    "status" "FleetMaintenanceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_exceptions" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "type" "DeliveryExceptionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "photos" TEXT[],
    "notes" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_history" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "gpsSamples" INTEGER NOT NULL,
    "distanceKm" DECIMAL(8,2) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_optimization_runs" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "strategyName" TEXT NOT NULL,
    "deliveryIds" TEXT[],
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_optimization_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_runs" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "driverId" TEXT,
    "fleetAssetId" TEXT,
    "status" "DeliveryRunStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_run_stops" (
    "id" TEXT NOT NULL,
    "deliveryRunId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "delivery_run_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zones_code_key" ON "delivery_zones"("code");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zone_parishes_parish_key" ON "delivery_zone_parishes"("parish");

-- CreateIndex
CREATE INDEX "delivery_zone_parishes_zoneId_idx" ON "delivery_zone_parishes"("zoneId");

-- CreateIndex
CREATE INDEX "vendor_zones_zoneId_idx" ON "vendor_zones"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_zones_vendorId_zoneId_key" ON "vendor_zones"("vendorId", "zoneId");

-- CreateIndex
CREATE INDEX "driver_zones_zoneId_idx" ON "driver_zones"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_zones_driverId_zoneId_key" ON "driver_zones"("driverId", "zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_assets_licensePlate_key" ON "fleet_assets"("licensePlate");

-- CreateIndex
CREATE INDEX "fleet_assets_zoneId_idx" ON "fleet_assets"("zoneId");

-- CreateIndex
CREATE INDEX "fleet_trips_fleetAssetId_idx" ON "fleet_trips"("fleetAssetId");

-- CreateIndex
CREATE INDEX "fleet_trips_driverId_idx" ON "fleet_trips"("driverId");

-- CreateIndex
CREATE INDEX "fleet_maintenance_records_fleetAssetId_idx" ON "fleet_maintenance_records"("fleetAssetId");

-- CreateIndex
CREATE INDEX "delivery_exceptions_deliveryId_idx" ON "delivery_exceptions"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "route_history_deliveryId_key" ON "route_history"("deliveryId");

-- CreateIndex
CREATE INDEX "route_optimization_runs_zoneId_idx" ON "route_optimization_runs"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_run_stops_deliveryId_key" ON "delivery_run_stops"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_run_stops_deliveryRunId_sequence_key" ON "delivery_run_stops"("deliveryRunId", "sequence");

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_primaryZoneId_fkey" FOREIGN KEY ("primaryZoneId") REFERENCES "delivery_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "delivery_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_assignedZoneId_fkey" FOREIGN KEY ("assignedZoneId") REFERENCES "delivery_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_vendorConfirmedById_fkey" FOREIGN KEY ("vendorConfirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_zone_parishes" ADD CONSTRAINT "delivery_zone_parishes_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "delivery_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_zones" ADD CONSTRAINT "vendor_zones_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_zones" ADD CONSTRAINT "vendor_zones_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "delivery_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_zones" ADD CONSTRAINT "driver_zones_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_zones" ADD CONSTRAINT "driver_zones_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "delivery_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_assets" ADD CONSTRAINT "fleet_assets_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "delivery_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_assets" ADD CONSTRAINT "fleet_assets_currentDriverId_fkey" FOREIGN KEY ("currentDriverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_trips" ADD CONSTRAINT "fleet_trips_fleetAssetId_fkey" FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_trips" ADD CONSTRAINT "fleet_trips_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_trips" ADD CONSTRAINT "fleet_trips_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "delivery_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_maintenance_records" ADD CONSTRAINT "fleet_maintenance_records_fleetAssetId_fkey" FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_exceptions" ADD CONSTRAINT "delivery_exceptions_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_exceptions" ADD CONSTRAINT "delivery_exceptions_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_history" ADD CONSTRAINT "route_history_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_history" ADD CONSTRAINT "route_history_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_optimization_runs" ADD CONSTRAINT "route_optimization_runs_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "delivery_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "delivery_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_fleetAssetId_fkey" FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_run_stops" ADD CONSTRAINT "delivery_run_stops_deliveryRunId_fkey" FOREIGN KEY ("deliveryRunId") REFERENCES "delivery_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_run_stops" ADD CONSTRAINT "delivery_run_stops_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
