-- AlterTable
ALTER TABLE "products" ADD COLUMN     "weightLbs" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "dispatch_decision_logs" (
    "id" TEXT NOT NULL,
    "deliveryRunId" TEXT NOT NULL,
    "requiresColdChain" BOOLEAN NOT NULL,
    "totalWeightLbs" DECIMAL(10,2) NOT NULL,
    "candidateDrivers" JSONB NOT NULL,
    "candidateAssets" JSONB NOT NULL,
    "selectedDriverId" TEXT,
    "selectedAssetId" TEXT,
    "reason" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_decision_logs_deliveryRunId_idx" ON "dispatch_decision_logs"("deliveryRunId");

-- AddForeignKey
ALTER TABLE "dispatch_decision_logs" ADD CONSTRAINT "dispatch_decision_logs_deliveryRunId_fkey" FOREIGN KEY ("deliveryRunId") REFERENCES "delivery_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
