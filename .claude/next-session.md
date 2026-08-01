# Next Session

## Entry point

**ADR-005 is Accepted**, committed as `d22afe4` (`docs(architecture): accept
catalogue and daily listing design`) on top of the earlier roadmap-
resequencing commits (`e2ba223`, `e60a743`, `516d207`). No Prisma schema,
migration, or application code has been written for any part of Phase 16 -
this entire arc has been design documentation only. See
`.claude/decisions.md` for the corrected final-architecture summary and
`.claude/worklog.md` for the full round-by-round correction history.

## Next session must begin with

**Phase 16A.0 - Cart Price Integrity - planning and gap analysis only.**

Per ADR-005's "Migration stages" table, this is the *first* roadmap unit -
before 16A.1 (Catalogue Foundation) - because it fixes an already-live
defect (`cart.service.ts` reads `item.product.price` live at cart-read time
today, with no lock at all) and is designed to ship independently of the
catalogue/listing work that follows it.

1. Gap analysis: current `CartItem`/`cart.service.ts` behavior vs. ADR-005's
   "Pricing authority" and "Existing cart migration" sections -
   `lockedUnitPrice`, `lockedCurrency`, `priceLockedAt`, the explicit
   `PRICE_RECONFIRMATION_REQUIRED` flow for pre-existing cart rows (no
   silent backfill), checkout validation, and the reservation-TTL tie-in.
2. Present the analysis plus an implementation plan for approval.
3. **No code changes are authorized until that Phase 16A.0 implementation
   plan is reviewed and approved.**

## After the 16A.0 plan is approved

- Only then: the actual `CartItem` schema change, migration, service logic,
  and tests for 16A.0, per `.claude/CLAUDE.md`'s Database/API Rules.
- Phase 16A.1 (Catalogue Foundation) follows only after 16A.0 ships - do not
  start catalogue work first.
- Azure credentials are still pending (see prior memory:
  azure-production-target) - blocks only the [AZ]-tagged tasks in
  `docs/uat/phase-17-uat-production-readiness.md`, not Phase 16 work.
- Phase 17 (UAT) cannot meaningfully begin until Phase 16 passes
  `docs/testing/marketplace-fulfilment-acceptance-plan.md`'s scenarios.

## Do NOT do

- Do not write Prisma schema changes, migrations, or application code for
  Phase 16A.0 (or any Phase 16 unit) before its own implementation plan is
  presented and approved.
- Do not say ADR-005 is "awaiting approval," "not yet written," or "not yet
  committed" - it is Accepted and committed (`d22afe4`).
- Do not treat `.claude/roadmap.md` or `.claude/project-status.md` as
  authoritative - both are permanent short pointers to `docs/roadmap.md`.
- Do not re-open the resolved Codespaces items (proxy, env override, image
  pipeline) without a new concrete symptom report.
