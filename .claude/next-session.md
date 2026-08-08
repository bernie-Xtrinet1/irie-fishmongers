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
- Commit history through `357e35b` (C0) and `8978f03` (C1), plus this
  session's docs closeout, are all present on `origin/develop`.

## Phase 16A.0-C, Units C0 and C1 are complete

`InventoryModule` now registers/exports the four checkout-state services
(C0). `ReservationEngineModeConfig`/`ReservationEngineModeService`/
`ReservationEngineModeConfigRepository` exist in a standalone, unwired
`ReservationEngineModeModule` (C1) - the full `LEGACY`/`MIRROR`/
`CART_SCOPED`/`DRAINING` transition graph, the Postgres-advisory-lock-
serialized append-only concurrency guard, and the dual-signal
(`product-total` + cart-index) rollback gate distinguishing
`ROLLBACK_BLOCKED` from `ROLLBACK_STRUCTURE_DRIFT` are all implemented and
tested. **Nothing calls any of it yet** - see `.claude/current-task.md`
for the full delivery summary.

## The next session begins READ-ONLY: Phase 16A.0-C2 - combined-availability bridge

**Do not implement C2 yet.** Inspect and define, in detail, before writing
any code:

```
Available = Product.quantityAvailable - LegacyReserved - NewReserved
```

Resolve:

1. Exact ownership of `getAvailability` (ADR-007 Decision 6 already names
   `CheckoutReservationFacade.getAvailability` as the intended home - confirm
   this is still correct, or whether C2 can deliver the bridge logic
   itself first, with the facade wrapping it later in C3).
2. How `LegacyReserved` is read (`InventoryReservationsService.getReservedByOthers`,
   existing, unchanged).
3. How `NewReserved` (the cart-scoped product-total) is read - and
   whether it needs the same suspect-flag fail-closed check
   `computeAvailableToPurchase` already implements.
4. Own-cart exclusion semantics (matching the existing
   `excludingCartId`/`requestingCartActiveReservationQuantity` pattern).
5. Suspect-flag fail-closed behavior when combining two systems' signals.
6. Zero-floor behavior (`Math.max(0, ...)`, matching every existing
   availability calculation in this codebase).
7. Per-mode routing: what the bridge returns in each of `LEGACY`/
   `MIRROR`/`CART_SCOPED`/`DRAINING` - in particular, whether `MIRROR`
   subtracts `NewReserved` at all (it's not yet authoritative) or only
   observes it for comparison.
8. `ProductsService.getAvailability` and `CartService.assertQuantityAvailable`
   caller impact - read-only analysis, no edits.
9. Whether C2 can remain fully unwired (no caller change) while still
   being fully tested - matching the discipline of every prior unit in
   this phase.
10. Unit test plan and real-Redis test plan.

## Explicitly prohibited this session

- `CheckoutReservationFacade` implementation, unless the C2 plan
  genuinely requires it to exist rather than deferring the wrapper to C3
  - state which, don't assume.
- `CartService` edits.
- `ProductsService` edits.
- Reservation writes (C2 is a read-only availability calculation, not a
  mutation).
- The compensation ledger (C4 - separate, later unit).
- Idempotency DTOs (C5 - separate, later unit).
- Any of C3/C4/C5/C6/C7/C8.
- Production mode changes (`ReservationEngineModeService.setMode` stays
  uncalled by anything outside its own tests).

## Do NOT do

- Do not begin any C2 source-code edit before a plan is presented and
  explicitly approved, matching the discipline used through every prior
  unit in this phase.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s,
  `ADR-007`'s, or `.claude/current-task.md`'s content into new session
  files - reference them, don't restate them.
- Do not treat C0/C1 as authorizing any caller wiring - they remain fully
  additive and unwired; do not assume otherwise or begin implementation
  without a separate, explicit approval.

The session must return a read-only plan and wait for approval before any
implementation begins.
