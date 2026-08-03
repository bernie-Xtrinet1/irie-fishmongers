# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `docs/architecture/reservation-lifecycle.md`
- `.claude/current-task.md`
- `.claude/next-session.md` (this file)
- `.claude/decisions.md`
- `.claude/worklog.md`

## Confirm before doing anything else

- Branch is `develop`.
- Working tree is clean.
- Local `develop` and `origin/develop` are synchronized (0 ahead / 0
  behind).
- Commit Unit 1 (`57c73b4`), Unit 2.1 (`c757bdd`), Unit 2.2 (`393c970`),
  and Unit 2.3 (`a27cb65`) are all present on `origin/develop`.

## The next session must begin with repository confirmation, then Unit 2.4 planning only

Unit 2.4 scope:

- Whole-cart `checkoutMark`
- `checkoutRevert`
- `extendCheckoutLease`
- `finalizeCheckoutConsumption`
- Redis pending-state reconciliation primitives
- Real-Redis atomicity and recovery tests

Per `docs/architecture/reservation-lifecycle.md` §7-10 (already resolved
and approved - implement exactly what is specified there, or flag a
concrete conflict if the real code reveals one).

**The next session must inspect and produce a read-only implementation
plan before editing any source file** - the same discipline used for
Units 2.1-2.3.

**Explicitly excluded from Unit 2.4**:

- Wiring `CartService`
- Wiring `OrdersService`
- Payment behavior
- Controllers and DTOs
- Frontend
- Prisma changes
- The scheduled recovery service (the cron caller for
  `reconcileExpiredCheckoutPending`/`reconcileProductReservedTotal` -
  still deferred, per the architecture document)
- Production cutover
- The legacy Redis drain

## Do NOT do

- Do not begin any Unit 2.4 source-code edit before a plan is presented
  and explicitly approved.
- Do not say Unit 2.4 implementation has begun until the corresponding
  files have actually been edited.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s content
  into session files - reference it, don't restate it.
- Do not treat the cart-scoped reservation engine (Units 2.1-2.3) as
  partially wired - it is fully additive and untouched by any production
  caller; do not assume otherwise or begin a cutover without a separate,
  explicit approval.
