# Current Task

Current phase: **Phase 16A.0 - Cart Price Integrity** (remains active)

## Status

- **Commit Unit 1 completed and pushed** at `57c73b4` - additive Prisma
  schema (`Cart.currency`, `CartItem.lockedUnitPrice`/`lockedCurrency`/
  `priceLockedAt`, `Order.currency`, `OrderItem.currency`) and the new
  `CheckoutAttempt` model/enum.
- **Unit 2.1 completed and pushed** at `c757bdd` - `RedisService.eval()`/
  `loadScript()`/`evalsha()`/`runScript()` (NOSCRIPT reload-and-retry).
- **Unit 2.2 completed and pushed** at `393c970` - cart-scoped reservation
  key helpers (`reservationKey`, `isLegacyReservationKey`/
  `isCurrentReservationKey`, `cartIndexKey`/`productIndexKey`/
  `productTotalKey`/`productSuspectKey`) and timing/version constants.
- **Unit 2.3 completed and pushed** at `a27cb65` - additive cart-scoped
  reservation accounting: `ReservationEntry` (version 1), atomic
  `reserveOrRenew`/`releaseReservation` Lua scripts (cart index + product
  index + product reserved-total maintained together, fail-closed
  underflow handling - never clamped), `getActiveReservation` (malformed/
  version-mismatch handling, expired-entry self-heal), cart-aware
  availability (`getReservedTotalExcludingCart`/`computeAvailableToPurchase`,
  correct empty-cart-context handling), and atomic
  `reconcileProductReservedTotal` (NO_DRIFT/OVERCOUNT/UNDERCOUNT, suspend-
  before-repair-verify-before-clear). Validated against real Redis 8.8.0
  (18/18 scenarios) and the full backend suite (192/192 suites, 1501/1501
  tests, CI-equivalent coverage 96.79/91.83/96.64/96.68 against an
  80/90/90/90 threshold).
- **Unit 2.4.1 completed and pushed** at `4db6018` - atomic checkout
  reservation marking (`checkoutMark`, `CHECKOUT_MARK_SCRIPT`, whole-cart
  validate-all-then-mutate-all).
- **Unit 2.4.2 completed and pushed** at `8c68f3b` - whole-cart
  checkout-pending lease inspection and extension
  (`getCheckoutPendingLeaseState`, `extendCheckoutLease`,
  `CheckoutLeaseStateService`).
- **Unit 2.4.3 completed and pushed** at `e907998` - checkout revert and
  final reservation consumption (`checkoutRevert`,
  `finalizeCheckoutConsumption`, `CheckoutReservationRecoveryService`,
  `CHECKOUT_REVERT_SCRIPT`, `FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT`);
  relocated `ReservationUnderflowDetails` into the neutral
  `reservation-accounting.types.ts` so `InventoryReservationsService`
  never depends on a checkout-specific types module.
- **Unit 2.4.4 completed and pushed** at `ad89219` - durable
  checkout-pending reconciliation orchestration
  (`CheckoutPendingReconciliationService.reconcileExpiredCheckoutPending`):
  durable `PROCESSING`/`COMMITTED`/`FAILED`/`NOT_FOUND` state handling,
  hard-ceiling-first recovery, active-lease/resync/revert branching, and
  strict dependency-contract-error handling. Pure orchestration over
  `CheckoutLeaseStateService`/`CheckoutReservationRecoveryService` - no
  Redis calls of its own, no Prisma dependency.
- **The complete checkout reservation engine (Units 2.4.1-2.4.4) remains
  additive and unwired.** `CartService`, `OrdersService`, and
  `ProductsService` are untouched and still call the legacy
  per-product-hash methods (`reserve`, `release`, `getReservedByOthers`,
  `getAvailableToPurchase`), which remain fully active and behaviorally
  unchanged. See `.claude/decisions.md` for the explicit approved decision
  that this stays additive/unwired until a separately approved,
  coordinated cutover.
- **No scheduler or Prisma integration exists yet.**
  `CheckoutPendingReconciliationService` takes durable state as plain
  input parameters; nothing reads or writes `CheckoutAttempt`, and no
  `@Cron` caller exists anywhere in the checkout reservation engine.

