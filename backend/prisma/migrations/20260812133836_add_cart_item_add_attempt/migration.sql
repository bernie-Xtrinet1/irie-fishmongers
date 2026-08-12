-- CreateEnum
CREATE TYPE "CartItemAddAttemptStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "cart_item_add_attempts" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "requestedQuantity" INTEGER NOT NULL,
    "status" "CartItemAddAttemptStatus" NOT NULL DEFAULT 'PROCESSING',
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "rejectionCode" TEXT,
    "rejectionMessage" TEXT,
    "resultCartItemId" TEXT,
    "resultQuantity" INTEGER,
    "resultMutationVersion" INTEGER,
    "resultGeneration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_item_add_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cart_item_add_attempts_createdAt_idx" ON "cart_item_add_attempts"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cart_item_add_attempts_customerId_idempotencyKey_key" ON "cart_item_add_attempts"("customerId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "cart_item_add_attempts" ADD CONSTRAINT "cart_item_add_attempts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item_add_attempts" ADD CONSTRAINT "cart_item_add_attempts_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item_add_attempts" ADD CONSTRAINT "cart_item_add_attempts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
