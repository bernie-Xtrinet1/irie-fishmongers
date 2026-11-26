-- Additive Migration #71: Catalogue Photo Library & Product Species/Library Attribution
-- Adds CataloguePhotoApprovalStatus enum, catalogue_photos table for verified species
-- reference imagery with source/photographer/licence/modification rights, and optional
-- speciesId / cataloguePhotoId links on products. Non-destructive to existing data.

CREATE TYPE "CataloguePhotoApprovalStatus" AS ENUM ('APPROVED', 'PENDING', 'REJECTED');

CREATE TABLE "catalogue_photos" (
  "id" TEXT NOT NULL,
  "speciesId" TEXT NOT NULL,
  "catalogueItemId" TEXT,
  "title" TEXT NOT NULL,
  "scientificName" TEXT NOT NULL,
  "jamaicanAliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "imageUrl" TEXT NOT NULL,
  "sourceName" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "photographer" TEXT NOT NULL,
  "licenseName" TEXT NOT NULL,
  "licenseUrl" TEXT NOT NULL,
  "modifications" TEXT NOT NULL,
  "requiresAttribution" BOOLEAN NOT NULL DEFAULT true,
  "approvalStatus" "CataloguePhotoApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "catalogue_photos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalogue_photos_speciesId_imageUrl_key" ON "catalogue_photos"("speciesId", "imageUrl");
CREATE INDEX "catalogue_photos_speciesId_approvalStatus_idx" ON "catalogue_photos"("speciesId", "approvalStatus");
CREATE INDEX "catalogue_photos_catalogueItemId_idx" ON "catalogue_photos"("catalogueItemId");

ALTER TABLE "products" ADD COLUMN "speciesId" TEXT;
ALTER TABLE "products" ADD COLUMN "cataloguePhotoId" TEXT;

CREATE INDEX "products_speciesId_idx" ON "products"("speciesId");
CREATE INDEX "products_cataloguePhotoId_idx" ON "products"("cataloguePhotoId");

ALTER TABLE "catalogue_photos"
  ADD CONSTRAINT "catalogue_photos_speciesId_fkey"
  FOREIGN KEY ("speciesId") REFERENCES "species"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "catalogue_photos"
  ADD CONSTRAINT "catalogue_photos_catalogueItemId_fkey"
  FOREIGN KEY ("catalogueItemId") REFERENCES "seafood_catalogue_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_speciesId_fkey"
  FOREIGN KEY ("speciesId") REFERENCES "species"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_cataloguePhotoId_fkey"
  FOREIGN KEY ("cataloguePhotoId") REFERENCES "catalogue_photos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
