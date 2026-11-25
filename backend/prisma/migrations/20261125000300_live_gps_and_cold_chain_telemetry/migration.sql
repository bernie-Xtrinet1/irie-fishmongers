-- Migration #74: Live vehicle GPS, cold-chain cargo-air telemetry,
-- tracker/compartment/sensor bindings, credential rotation, deduplicated frames,
-- and custody-linked cargo compartment assignments.

-- AlterTable: fleet_assets
ALTER TABLE "fleet_assets"
  ADD COLUMN IF NOT EXISTS "lastLatitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lastLongitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lastSpeedKph" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastHeadingDeg" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastSatellites" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastGpsCapturedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastTelemetryReceivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastTelemetryDelayed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastGpsNoFixAt" TIMESTAMP(3);

-- CreateTable: vehicle_compartments (needed before temperature_devices FK)
CREATE TABLE "vehicle_compartments" (
  "id" TEXT NOT NULL,
  "fleetAssetId" TEXT NOT NULL,
  "compartmentCode" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "storageType" "SeafoodStorageType" NOT NULL DEFAULT 'FRESH',
  "targetMinC" DECIMAL(5,2),
  "targetMaxC" DECIMAL(5,2),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vehicle_compartments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: vehicle_trackers
CREATE TABLE "vehicle_trackers" (
  "id" TEXT NOT NULL,
  "fleetAssetId" TEXT NOT NULL,
  "imei" TEXT NOT NULL,
  "hardwareModel" "TrackerHardwareModel" NOT NULL DEFAULT 'TELTONIKA_FMC130',
  "firmwareVersion" TEXT,
  "simIccid" TEXT,
  "simCarrier" TEXT,
  "protocol" "TelemetryProtocol" NOT NULL DEFAULT 'TELTONIKA_CODEC_8E',
  "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
  "lastSeenAt" TIMESTAMP(3),
  "lastCapturedAt" TIMESTAMP(3),
  "lastReceivedAt" TIMESTAMP(3),
  "lastPacketCrc" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vehicle_trackers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: telemetry_device_credentials
CREATE TABLE "telemetry_device_credentials" (
  "id" TEXT NOT NULL,
  "scope" "TelemetryCredentialScope" NOT NULL DEFAULT 'DEVICE_TRACKER',
  "trackerId" TEXT,
  "label" TEXT NOT NULL,
  "keyPrefix" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  "lastUsedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "revokedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "telemetry_device_credentials_pkey" PRIMARY KEY ("id")
);

-- AlterTable: temperature_devices
ALTER TABLE "temperature_devices"
  ALTER COLUMN "vendorId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "compartmentId" TEXT,
  ADD COLUMN IF NOT EXISTS "hardwareModel" "TemperatureSensorModel" NOT NULL DEFAULT 'GENERIC_BLE_PROBE',
  ADD COLUMN IF NOT EXISTS "bleMacAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "sensorSlot" INTEGER,
  ADD COLUMN IF NOT EXISTS "firmwareVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "lastTemperatureC" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "lastCapturedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastReceivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastDelaySeconds" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastHumidityPct" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "lastBatteryMv" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastDoorOpen" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "lastMovement" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "lastGapKind" "TelemetryGapKind",
  ADD COLUMN IF NOT EXISTS "lastSignalMissingAt" TIMESTAMP(3);

-- CreateTable: vehicle_telemetry_frames
CREATE TABLE "vehicle_telemetry_frames" (
  "id" TEXT NOT NULL,
  "trackerId" TEXT,
  "sensorDeviceId" TEXT,
  "fleetAssetId" TEXT,
  "compartmentId" TEXT,
  "protocol" "TelemetryProtocol" NOT NULL,
  "origin" "TemperatureReadingOrigin" NOT NULL DEFAULT 'CARGO_AIR_SENSOR',
  "dedupeKey" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delaySeconds" INTEGER NOT NULL DEFAULT 0,
  "isDelayed" BOOLEAN NOT NULL DEFAULT false,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "altitudeM" INTEGER,
  "speedKph" INTEGER,
  "angleDeg" INTEGER,
  "satellites" INTEGER,
  "gnssValid" BOOLEAN NOT NULL DEFAULT false,
  "cargoTempC" DECIMAL(5,2),
  "humidityPct" DECIMAL(5,2),
  "doorOpen" BOOLEAN,
  "movement" BOOLEAN,
  "batteryMv" INTEGER,
  "externalVoltageMv" INTEGER,
  "gsmSignal" INTEGER,
  "gapKind" "TelemetryGapKind",
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "vehicle_telemetry_frames_pkey" PRIMARY KEY ("id")
);

-- AlterTable: temperature_readings
ALTER TABLE "temperature_readings"
  ALTER COLUMN "recordedById" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "origin" "TemperatureReadingOrigin" NOT NULL DEFAULT 'MANUAL_PRODUCT_CHECK',
  ADD COLUMN IF NOT EXISTS "capturedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "isDelayed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "deliveryId" TEXT,
  ADD COLUMN IF NOT EXISTS "fleetAssetId" TEXT,
  ADD COLUMN IF NOT EXISTS "compartmentId" TEXT,
  ADD COLUMN IF NOT EXISTS "trackerId" TEXT,
  ADD COLUMN IF NOT EXISTS "telemetryFrameId" TEXT,
  ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;

-- Backfill existing manual readings consistently
UPDATE "temperature_readings"
SET "capturedAt" = COALESCE("capturedAt", "recordedAt"),
    "receivedAt" = "recordedAt"
WHERE "capturedAt" IS NULL;

-- AlterTable: chain_of_custody_events
ALTER TABLE "chain_of_custody_events"
  ADD COLUMN IF NOT EXISTS "deliveryId" TEXT,
  ADD COLUMN IF NOT EXISTS "compartmentId" TEXT,
  ADD COLUMN IF NOT EXISTS "fleetAssetId" TEXT;

-- CreateTable: cargo_compartment_assignments
CREATE TABLE "cargo_compartment_assignments" (
  "id" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "vendorOrderId" TEXT NOT NULL,
  "lotId" TEXT NOT NULL,
  "fleetAssetId" TEXT NOT NULL,
  "compartmentId" TEXT NOT NULL,
  "trackerId" TEXT,
  "sensorDeviceId" TEXT,
  "quantityUnits" INTEGER NOT NULL,
  "handedOverQuantity" INTEGER NOT NULL DEFAULT 0,
  "loadedAt" TIMESTAMP(3) NOT NULL,
  "unloadedAt" TIMESTAMP(3),
  "pickupCustodyEventId" TEXT,
  "handoverCustodyEventId" TEXT,
  "recordedById" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cargo_compartment_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE UNIQUE INDEX "vehicle_compartments_fleetAssetId_compartmentCode_key" ON "vehicle_compartments"("fleetAssetId", "compartmentCode");
CREATE INDEX "vehicle_compartments_fleetAssetId_idx" ON "vehicle_compartments"("fleetAssetId");

CREATE UNIQUE INDEX "vehicle_trackers_imei_key" ON "vehicle_trackers"("imei");
CREATE INDEX "vehicle_trackers_fleetAssetId_idx" ON "vehicle_trackers"("fleetAssetId");

CREATE UNIQUE INDEX "telemetry_device_credentials_secretHash_key" ON "telemetry_device_credentials"("secretHash");
CREATE INDEX "telemetry_device_credentials_trackerId_idx" ON "telemetry_device_credentials"("trackerId");
CREATE INDEX "telemetry_device_credentials_active_expiresAt_idx" ON "telemetry_device_credentials"("active", "expiresAt");

CREATE UNIQUE INDEX "temperature_devices_bleMacAddress_key" ON "temperature_devices"("bleMacAddress");
CREATE INDEX "temperature_devices_compartmentId_idx" ON "temperature_devices"("compartmentId");

CREATE UNIQUE INDEX "vehicle_telemetry_frames_dedupeKey_key" ON "vehicle_telemetry_frames"("dedupeKey");
CREATE INDEX "vehicle_telemetry_frames_fleetAssetId_capturedAt_idx" ON "vehicle_telemetry_frames"("fleetAssetId", "capturedAt");
CREATE INDEX "vehicle_telemetry_frames_trackerId_capturedAt_idx" ON "vehicle_telemetry_frames"("trackerId", "capturedAt");
CREATE INDEX "vehicle_telemetry_frames_sensorDeviceId_capturedAt_idx" ON "vehicle_telemetry_frames"("sensorDeviceId", "capturedAt");
CREATE INDEX "vehicle_telemetry_frames_compartmentId_capturedAt_idx" ON "vehicle_telemetry_frames"("compartmentId", "capturedAt");

CREATE UNIQUE INDEX "temperature_readings_dedupeKey_key" ON "temperature_readings"("dedupeKey");
CREATE INDEX "temperature_readings_lotId_capturedAt_idx" ON "temperature_readings"("lotId", "capturedAt");
CREATE INDEX "temperature_readings_deliveryId_idx" ON "temperature_readings"("deliveryId");
CREATE INDEX "temperature_readings_origin_idx" ON "temperature_readings"("origin");
CREATE INDEX "temperature_readings_telemetryFrameId_idx" ON "temperature_readings"("telemetryFrameId");

CREATE INDEX "chain_of_custody_events_deliveryId_idx" ON "chain_of_custody_events"("deliveryId");
CREATE INDEX "chain_of_custody_events_compartmentId_idx" ON "chain_of_custody_events"("compartmentId");

CREATE INDEX "cargo_compartment_assignments_compartmentId_loadedAt_unloaded_idx" ON "cargo_compartment_assignments"("compartmentId", "loadedAt", "unloadedAt");
CREATE INDEX "cargo_compartment_assignments_trackerId_loadedAt_unloadedAt_idx" ON "cargo_compartment_assignments"("trackerId", "loadedAt", "unloadedAt");
CREATE INDEX "cargo_compartment_assignments_sensorDeviceId_loadedAt_unloade_idx" ON "cargo_compartment_assignments"("sensorDeviceId", "loadedAt", "unloadedAt");
CREATE INDEX "cargo_compartment_assignments_deliveryId_idx" ON "cargo_compartment_assignments"("deliveryId");
CREATE INDEX "cargo_compartment_assignments_lotId_idx" ON "cargo_compartment_assignments"("lotId");

-- AddForeignKeys
ALTER TABLE "vehicle_compartments"
  ADD CONSTRAINT "vehicle_compartments_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vehicle_trackers"
  ADD CONSTRAINT "vehicle_trackers_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "telemetry_device_credentials"
  ADD CONSTRAINT "telemetry_device_credentials_trackerId_fkey"
  FOREIGN KEY ("trackerId") REFERENCES "vehicle_trackers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_device_credentials"
  ADD CONSTRAINT "telemetry_device_credentials_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telemetry_device_credentials"
  ADD CONSTRAINT "telemetry_device_credentials_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "temperature_devices"
  ADD CONSTRAINT "temperature_devices_compartmentId_fkey"
  FOREIGN KEY ("compartmentId") REFERENCES "vehicle_compartments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vehicle_telemetry_frames"
  ADD CONSTRAINT "vehicle_telemetry_frames_trackerId_fkey"
  FOREIGN KEY ("trackerId") REFERENCES "vehicle_trackers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_telemetry_frames"
  ADD CONSTRAINT "vehicle_telemetry_frames_sensorDeviceId_fkey"
  FOREIGN KEY ("sensorDeviceId") REFERENCES "temperature_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_telemetry_frames"
  ADD CONSTRAINT "vehicle_telemetry_frames_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vehicle_telemetry_frames"
  ADD CONSTRAINT "vehicle_telemetry_frames_compartmentId_fkey"
  FOREIGN KEY ("compartmentId") REFERENCES "vehicle_compartments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "temperature_readings"
  ADD CONSTRAINT "temperature_readings_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "temperature_readings"
  ADD CONSTRAINT "temperature_readings_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "temperature_readings"
  ADD CONSTRAINT "temperature_readings_compartmentId_fkey"
  FOREIGN KEY ("compartmentId") REFERENCES "vehicle_compartments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "temperature_readings"
  ADD CONSTRAINT "temperature_readings_trackerId_fkey"
  FOREIGN KEY ("trackerId") REFERENCES "vehicle_trackers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "temperature_readings"
  ADD CONSTRAINT "temperature_readings_telemetryFrameId_fkey"
  FOREIGN KEY ("telemetryFrameId") REFERENCES "vehicle_telemetry_frames"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "chain_of_custody_events"
  ADD CONSTRAINT "chain_of_custody_events_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chain_of_custody_events"
  ADD CONSTRAINT "chain_of_custody_events_compartmentId_fkey"
  FOREIGN KEY ("compartmentId") REFERENCES "vehicle_compartments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chain_of_custody_events"
  ADD CONSTRAINT "chain_of_custody_events_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_vendorOrderId_fkey"
  FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_compartmentId_fkey"
  FOREIGN KEY ("compartmentId") REFERENCES "vehicle_compartments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_trackerId_fkey"
  FOREIGN KEY ("trackerId") REFERENCES "vehicle_trackers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_sensorDeviceId_fkey"
  FOREIGN KEY ("sensorDeviceId") REFERENCES "temperature_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_pickupCustodyEventId_fkey"
  FOREIGN KEY ("pickupCustodyEventId") REFERENCES "chain_of_custody_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_handoverCustodyEventId_fkey"
  FOREIGN KEY ("handoverCustodyEventId") REFERENCES "chain_of_custody_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cargo_compartment_assignments"
  ADD CONSTRAINT "cargo_compartment_assignments_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
