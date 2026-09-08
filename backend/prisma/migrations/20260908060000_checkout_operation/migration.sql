CREATE TABLE "checkout_operations" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "retryKeyHash" VARCHAR(64) NOT NULL,
    "operationKey" VARCHAR(36) NOT NULL,
    "selectedPath" "CheckoutPath",
    "priceLockFingerprint" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "checkout_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checkout_operations_operationKey_key" ON "checkout_operations"("operationKey");
CREATE UNIQUE INDEX "checkout_operations_customerId_retryKeyHash_key" ON "checkout_operations"("customerId", "retryKeyHash");
CREATE INDEX "checkout_operations_cartId_idx" ON "checkout_operations"("cartId");
ALTER TABLE "checkout_operations" ADD CONSTRAINT "checkout_operations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkout_operations" ADD CONSTRAINT "checkout_operations_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
