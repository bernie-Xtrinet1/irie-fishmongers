-- CreateTable
CREATE TABLE "marketplace_mode_configs" (
    "id" TEXT NOT NULL,
    "customerSelectedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "bestAvailableEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_mode_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_selection_weight_configs" (
    "id" TEXT NOT NULL,
    "inventoryWeight" DECIMAL(5,4) NOT NULL,
    "freshnessWeight" DECIMAL(5,4) NOT NULL,
    "complianceWeight" DECIMAL(5,4) NOT NULL,
    "distanceWeight" DECIMAL(5,4) NOT NULL,
    "ratingWeight" DECIMAL(5,4) NOT NULL,
    "deliveryCapacityWeight" DECIMAL(5,4) NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_selection_weight_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_decisions" (
    "id" TEXT NOT NULL,
    "requestedProductId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "deliveryParish" "Parish" NOT NULL,
    "customerId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfillment_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_scores" (
    "id" TEXT NOT NULL,
    "fulfillmentDecisionId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "inventoryScore" DECIMAL(5,2) NOT NULL,
    "freshnessScore" DECIMAL(5,2) NOT NULL,
    "complianceScore" DECIMAL(5,2) NOT NULL,
    "distanceScore" DECIMAL(5,2) NOT NULL,
    "ratingScore" DECIMAL(5,2) NOT NULL,
    "deliveryCapacityScore" DECIMAL(5,2) NOT NULL,
    "totalScore" DECIMAL(5,2) NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "ineligibilityReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_assignments" (
    "id" TEXT NOT NULL,
    "fulfillmentDecisionId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fulfillment_decisions_requestedProductId_idx" ON "fulfillment_decisions"("requestedProductId");

-- CreateIndex
CREATE INDEX "fulfillment_decisions_customerId_idx" ON "fulfillment_decisions"("customerId");

-- CreateIndex
CREATE INDEX "vendor_scores_fulfillmentDecisionId_idx" ON "vendor_scores"("fulfillmentDecisionId");

-- CreateIndex
CREATE INDEX "vendor_scores_vendorId_idx" ON "vendor_scores"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_assignments_fulfillmentDecisionId_key" ON "vendor_assignments"("fulfillmentDecisionId");

-- CreateIndex
CREATE INDEX "vendor_assignments_vendorId_idx" ON "vendor_assignments"("vendorId");

-- AddForeignKey
ALTER TABLE "marketplace_mode_configs" ADD CONSTRAINT "marketplace_mode_configs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_selection_weight_configs" ADD CONSTRAINT "vendor_selection_weight_configs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_decisions" ADD CONSTRAINT "fulfillment_decisions_requestedProductId_fkey" FOREIGN KEY ("requestedProductId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_decisions" ADD CONSTRAINT "fulfillment_decisions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_scores" ADD CONSTRAINT "vendor_scores_fulfillmentDecisionId_fkey" FOREIGN KEY ("fulfillmentDecisionId") REFERENCES "fulfillment_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_scores" ADD CONSTRAINT "vendor_scores_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_scores" ADD CONSTRAINT "vendor_scores_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_assignments" ADD CONSTRAINT "vendor_assignments_fulfillmentDecisionId_fkey" FOREIGN KEY ("fulfillmentDecisionId") REFERENCES "fulfillment_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_assignments" ADD CONSTRAINT "vendor_assignments_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_assignments" ADD CONSTRAINT "vendor_assignments_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
