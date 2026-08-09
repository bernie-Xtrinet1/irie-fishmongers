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
- Commit history through `0e97a5c` (C4.1), `943c913` (C4.2), plus this
  session's docs closeout, are all present on `origin/develop`.

## Phase 16A.0-C, Units C0-C3, C4.0, C4.1, and C4.2 are complete

C0-C3: see prior entries in `.claude/current-task.md` -
`ReservationGateway`/`CheckoutReservationFacade` implemented, unwired.
C4.0: shared error-message sanitizer. C4.1: `CartReservationCompensation`
schema + `CompensationRepository` (11 primitive conditional-update
methods). C4.2: `CompensationService.recordMirrorDivergence` - runtime-
validated, sanitized, bounded-optimistic-retry divergence recording with
widened latest-wins arrival semantics (`operation`/`customerId`/
`desiredQuantity` included, not just `reasonCode`/`lastError`/
`nextAttemptAt`). **Nothing outside C4.2's own tests calls
`CompensationService` yet** - no reconciler, no decorator, no scheduler,
no `CartService`/`ProductsService`/`OrdersService` wiring. See
`.claude/current-task.md` for the full delivery summary of every unit.

The `_prisma_migrations` incident discovered during C4.2 validation has a
**confirmed, reproduced root cause** (documented in ADR-007 §12): a
`prisma migrate diff --shadow-database-url` call mistakenly pointed at
the same URL as its live target. The proposed 31x `prisma migrate resolve
--applied` repair remains a proposal only, deferred to a separate
maintenance task with its own approval - do not execute it as part of
any Phase 16A.0-C4 work.

## The next session begins READ-ONLY: Phase 16A.0-C4.3 - desired-state reconciler

**Do not implement C4.3 yet** without first restating the contract.
Begin by reviewing:

- `CompensationService.recordMirrorDivergence` and
  `CompensationRepository`'s full primitive set (all generation/status
  guards, the claim/resolve/permanent-failure/blocked-transition
  semantics).
- The `CartReservationCompensation` schema, in particular what
  `operation`/`customerId`/`desiredQuantity` mean as of C4.2's widened
  latest-wins arrival contract (they now always reflect the most
  recently observed divergence, not necessarily the divergence that
  originally created the row).
- C3's `ReservationGateway`/`MirrorDiagnostic` (what the reconciler will
  need to call to actually retry the mirror write, and what diagnostic
  shape it will receive back).
- Current `CartItem` as the source of desired-state truth (C4's original
  framing: recovery re-derives desired state, it never replays
  `operation` as a literal command).

Then plan (do not implement without approval):

1. How the reconciler claims a row (`claimForRecoveryAttempt`) and what
   it does with the claimed `generation`.
2. How it derives current desired state from `CartItem` rather than
   trusting the row's own `operation`/`customerId`/`desiredQuantity` as a
   command to replay.
3. How a precondition check (product suspect state, `DRAINING` mode)
   maps to `BLOCKED` (`rescheduleBlockedCheckIfGenerationMatches`) vs.
   proceeding.
4. How success maps to `resolveIfGenerationMatches` and failure maps to
   either a scheduled retry (`requeueAfterAttempt`) or
   `markPermanentFailureIfGenerationMatches`, and what threshold governs
   that choice.
5. Idempotency/backoff policy for repeated attempts.
6. Whether this unit calls `ReservationGateway` directly or through some
   narrower seam, and how that interacts with the still-open
   Redis-first-vs-Postgres-first `CartService` write-order question
   (ADR-007 open decision 1) - the compensation decorator itself stays
   out of scope regardless (see prohibitions below).
7. Service/result types and required tests (including a generation-race
   test: the row's generation changes between claim and resolve).

## Explicitly prohibited this session

- The batch orchestrator (C4.4).
- The scheduler (C4.5).
- The compensation decorator (`CompensatingReservationGateway` or
  similar) - still deferred until the durable `CartService`/Postgres
  write-order boundary (ADR-007 open decision 1) is resolved by a future
  caller-integration unit.
- `ReservationGateway` composition of any kind beyond what C4.3's own
  reconciler directly needs to call, if approved.
- `CartService` integration.
- C5 idempotency.
- Production caller cutover.
- Executing the deferred `prisma migrate resolve` migration-history
  repair - remains its own separate maintenance task.

## Do NOT do

- Do not begin any C4.3 source-code edit before the contract above is
  restated and a plan is presented and explicitly approved, matching the
  discipline used through every prior unit in this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0-C3/C4.0/C4.1/C4.2 as authorizing any caller wiring -
  they remain fully additive and unwired; do not assume otherwise or
  begin implementation without a separate, explicit approval.

The session must return a read-only plan/contract restatement and wait
for approval before any implementation begins.
