/*
  Warnings:

  - Added the required column `parish` to the `vendors` table without a default value. This is not possible if the table is not empty.
  - Added the required column `termsAcceptedAt` to the `vendors` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Parish" AS ENUM ('KINGSTON', 'ST_ANDREW', 'ST_CATHERINE', 'CLARENDON', 'MANCHESTER', 'ST_ELIZABETH', 'HANOVER', 'WESTMORELAND', 'ST_JAMES', 'TRELAWNY', 'ST_ANN', 'ST_MARY', 'PORTLAND', 'ST_THOMAS');

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "description" TEXT,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "parish" "Parish" NOT NULL,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3) NOT NULL;
