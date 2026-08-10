-- CreateEnum
CREATE TYPE "CompensationBlockReason" AS ENUM ('PRODUCT_SUSPECT', 'MODE_NOT_ADMITTING');

-- AlterTable
ALTER TABLE "cart_reservation_compensations" ADD COLUMN     "blockReason" "CompensationBlockReason";
