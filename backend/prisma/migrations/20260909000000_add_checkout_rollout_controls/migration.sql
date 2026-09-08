CREATE TYPE "CheckoutRolloutBehavior" AS ENUM ('LEGACY', 'CART_SCOPED', 'SHADOW', 'DENY');

CREATE TABLE "checkout_rollout_control_revisions" (
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "newAdmissionStopped" BOOLEAN NOT NULL,
    "behavior" "CheckoutRolloutBehavior" NOT NULL,
    "eligibleCohort" VARCHAR(64),
    "reason" VARCHAR(500) NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "checkout_rollout_control_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "checkout_rollout_control_positive_revision" CHECK ("revision" > 0),
    CONSTRAINT "checkout_rollout_control_cohort" CHECK ("eligibleCohort" IS NULL OR "eligibleCohort" ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
    CONSTRAINT "checkout_rollout_control_reason" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX "checkout_rollout_control_revisions_revision_key" ON "checkout_rollout_control_revisions"("revision");
ALTER TABLE "checkout_rollout_control_revisions" ADD CONSTRAINT "checkout_rollout_control_revisions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
