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
- **The complete checkout reservation engine (Units 2.4.1-2.4.3) remains
  additive and unwired.** `CartService`, `OrdersService`, and
  `ProductsService` are untouched and still call the legacy
  per-product-hash methods (`reserve`, `release`, `getReservedByOthers`,
  `getAvailableToPurchase`), which remain fully active and behaviorally
  unchanged. See `.claude/decisions.md` for the explicit approved decision
  that this stays additive/unwired until a separately approved,
  coordinated cutover.
- **Unit 2.4.4 has not begun.** No durable-reconciliation-orchestration
  code has been written.

## Next work unit: Unit 2.4.4 - durable checkout-pending reconciliation orchestration

Scope: reuse `getCheckoutPendingLeaseState`, implement
`reconcileExpiredCheckoutPending` taking durable `CheckoutAttempt` state
(`PROCESSING`/`COMMITTED`/`FAILED`/not-found) as input, durable heartbeat
freshness, the 600-second hard pending ceiling, and calling
`checkoutRevert`/`finalizeCheckoutConsumption`/`extendCheckoutLease` as
appropriate - per `docs/architecture/reservation-lifecycle.md` §10. Begins
with read-only inspection and a presented implementation plan, per
`.claude/next-session.md`.

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

## Next task

Begin Unit 2.4.4 planning only, after this session's repository-state
confirmation, per `.claude/next-session.md`.
