-- Migration #77: Admin Catalogue Photo Management, Versioning, Default Selection,
-- Azure Blob Storage Metadata, Explicit Upload/Edit Permission, and Append-Only Audit Log.
-- Non-destructive to existing 9 seeded catalogue_photos rows, credits, and Product selections.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "canManageCataloguePhotos" BOOLEAN NOT NULL DEFAULT false;

-- Preserve existing ADMINISTRATOR accounts' ability to manage catalogue photos immediately;
-- newly created users and OPERATIONS_STAFF default to false unless explicitly granted.
UPDATE "users" u
SET "canManageCataloguePhotos" = true
WHERE EXISTS (
  SELECT 1
  FROM "user_roles" ur
  JOIN "roles" r ON r."id" = ur."roleId"
  WHERE ur."userId" = u."id" AND r."name" = 'ADMINISTRATOR'
);

ALTER TABLE "catalogue_photos"
  ADD COLUMN IF NOT EXISTS "versionGroupId" TEXT,
  ADD COLUMN IF NOT EXISTS "versionNumber" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "replacesPhotoId" TEXT,
  ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "storageProvider" TEXT NOT NULL DEFAULT 'BUNDLED',
  ADD COLUMN IF NOT EXISTS "storageContainer" TEXT,
  ADD COLUMN IF NOT EXISTS "storageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "mimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "fileSizeBytes" INTEGER,
  ADD COLUMN IF NOT EXISTS "widthPx" INTEGER,
  ADD COLUMN IF NOT EXISTS "heightPx" INTEGER,
  ADD COLUMN IF NOT EXISTS "uploadedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publishedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retiredByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "retirementReason" TEXT;

UPDATE "catalogue_photos"
SET
  "versionGroupId" = COALESCE("versionGroupId", "id"),
  "publishedAt" = COALESCE(
    "publishedAt",
    CASE WHEN "approvalStatus" = 'APPROVED' THEN "createdAt" ELSE NULL END
  ),
  "mimeType" = COALESCE(
    "mimeType",
    CASE
      WHEN LOWER("imageUrl") LIKE '%.png' THEN 'image/png'
      WHEN LOWER("imageUrl") LIKE '%.webp' THEN 'image/webp'
      WHEN LOWER("imageUrl") LIKE '%.jpg' OR LOWER("imageUrl") LIKE '%.jpeg' THEN 'image/jpeg'
      ELSE NULL
    END
  );

ALTER TABLE "catalogue_photos"
  ALTER COLUMN "versionGroupId" SET NOT NULL,
  ALTER COLUMN "versionGroupId" SET DEFAULT gen_random_uuid()::text;

WITH first_per_species AS (
  SELECT DISTINCT ON ("speciesId") "id"
  FROM "catalogue_photos"
  WHERE "approvalStatus" = 'APPROVED' AND "retiredAt" IS NULL
  ORDER BY "speciesId" ASC, "createdAt" ASC, "id" ASC
)
UPDATE "catalogue_photos" cp
SET "isDefault" = true
FROM first_per_species fps
WHERE cp."id" = fps."id"
  AND NOT EXISTS (
    SELECT 1 FROM "catalogue_photos" existing_def
    WHERE existing_def."speciesId" = cp."speciesId"
      AND existing_def."isDefault" = true
      AND existing_def."retiredAt" IS NULL
      AND existing_def."approvalStatus" = 'APPROVED'
  );

CREATE UNIQUE INDEX IF NOT EXISTS "catalogue_photos_storage_key_unique"
  ON "catalogue_photos"("storageProvider", "storageContainer", "storageKey")
  WHERE "storageKey" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "catalogue_photos_one_default_per_species_idx"
  ON "catalogue_photos"("speciesId")
  WHERE "isDefault" = true AND "retiredAt" IS NULL AND "approvalStatus" = 'APPROVED';

CREATE INDEX IF NOT EXISTS "catalogue_photos_versionGroupId_idx"
  ON "catalogue_photos"("versionGroupId");

CREATE INDEX IF NOT EXISTS "catalogue_photos_retiredAt_idx"
  ON "catalogue_photos"("retiredAt");

ALTER TABLE "catalogue_photos"
  ADD CONSTRAINT "catalogue_photos_replacesPhotoId_fkey"
  FOREIGN KEY ("replacesPhotoId") REFERENCES "catalogue_photos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "catalogue_photos"
  ADD CONSTRAINT "catalogue_photos_uploadedByUserId_fkey"
  FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "catalogue_photos"
  ADD CONSTRAINT "catalogue_photos_publishedByUserId_fkey"
  FOREIGN KEY ("publishedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "catalogue_photos"
  ADD CONSTRAINT "catalogue_photos_rejectedByUserId_fkey"
  FOREIGN KEY ("rejectedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "catalogue_photos"
  ADD CONSTRAINT "catalogue_photos_retiredByUserId_fkey"
  FOREIGN KEY ("retiredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "CataloguePhotoAuditAction" AS ENUM (
  'UPLOAD_DRAFT',
  'UPDATE_METADATA',
  'UPLOAD_REPLACEMENT_DRAFT',
  'APPROVE_AND_PUBLISH',
  'REJECT_DRAFT',
  'SET_DEFAULT',
  'RETIRE',
  'BULK_SWITCH_LISTINGS',
  'ROLLBACK_RESTORE'
);

CREATE TABLE "catalogue_photo_audit_logs" (
  "id" TEXT NOT NULL,
  "cataloguePhotoId" TEXT NOT NULL,
  "versionGroupId" TEXT NOT NULL,
  "action" "CataloguePhotoAuditAction" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "affectedCount" INTEGER NOT NULL DEFAULT 0,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalogue_photo_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalogue_photo_audit_logs_cataloguePhotoId_createdAt_idx"
  ON "catalogue_photo_audit_logs"("cataloguePhotoId", "createdAt");
CREATE INDEX "catalogue_photo_audit_logs_versionGroupId_createdAt_idx"
  ON "catalogue_photo_audit_logs"("versionGroupId", "createdAt");
CREATE INDEX "catalogue_photo_audit_logs_actorUserId_idx"
  ON "catalogue_photo_audit_logs"("actorUserId");

ALTER TABLE "catalogue_photo_audit_logs"
  ADD CONSTRAINT "catalogue_photo_audit_logs_cataloguePhotoId_fkey"
  FOREIGN KEY ("cataloguePhotoId") REFERENCES "catalogue_photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "catalogue_photo_audit_logs"
  ADD CONSTRAINT "catalogue_photo_audit_logs_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "guard_catalogue_photo_audit_logs_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'catalogue_photo_audit_logs is append-only; % is prohibited', TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "catalogue_photo_audit_logs_immutable_guard"
  BEFORE UPDATE OR DELETE ON "catalogue_photo_audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_catalogue_photo_audit_logs_immutable"();

CREATE TRIGGER "zz_catalogue_photo_audit_logs_truncate_guard"
  BEFORE TRUNCATE ON "catalogue_photo_audit_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "guard_catalogue_photo_audit_logs_immutable"();
