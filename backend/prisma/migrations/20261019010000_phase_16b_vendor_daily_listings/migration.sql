-- CreateEnum
CREATE TYPE "ListingLifecycleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ListingPhotoModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SeafoodOriginType" AS ENUM ('WILD_CAUGHT', 'AQUACULTURE', 'IMPORTED', 'PROCESSED');

-- CreateEnum
CREATE TYPE "SeafoodAcquisitionType" AS ENUM ('DIRECT_CATCH', 'COOPERATIVE_PURCHASE', 'WHOLESALE_PURCHASE', 'TRANSFER', 'CONSIGNMENT', 'OTHER');

-- CreateTable
CREATE TABLE "vendor_daily_listings" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "catalogueItemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "landingSiteId" TEXT,
    "listingTitle" TEXT,
    "description" TEXT,
    "catchDate" TIMESTAMP(3) NOT NULL,
    "availableFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "unit" "ProductUnit" NOT NULL DEFAULT 'PER_POUND',
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JMD',
    "quantityUploaded" DECIMAL(10,2) NOT NULL,
    "quantityAvailable" DECIMAL(10,2) NOT NULL,
    "quantityReserved" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "quantitySold" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "preparationOptions" JSONB,
    "deliveryAvailable" BOOLEAN NOT NULL DEFAULT true,
    "pickupAvailable" BOOLEAN NOT NULL DEFAULT true,
    "status" "ListingLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_daily_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_photos" (
    "id" TEXT NOT NULL,
    "vendorDailyListingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "moderationStatus" "ListingPhotoModerationStatus" NOT NULL DEFAULT 'APPROVED',
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captureDate" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnByUserId" TEXT,
    "withdrawnReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_daily_listing_species" (
    "id" TEXT NOT NULL,
    "vendorDailyListingId" TEXT NOT NULL,
    "speciesId" TEXT NOT NULL,
    "proportion" DECIMAL(5,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_daily_listing_species_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "seafood_lots" ADD COLUMN "originType" "SeafoodOriginType";
ALTER TABLE "seafood_lots" ADD COLUMN "acquisitionType" "SeafoodAcquisitionType";

-- CreateIndex
CREATE INDEX "vendor_daily_listings_vendorId_status_idx" ON "vendor_daily_listings"("vendorId", "status");

-- CreateIndex
CREATE INDEX "vendor_daily_listings_catalogueItemId_status_idx" ON "vendor_daily_listings"("catalogueItemId", "status");

-- CreateIndex
CREATE INDEX "vendor_daily_listings_productId_idx" ON "vendor_daily_listings"("productId");

-- CreateIndex
CREATE INDEX "vendor_daily_listings_lotId_idx" ON "vendor_daily_listings"("lotId");

-- CreateIndex
CREATE INDEX "vendor_daily_listings_status_expiresAt_idx" ON "vendor_daily_listings"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "listing_photos_vendorDailyListingId_idx" ON "listing_photos"("vendorDailyListingId");

-- CreateIndex (Partial unique index: exactly one primary non-withdrawn photo per listing)
CREATE UNIQUE INDEX "listing_photos_one_primary_idx" ON "listing_photos"("vendorDailyListingId") WHERE "isPrimary" = true AND "withdrawnAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "vendor_daily_listing_species_vendorDailyListingId_speciesId_key" ON "vendor_daily_listing_species"("vendorDailyListingId", "speciesId");

-- CreateIndex
CREATE INDEX "vendor_daily_listing_species_speciesId_idx" ON "vendor_daily_listing_species"("speciesId");

-- AddForeignKey
ALTER TABLE "vendor_daily_listings" ADD CONSTRAINT "vendor_daily_listings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_daily_listings" ADD CONSTRAINT "vendor_daily_listings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_daily_listings" ADD CONSTRAINT "vendor_daily_listings_catalogueItemId_fkey" FOREIGN KEY ("catalogueItemId") REFERENCES "seafood_catalogue_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_daily_listings" ADD CONSTRAINT "vendor_daily_listings_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "seafood_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_daily_listings" ADD CONSTRAINT "vendor_daily_listings_landingSiteId_fkey" FOREIGN KEY ("landingSiteId") REFERENCES "landing_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_photos" ADD CONSTRAINT "listing_photos_vendorDailyListingId_fkey" FOREIGN KEY ("vendorDailyListingId") REFERENCES "vendor_daily_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_photos" ADD CONSTRAINT "listing_photos_withdrawnByUserId_fkey" FOREIGN KEY ("withdrawnByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_daily_listing_species" ADD CONSTRAINT "vendor_daily_listing_species_vendorDailyListingId_fkey" FOREIGN KEY ("vendorDailyListingId") REFERENCES "vendor_daily_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_daily_listing_species" ADD CONSTRAINT "vendor_daily_listing_species_speciesId_fkey" FOREIGN KEY ("speciesId") REFERENCES "species"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
