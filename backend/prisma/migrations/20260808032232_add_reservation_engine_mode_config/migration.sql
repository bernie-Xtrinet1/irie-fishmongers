-- CreateEnum
CREATE TYPE "ReservationEngineMode" AS ENUM ('LEGACY', 'MIRROR', 'CART_SCOPED', 'DRAINING');

-- CreateTable
CREATE TABLE "reservation_engine_mode_configs" (
    "id" TEXT NOT NULL,
    "mode" "ReservationEngineMode" NOT NULL DEFAULT 'LEGACY',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_engine_mode_configs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "reservation_engine_mode_configs" ADD CONSTRAINT "reservation_engine_mode_configs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
