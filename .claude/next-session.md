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
- Commit history through `357e35b` (C0), `8978f03` (C1), `a89aff8` (C2),
  `7fddac0` (C3), plus this session's docs closeout, are all present on
  `origin/develop`.

## Phase 16A.0-C, Units C0, C1, C2, and C3 are complete

C0: `InventoryModule` registers/exports the four checkout-state services.
C1: the `LEGACY`/`MIRROR`/`CART_SCOPED`/`DRAINING` transition graph and
rollback gate. C2: `ReservationAvailabilityService`, the corrected
per-mode availability authority matrix. C3: `ReservationGateway`
(interface) / `CheckoutReservationFacade` (sole implementation,
`RESERVATION_GATEWAY` token via `useExisting`) - mode-aware
`reserveForCart`/`releaseForCart`/`releaseCart`/
`getCartAdmissionAvailability`, `MirrorDiagnostic` with
`ACCOUNTING_UNDERFLOW` detection, `releaseCart`'s single mode snapshot.
**Nothing calls any of it yet** - `CheckoutReservationModule` is not
imported by `CartModule`/`AppModule`; `CartService` still calls
`InventoryReservationsService`'s legacy methods directly, unchanged. See
`.claude/current-task.md` for the full delivery summary of all four
units.

## The next session begins READ-ONLY: Phase 16A.0-C4 - durable mirror compensation

**Do not implement C4 yet.** Inspect and design:

1. `CartReservationCompensation` schema.
2. `CompensationRepository`.
3. `CompensationService`/reconciler ownership.
4. Exact creation point after `MIRROR` divergence:
   - legacy reserve succeeded / mirror reserve failed;
   - legacy release succeeded / mirror release failed.
5. Correlation without prematurely implementing C5 idempotency.
6. Desired-state recovery - do not blindly replay stale writes.
7. Idempotent reconciliation.
8. Retry/backoff policy.
9. Optimistic version field.
10. `lastError` sanitization.
11. `correlationId`/`requestId` fields.
12. `resolvedAt`/permanent-failure handling.
13. Scheduler boundary - C4 may build durable recovery logic, but actual
    scheduling should remain separately approved if ADR sequencing
    requires it.
14. Compensation metrics/logging.
15. How C3's `MirrorDiagnostic` eventually feeds C4 without making C3
    depend directly on persistence.

## Explicitly prohibited this session

- `CartService` caller cutover.
- `ProductsService` edits.
- `OrdersService` edits.
- C5 idempotency implementation.
- Payment.
- Production mode switching.
- Checkout coordinator.
- Scheduler wiring, unless separately approved.

## Do NOT do

- Do not begin any C4 source-code edit before a plan is presented and
  explicitly approved, matching the discipline used through every prior
  unit in this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0/C1/C2/C3 as authorizing any caller wiring - they remain
  fully additive and unwired; do not assume otherwise or begin
  implementation without a separate, explicit approval.

The session must return a read-only plan and wait for approval before any
implementation begins.
