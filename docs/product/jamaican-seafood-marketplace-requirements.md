# Jamaican Seafood Marketplace — Operating Model Requirements

Status: **Approved requirements, Phase 16 not started**
Roadmap: `docs/roadmap.md` — Phase 16 (Jamaican Seafood Marketplace Operating
Model), sub-phases 16A–16F, gates Phase 17 (UAT and Production Readiness)

## Purpose

This is the requirements index for Phase 16. It restates the approved
requirement set (A–Q below), maps each requirement to the sub-phase that
delivers it, and points to the detailed operations/UX/domain/ADR documents
that specify how each is built. It does not itself specify implementation —
that lives in the linked documents.

## Why this phase exists, and why it precedes UAT

The platform, as it stands after Phase 15, is a transactional marketplace
(products, cart, orders, payments, delivery) with the trust and analytics
layers (Phases 13–15) built on top of it. It does not yet model how a
Jamaican seafood market actually operates day to day: vendors do not sell a
fixed catalog SKU — they sell whatever they landed or have in stock *today*,
in variable quantity, at a price they set that morning, until it sells out or
spoils. Customers do not shop a static product list — they check what is
available today, from which sellers, and either pick a specific vendor or let
the platform pick the best available one for them.

Phase 17 (UAT and Production Readiness) exists to validate that the platform
works as intended before production. If Phase 16 has not been built, UAT
would only validate the pre-marketplace transactional skeleton — not the
platform the business actually intends to operate. Phase 16 must be complete
before Phase 17 begins.

## Requirement-to-sub-phase map

| # | Requirement | Sub-phase | Primary design doc |
|---|---|---|---|
| A | Jamaican Seafood Master Catalogue | 16A | `docs/product/jamaican-seafood-marketplace-requirements.md` (this doc, §Catalogue) + ADR-005 |
| B | Standard seafood categories and names | 16A | ADR-005 |
| C | Vendor daily catch and stock listings | 16B | `docs/ux/vendor-daily-catch-listing.md` |
| D | Daily quantity, price, unit and expiry management | 16B | `docs/ux/vendor-daily-catch-listing.md` |
| E | Actual-catch photographs | 16B | `docs/ux/vendor-daily-catch-listing.md` |
| F | Customer Available Today marketplace | 16C | `docs/ux/customer-seafood-marketplace.md` |
| G | Best Available Vendor and Choose Your Seller | 16C | `docs/ux/customer-seafood-marketplace.md` |
| H | Weight, item, package and case purchasing | 16C, 16D | `docs/domain/seafood-inventory-weight-and-reservation-rules.md` |
| I | Preparation options and charges | 16B, 16C | `docs/ux/vendor-daily-catch-listing.md`, `docs/ux/customer-seafood-marketplace.md` |
| J | Soft inventory reservation | 16D | `docs/domain/seafood-inventory-weight-and-reservation-rules.md` |
| K | Multi-vendor allocation | 16D | `docs/domain/seafood-inventory-weight-and-reservation-rules.md` |
| L | Estimated-weight and final-weight adjustment | 16D | `docs/domain/seafood-inventory-weight-and-reservation-rules.md` |
| M | Platform-managed pickup | 16E | `docs/operations/platform-managed-pickup-policy.md` + ADR-006 |
| N | QR/PIN verified collection | 16E | `docs/operations/platform-managed-pickup-policy.md` + ADR-006 |
| O | Platform payment and settlement controls | 16E, 16F | `docs/operations/marketplace-operating-model.md` |
| P | Prevention of off-platform transaction leakage | 16F | `docs/operations/marketplace-operating-model.md` |
| Q | Seasonal and regulated-product controls | 16A, 16F | ADR-005, `docs/operations/marketplace-operating-model.md` |

## §Catalogue: Master Catalogue vs. Daily Listing (requirements A, B)

Two distinct concepts, both required, and easy to conflate:

- **Master Catalogue** (16A) — a platform-curated reference list of seafood
  species/products Jamaica's market recognizes: standardized category,
  common name, alternative/local Jamaican name(s), scientific name, reference
  image, typical selling unit(s), typical size/weight range, and regulatory
  metadata (`Species.regulatoryStatus`, `seasonalStartMonth/EndMonth`,
  `minimumSizeCm` already exist for this). It changes rarely — new species
  are rare events, not daily activity.