- **Caller-cutover planning is complete.** A read-only investigation
  mapped the current `CartService`/`OrdersService`/payment/scheduler/module
  flows in full and produced a 19-section cutover plan, since revised after
  review.
- **ADR-007 is committed and pushed** at `15bbacf`
  (`docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md`)
  - records the approved architecture (`CheckoutAttemptRepository` ->
  `CheckoutAttemptService` -> `CheckoutCoordinatorService`,
  `CheckoutReservationFacade`, `PriceLockService`, PostgreSQL advisory
  locking for the future scheduler, the combined-availability formula) and
  the phased sequence A-H, with 11 open decisions each explicitly marked
  OPEN (with the phase it blocks) or RESOLVED.
- **Phase 16A.0-A is complete**, committed locally at `5acbb4b`
  (`feat(checkout): add checkout attempt persistence`) with a follow-up
  docs commit at `c8ccdf3`
  (`docs(architecture): record failure-message sanitization contract in
  ADR-007`). **Neither commit is pushed yet** - `git push origin develop`
  failed with `Could not resolve host: github.com` (no network access from
  the implementing environment). Push these two commits before starting
  any further work.
  - Delivered: `CheckoutAttemptRepository` (`createOrGetByIdempotencyKey`
    with target-validated P2002 handling, `findById`, conditional
    `updateHeartbeatIfProcessing`/`markCommitted`/`markFailed`, keyset
    `findStaleProcessing`), `CheckoutAttemptService` (`createOrResume`,
    `updateHeartbeat`, `markCommittedInTransaction` - `tx` required, never
    defaulted, `markFailed` - sanitizes `failureMessage` rather than
    rejecting it, `findStalePage`), the narrow `CheckoutAttemptSummary`
    projection (excludes `failureMessage`), and the additive
    `[status, lastHeartbeatAt, id]` index (old two-column index untouched -
    confirmed via `pg_indexes`).
  - 66 new tests across 7 files (6 service/repository unit files + 1
    module-boundary structural file), full backend suite 1733 -> 1799,
    216 suites passing, `checkout-attempt.service.ts` at 100%
    lines/functions/branches.
  - Zero production wiring: confirmed via `git grep` that
    `CheckoutAttemptService`/`Repository`/`Module` appear nowhere outside
    `backend/src/modules/checkout-attempt/` except in documentation
    (`ADR-007`, `.claude/*.md`).

## Next task: Phase 16A.0-B - see the phase-sequence note below before picking scope

**Do not default to "CheckoutCoordinatorService + CheckoutReservationFacade"
without re-checking ADR-007's own gates first.** ADR-007's Implementation
sequence table blocks Phase C (`CheckoutReservationFacade`) on open
decisions 1, 9, 10, and Phase D (`CheckoutCoordinatorService`) on both A
*and* C - none of decisions 1/9/10 have been resolved. The only phases
Phase A alone unblocks are:
- **Phase F** (scheduler, heartbeat recovery, Postgres advisory lock) -
  blocked only on A, which is now done.
- **Phase B** (`PriceLockService`) - blocked on open decisions 4 (price-
  lock TTL value) and 8 (`Product` currency field), both still open.

Confirm with the user which phase to start (most likely F, or resolving
open decisions 4/8 first to unblock B) rather than assuming C/D are ready.

## Operational policy: Accepted (see `.claude/decisions.md`)

- Rolling reservation TTL 15 minutes; absolute ordinary-retail maximum 60
  minutes, never extended by renewal.
- Price locks never renew automatically.
- No wholesale exception in Phase 16A.0.
- One-cart-one-currency (`Cart.currency`, nullable).
- Checkout requires both a valid price lock **and** a valid Redis
  reservation, independently.
- Product reserved-total underflow must never be silently clamped;
  undercount drift is fail-closed until reconciliation repairs and
  verifies the total; Redis Cluster migration is prohibited until a
  separately approved design exists.
- Cart-scoped reservation accounting remains additive and unwired until a
  separately approved, coordinated cutover.

See "Next task" above for the exact scope of the next session's work.
