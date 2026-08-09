-- CreateEnum
CREATE TYPE "CompensationOperation" AS ENUM ('RESERVE_MIRROR', 'RELEASE_MIRROR');

-- CreateEnum
CREATE TYPE "CompensationStatus" AS ENUM ('PENDING', 'PROCESSING', 'BLOCKED', 'RESOLVED', 'PERMANENT_FAILURE');

-- CreateEnum
CREATE TYPE "CompensationReasonCode" AS ENUM ('PRODUCT_SUSPENDED', 'CHECKOUT_IN_PROGRESS', 'ACCOUNTING_UNDERFLOW', 'UNKNOWN_INFRA_FAILURE');

-- CreateTable
CREATE TABLE "cart_reservation_compensations" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "operation" "CompensationOperation" NOT NULL,
    "status" "CompensationStatus" NOT NULL DEFAULT 'PENDING',
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "customerId" TEXT,
    "desiredQuantity" INTEGER,
    "reasonCode" "CompensationReasonCode" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCheckCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "permanentFailureAt" TIMESTAMP(3),

    CONSTRAINT "cart_reservation_compensations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cart_reservation_compensations_status_nextAttemptAt_idx" ON "cart_reservation_compensations"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "cart_reservation_compensations_cartId_productId_idx" ON "cart_reservation_compensations"("cartId", "productId");

-- AddForeignKey
ALTER TABLE "cart_reservation_compensations" ADD CONSTRAINT "cart_reservation_compensations_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_reservation_compensations" ADD CONSTRAINT "cart_reservation_compensations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Manually added (not Prisma-generated): partial unique index enforcing
-- at most one unresolved compensation row per (cartId, productId),
-- independent of operation. Deliberately NOT a Prisma-level @@unique -
-- that would be a global constraint and would incorrectly block a fresh
-- row once any historical RESOLVED/PERMANENT_FAILURE row exists for the
-- same pair. See CartReservationCompensation's schema comment.
CREATE UNIQUE INDEX "one_unresolved_compensation_per_cart_product"
ON "cart_reservation_compensations" ("cartId", "productId")
WHERE "status" IN ('PENDING', 'PROCESSING', 'BLOCKED');