- **Vendor Daily Listing** (16B) — a specific vendor's *instance* of a
  catalogue entry, for *today*: quantity, price, unit, expiry, actual-catch
  photo, preparation options. It changes every day, sometimes hourly.

The existing `Species` model already carries most of the master-catalogue
regulatory fields. `Category` and `Product` already carry the general
commerce shape. What is missing, and what ADR-005 decides, is where the
catalogue-only fields (alternative/local names, reference image, typical
size/weight range) live relative to `Species`/`Category`, and how a vendor's
daily listing references the catalogue entry without duplicating its data.
See ADR-005 for the decision and rationale.

## Reuse posture (binding across all of Phase 16)

Per `.claude/CLAUDE.md`'s "never duplicate business logic" and "never create
placeholder services" rules, and the roadmap's own instruction: **do not
create a duplicate listing, catalogue, reservation, or allocation domain
without first proving the existing chain cannot support the requirement.**
The existing surface each sub-phase must extend, not replace:

- Catalogue/regulatory: `Species`, `Category`, `Product`
- Catch provenance: `Catch`, `CatchItem`, `SeafoodLot` (already carry
  catch/landing/species/vessel/traceability data per the food-safety rules)
- Inventory/reservation: the Redis-backed soft-hold reservation system
  already gating `POST /cart/items` (see
  `docs/domain/seafood-inventory-weight-and-reservation-rules.md`)
- Vendor selection/allocation: `MarketplaceModeConfig`, the vendor-scoring
  engine, `FulfillmentDecision`/`VendorScore`/`VendorAssignment` (the
  existing "Marketplace Selection Engine" / Best Available Vendor flow)
- Delivery: the existing Delivery Engine and driver pickup workflow — Phase
  16E's *customer* platform-managed pickup is a distinct concept and must
  not be merged into or confused with driver pickup (see
  `docs/operations/platform-managed-pickup-policy.md`)

## Compliance posture

Every Phase 16 deliverable is subject to the existing compliance documents
without exception — this phase does not get a carve-out:
`.claude/rules/seafood-compliance-rules.md`, `.claude/rules/food-safety.md`,
`.claude/rules/cold-chain-management.md`, `.claude/rules/business-rules1.md`,
`.claude/rules/business-rules2.md`,
`.claude/rules/multi-vendor fulfillment rules.md`, and
`.claude/rules/location-based multi-vendor fulfillment rules.md`. Where a
Phase 16 document restates a rule from one of these, that document is
illustrative; the compliance document is authoritative.

## Sub-phases

See `docs/roadmap.md` Phase 16 for the authoritative sub-phase list
(16A–16F) and dependency notes. Detailed specifications:

- **16A — Catalogue and Regulatory Foundation**: ADR-005.
- **16B — Vendor Daily Catch and Stock Listings**: `docs/ux/vendor-daily-catch-listing.md`.
- **16C — Customer Available-Today Marketplace**: `docs/ux/customer-seafood-marketplace.md`.
- **16D — Weight, Reservation and Order Adjustment**: `docs/domain/seafood-inventory-weight-and-reservation-rules.md`.
- **16E — Platform-Managed Pickup and Collection**: `docs/operations/platform-managed-pickup-policy.md`, ADR-006.
- **16F — Marketplace Protection and Operational Controls**: `docs/operations/marketplace-operating-model.md`.

## Acceptance for Phase 16 as a whole

Phase 16 is complete when all six sub-phases meet their own acceptance
criteria (recorded in their linked documents) AND the end-to-end workflow
validated in `docs/testing/marketplace-fulfilment-acceptance-plan.md` passes:
catalogue → daily listing → available-today marketplace → customer selection
→ reservation → payment → vendor acceptance → preparation → delivery or
platform-managed pickup → QR/PIN or proof of delivery → settlement →
reporting. That same chain is what Phase 17 (UAT) then validates with
realistic data and a human operator.
