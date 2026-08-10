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
- Commit history through `4c139b4` (C4.3), `318adf1` (C4.4), `14914fc`
  (C4.5), plus this session's docs closeout, are all present on
  `origin/develop`.

## Phase 16A.0-C, Units C0-C4.5 are complete

C0-C3: `ReservationGateway`/`CheckoutReservationFacade` implemented,
unwired. C4.0-C4.3: shared sanitizer, `CartReservationCompensation`
schema + repository, `CompensationService.recordMirrorDivergence`,
`CompensationReconciliationService`/`CompensationBlockedRecheckService`
(single-row desired-state recovery). C4.4:
`CompensationBatchService.runBatch` - batch orchestration over the C4.3
single-row services, sequential processing, no locking, real-Postgres-
proven concurrency safety. C4.5: `CompensationSchedulerService` -
`@Cron(EVERY_MINUTE)` wrapper over `runBatch`, in-process
efficiency-only overlap guard, mode-independent, no startup catch-up or
custom shutdown handling. `MirrorCompensationModule` is now imported by
`AppModule` - the compensation provider graph is reachable in
production for the first time - but this is explicitly **not** caller
cutover: no `CartService`/`ProductsService`/`OrdersService`/
`ReservationGateway`/`CheckoutReservationFacade` code changed, and
`setMode()` is never called anywhere in this subsystem. See
`.claude/current-task.md` for the full delivery summary of every unit.

Two real engineering findings from C4.4, both diagnosed and permanently
resolved (see ADR-007 §14 and `.claude/decisions.md`): a PostgreSQL
`timestamp`/`timestamptz` binding bug in raw SQL date parameters
(fixed, regression-tested), and a Redis integration-test DB-index
collision between concurrently-running spec files (fixed via a
dedicated index for the new suite, test infrastructure only).

## IMPORTANT - naming discrepancy: "C5" vs. ADR-007's "Phase D"

Every prior session in this phase informally referred to the next unit
as "C5 idempotency" in its own prohibition lists. That label does not
exist in any authoritative document. Direct verification this session:

- **ADR-007's own "Implementation sequence (approved order)" table**
  names the phase after Phase C (C0-C4.5, now fully complete) as
  **Phase D**: `CheckoutCoordinatorService`, `CheckoutAttempt` lifecycle
  wiring, `checkoutMark` integration - blocked on Phase A + Phase C,
  both now satisfied.
- **`docs/roadmap.md`** was grepped directly for "C5", "16A.0-C",
  "Phase D", and "idempoten" - **zero matches for any of them.** It is
  not the source of either label.
- Phase F in ADR-007 ("Scheduler, heartbeat recovery, Postgres advisory
  lock") refers to a **different** scheduler entirely - the one for
  `CheckoutPendingReconciliationService`'s stale-checkout-attempt
  heartbeat (Unit 2.4.4) - **not** the compensation batch scheduler
  just shipped in C4.5. Do not conflate the two when reading ADR-007's
  sequence table.

**Before beginning any implementation work, the next session must
explicitly confirm with the user which label/scope is intended** -
ADR-007's own "Phase D" (`CheckoutCoordinatorService`/`CheckoutAttempt`
lifecycle/`checkoutMark`), or something else the user separately
clarifies. Do not silently adopt "C5" as if it were settled, and do not
silently substitute "Phase D" without surfacing this finding first -
this file records the finding; the session itself must still get
explicit confirmation before scoping work.

## The next session begins READ-ONLY

Whichever label is confirmed, the review scope the prior session
specified (substance preserved here regardless of naming) is:

1. ADR-007's remaining Phase D / caller-cutover decisions in full.
2. `CartService`'s current `addItem`/`update`/`remove` mutation flow.
3. The current `ReservationGateway` interface (C3).
4. `CheckoutReservationFacade`'s current shape.
5. How `CompensationService`/C3/C4 interact today.
6. `CheckoutAttempt`'s idempotency model (Phase 16A.0-A).
7. Existing HTTP/API idempotency conventions elsewhere in this codebase,
   if any.
8. Whether an `operationId`/`idempotencyKey` belongs at the API/DTO
   layer, `CartService`, `ReservationGateway`, or the durable
   compensation-correlation layer - this is an open design question, not
   pre-decided.
9. Retry semantics for duplicate requests.
10. Redis-first vs. Postgres-first write sequencing (ADR-007 open
    decision 1 - still unresolved; the compensation decorator remains
    deferred until this is resolved, per the C4.2 decisions).
11. Rollback/compensation behavior at the caller-integration boundary.
12. The `MIRROR`/`CART_SCOPED` cutover path.
13. Feature/mode gating for any new caller wiring.
14. Observability needs for caller-level idempotency.
15. Migration/API compatibility impact of any caller-facing change.

## Explicitly prohibited this session

- No caller cutover (`CartService`/`ProductsService`/`OrdersService`
  integration) until this read-only review is presented and explicitly
  approved.
- No payment integration unless separately planned in its own session.
- No production `ReservationEngineMode` change (i.e. actually
  transitioning the live mode config).
- No unrelated frontend work.
- No removing legacy reservation paths prematurely.
- No implementation of any kind before the naming discrepancy above is
  raised with the user and the actual next-phase scope is confirmed.

## Do NOT do

- Do not begin any source-code edit before the naming question is
  resolved and a read-only plan/contract is presented and explicitly
  approved, matching the discipline used through every prior unit in
  this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0-C4.5 as authorizing any caller wiring beyond what was
  explicitly scoped and shipped (the C4.5 scheduler's own `AppModule`
  registration) - `CartService`/`ProductsService`/`OrdersService` remain
  untouched until a separate, explicit approval.

The session must return a read-only plan/contract restatement -
including explicit confirmation of the correct phase label - and wait
for approval before any implementation begins.
