-- Migration #78: Create/extend PostgreSQL enums for portable cooler cold-chain
-- pilot separately before altering tables or backfilling (avoids PG 55P04).

ALTER TYPE "FleetAssetType" ADD VALUE IF NOT EXISTS 'MOTORBIKE';
ALTER TYPE "TrackerHardwareModel" ADD VALUE IF NOT EXISTS 'TELTONIKA_FMC234';

CREATE TYPE "CompartmentKind" AS ENUM (
  'FIXED_COMPARTMENT',
  'PORTABLE_COOLER'
);
