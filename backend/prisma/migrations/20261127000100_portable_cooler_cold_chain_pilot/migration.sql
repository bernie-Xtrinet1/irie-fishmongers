-- Migration #79: Portable cooler & motorbike cold-chain monitoring pilot.
-- Additive, non-destructive changes preserving all existing compartments,
-- trackers, sensors, frames, custody events, and refrigerated-van workflows.

-- 1. Extend vehicle_compartments to support standalone/reusable portable coolers
ALTER TABLE "vehicle_compartments"
  DROP CONSTRAINT IF EXISTS "vehicle_compartments_fleetAssetId_fkey";

ALTER TABLE "vehicle_compartments"
  ALTER COLUMN "fleetAssetId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "compartmentKind" "CompartmentKind" NOT NULL DEFAULT 'FIXED_COMPARTMENT',
  ADD COLUMN IF NOT EXISTS "coolerCode" TEXT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

ALTER TABLE "vehicle_compartments"
  ADD CONSTRAINT "vehicle_compartments_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_compartments_coolerCode_key"
  ON "vehicle_compartments"("coolerCode");

CREATE INDEX IF NOT EXISTS "vehicle_compartments_compartmentKind_idx"
  ON "vehicle_compartments"("compartmentKind");

-- 2. Assignment history table linking coolers/compartments to vehicles over time
CREATE TABLE IF NOT EXISTS "cooler_vehicle_assignments" (
  "id" TEXT NOT NULL,
  "compartmentId" TEXT NOT NULL,
  "fleetAssetId" TEXT NOT NULL,
  "sensorSlot" INTEGER,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unassignedAt" TIMESTAMP(3),
  "assignedById" TEXT,
  "unassignedById" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cooler_vehicle_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cooler_vehicle_assignments_compartmentId_assignedAt_idx"
  ON "cooler_vehicle_assignments"("compartmentId", "assignedAt");

CREATE INDEX IF NOT EXISTS "cooler_vehicle_assignments_fleetAssetId_unassignedAt_idx"
  ON "cooler_vehicle_assignments"("fleetAssetId", "unassignedAt");

ALTER TABLE "cooler_vehicle_assignments"
  ADD CONSTRAINT "cooler_vehicle_assignments_compartmentId_fkey"
  FOREIGN KEY ("compartmentId") REFERENCES "vehicle_compartments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cooler_vehicle_assignments"
  ADD CONSTRAINT "cooler_vehicle_assignments_fleetAssetId_fkey"
  FOREIGN KEY ("fleetAssetId") REFERENCES "fleet_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cooler_vehicle_assignments"
  ADD CONSTRAINT "cooler_vehicle_assignments_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cooler_vehicle_assignments"
  ADD CONSTRAINT "cooler_vehicle_assignments_unassignedById_fkey"
  FOREIGN KEY ("unassignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill open assignment history rows for all existing compartments assigned to vehicles
INSERT INTO "cooler_vehicle_assignments" ("id", "compartmentId", "fleetAssetId", "sensorSlot", "assignedAt", "createdAt", "updatedAt")
SELECT
  'cva-' || vc."id",
  vc."id",
  vc."fleetAssetId",
  (
    SELECT td."sensorSlot"
    FROM "temperature_devices" td
    WHERE td."compartmentId" = vc."id"
    ORDER BY td."sensorSlot" ASC NULLS LAST, td."createdAt" ASC
    LIMIT 1
  ),
  vc."createdAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "vehicle_compartments" vc
WHERE vc."fleetAssetId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "cooler_vehicle_assignments" cva
    WHERE cva."compartmentId" = vc."id"
      AND cva."unassignedAt" IS NULL
  );

-- 3. Persist explicit unmatched-lot flagging on telemetry frames
ALTER TABLE "vehicle_telemetry_frames"
  ADD COLUMN IF NOT EXISTS "unmatchedLot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "unmatchedReason" TEXT;

CREATE INDEX IF NOT EXISTS "vehicle_telemetry_frames_unmatchedLot_capturedAt_idx"
  ON "vehicle_telemetry_frames"("unmatchedLot", "capturedAt");
