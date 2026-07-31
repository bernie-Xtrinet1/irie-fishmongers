# Marketplace Fulfilment Acceptance Plan (Phase 16)

Status: **Design, Phase 16 not started**
Roadmap: `docs/roadmap.md` Phase 16 (overall acceptance, all sub-phases)

## Purpose

Phase 16's six sub-phases (16A–16F) each have their own acceptance criteria
in their own document. This plan is the **end-to-end chain** that proves
those sub-phases actually compose into one working marketplace, before
Phase 17 (UAT) repeats the same chain against realistic data with a human
operator. Passing this plan is Phase 16's own definition of "done"; passing
Phase 17 is the pre-production gate on top of that.

This is an engineering acceptance plan (automated + manual test-case
definitions for the build itself), not the business-facing UAT script
catalogue — `docs/uat/phase-17-uat-production-readiness.md` owns that.

## The chain under test

```
Catalogue (16A)
  → Vendor daily listing (16B)
  → Available-Today marketplace discovery (16C)
  → Customer selection: Best Available Vendor or Choose Your Seller (16C)
  → Reservation (16D)
  → Payment (existing payment module)
  → Vendor acceptance (existing order workflow)
  → Preparation, incl. weight/preparation-yield handling (16D)
  → Delivery (existing Delivery Engine) OR Platform-managed pickup (16E)
  → QR/PIN verified collection (16E) OR existing proof-of-delivery
  → Settlement (16E/16F — gated on confirmed handover)
  → Reporting (Phase 15 Analytics integration, 16F)
```

## Test scenarios

Each scenario below must pass as an integration/e2e test before Phase 16 is
considered complete. "Evidence" is what the test asserts on, not a manual
screenshot — this is engineering acceptance, automated where the existing
test suite conventions (`backend/test/*.e2e-spec.ts`,
`apps/*/**/*.test.tsx`) already support it.

| ID | Scenario | Evidence |
|---|---|---|
| MKT-01 | Single-vendor, exact-weight (item unit), delivery fulfillment, full chain | Order reaches DELIVERED; vendor settlement recorded; reporting reflects the sale |
| MKT-02 | Single-vendor, estimated-weight (pound unit) within tolerance, delivery | Final weight within band auto-adjusts payment; no customer confirmation prompt fires |
| MKT-03 | Single-vendor, estimated-weight, final weight OUTSIDE tolerance | Order pauses for customer confirmation before capture; confirms/declines both tested |
| MKT-04 | Single-vendor, platform-managed pickup, on-time collection | QR and PIN both independently verify handover; settlement blocked until handover, released after |
| MKT-05 | Single-vendor, platform-managed pickup, no-show after Ready-For-Pickup | No refund by default; inventory not returned to active stock; audit record retained |
| MKT-06 | Single-vendor, platform-managed pickup, vendor-fault failure (never actually prepared) | Refund path triggers; distinguishable from MKT-05 in the audit trail |
| MKT-07 | Multi-vendor allocation (Best Available Vendor), quantity split across ≥2 vendors, all delivery | Split disclosed to customer pre-confirmation; each vendor's portion settles independently |
| MKT-08 | Multi-vendor allocation, mixed fulfillment (one vendor delivery-only, one pickup-only) | Customer sees fulfillment-method disclosure before confirmation, not just quantity split |
| MKT-09 | Multi-vendor, consolidated collection point | One QR/PIN verifies all vendors' portions present before handover confirms |
| MKT-10 | Choose Your Seller, selected vendor's stock insufficient for requested quantity | Customer-visible partial-fulfillment/reduce-quantity prompt; no silent fallback to Best Available Vendor |
| MKT-11 | Listing expiry mid-checkout (reservation active when listing expires) | Existing reservation honored through its own TTL; no NEW reservation possible against the expired listing |
| MKT-12 | Reservation lazy-expiry (customer abandons checkout) | Reserved quantity returns to available within one TTL window; verified via existing `InventoryEvent: RESTOCKED` |
| MKT-13 | Regulated/seasonal item — listing attempt during a prohibited period | Listing creation blocked; audit log records actor, reason, timestamp |
| MKT-14 | Regulated/seasonal item — admin restricts mid-season after a listing/reservation already exists | Re-validation at reservation-confirmation blocks checkout; existing reservation does not silently complete |
| MKT-15 | Preparation option selected, yield-reducing (e.g. filleting) | Charged weight is final prepared weight, not raw catch weight; preparation fee itemized separately |
| MKT-16 | Overselling attempt (concurrent reservations exceeding available quantity) | Second reservation correctly rejected or queued per existing soft-hold concurrency behavior; no negative available-quantity state persists |
| MKT-17 | Off-platform-leakage signal (order created then both parties cancel immediately, repeated pattern) | Signal surfaces on the admin analytics dashboard (Phase 15 integration), not just a raw log line |
| MKT-18 | Dispute raised against a Phase 16 order (pickup weight discrepancy) | Routes through the existing dispute/refund workflow; no parallel dispute code path exercised |
| MKT-19 | "Repeat previous listing" then edit the new day's copy | Prior day's listing is unaffected by the edit (independent records verified) |
| MKT-20 | Catalogue search by common name, alternative/local name, and scientific name | All three resolve to the same catalogue entry in Available-Today discovery |

## Non-goals of this plan

This plan does not re-test the underlying systems Phase 16 reuses (payment
capture mechanics, the Delivery Engine's own driver-assignment logic, the
vendor-scoring engine's own ranking algorithm, the Redis reservation
primitive's own correctness) — those already have their own test suites
from the phases that built them. This plan tests that Phase 16's *new*
composition of those systems behaves correctly end to end.

## Relationship to Phase 17 (UAT)

Every scenario above should also appear, in business-readable form, as a
Phase 17 UAT test case (see
`docs/uat/phase-17-uat-production-readiness.md`, §17D). The two are not
duplicative: this plan is what proves the build is correct before UAT
begins; Phase 17 is a human operator, using the real UI, with realistic
seeded data, confirming the same behavior a non-technical stakeholder would
observe and sign off on.

## Acceptance

All twenty scenarios pass. Any scenario that cannot pass without a change
to an existing, already-shipped module (payment, delivery, vendor-scoring,
inventory-reservation) must be escalated as an architecture question before
Phase 16 is marked complete — per this phase's own reuse posture, a failing
scenario is more likely a modeling gap in the new Phase 16 code than a
defect in the reused system.
