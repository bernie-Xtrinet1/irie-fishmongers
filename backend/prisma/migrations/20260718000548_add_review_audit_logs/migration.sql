-- CreateTable
CREATE TABLE "review_audit_logs" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_audit_logs_reviewId_idx" ON "review_audit_logs"("reviewId");

-- AddForeignKey
ALTER TABLE "review_audit_logs" ADD CONSTRAINT "review_audit_logs_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_audit_logs" ADD CONSTRAINT "review_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
