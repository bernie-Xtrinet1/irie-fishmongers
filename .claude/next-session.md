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
  plus this session's docs closeout, are all present on `origin/develop`.

## Phase 16A.0-C, Units C0, C1, and C2 are complete

C0: `InventoryModule` registers/exports the four checkout-state services.
C1: the full `LEGACY`/`MIRROR`/`CART_SCOPED`/`DRAINING` transition graph,
the Postgres-advisory-lock-serialized append-only concurrency guard, and
the dual-signal rollback gate. C2: `ReservationAvailabilityService`
(`getGeneralAvailability`/`getCartAdmissionAvailability`), implementing
the corrected per-mode availability authority matrix (ADR-007 Decision
6) - `LEGACY`/`MIRROR` admit via legacy only, `CART_SCOPED` via the new
engine only, `DRAINING` never admits. **Nothing calls any of it yet** -
see `.claude/current-task.md` for the full delivery summary of all three
units.

## The next session begins READ-ONLY: Phase 16A.0-C3 - checkout reservation facade / reservation gateway

**Do not implement C3 yet.** Inspect and design:

1. `ReservationGateway` abstraction.
2. `CheckoutReservationFacade`.
3. Mode-aware write routing: `LEGACY`, `MIRROR`, `CART_SCOPED`, `DRAINING`.
4. `reserveForCart`.
5. `releaseForCart`.
6. Clear/release-cart behavior.
7. Use of `ReservationAvailabilityService` (its `getGeneralAvailability`/
   `getCartAdmissionAvailability` split from C2 - the facade's own
   `getAvailability` is expected to delegate to it, not reimplement it;
   confirm or revise).
8. `MIRROR` write semantics.
9. Non-blocking mirror failures.
10. Compensation boundary (design only - the ledger itself is C4).
11. Operation/idempotency inputs required by later C5.
12. Relationship to `CartService`.
13. Relationship to `PriceLockService`.
14. No production `CartService` wiring yet.

## Explicitly prohibited this session

- `CartService` source edits.
- `ProductsService` edits.
- `OrdersService` edits.
- Compensation ledger implementation (C4).
- `addItem` idempotency implementation (C5).
- Payment.
- Scheduler.
- Production mode switching (`ReservationEngineModeService.setMode` stays
  uncalled by anything outside its own tests).
- C4+ implementation.

## Do NOT do

- Do not begin any C3 source-code edit before a plan is presented and
  explicitly approved, matching the discipline used through every prior
  unit in this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0/C1/C2 as authorizing any caller wiring - they remain
  fully additive and unwired; do not assume otherwise or begin
  implementation without a separate, explicit approval.

The session must return a read-only plan and wait for approval before any
implementation begins.
