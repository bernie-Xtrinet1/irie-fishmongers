-- Historical provenance is not proven. Preserve existing rows as unknown,
-- with no default/backfill that could silently authorize a checkout path.
CREATE TYPE "CheckoutPath" AS ENUM ('LEGACY', 'CART_SCOPED');
ALTER TABLE "checkout_attempts" ADD COLUMN "selectedPath" "CheckoutPath";
