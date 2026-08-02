# Current Task

Current phase: **Phase 16A.0 - Cart Price Integrity**

## Status

- **Commit Unit 1 is complete and pushed** at `57c73b4` (additive Prisma
  schema: `Cart.currency`, `CartItem.lockedUnitPrice`/`lockedCurrency`/
  `priceLockedAt`, `Order.currency`, `OrderItem.currency`, the new
  `CheckoutAttempt` model/enum - plus the six fixture-only spec updates
  needed to keep `develop` typechecking green).
- **Reservation lifecycle architecture is finalized and pushed** at
  `2068d9f` (`docs/architecture/reservation-lifecycle.md`) - the durable
  technical reference for the Redis reservation model, atomic mutation
  contracts, product reserved-total accounting (including
  `RESERVATION_TOTAL_UNDERFLOW` and OVERCOUNT/UNDERCOUNT reconciliation),
  checkout recovery, and the explicit Redis Cluster limitation.
- **Commit Unit 2 (Redis reservation model, Lua scripts, isolated tests)
  implementation has not begun.** No TypeScript, Lua, or test file for
  this unit has been written.

## Next work unit: Commit Unit 2.1

**RedisService `eval`/`loadScript`/`evalsha`/NOSCRIPT reload-and-retry, and
their isolated unit tests.** See
`docs/architecture/reservation-lifecycle.md` §11 for the exact contract.
Explicitly excluded from 2.1 (later, separate commits per the same
document): reservation-key changes, `ReservationEntry` implementation, the
Lua business scripts (`reserveOrRenew`/`release`/`checkoutMark`/etc.),
product/cart indexes, the product reserved-total projection, and any
change to `CartService`, `OrdersService`, payments, controllers, or
frontend code.

## Repository gap analysis (complete, from earlier sessions)

A read-only inspection of the cart, reservation, order, payment, and
storefront code confirmed the following current defects, which Phase
16A.0 exists to fix:

- `CartItem` stores no price or currency at all (fixed additively in
  Commit Unit 1 - not yet consumed by any service).
- Cart totals are always computed from **live** `Product.price`.
- Checkout silently uses whatever `Product.price` is live at checkout
  time, and **hardcodes `currency: 'JMD'`** (`orders.service.ts:184`).
- `OrderItem` had no `currency` column (fixed additively in Commit Unit 1).
- Reservation expiry (Redis) has no connection to cart/price display.
- No customer-facing cart page exists in the storefront today.
- Current `addItem` writes the `CartItem` row before calling `reserve()` -
  the opposite of the required order for a valid-lock quantity increment.

None of these application-level defects have been fixed yet - Commit Unit
1 only added the additive schema; Commit Unit 2 only builds the Redis
layer. Both remain unconsumed by `CartService`/`OrdersService` until later
commits.

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

## Next task

Begin Commit Unit 2.1 only, after this session's repository-state
confirmation, per `.claude/next-session.md`.
