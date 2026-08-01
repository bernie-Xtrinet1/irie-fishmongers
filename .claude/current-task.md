# Current Task

Current phase: **Phase 16A.0 - Cart Price Integrity**
Status: **Operational policy Accepted. Source implementation has not yet
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
- Current `addItem` writes the `CartItem` row before calling `reserve()` -
  the opposite of the required order for a valid-lock quantity increment.

## Operational policy: Accepted (see `.claude/decisions.md`)

- Rolling reservation TTL 15 minutes; absolute ordinary-retail maximum 60
  minutes, never extended by renewal.
- `GET /cart` never renews anything; quantity-changing operations may renew
  the reservation, capped at the 60-minute ceiling.
- Price locks never renew automatically - only creation or explicit
  reconfirmation writes `priceLockedAt`.
- No wholesale exception in Phase 16A.0.
- One-cart-one-currency (`Cart.currency`, nullable).
- Checkout requires both a valid price lock **and** a valid Redis
  reservation, independently - a valid lock alone is never sufficient.

## Final implementation-plan corrections resolved (this session)

- Cart-level atomic Redis Lua checkout marking (not per-item preflight
  reads) - one script validating every reservation in the cart's plan and
  marking all `CHECKOUT_PENDING` atomically, or none.
- Separate idempotency semantics for cart mutation, reconfirmation, and
  checkout consumption - not one shared mutable field.
- Item-removal consistency model chosen (release Redis first, then delete
  `CartItem`, with bounded idempotent retry - never a re-reservation as
  compensation).
- Deployment gate tightened to a short checkout **maintenance window**
  around the enforcement flip, rather than an open-ended compatibility
  period silently using live `Product.price`.
- Proven (in the execution plan) that checkout performs exactly one durable
  Postgres stock decrement; Redis reservation deletion is never itself
  treated as inventory consumption.

## Next task

**No source implementation has begun.** Next session begins the actual
Prisma schema/migration and backend work, in the commit-boundary order
defined in the execution plan, starting only after this plan's STEP 4
documentation commit is separately approved.
