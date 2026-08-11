-- CreateEnum
CREATE TYPE "CartReservationSyncStatus" AS ENUM ('PENDING', 'PROCESSING');

-- AlterTable
ALTER TABLE "cart_items" ADD COLUMN     "mutationVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "cart_reservation_sync_states" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expectedMutationVersion" INTEGER NOT NULL,
    "expectedQuantity" INTEGER,
    "status" "CartReservationSyncStatus" NOT NULL DEFAULT 'PENDING',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_reservation_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cart_reservation_sync_states_cartId_productId_key" ON "cart_reservation_sync_states"("cartId", "productId");

-- AddForeignKey
ALTER TABLE "cart_reservation_sync_states" ADD CONSTRAINT "cart_reservation_sync_states_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_reservation_sync_states" ADD CONSTRAINT "cart_reservation_sync_states_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
