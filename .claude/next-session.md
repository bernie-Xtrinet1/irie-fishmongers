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
- Commit history through `7fddac0` (C3), `8e2daaf` (C4.0), `0e97a5c`
  (C4.1), plus this session's docs closeout, are all present on
  `origin/develop`.

## Phase 16A.0-C, Units C0-C3, C4.0, and C4.1 are complete

C0-C3: see prior entries in `.claude/current-task.md` -
`ReservationGateway`/`CheckoutReservationFacade` implemented, unwired.
C4.0: `CheckoutAttempt`'s failure-message sanitizer extracted to
`common/utils/sanitize-error-message.util.ts`, now the approved source
for compensation `lastError` too. C4.1:
`CartReservationCompensation` schema + `CompensationRepository` - 11
primitive conditional-update methods (generation-gated
resolve/permanent-failure/blocked-transitions, latest-wins arrival
semantics, stale-`PROCESSING` reclaim folded into the normal claim path,
`MAX_OPTIMISTIC_RETRIES = 3` defined at the repository level, partial
uniqueness enforced only via migration SQL). **Nothing calls
`CompensationRepository` yet** - no service, no reconciler, no decorator,
no scheduler. See `.claude/current-task.md` for the full delivery summary
of every unit.

## The next session begins READ-ONLY: Phase 16A.0-C4.2 - compensation service / divergence recording

**Do not implement C4.2 yet** without first restating the contract.
Begin by reviewing:

- `CompensationRepository` (all 11 primitives, their exact generation/
  status guards).
- The `CartReservationCompensation` schema.
- The final approved `recordDivergence` concurrency contract (bounded
  retry via `MAX_OPTIMISTIC_RETRIES`, re-scoping the conditional update
  to the still-unresolved-status guard after every `P2002`, never `WHERE
  id` alone).
- The shared sanitizer (`sanitizeErrorMessage`).
- C3's `MirrorDiagnostic` (the exact shape `recordMirrorDivergence` will
  consume).

Then plan/implement only:

1. `CompensationService`.
2. `recordMirrorDivergence`.
3. The bounded `recordDivergence` retry loop, using
   `MAX_OPTIMISTIC_RETRIES`.
4. Latest-wins diagnostics (`reasonCode`/`lastError`/`nextAttemptAt`
   overwritten unconditionally on arrival).
5. `BLOCKED` arrival-status behavior (`ACCOUNTING_UNDERFLOW` stays
   `BLOCKED`; any other reasonCode unblocks to `PENDING`).
6. The resolve-between-read-and-update race - handled correctly (see
   test requirement below).
7. Concurrent duplicate-arrival handling.
8. `CartRepository.findItemByCartAndProduct`, if still assigned to this
   unit.
9. Service/result types and tests.

## Explicitly prohibited this session

- The desired-state reconciler (C4.3).
- The batch orchestrator (C4.4).
- The scheduler (C4.5).
- The compensation decorator (`CompensatingReservationGateway` or
  similar) - deferred until the durable `CartService`/Postgres
  write-order boundary is resolved by a future caller-integration unit.
- `ReservationGateway` composition of any kind.
- `CartService` integration.
- C5 idempotency.
- Production caller cutover.

## Required test coverage for C4.2

- The resolve-between-read-and-update race: `create` -> `P2002` -> read
  the existing unresolved row -> the row resolves before the conditional
  update runs -> `recordDivergence` retries -> a new unresolved row is
  created -> the historical resolved row is untouched.
- Concurrent duplicate-arrival: two `recordDivergence` calls racing one
  unresolved row leave exactly one unresolved row, `generation` advances
  once per accepted arrival, latest-committed diagnostics win.
- Revisit the corruption-handling test now that `recordDivergence`
  exists: deliberately bypass the partial index inside a transaction that
  always rolls back (never committed), insert two unresolved rows for the
  same `(cartId, productId)`, run `recordDivergence`, and confirm it
  fails closed with a plain consistency error rather than reporting
  `CREATED`/`GENERATION_ADVANCED` - neither row is mutated, no third row
  is created. Confirm this technique with the user before implementing it
  (temporarily dropping a live index, even inside a rolled-back
  transaction, in a shared dev database warrants explicit sign-off).

## Do NOT do

- Do not begin any C4.2 source-code edit before the contract above is
  restated and a plan is presented and explicitly approved, matching the
  discipline used through every prior unit in this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0-C3/C4.0/C4.1 as authorizing any caller wiring - they
  remain fully additive and unwired; do not assume otherwise or begin
  implementation without a separate, explicit approval.

The session must return a read-only plan/contract restatement and wait
for approval before any implementation begins.
