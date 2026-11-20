-- ============================================================================
-- WP4.3B.4F.7D.4B.3 — F-04 Allocation Granularity, Identity & Reversal Safety
-- Narrowly scoped additive migration on refund_vendor_order_allocations.
-- Preserves all existing allocation rows and enforces PostgreSQL CHECK guards.
-- ============================================================================

-- 1. Pre-flight data integrity validation before modifying allocation constraints
DO $$
DECLARE
  invalid_amount_count INTEGER;
  duplicate_group_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO invalid_amount_count
  FROM "refund_vendor_order_allocations"
  WHERE "amount" IS NULL OR "amount" <= 0;

  IF invalid_amount_count > 0 THEN
    RAISE EXCEPTION 'Migration pre-flight failed: found % existing allocation rows with non-positive or NULL amount', invalid_amount_count;
  END IF;

  SELECT COUNT(*) INTO duplicate_group_count
  FROM (
    SELECT "refundId", "vendorOrderId", "allocationType"
    FROM "refund_vendor_order_allocations"
    GROUP BY "refundId", "vendorOrderId", "allocationType"
    HAVING COUNT(*) > 1
  ) dup;

  IF duplicate_group_count > 0 THEN
    RAISE EXCEPTION 'Migration pre-flight failed: found % duplicate (refundId, vendorOrderId, allocationType) groups', duplicate_group_count;
  END IF;
END $$;

-- 2. Create entry kind enum
CREATE TYPE "RefundAllocationEntryKind" AS ENUM ('ALLOCATION', 'REVERSAL');

-- 3. Add Option B identity & reversal columns cleanly preserving existing rows
ALTER TABLE "refund_vendor_order_allocations"
  ADD COLUMN "orderItemId" TEXT,
  ADD COLUMN "componentKey" TEXT NOT NULL DEFAULT 'VO',
  ADD COLUMN "entryKind" "RefundAllocationEntryKind" NOT NULL DEFAULT 'ALLOCATION',
  ADD COLUMN "reversesAllocationId" TEXT;

-- 4. Create new unique identity & reversal indexes BEFORE dropping the prior 3-column unique index
CREATE UNIQUE INDEX "refund_vendor_order_allocations_reversesAllocationId_key"
  ON "refund_vendor_order_allocations"("reversesAllocationId");

CREATE INDEX "refund_vendor_order_allocations_orderItemId_idx"
  ON "refund_vendor_order_allocations"("orderItemId");

CREATE UNIQUE INDEX "refund_vendor_order_allocations_refundId_vendorOrderId_allo_key"
  ON "refund_vendor_order_allocations"("refundId", "vendorOrderId", "allocationType", "componentKey");

-- 5. Safe constraint transition: drop legacy 3-column index only after 4-column index is live
DROP INDEX "refund_vendor_order_allocations_refundId_vendorOrderId_all_key";

-- 6. Foreign keys (ON DELETE RESTRICT preserving financial lineage)
ALTER TABLE "refund_vendor_order_allocations"
  ADD CONSTRAINT "refund_vendor_order_allocations_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_vendor_order_allocations"
  ADD CONSTRAINT "refund_vendor_order_allocations_reversesAllocationId_fkey"
  FOREIGN KEY ("reversesAllocationId") REFERENCES "refund_vendor_order_allocations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. PostgreSQL CHECK constraints enforcing F-04 entry polarity, disjoint namespaces, and item traceability
ALTER TABLE "refund_vendor_order_allocations"
  ADD CONSTRAINT "chk_alloc_component_nonempty"
  CHECK (length(trim("componentKey")) > 0);

ALTER TABLE "refund_vendor_order_allocations"
  ADD CONSTRAINT "chk_alloc_entry_sign"
  CHECK (
    (
      "entryKind" = 'ALLOCATION'
      AND "amount" > 0
      AND "reversesAllocationId" IS NULL
      AND "componentKey" NOT LIKE 'REV:%'
    )
    OR
    (
      "entryKind" = 'REVERSAL'
      AND "amount" < 0
      AND "reversesAllocationId" IS NOT NULL
      AND "reversesAllocationId" <> "id"
      AND "componentKey" = ('REV:' || "reversesAllocationId")
    )
  );

ALTER TABLE "refund_vendor_order_allocations"
  ADD CONSTRAINT "chk_alloc_item_key"
  CHECK (
    ("orderItemId" IS NULL AND "componentKey" NOT LIKE 'ITEM:%')
    OR ("orderItemId" IS NOT NULL AND "entryKind" = 'ALLOCATION' AND "componentKey" = ('ITEM:' || "orderItemId"))
    OR ("orderItemId" IS NOT NULL AND "entryKind" = 'REVERSAL' AND "componentKey" = ('REV:' || "reversesAllocationId"))
  );
