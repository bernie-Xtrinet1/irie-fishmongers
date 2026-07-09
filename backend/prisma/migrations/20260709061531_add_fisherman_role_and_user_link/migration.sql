-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'FISHERMAN';

-- AlterTable
ALTER TABLE "fishermen" ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "fishermen_userId_key" ON "fishermen"("userId");

-- AddForeignKey
ALTER TABLE "fishermen" ADD CONSTRAINT "fishermen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

