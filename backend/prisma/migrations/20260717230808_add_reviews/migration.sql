-- CreateEnum
CREATE TYPE "ReviewModerationStatus" AS ENUM ('VISIBLE', 'REMOVED_BY_AUTHOR', 'REMOVED_BY_ADMIN');

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "authorId" TEXT,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT,
    "vendorOrderId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "moderationStatus" "ReviewModerationStatus" NOT NULL DEFAULT 'VISIBLE',
    "removedById" TEXT,
    "removalReason" TEXT,
    "removedAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_vendorId_moderationStatus_idx" ON "reviews"("vendorId", "moderationStatus");

-- CreateIndex
CREATE INDEX "reviews_productId_moderationStatus_idx" ON "reviews"("productId", "moderationStatus");

-- Hand-added (Phase 13A): enforce one-review-per-purchase. Postgres treats
-- every NULL as distinct, so a single compound unique across the nullable
-- productId would NOT block duplicate vendor-only reviews. Two PARTIAL
-- unique indexes express the real rule Prisma's @@unique cannot:
--   * a customer gets at most one vendor-only review per vendor order
--   * a customer gets at most one review per (vendor order, product)
-- These apply regardless of moderationStatus, so removing a review (by
-- author or admin) does NOT free up a second review for the same purchase.
CREATE UNIQUE INDEX "reviews_author_order_vendor_review_key"
  ON "reviews" ("authorId", "vendorOrderId") WHERE "productId" IS NULL;
CREATE UNIQUE INDEX "reviews_author_order_product_review_key"
  ON "reviews" ("authorId", "vendorOrderId", "productId") WHERE "productId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
