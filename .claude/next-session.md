# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md`
  (see especially §16, the Phase D closeout section, and the "Open
  decisions" list at the end)
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
- Commit history includes `9e6163b`/`757b6e9`/`9674cf4`/`1f41932`/
  `8324fd1`/`3ef72da` (Phase 16A.0-D, Units D.1-D.4) plus the D.5
  docs-closeout commit, all present on `origin/develop`.

## Phase 16A.0-D, Units D.1-D.5 are complete - D-core is frozen

`CheckoutCoordinatorService` (durable checkout saga: `CheckoutAttempt`
idempotency, `checkoutMark`, the order transaction, post-commit
`finalizeCheckoutConsumption`/payment initiation) is implemented, fully
tested (unit + real Postgres/Redis integration + a real Nest DI-boundary
proof), and packaged into `CheckoutModule`. See `.claude/current-task.md`
for the full D.1-D.5 delivery summary and ADR-007 §16 for the verified
invariants, the Phase-E gap, and the Decision-3 supersession (direct
composition onto `CheckoutReservationStateService`/
`CheckoutReservationRecoveryService`, not a facade - do not build one).

**`CheckoutModule` remains intentionally unreachable from `AppModule`.** No
controller, no route, no idempotency-key endpoint, no
`CartService`/`ProductsService`/`OrdersController` change. D-core
completion does not mean production activation is approved.

## The next session's task: PHASE D-ACTIVATION READINESS / PHASE-C CUTOVER GATE RESOLUTION

This is a **different, narrower** task than "build Phase D" (already done).
The next session must resolve the prerequisites that currently block
exposing `CheckoutCoordinatorService` to any real caller - **read-only
first**, exactly as every prior unit in this phase began.

Review scope:

1. `CartService`'s current legacy reservation writes (`addItem`/`update`/
   `remove`, exact mutation order today).
2. `ReservationGateway`/`CheckoutReservationFacade`'s shipped C3 behavior
   (per-item cart reservation/admission routing - confirm current shape
   directly, do not trust a carried-forward summary).
3. `ReservationEngineMode` transition architecture (C1) and its current
   persisted mode in this environment.
4. ADR-007 open decisions 1, 9, 10 in full (see the ADR's "Open decisions"
   section - each is either OPEN with the phase it blocks, or RESOLVED
   with the resolution).
5. `addItem`/`update`/`remove` idempotency semantics (open decision 9,
   dependent on decision 1).
6. Redis-first vs. Postgres-first cart-write authority (open decision 1) -
   this is the one decision everything else in this review is downstream
   of.
7. `MIRROR`/`CART_SCOPED` transition mechanics and the rollback
   (`DRAINING`) gate (ADR-007 Decision 8).
8. Rollout-flag mechanism (open decision 10) - direction is settled
   (allowlist-based, per-request), exact mechanism is not.
9. A server-issued checkout idempotency-key API - none exists yet; ADR-007
   Decision 1 already resolved server-generated (not client-generated),
   but no endpoint issues one.
10. The eventual `CheckoutController`/production checkout route - does not
    exist yet.
11. Legacy `OrdersController` checkout-route compatibility/deprecation
    decision - not yet made.
12. `AppModule` activation sequencing - what order `CheckoutModule` and any
    `CartService` change should land in, and what must be true before each
    step.
13. Rollback plan if activation needs to be reversed after partial
    rollout.
14. Observability/shadow-comparison needs for caller-level idempotency
    (building on C2's `mirrorComparison` precedent).
15. Maintenance/drain requirements (ADR-007 open decision 7, legacy-drain
    wait time - still OPEN, blocks Phase H, but relevant context for any
    rollout sequencing discussion here).

## Explicitly prohibited this session

- No caller cutover (`CartService`/`ProductsService`/`OrdersService`
  integration) until this read-only review is presented and explicitly
  approved.
- No `CheckoutController`, no route, no idempotency-key endpoint.
- No `AppModule` import of `CheckoutModule`.
- No new checkout-lifecycle facade (ADR-007 §16.1 - direct composition is
  the approved, final architecture; do not reintroduce a facade "to match
  the old ADR text").
- No payment integration unless separately planned in its own session
  (Phase E, kept explicitly distinct from Phase F - the `CheckoutAttempt`
  durable-recovery scheduler, C4.5's mirror-compensation scheduler is
  neither of these, see ADR-007 §15's naming note).
- No production `ReservationEngineMode` change (i.e. actually transitioning
  the live mode config).
- No unrelated frontend work.
- No removing legacy reservation paths prematurely.

## Do NOT do

- Do not begin any source-code edit before this read-only plan/contract is
  presented and explicitly approved, matching the discipline used through
  every prior unit in this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat D.1-D.5 as authorizing any caller wiring beyond what was
  explicitly scoped and shipped - `CartService`/`ProductsService`/
  `OrdersService` remain untouched until a separate, explicit approval.
- Do not assume ADR-007's open decisions 1/9/10 are resolved without
  re-reading the ADR's own "Open decisions" section directly.

The session must return a read-only plan/contract restatement - including
explicit resolution proposals for open decisions 1/9/10 - and wait for
approval before any implementation begins.
