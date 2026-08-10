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
- Commit history through `4c139b4` (C4.3), `318adf1` (C4.4), plus this
  session's docs closeout, are all present on `origin/develop`.

## Phase 16A.0-C, Units C0-C3, C4.0-C4.4 are complete

C0-C3: see prior entries in `.claude/current-task.md` -
`ReservationGateway`/`CheckoutReservationFacade` implemented, unwired.
C4.0-C4.3: shared sanitizer, `CartReservationCompensation` schema +
repository, `CompensationService.recordMirrorDivergence`,
`CompensationReconciliationService`/`CompensationBlockedRecheckService`
(single-row desired-state recovery). C4.4:
`CompensationBatchService.runBatch` - batch orchestration over the C4.3
single-row services, sequential processing, no locking, real-Postgres-
proven concurrency safety. **Nothing outside C4.4's own tests calls
`runBatch` yet** - no scheduler, no `@Cron`, no caller wiring of any
kind. See `.claude/current-task.md` for the full delivery summary of
every unit.

Two real engineering findings from C4.4, both diagnosed and permanently
resolved (see ADR-007 §14 and `.claude/decisions.md`): a PostgreSQL
`timestamp`/`timestamptz` binding bug in raw SQL date parameters
(fixed, regression-tested), and a Redis integration-test DB-index
collision between concurrently-running spec files (fixed via a
dedicated index for the new suite, test infrastructure only).

## The next session begins READ-ONLY: Phase 16A.0-C4.5 - compensation scheduler / operational execution

**Do not implement C4.5 yet** without first restating the contract.
Begin by reviewing:

- `CompensationBatchService.runBatch`'s exact current signature and
  `RunBatchResult` shape.
- **This project's existing scheduler conventions** before assuming
  `@Cron` is automatically correct -
  `ComplianceScoreCronService`/`compliance-score-cron.service.ts` and
  `SLABreachDetectionService`/`sla-breach-detection.service.ts` are the
  established precedents (both `@Cron`-based, both single-process
  in-memory guards, both explicitly documented as insufficient for a
  genuine multi-instance deployment without a DB-backed lock). Confirm
  whether `@Cron` is actually the right mechanism here or whether C4.4's
  own "no advisory lock needed because claims are already safe" finding
  changes that calculus for this specific subsystem.

Then plan (do not implement without approval):

1. **Scheduler ownership/module placement** - does this live inside
   `MirrorCompensationModule` (matching every other C4.x unit) or as its
   own thin wrapper module.
2. **Execution cadence** - how often `runBatch` should fire, with
   reasoning grounded in the actual due-row timing this subsystem
   produces (30s/120s/600s/1800s recovery backoff, 60s blocked-recheck
   interval).
3. **Overlap policy** - what happens if one tick is still running when
   the next is due. C4.4 already proved database-level correctness
   tolerates overlapping `runBatch` calls - confirm explicitly whether
   that finding changes whether an overlap guard is even needed, versus
   just being a cadence/efficiency question.
4. **Whether a single-process guard is useful even though database
   correctness already tolerates overlapping workers** - explicitly
   asked for: reason about this rather than reflexively adding one.
5. **Batch size/configuration** - reuse `DEFAULT_BATCH_SIZE`/`MAX_BATCH_SIZE`
   as-is, or does a scheduled context warrant different values than an
   ad hoc/manual invocation.
6. **Shutdown/startup behavior** - what a scheduled tick should do
   during app shutdown (in-flight batch) and at startup (does it need to
   wait for anything, e.g. Prisma/Redis readiness).
7. **Observability/logging** - beyond what `runBatch` itself already
   logs per call.
8. **Scheduler failure isolation** - what happens if `runBatch` itself
   throws (it currently shouldn't, given C4.4's own per-candidate
   isolation, but confirm this explicitly rather than assuming).
9. **Whether scheduler activation is mode-dependent** - should the
   scheduler tick differently (or not at all) depending on
   `ReservationEngineMode` (e.g. is there any reason to skip ticks under
   `LEGACY`, where compensation rows should already be draining via
   `RESOLVED_NO_LONGER_NEEDED_LEGACY`).
10. **`AppModule`/module-graph wiring** - this is the first C4.x unit
    expected to actually touch `AppModule` (registering the scheduler),
    since everything through C4.4 has deliberately stayed unwired -
    confirm this explicitly as in-scope for C4.5 specifically, not an
    accidental scope creep repeating the "additive and unwired" pattern
    from every prior unit.
11. **Test strategy** - fake timers versus explicit invocation of the
    scheduler's handler method (matching how
    `ComplianceScoreCronService`'s tests likely already handle this, if
    it has its own spec file - check before assuming a pattern).

## Explicitly prohibited this session

- Production caller cutover.
- `CartService` integration.
- `ProductsService` integration.
- `OrdersService` integration.
- `ReservationGateway` decorator/composition
  (`CompensatingReservationGateway` or similar) - still deferred until
  the durable `CartService`/Postgres write-order boundary (ADR-007 open
  decision 1) is resolved.
- C5 idempotency.
- Payment integration.
- Changing `ReservationEngineMode` in production (i.e. actually
  transitioning the live mode config - distinct from *reading* the mode
  to decide scheduler behavior, which is in-scope per item 9 above).

## Do NOT do

- Do not begin any C4.5 source-code edit before the contract above is
  restated and a plan is presented and explicitly approved, matching the
  discipline used through every prior unit in this phase.
- Do not assume `@Cron` is automatically the correct mechanism - review
  existing scheduler conventions first (see above).
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0-C3/C4.0-C4.4 as authorizing any caller wiring beyond
  what C4.5 itself is explicitly scoped to (the scheduler's own
  `AppModule` registration) - `CartService`/`ProductsService`/
  `OrdersService` remain untouched until a separate, explicit approval.

The session must return a read-only plan/contract restatement and wait
for approval before any implementation begins.
