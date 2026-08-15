-- Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). Two independent,
-- coherently-bundled changes:
--
-- 1. CartReservationSyncState gains a BLOCKED status, a blockReason, and a
--    nextAttemptAt scheduling column - the durable precondition-wait state
--    for a recovery attempt that cannot proceed right now (product-suspect
--    accounting, or a mode that is not currently admitting reserve-shaped
--    recovery).
--
-- 2. ReservationEngineModeConfig gains a monotonic `revision` column,
--    replacing createdAt as the ordering key for "what is current". A
--    random UUID (`id`) has identity but no ordering; createdAt is
--    TIMESTAMP(3) (millisecond precision) and is not a reliable ordering
--    under a same-millisecond tie between two transitions. `revision` is
--    Postgres-sequence-backed and therefore atomic and strictly monotonic
--    by construction. Existing rows are backfilled in ascending createdAt
--    order - deliberately with NO id-based tiebreak: a UUID carries no
--    historical meaning, so if two existing rows share an identical
--    createdAt, their true chronological order is genuinely unknowable,
--    and this migration must fail loudly rather than invent one.

-- CreateEnum
CREATE TYPE "CartReservationSyncBlockReason" AS ENUM ('PRODUCT_SUSPECT', 'MODE_NOT_ADMITTING');

-- AlterEnum
ALTER TYPE "CartReservationSyncStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "cart_reservation_sync_states" ADD COLUMN     "blockReason" "CartReservationSyncBlockReason",
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- Fail loudly if existing reservation_engine_mode_configs rows cannot be
-- ordered unambiguously by createdAt alone. No id-based tiebreak is used
-- here or anywhere below.
DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "createdAt"
    FROM "reservation_engine_mode_configs"
    GROUP BY "createdAt"
    HAVING COUNT(*) > 1
  ) AS duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % reservation_engine_mode_configs row(s) share a duplicate createdAt value - their true chronological order is unknowable and this migration will not guess one. Resolve the ambiguity manually (e.g. by correcting createdAt against another authoritative source) before retrying.', duplicate_count;
  END IF;
END $$;

-- AlterTable: add revision as a plain nullable column first, so the
-- backfill below controls exactly which value each existing row gets,
-- rather than relying on whatever implicit row order an
-- "ADD COLUMN ... SERIAL" backfill would otherwise use.
ALTER TABLE "reservation_engine_mode_configs" ADD COLUMN     "revision" INTEGER;

-- Backfill: ascending createdAt order only, already proven unambiguous by
-- the guard above.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) AS rn
  FROM "reservation_engine_mode_configs"
)
UPDATE "reservation_engine_mode_configs" AS r
SET "revision" = ordered.rn
FROM ordered
WHERE r."id" = ordered."id";

-- Sequence for all future inserts, seeded past the backfilled maximum so
-- the very next setMode() call continues the same monotonic sequence
-- rather than colliding with or reusing a backfilled value.
CREATE SEQUENCE "reservation_engine_mode_configs_revision_seq"
  OWNED BY "reservation_engine_mode_configs"."revision";

SELECT setval(
  'reservation_engine_mode_configs_revision_seq',
  COALESCE((SELECT MAX("revision") FROM "reservation_engine_mode_configs"), 0) + 1,
  false
);

ALTER TABLE "reservation_engine_mode_configs"
  ALTER COLUMN "revision" SET DEFAULT nextval('reservation_engine_mode_configs_revision_seq');
ALTER TABLE "reservation_engine_mode_configs" ALTER COLUMN "revision" SET NOT NULL;
ALTER TABLE "reservation_engine_mode_configs"
  ADD CONSTRAINT "reservation_engine_mode_configs_revision_key" UNIQUE ("revision");
