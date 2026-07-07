-- CreateEnum
CREATE TYPE "VendorTier" AS ENUM ('COMMUNITY_FISHER', 'VERIFIED_VENDOR', 'COMMERCIAL_SUPPLIER', 'ENTERPRISE_SUPPLIER');

-- CreateEnum
CREATE TYPE "VendorDocumentType" AS ENUM ('GOVERNMENT_ID', 'BUSINESS_REGISTRATION', 'TAX_COMPLIANCE_CERTIFICATE', 'INSURANCE_CERTIFICATE', 'FOOD_SAFETY_DOCUMENTATION', 'REGULATORY_CERTIFICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VendorTierFeatureFlag" AS ENUM ('SELL_RETAIL', 'SELL_WHOLESALE', 'ACCEPT_HOTEL_ORDERS', 'ACCEPT_RESTAURANT_ORDERS', 'ACCEPT_GOVERNMENT_ORDERS', 'EXPORT_PRODUCTS', 'ACCESS_ANALYTICS', 'ACCESS_PROMOTIONS', 'API_ACCESS', 'MULTI_ZONE_OPERATIONS');

-- CreateEnum
CREATE TYPE "TierRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DowngradeReason" AS ENUM ('EXPIRED_DOCUMENTS', 'FOOD_SAFETY_VIOLATION', 'REPEATED_DELIVERY_FAILURES', 'FRAUD_REPORT', 'COMPLIANCE_BREACH', 'ADMIN_MANUAL');

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "complianceScore" INTEGER,
ADD COLUMN     "tier" "VendorTier" NOT NULL DEFAULT 'COMMUNITY_FISHER';

-- CreateTable
CREATE TABLE "vendor_documents" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "documentType" "VendorDocumentType" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "documentNumber" TEXT,
    "issuedDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "status" "DocumentReviewStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_tier_configs" (
    "id" TEXT NOT NULL,
    "tier" "VendorTier" NOT NULL,
    "dailySalesLimit" DECIMAL(12,2),
    "monthlySalesLimit" DECIMAL(12,2),
    "maxActiveListings" INTEGER,
    "badge" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_tier_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_tier_features" (
    "id" TEXT NOT NULL,
    "tier" "VendorTier" NOT NULL,
    "feature" "VendorTierFeatureFlag" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_tier_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_upgrade_requests" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "requestedTier" "VendorTier" NOT NULL,
    "status" "TierRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_upgrade_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_downgrade_events" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fromTier" "VendorTier" NOT NULL,
    "toTier" "VendorTier" NOT NULL,
    "reason" "DowngradeReason" NOT NULL,
    "triggeredById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_downgrade_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_documents_vendorId_idx" ON "vendor_documents"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_tier_configs_tier_key" ON "vendor_tier_configs"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_tier_features_tier_feature_key" ON "vendor_tier_features"("tier", "feature");

-- CreateIndex
CREATE INDEX "vendor_upgrade_requests_vendorId_idx" ON "vendor_upgrade_requests"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_downgrade_events_vendorId_idx" ON "vendor_downgrade_events"("vendorId");

-- AddForeignKey
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_upgrade_requests" ADD CONSTRAINT "vendor_upgrade_requests_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_upgrade_requests" ADD CONSTRAINT "vendor_upgrade_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_downgrade_events" ADD CONSTRAINT "vendor_downgrade_events_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_downgrade_events" ADD CONSTRAINT "vendor_downgrade_events_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
