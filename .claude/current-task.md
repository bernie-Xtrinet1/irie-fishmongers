# Current Task

Current phase: **Phase 16A.0 - Cart Price Integrity**
Status: **Planning and design refinement in progress. No implementation
started.**

## Repository gap analysis: complete

A read-only inspection of the cart, reservation, order, payment, and
storefront code confirmed the following current defects:

- `CartItem` stores no price or currency at all (only `cartId`, `productId`,
  `quantity`, timestamps).
- Cart totals are always computed from **live** `Product.price` - recomputed
  fresh on every `getCart`/`addItem`/`updateItemQuantity`/`removeItem` call.
- Checkout silently uses whatever `Product.price` is live at checkout time -
  completely independent of what the customer saw when they added the item.
- Checkout **hardcodes `currency: 'JMD'`** (`orders.service.ts:184`) -
  `Product.currency` is never actually read at checkout despite existing as
  a per-row schema field.
- `OrderItem` has no `currency` column at all.
- Reservation expiry (Redis, 15-minute TTL, lazy-checked) has **no
  connection** to cart/price display - an expired hold gives the customer no
  signal whatsoever.
- **No customer-facing cart page exists in the storefront today** - only an
  API client wrapper (`apps/web/lib/api/cart.ts`) with a single
  `addCartItem` call. The reconfirmation UX has no existing page to retrofit.

## Architecture approved in principle

- Lock price and currency on `CartItem` at add-to-cart time (new items) or
  explicit reconfirmation (legacy/expired items).
- No silent backfill of pre-existing unlocked cart items - explicit customer
  reconfirmation only.
- One-cart-one-currency.
- `OrderItem` remains the final, immutable transaction snapshot (already
  true today for price/name/unit/subtotal; needs `currency` added to be
  complete).

## Outstanding design corrections required before any coding

- Coherent reservation/price-lock timing policy (they are independent
  timers, not one shared clock).
- **60-minute retail absolute maximum hold** (not yet approved as permanent -
  see `.claude/next-session.md`), on top of the existing 15-minute rolling
  TTL.
- Checkout must verify the Redis reservation **exists, belongs to this
  cart, and matches quantity** - not just that the price lock is valid.
- Reconfirmation must reacquire/renew the reservation **and** check
  inventory availability before writing a new lock - not price-only.
- Redis/PostgreSQL compensation strategy (release a leaked reservation if
  the DB write fails; roll back the DB write if reservation reacquisition
  fails) plus idempotency keys and bounded retries.
- `Cart.currency` (nullable) as the authority - established by the first
  locked item, must match on every later add, clears when the cart empties.
- A rollback plan that never falls back to silent live-price charging -
  fail-closed, not fail-open.
- Structured, machine-readable per-item API error codes.
- Precise customer-facing UX language that never says "price changed" when
  only a lock/reservation expired with no actual price difference.

## Next task

Produce the corrected, final Phase 16A.0 operational specification
resolving the items above, then wait for approval before touching any
Prisma schema, migration, or application code.
