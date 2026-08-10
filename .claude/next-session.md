# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md`
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
- Commit history through `943c913` (C4.2), `4c139b4` (C4.3), plus this
  session's docs closeout, are all present on `origin/develop`.

## Phase 16A.0-C, Units C0-C3, C4.0, C4.1, C4.2, and C4.3 are complete

C0-C3: see prior entries in `.claude/current-task.md` -
`ReservationGateway`/`CheckoutReservationFacade` implemented, unwired.
C4.0: shared error-message sanitizer. C4.1: `CartReservationCompensation`
schema + `CompensationRepository`. C4.2: `CompensationService.recordMirrorDivergence`.
C4.3: `CompensationReconciliationService.attemptRecovery` +
`CompensationBlockedRecheckService.recheckBlocked` - single-row
desired-state recovery, generation-safe, mode-aware, with the separate
`CompensationBlockReason` schema. **Nothing outside C4.3's own tests
calls either service yet** - no batch orchestrator, no scheduler, no
caller wiring of any kind. See `.claude/current-task.md` for the full
delivery summary of every unit.

The Prisma migration-history incident (documented in ADR-007 §12) is now
**fully repaired**, not just root-caused - the 31x `prisma migrate
resolve --applied` maintenance action was executed and verified this
session. Do not repeat it. `migrate status` reports the database current;
a genuinely separate disposable-shadow drift check reports no
differences.

## The next session begins READ-ONLY: Phase 16A.0-C4.4 - compensation batch orchestration

**Do not implement C4.4 yet** without first restating the contract.
Begin by reviewing:

- `CompensationReconciliationService.attemptRecovery` and
  `CompensationBlockedRecheckService.recheckBlocked`'s exact current
  signatures and result types (`ReconcileOneResult`).
- `CompensationRepository`'s full primitive set, in particular
  `claimForRecoveryAttempt`'s exact `WHERE` clause (which rows it can
  claim) and the distinction between `PENDING`-due/stale-`PROCESSING`
  rows (claimable via `attemptRecovery`) and `BLOCKED` rows (only
  reachable via `recheckBlocked`, never through the claim path).
- The `CartReservationCompensation` schema's indexes
  (`[status, nextAttemptAt]`, `[cartId, productId]`) as the starting
  point for designing an efficient batch candidate query.

Then plan (do not implement without approval) the batch orchestrator that
repeatedly invokes the two single-row services:

1. **Batch candidate query** - how due `PENDING`/stale-`PROCESSING` rows
   and due `BLOCKED` rows are selected from Postgres.
2. **Bounded batch size** - an explicit, justified limit per orchestrator
   run.
3. **Deterministic ordering** - e.g. `nextAttemptAt` ascending, matching
   `findUnresolvedByCartAndProduct`'s existing `createdAt asc` precedent
   for reproducibility.
4. **Handling PENDING due rows** - route to `attemptRecovery`.
5. **Stale PROCESSING reclaim candidates** - also route to
   `attemptRecovery` (already folded into `claimForRecoveryAttempt`'s own
   query - confirm whether the batch query needs to select these
   explicitly or whether attempting every `PENDING`-shaped candidate
   query naturally also catches them).
6. **BLOCKED due recheck candidates** - route to `recheckBlocked`,
   selected separately since `claimForRecoveryAttempt` never matches
   `BLOCKED`.
7. **Single-row service delegation** - the orchestrator must not
   reimplement any recovery/recheck logic itself, only call the two
   existing services per candidate.
8. **Isolation between row failures** - one row's exception must not
   abort the batch; how errors are caught and reported per-row.
9. **Result aggregation** - what the orchestrator returns (counts per
   `ReconcileOneResult` outcome, or the full list, or both).
10. **Concurrency between multiple orchestrator runs** - what happens if
    two orchestrator invocations overlap (the underlying single-row
    services are already claim-safe via `claimForRecoveryAttempt`'s
    conditional update, but confirm whether the batch-selection query
    itself needs additional protection against double-selection).
11. **Whether a Postgres advisory lock is needed** - matching
    `ReservationEngineModeService.setMode`'s established
    `pg_advisory_xact_lock` precedent, or whether per-row claim safety
    already makes this unnecessary.
12. **Whether `SKIP LOCKED` is preferable** to an advisory lock for the
    batch-selection query specifically, given Postgres row-level locking
    semantics under concurrent orchestrator runs.
13. **Observability** - what gets logged per batch run (counts by
    outcome, duration, candidates considered).
14. **Scheduler boundary** - confirm explicitly that C4.4 defines the
    batch orchestration logic only; the actual periodic invocation
    mechanism is C4.5's scope, not this unit's.

## Explicitly prohibited this session

- `@Cron` or any scheduler wiring - C4.4 must NOT implement `@Cron`
  unless separately approved, even though it designs the batch logic
  that a future scheduler will eventually call.
- C4.5 (the scheduler itself).
- The compensation decorator (`CompensatingReservationGateway` or
  similar) - still deferred until the durable `CartService`/Postgres
  write-order boundary (ADR-007 open decision 1) is resolved.
- `ReservationGateway` composition beyond what C4.3's services already
  call.
- `CartService` integration.
- `ProductsService` integration.
- `OrdersService` integration.
- C5 idempotency.
- Production mode switching.
- Payment integration.

## Do NOT do

- Do not begin any C4.4 source-code edit before the contract above is
  restated and a plan is presented and explicitly approved, matching the
  discipline used through every prior unit in this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0-C3/C4.0-C4.3 as authorizing any caller wiring - they
  remain fully additive and unwired; do not assume otherwise or begin
  implementation without a separate, explicit approval.
- Do not repeat the migration-history repair - it is complete.

The session must return a read-only plan/contract restatement and wait
for approval before any implementation begins.
