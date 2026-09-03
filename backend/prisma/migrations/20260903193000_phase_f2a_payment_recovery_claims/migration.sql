ALTER TABLE "payments"
ADD COLUMN "recoveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "recoveryStartedAt" TIMESTAMP(3);
