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

**Key principle for C4.3 (stated explicitly at C4.2 approval time,
carried forward as the central design constraint):** recovery must
converge the cart-scoped mirror to the *current* durable
`Cart`/`CartItem` state. It must never replay the `operation` or
`desiredQuantity` stored on the compensation row as a literal command -
those fields are C4.2's latest-wins *diagnostic snapshot* of what was
observed at arrival time, not a queued instruction to execute.

**Do not implement C4.3 yet** without first restating the contract. The
first review must focus on these five areas, in this order:

1. **The desired-state read boundary** - exactly how and where the
   reconciler reads current `Cart`/`CartItem` truth, and how that read is
   kept separate from (never substitutes for) the compensation row's own
   diagnostic fields.
2. **Generation-safe claim/resolve behavior** - how the reconciler claims
   a row (`claimForRecoveryAttempt`), carries the claimed `generation`
   through its recovery attempt, and how `resolveIfGenerationMatches`/
   `markPermanentFailureIfGenerationMatches` protect against a newer
   divergence arriving mid-repair (a generation-race test is required:
   the row's `generation` changes between claim and resolve).
3. **`BLOCKED` handling** - how a precondition check (product suspect
   state, `DRAINING` mode) maps to
   `rescheduleBlockedCheckIfGenerationMatches`/
   `unblockIfGenerationMatches` vs. proceeding to an actual recovery
   attempt.
4. **Mode-dependent recovery policy** - what the reconciler does per
   `ReservationEngineMode` (recovery only has meaning under `MIRROR`;
   confirm explicitly what happens if the row is claimed while the mode
   has since moved to `CART_SCOPED` or `DRAINING`).
5. **How `CartRepository.findItemByCartAndProduct` should be introduced
   without pulling `CartService` into the reconciler** - this must read
   `CartItem` directly through a narrow repository method, not through
   `CartService`, to avoid coupling the reconciler to `CartService`'s
   own (still-open, ADR-007 decision 1) write-order semantics.

Also review before planning:

- `CompensationService.recordMirrorDivergence` and
  `CompensationRepository`'s full primitive set (all generation/status
  guards, the claim/resolve/permanent-failure/blocked-transition
  semantics).
- C3's `ReservationGateway`/`MirrorDiagnostic` (what the reconciler will
  need to call to actually retry the mirror write, and what diagnostic
  shape it will receive back).

Then plan (do not implement without approval):

1. The five focus areas above, made concrete as an implementation
   contract.
2. How success maps to `resolveIfGenerationMatches` and failure maps to
   either a scheduled retry (`requeueAfterAttempt`) or
   `markPermanentFailureIfGenerationMatches`, and what threshold governs
   that choice.
3. Idempotency/backoff policy for repeated attempts.
4. Whether this unit calls `ReservationGateway` directly or through some
   narrower seam, and how that interacts with the still-open
   Redis-first-vs-Postgres-first `CartService` write-order question
   (ADR-007 open decision 1) - the compensation decorator itself stays
   out of scope regardless (see prohibitions below).
5. Service/result types and required tests.

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
