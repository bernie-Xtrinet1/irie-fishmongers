-- CreateEnum
CREATE TYPE "CheckoutAttemptStatus" AS ENUM ('PROCESSING', 'COMMITTED', 'FAILED');

-- AlterTable
ALTER TABLE "cart_items" ADD COLUMN     "lockedCurrency" TEXT,
ADD COLUMN     "lockedUnitPrice" DECIMAL(10,2),
ADD COLUMN     "priceLockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "carts" ADD COLUMN     "currency" TEXT;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "currency" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "currency" TEXT;

-- CreateTable
CREATE TABLE "checkout_attempts" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "CheckoutAttemptStatus" NOT NULL DEFAULT 'PROCESSING',
    "orderId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_attempts_idempotencyKey_key" ON "checkout_attempts"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_attempts_orderId_key" ON "checkout_attempts"("orderId");

-- CreateIndex
CREATE INDEX "checkout_attempts_cartId_idx" ON "checkout_attempts"("cartId");

-- CreateIndex
CREATE INDEX "checkout_attempts_customerId_idx" ON "checkout_attempts"("customerId");

-- CreateIndex
CREATE INDEX "checkout_attempts_status_lastHeartbeatAt_idx" ON "checkout_attempts"("status", "lastHeartbeatAt");

-- AddForeignKey
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
