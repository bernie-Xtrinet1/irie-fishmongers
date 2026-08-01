# Current Task

Status: ADR-005 Accepted and committed (2026-07-31). No roadmap phase is
currently in progress; no Prisma schema, migration, or application code has
been written for Phase 16.

## What just finished

The Phase 16 roadmap resequencing (Phase 16 = Jamaican Seafood Marketplace
Operating Model, Phase 17 = UAT & Production Readiness, Phase 18 = AI
Marketplace) was committed and pushed - see the 2026-07-31 entries in
`.claude/worklog.md` (`e2ba223`, `e60a743`, `516d207`).

`ADR-005` (`docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-
listing.md`) then went through five rounds of design correction in this
session - catalogue composition, inventory-mode transition and aggregate
cache semantics, cart price integrity, provenance, regulatory enforcement
and its approval workflow, multi-vendor allocation, and customer aggregation
level were all revised and re-verified against the actual codebase across
those rounds. **ADR-005's status is now `Accepted`**, committed separately
as `d22afe4` (`docs(architecture): accept catalogue and daily listing
design`). `.claude/decisions.md` has been corrected to reflect this final
accepted shape rather than the first-round draft it previously summarized.

**No Prisma schema, migration, or application code has been written or
changed for any part of Phase 16.** This session's entire output was design
documentation: the marketplace requirement docs (`516d207`) and ADR-005's
five correction rounds culminating in acceptance (`d22afe4`).

## Blocking decision before next work

None. The architecture is accepted. The only remaining step before
implementation is the Phase 16A.0 gap analysis below.

## Next session must begin with

**Phase 16A.0 - Cart Price Integrity - planning and gap analysis only.**

This is the first roadmap unit (per ADR-005's "Migration stages"), not
16A.1 - it fixes an already-live pricing-trust defect and ships
independently of the catalogue/listing work that follows it.

1. Produce a gap analysis: what `CartItem`/`cart.service.ts` actually do
   today (confirmed this session: price is read live off `Product.price`
   at cart-read time, with no lock at all) vs. what ADR-005's "Pricing
   authority" and "Existing cart migration" sections require
   (`lockedUnitPrice`, `lockedCurrency`, `priceLockedAt`, the
   `PRICE_RECONFIRMATION_REQUIRED` flow for pre-existing cart rows, checkout
   validation, reservation-TTL tie-in).
2. Present that analysis plus an implementation plan for approval.
3. **No code changes are authorized until the Phase 16A.0 implementation
   plan is reviewed and approved** - do not edit the Prisma schema, create
   a migration, or write any application code before that happens.
