-- CreateTable
CREATE TABLE "checkout_rollout_participants" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cohort" VARCHAR(64),
    "reason" VARCHAR(500) NOT NULL,
    "actorId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_rollout_participants_pkey" PRIMARY KEY ("id"),
    -- Domain checks are maintained here because Prisma does not represent CHECKs.
    CONSTRAINT "checkout_rollout_positive_revision" CHECK ("revision" > 0),
    CONSTRAINT "checkout_rollout_cohort_label" CHECK ("cohort" IS NULL OR "cohort" ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
    CONSTRAINT "checkout_rollout_reason_length" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500)
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_rollout_participants_customerId_revision_key" ON "checkout_rollout_participants"("customerId", "revision");

-- AddForeignKey
ALTER TABLE "checkout_rollout_participants" ADD CONSTRAINT "checkout_rollout_participants_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_rollout_participants" ADD CONSTRAINT "checkout_rollout_participants_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
