-- CreateEnum
CREATE TYPE "SLABreachType" AS ENUM ('OVERDUE_IN_TRANSIT', 'LATE_DELIVERY');

-- CreateTable
CREATE TABLE "sla_breaches" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "type" "SLABreachType" NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "minutesLate" INTEGER NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "sla_breaches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sla_breaches_deliveryId_idx" ON "sla_breaches"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "sla_breaches_deliveryId_type_key" ON "sla_breaches"("deliveryId", "type");

-- AddForeignKey
ALTER TABLE "sla_breaches" ADD CONSTRAINT "sla_breaches_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_breaches" ADD CONSTRAINT "sla_breaches_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
