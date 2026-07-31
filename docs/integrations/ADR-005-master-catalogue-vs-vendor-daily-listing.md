# ADR-005 Master Catalogue versus Vendor Daily Listing

Status:
Proposed

Date:
2026-07-31

---

## Context

Phase 16 (Jamaican Seafood Marketplace Operating Model) requires two
distinct concepts that are easy to conflate:

- A **master catalogue** of Jamaican seafood species/products: standardized
  category, common name, alternative/local Jamaican name(s), scientific
  name, reference image, typical selling unit(s), typical size/weight
  range, and regulatory/seasonal metadata. This changes rarely.
- A vendor's **daily listing**: today's quantity, price, expiry, an
  actual-catch photograph, and preparation options for a specific catalogue
  item, published by a specific vendor. This changes daily, sometimes
  hourly.

The existing schema already has real estate for parts of both concepts:

- `Species` (`backend/prisma/schema.prisma`) already carries
  `scientificName`, `commercialName`, `regulatoryStatus`,
  `seasonalStartMonth`/`seasonalEndMonth`, `minimumSizeCm` — closely
  matching the master-catalogue's regulatory/seasonal fields.
- `Category` is a bare `name`/`slug` — generic commerce categorization, not
  seafood-specific.
- `Product` is the existing sellable-unit shape: `vendorId`, `categoryId`,
  `lotId`, `name`, `description`, `unit`, `price`, `currency`,
  `quantityAvailable`, `imageUrl`, `isActive`, `availability`.
- `Catch` → `CatchItem` → `SeafoodLot` already model a specific traceable
  catch, with `CatchItem` and `SeafoodLot` both relating to `Species`.

No model today carries alternative/local Jamaican names, a catalogue
reference image distinct from a listing's actual-catch photo, or a typical
size/weight range as *catalogue* metadata (as opposed to a specific catch's
measured weight). Building Phase 16 without deciding where these live risks
either duplicating catalogue data onto every vendor's listing (breaking
"standardized categories and names," requirement B) or overloading
`Species` with listing-instance data it should not own.

## Options considered

**Option 1 — Extend `Species` with catalogue-only fields, `Product`
remains the daily listing, unchanged relationship.** Add
`alternativeNames String[]`, `referenceImageUrl String?`, and a typical
size/weight range to `Species`. A vendor's daily listing is a `Product` row
with `categoryId` pointing at a `Category` derived from/aligned to the
`Species`, and a new required `speciesId` foreign key added to `Product`
linking it to its catalogue entry (nullable today for non-seafood-typed
products if any exist, required for Phase 16 seafood listings).

*Pro*: no new top-level model; `Species` already exists and already owns
regulatory/seasonal fields, so catalogue metadata consolidates in one
place. `Product` already owns everything a daily listing needs
(price/unit/quantity/image/vendor). Directly satisfies "reuse existing
Species/Category/Product models" from the Phase 16 requirement.
*Con*: `Species` was originally scoped for catch/lot traceability, not
customer-facing catalogue browsing; broadening its purpose needs a
migration and a review of every existing `Species` consumer
(`CatchItem`, `SeafoodLot`) to confirm no assumption breaks.

**Option 2 — New `SeafoodCatalogueEntry` model, decoupled from `Species`.**
A new top-level model purely for customer-facing catalogue browsing;
`Species` remains catch/compliance-only.

*Pro*: no risk of disturbing `Species`'s existing consumers.
*Con*: duplicates `scientificName`/`commercialName`/regulatory fields that
already exist on `Species`, creating two sources of truth for the same
species' regulatory status — directly conflicts with `.claude/CLAUDE.md`'s
"never duplicate business logic" rule and the seafood-compliance
requirement that regulatory enforcement have one authoritative source.

**Option 3 — Everything on `Product`, no catalogue/listing separation.**
Vendors free-type product names as today; no master catalogue.

*Pro*: no schema change at all.
*Con*: fails requirement B (standardized categories and names) outright —
this is the status quo the Phase 16 requirement exists specifically to fix.

## Decision

**Option 1.** Extend `Species` with the catalogue-only fields it is
currently missing, and add a required `speciesId` reference from `Product`
to `Species` for any Phase 16 seafood listing. `Category` continues to
serve general commerce categorization (unchanged); `Species` becomes the
single source of truth for seafood-specific catalogue and regulatory
metadata; `Product` remains the vendor's daily listing, now anchored to a
catalogue entry instead of a free-typed name.

Concretely:

- `Species.alternativeNames` — array of local/Jamaican common names, so
  search (per `docs/ux/customer-seafood-marketplace.md`) resolves any of
  common name, alternative name(s), or scientific name to the same entry.
- `Species.referenceImageUrl` — the catalogue illustration, distinct from
  and never substituted for a listing's actual-catch photo
  (`Product.imageUrl` remains the listing's own photo).
- `Species.typicalWeightRangeMin`/`typicalWeightRangeMax` (or an equivalent
  structured range) — catalogue-level expectation, distinct from a specific
  `SeafoodLot`'s measured weight.
- `Product.speciesId` (new foreign key) — required when the listing
  represents a Phase 16 seafood daily listing; existing non-seafood or
  legacy products remain valid with it nullable, avoiding a disruptive
  backfill requirement.

This does not change `Catch`/`CatchItem`/`SeafoodLot`'s existing
relationships to `Species` — they continue to model a specific traceable
catch instance, unaffected by `Species` gaining catalogue-browsing fields.

## Consequences

Positive

- One authoritative source for a species' regulatory/seasonal status —
  `Species.regulatoryStatus`/`seasonalStartMonth`/`seasonalEndMonth` — used
  identically by catch registration (existing), daily listing enforcement
  (16B/16F, new), and customer search (16C, new).
- No duplicate catalogue model to keep in sync with `Species`.
- A vendor's daily listing (`Product`) stays the same shape it already is
  — this is additive (one new FK, nullable outside Phase 16 use), not a
  breaking rework of the existing `Product` consumers (cart, orders,
  inventory reservation all continue to operate on `Product` unchanged).

Negative

- `Species` takes on a second responsibility (catch-traceability metadata
  + customer-catalogue metadata). This is judged acceptable because the
  data itself — the species' identity and regulatory status — is genuinely
  one thing, not two; the risk is purely organizational (a future engineer
  must understand `Species` serves both purposes), not a data-integrity
  risk.
- Existing `Species` rows will need `alternativeNames`/
  `referenceImageUrl`/typical-weight-range backfilled before Phase 16C
  (customer search/discovery) can rely on them — a data-population task,
  not a schema risk, tracked under Phase 16A's acceptance criteria.

## Implementation directive

Claude shall:

- Extend `Species`, not create a parallel catalogue model.
- Add `Product.speciesId` as the anchor between a daily listing and its
  catalogue entry; keep it nullable for non-Phase-17 products.
- Treat `Species.referenceImageUrl` and `Product.imageUrl` as permanently
  distinct fields, never collapsed into one — `docs/ux/customer-seafood-
  marketplace.md` depends on this distinction being real, not cosmetic.
- Include a Prisma migration and DTO validation for every new field, per
  `.claude/CLAUDE.md`'s Database Rules — no schema change without a
  migration.

This ADR takes precedence over an ad hoc catalogue design invented during
Phase 16 implementation without revisiting this decision.
