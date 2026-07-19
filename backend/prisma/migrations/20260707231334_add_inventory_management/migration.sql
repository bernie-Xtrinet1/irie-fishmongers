-- CreateEnum
CREATE TYPE "InventoryEventType" AS ENUM ('DECREMENTED', 'RESTOCKED', 'MANUAL_ADJUSTMENT');

-- CreateTable
CREATE TABLE "inventory_events" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "eventType" "InventoryEventType" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "vendorOrderId" TEXT,
    "triggeredById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_events_productId_idx" ON "inventory_events"("productId");

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
