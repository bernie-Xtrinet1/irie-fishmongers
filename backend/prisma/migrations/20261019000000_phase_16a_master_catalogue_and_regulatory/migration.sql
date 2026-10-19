-- CreateEnum
CREATE TYPE "CatalogueCompositionMode" AS ENUM ('SINGLE_SPECIES', 'FIXED_COMPOSITE', 'VARIABLE_COMPOSITE', 'UNVERIFIED_COMPOSITION');

-- CreateEnum
CREATE TYPE "CatalogueLifecycleStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "CatalogueRetirementReason" AS ENUM ('COMMERCIAL_RETIREMENT', 'DUPLICATE_CONSOLIDATION', 'SAFETY_REGULATORY_RETIREMENT', 'DATA_CORRECTION');

-- CreateEnum
CREATE TYPE "InventoryMode" AS ENUM ('LEGACY_PRODUCT', 'MIGRATION_PENDING', 'LISTING_BACKED');

-- CreateEnum
CREATE TYPE "RegulatoryOverrideReason" AS ENUM ('DATA_CORRECTION');

-- CreateTable
CREATE TABLE "seafood_catalogue_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scientificName" TEXT,
    "scientificFamily" TEXT,
    "commonName" TEXT NOT NULL,
    "jamaicanNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "categoryId" TEXT NOT NULL,
    "compositionMode" "CatalogueCompositionMode" NOT NULL DEFAULT 'UNVERIFIED_COMPOSITION',
    "lifecycleStatus" "CatalogueLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "retirementReason" "CatalogueRetirementReason",
    "retirementNotes" TEXT,
    "consolidatedIntoId" TEXT,
    "referenceImageUrl" TEXT,
    "imageSourceLicense" TEXT,
    "typicalUnit" "ProductUnit" NOT NULL DEFAULT 'PER_POUND',
    "typicalSizeMinCm" DECIMAL(6,2),
    "typicalSizeMaxCm" DECIMAL(6,2),
    "typicalWeightMinLbs" DECIMAL(6,2),
    "typicalWeightMaxLbs" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seafood_catalogue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue_item_species" (
    "catalogueItemId" TEXT NOT NULL,
    "speciesId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "typicalProportion" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalogue_item_species_pkey" PRIMARY KEY ("catalogueItemId","speciesId")
);

-- CreateTable
CREATE TABLE "regulatory_overrides" (
    "id" TEXT NOT NULL,
    "catalogueItemId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "reason" "RegulatoryOverrideReason" NOT NULL DEFAULT 'DATA_CORRECTION',
    "justification" TEXT NOT NULL,
    "documentEvidenceUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regulatory_overrides_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "products" ADD COLUMN "catalogueItemId" TEXT;
ALTER TABLE "products" ADD COLUMN "inventoryMode" "InventoryMode" NOT NULL DEFAULT 'LEGACY_PRODUCT';

-- CreateIndex
CREATE INDEX "seafood_catalogue_items_categoryId_idx" ON "seafood_catalogue_items"("categoryId");

-- CreateIndex
CREATE INDEX "seafood_catalogue_items_lifecycleStatus_idx" ON "seafood_catalogue_items"("lifecycleStatus");

-- CreateIndex
CREATE INDEX "seafood_catalogue_items_compositionMode_idx" ON "seafood_catalogue_items"("compositionMode");

-- CreateIndex
CREATE INDEX "seafood_catalogue_items_consolidatedIntoId_idx" ON "seafood_catalogue_items"("consolidatedIntoId");

-- CreateIndex
CREATE INDEX "catalogue_item_species_speciesId_idx" ON "catalogue_item_species"("speciesId");

-- CreateIndex
CREATE INDEX "regulatory_overrides_catalogueItemId_idx" ON "regulatory_overrides"("catalogueItemId");

-- CreateIndex
CREATE INDEX "regulatory_overrides_expiresAt_idx" ON "regulatory_overrides"("expiresAt");

-- CreateIndex
CREATE INDEX "products_catalogueItemId_idx" ON "products"("catalogueItemId");

-- AddForeignKey
ALTER TABLE "seafood_catalogue_items" ADD CONSTRAINT "seafood_catalogue_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seafood_catalogue_items" ADD CONSTRAINT "seafood_catalogue_items_consolidatedIntoId_fkey" FOREIGN KEY ("consolidatedIntoId") REFERENCES "seafood_catalogue_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue_item_species" ADD CONSTRAINT "catalogue_item_species_catalogueItemId_fkey" FOREIGN KEY ("catalogueItemId") REFERENCES "seafood_catalogue_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue_item_species" ADD CONSTRAINT "catalogue_item_species_speciesId_fkey" FOREIGN KEY ("speciesId") REFERENCES "species"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_overrides" ADD CONSTRAINT "regulatory_overrides_catalogueItemId_fkey" FOREIGN KEY ("catalogueItemId") REFERENCES "seafood_catalogue_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_overrides" ADD CONSTRAINT "regulatory_overrides_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_overrides" ADD CONSTRAINT "regulatory_overrides_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_catalogueItemId_fkey" FOREIGN KEY ("catalogueItemId") REFERENCES "seafood_catalogue_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
