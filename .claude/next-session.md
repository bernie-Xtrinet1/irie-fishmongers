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
  Unit 2.3 (`a27cb65`), Unit 2.4.1 (`4db6018`), Unit 2.4.2 (`8c68f3b`), and
  Unit 2.4.3 (`e907998`) are all present on `origin/develop`.

## The next session must begin with repository confirmation, then Unit 2.4.4 planning only

**UNIT 2.4.4 - DURABLE CHECKOUT-PENDING RECONCILIATION ORCHESTRATION**

Scope:

- Reuse of `getCheckoutPendingLeaseState` (Unit 2.4.2, unchanged).
- `reconcileExpiredCheckoutPending`.
- Durable `CheckoutAttempt` state as input: `PROCESSING` / `COMMITTED` /
  `FAILED` / not-found handling.
- Durable heartbeat freshness.
- The 600-second hard pending ceiling.
- Calling `checkoutRevert` (Unit 2.4.3) where appropriate.
- Calling `finalizeCheckoutConsumption` (Unit 2.4.3) where appropriate.
- Calling `extendCheckoutLease` (Unit 2.4.2) where appropriate.
- Unit tests.
- Real-Redis recovery and concurrency tests.

Per `docs/architecture/reservation-lifecycle.md` §10 (already resolved and
approved - implement exactly what is specified there, or flag a concrete
conflict if the real code reveals one).

**The next session must inspect and produce a read-only implementation
plan before editing any source file** - the same discipline used for every
prior unit.

**Explicitly excluded from Unit 2.4.4**:

- Scheduler implementation (the cron caller itself).
- Prisma query service implementation (reading `CheckoutAttempt` rows).
- Wiring `OrdersService`.
- Wiring `CartService`.
- Payment wiring.
- Controllers and DTOs.
- Frontend.
- Production cutover.
- The legacy Redis drain.
- Nest module registration.

## Do NOT do

- Do not begin any Unit 2.4.4 source-code edit before a plan is presented
  and explicitly approved.
- Do not say Unit 2.4.4 implementation has begun until the corresponding
  files have actually been edited.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s content
  into session files - reference it, don't restate it.
- Do not treat the checkout reservation engine (Units 2.4.1-2.4.3) or the
  cart-scoped reservation engine (Units 2.1-2.3) as partially wired - both
  are fully additive and untouched by any production caller; do not
  assume otherwise or begin a cutover without a separate, explicit
  approval.
