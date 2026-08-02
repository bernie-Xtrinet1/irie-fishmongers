# Reservation Lifecycle — Phase 16A.0 Redis Design

Status: Accepted (design), implementation not yet started
Date: 2026-08-02
Scope: Commit Unit 2 (Redis reservation model, Lua scripts, isolated tests)

This document is the durable reference for the Redis-side reservation
subsystem introduced by Phase 16A.0 (Cart Price Integrity). It supersedes
the informal description of the old reservation format wherever they
differ. It does not cover `CartService`, `OrdersService`, controllers,
DTOs, or frontend work — those are later, separate commits.

**Revision note (2026-08-02):** the first version of this document treated
the product-side reservation index and total as a best-effort, eventually-
consistent second step, justified by preserving Redis Cluster
compatibility. That was corrected: `getReservedByOthers`/
`getAvailableToPurchase` participate directly in reservation admission
(consumed by `CartService` and `ProductsService`), so the product-side
projection cannot tolerate missing updates. This revision makes every
Redis structure — reservation entry, cart index, product index, and
product reserved-total — part of one atomic Lua mutation, prioritizing
correctness on the actual current deployment (a single, non-cluster Redis
instance) over a Cluster-compatibility claim the codebase does not need
yet. See §12 for the explicit, narrowed Cluster position.

---

## 1. Key format

```ts
function reservationKey(cartId: string, productId: string): string {
  assertNoKeyDelimiters(cartId, 'cartId');
  assertNoKeyDelimiters(productId, 'productId');
  return `inv:reserved:{${cartId}}:${productId}`;
}
```

- The `{cartId}` hash tag groups every reservation key for one cart onto
  the same Redis Cluster slot, were Cluster ever in use. On the current
  single-instance deployment this has no operational effect (there is no
  slot concept at all) — see §12 for why this fact does not make the
  design Cluster-ready.
- `cartId`/`productId` are always Prisma UUIDs already resolved from
  `Cart`/`Product` records before this helper runs. The delimiter check is
  defensive (stops a future caller from corrupting the hash-tag boundary),
  not a guard against a realistic input today.
- Keys are never parsed back apart. Every caller already holds both ids
  from the record it is working with. A future "all reservations for cart
  X" need is served by the cart index (§4), not by parsing.
- **Old vs. new discrimination**: old-format keys (`inv:reserved:<productId>`)
  never contain `{`/`}` (UUIDs are alphanumeric+hyphen only); new-format
  keys always contain exactly one `{...}` segment right after the prefix.
  `key.includes('{')` (or `/^inv:reserved:\{[^}]+\}:.+$/`) is an
  unambiguous, collision-free discriminator, used both by application code
  and by the legacy-drain tooling (§8).

## 2. Reservation entry

One Redis **STRING** key per `(cartId, productId)` pair holds the full JSON
entry — not a per-product HASH. The old format's hash-of-carts shape mixed
unrelated carts under one key, which is part of why it cannot support
either the cart-scoped checkout script or the atomic total maintenance
this revision requires.

```ts
type ReservationStatus = 'ACTIVE' | 'CHECKOUT_PENDING';

interface ReservationEntry {
  version: 1;                           // schema version, stamped on every write
  quantity: number;
  cartId: string;
  customerId: string;
  status: ReservationStatus;
  createdAt: number;                    // epoch ms, set once, never rewritten
  lastRenewedAt: number;                // epoch ms, updated by reserveOrRenew
  expiresAt: number;                    // epoch ms, rolling, capped by absoluteExpiresAt
  absoluteExpiresAt: number;            // epoch ms = createdAt + 3_600_000, immutable
  checkoutIdempotencyKey: string | null;
  checkoutPendingAt: number | null;
  checkoutPendingExpiresAt: number | null;
}
```

**`version`**: every entry carries a literal `version: 1` today. There is
nothing to migrate yet (this is a brand-new format with no prior
production data), but stamping the version now means a future shape change
can branch on an explicit field instead of guessing from key/field
presence. Every write path (create, renew, `checkoutMark`, `checkoutRevert`,
`extendCheckoutLease`, `finalizeCheckoutConsumption`) must preserve
`version: 1` verbatim.

Constants (`inventory.constants.ts`, alongside the existing ones):
```ts
export const RESERVATION_TTL_SECONDS = 900;                 // unchanged
export const MAX_RESERVATION_LIFETIME_SECONDS = 3600;        // new
export const CHECKOUT_PENDING_INITIAL_LEASE_SECONDS = 180;   // new
export const MAX_CHECKOUT_PENDING_SECONDS = 600;             // new
```

The key's native Redis TTL is set to `absoluteExpiresAt - now` at creation
(a real backstop, not merely 2×-defensive as today), but correctness never
depends on it — every read still checks `expiresAt`/`checkoutPendingExpiresAt`
explicitly. Note that native TTL eviction is a Redis-internal event that
does **not** run application Lua code, so a key that is silently evicted
this way does not decrement the product reserved-total on its own — this
is precisely what §7's reconciliation operation exists to repair, and
what the lazy-read self-heal in §5 catches opportunistically before
reconciliation ever needs to run.

## 3. Legacy format (verified, for contrast)

- Key: `inv:reserved:<productId>` (a per-product HASH).
- Entry: `{ quantity, expiresAt }` only — no version, no status, no absolute
  cap, no cart/customer fields inside the value (cartId is the hash
  field name).
- `expiresAt` renews 15 minutes forward on every `reserve()` call, with
  **no absolute cap** — confirmed by direct code reading, not assumed.
- Outer hash TTL 1800s, also reset on every call; a defensive backstop only,
  never relied on for correctness.

## 4. Redis structures

Five structures, all maintained **atomically together** by every
reservation-changing Lua script on the current single Redis instance:

```
Reservation key:                inv:reserved:{cartId}:{productId}
Cart index (SET of productIds): inv:reserved:cart-index:{cartId}
Product index (SET of cartIds): inv:reserved:product-index:{productId}
Product reserved total (INT):   inv:reserved:product-total:{productId}
Product total suspect flag:     inv:reserved:product-total-suspect:{productId}
```

- **Reservation key**: the entry itself, as in §2.
- **Cart index**: every productId a cart currently holds a reservation for.
  Used by `reconcileExpiredCheckoutPending` and the future scheduled
  recovery service to enumerate "every reservation held by cart X" from
  Redis directly, without depending on a caller reconstructing that list
  from Postgres `CartItem` rows.
- **Product index**: every cartId currently holding a reservation on a
  product. This is the enumerable, authoritative membership set — used by
  reconciliation (§7) to recompute the true total from scratch, and as the
  ground truth against which the fast total is checked for drift.
- **Product reserved total**: a plain integer, the fast-path sum of active
  reservation quantities across all carts for one product. This is what
  `getAvailableToPurchase`/`getReservedByOthers` read on the hot path
  (every add-to-cart, every product page view) instead of enumerating and
  summing the product index on every call.
- **Product total suspect flag**: existence-only marker (no TTL). Set the
  moment any operation detects the stored total cannot be trusted (§5's
  `RESERVATION_TOTAL_UNDERFLOW`, or reconciliation discovering an
  UNDERCOUNT, §7). While set, `getAvailableToPurchase` returns `0` for
  that product regardless of the stored total's value (§6) — new
  reservation admission fails closed. Cleared only by a reconciliation run
  that successfully repairs and verifies the total (§7).

**Why all four in one script is correct here, and was not proposed for
Redis Cluster**: on a single Redis instance there is no hash-slot
restriction at all — any set of keys can be touched by one `EVAL`
regardless of naming. The `{cartId}`/`{productId}` tag choices in the key
names remain meaningful documentation of "what this key logically belongs
to," but they impose no actual constraint on today's deployment. §12
states explicitly that this does not extend to a future Cluster
deployment.

## 5. Atomic mutation contracts

### `reserveOrRenew(cartId, productId, customerId, quantity)`

Single Lua script. Reads the existing entry (if any) to determine
`oldQuantity` (0 if none exists), writes the new/updated entry with
`quantity = newQuantity`, computes:

```
delta = newQuantity - oldQuantity
```

and atomically:
1. `SET` the reservation key (entry, with `version: 1`).
2. `SADD` the cart index with `productId`.
3. `SADD` the product index with `cartId`.
4. If `delta ~= 0`: apply the delta to the product-total key (see
   underflow handling below for the negative-delta case).

If the product-total suspect flag (§4) is currently set for this product,
and this call would be a **new** reservation (`oldQuantity == 0`) or an
**increase** (`newQuantity > oldQuantity`), it is rejected with
`RESERVATION_PRODUCT_SUSPENDED` — new exposure to a product whose
accounting is currently untrustworthy is refused. A decrease or same-
quantity renewal is still permitted while suspended: an unrelated backend
accounting bug must never block a customer from reducing or simply keeping
their existing cart contents. This is defense in depth — the primary gate
is `getAvailableToPurchase` returning `0` while suspended (§6), which is
what `CartService.assertQuantityAvailable` already checks before ever
calling `reserveOrRenew`; this second check protects any future caller
that skips the pre-check.

Rejects with `RESERVATION_CHECKOUT_IN_PROGRESS` if the existing entry is
`CHECKOUT_PENDING` — a cart mutation must never silently interfere with an
in-flight checkout attempt.

### `release(cartId, productId)`

Single Lua script. Reads the entry to get its exact `quantity` (if the key
is already gone, this is a no-op success — idempotent by construction: no
entry means nothing to subtract, and the total is never touched for a
duplicate release). If an entry exists, atomically:
1. `DEL` the reservation key.
2. `SREM` the cart index.
3. `SREM` the product index.
4. Subtract the entry's exact `quantity` from the product-total key (see
   underflow handling below).

### `RESERVATION_TOTAL_UNDERFLOW` — invariant violation, not clamped

**The product reserved total is never silently clamped to zero.** If, at
the moment `reserveOrRenew` (negative delta) or `release`/
`checkoutRevert`'s delete branch/`finalizeCheckoutConsumption` (§10) is
about to subtract a quantity `Q` from the stored total `T`, and `T < Q`,
this is treated as an invariant violation, not a number to round down:

1. **The reservation entry itself is still deleted** (or, for
   `reserveOrRenew`, the renewal itself still proceeds) — both indexes are
   still updated. The specific action a customer or checkout is performing
   is real and must not be blocked by an unrelated aggregate-accounting
   inconsistency discovered elsewhere.
2. **The product-total key's arithmetic is skipped**, not applied and not
   clamped — its current (already-inconsistent) value is left as-is,
   since performing further arithmetic on a number already known to be
   wrong does not make it more correct.
3. **The product-total suspect flag is set** (§4) — marking the product
   for urgent reconciliation.
4. The script returns a distinguished result, `RESERVATION_TOTAL_UNDERFLOW`,
   alongside the otherwise-successful outcome of the entry mutation, so the
   calling TypeScript layer can react.
5. **The calling layer logs a structured entry and increments a metric**
   with: `productId`, `cartId`, `reservationQuantity` (the `Q` that could
   not be subtracted), `storedTotal` (the `T` observed at violation),
   `operationName` (`reserveOrRenew` | `release` | `checkoutRevert` |
   `finalizeCheckoutConsumption`), and `timestamp`.
6. Until a reconciliation run (§7) repairs and clears the flag, new
   reservation admission for this product fails closed via
   `getAvailableToPurchase` returning `0` (§6).

This is distinct from, and must never be confused with, **normal duplicate
release**: if the reservation entry no longer exists at all, `release`
returns success/no-op *before* any quantity is known or any subtraction is
attempted — there is nothing to subtract, so there is no underflow check
to run, and the total is never decremented a second time for the same
entry.

### Lazy-expiry self-heal (read path)

Any read that encounters an entry with `expiresAt <= now` does not merely
treat it as absent — it invokes the same `release` logic (same exact-
quantity subtraction, same underflow handling) as a side effect, since the
read has already parsed the entry and knows its precise quantity. This
closes the drift window opportunistically on the natural read path, rather
than waiting solely for the scheduled reconciliation sweep (§7) to catch
every abandoned reservation. It complements, and does not replace,
reconciliation — a reservation nobody happens to read again before its
native TTL evicts it is still caught by reconciliation, not by this path.

### Operations unaffected by quantity (no total mutation)

`checkoutMark` and `extendCheckoutLease` change only `status`/pending
fields, never `quantity` — the product-total is untouched by either.
`checkoutRevert`'s restore-to-`ACTIVE` branch likewise leaves quantity
unchanged. Its delete branch (already-expired at revert time), and
`finalizeCheckoutConsumption`'s deletion of every consumed entry, both
follow the exact same rule as `release`, including the underflow handling
above: subtract the deleted entry's precise quantity from the product-total,
atomically, in the same script that performs the deletion.

## 6. Availability authority

```
availableToPurchase = Product.quantityAvailable
                     - productReservedTotal
                     + requestingCartActiveReservationQuantity
```

`Product.quantityAvailable` (Postgres) remains the durable authority on
stock. `productReservedTotal` is the fast-path Redis projection (§4) — the
sum of active reservation quantities across *every* cart, including the
requesting one. `requestingCartActiveReservationQuantity` is added back so
the requesting cart's own hold is excluded from what counts against it —
algebraically the same result as subtracting "reservations held by others"
directly, restated as an add-back so the fast total never needs to be
computed with any cart already excluded from it.

`requestingCartActiveReservationQuantity` is read from the specific
reservation key `inv:reserved:{cartId}:{productId}` — if absent, or
present but expired (in which case the same lazy self-heal from §5
applies), it is treated as `0`.

**Fail-closed override**: if the product-total suspect flag (§4) is set
for this product, `availableToPurchase` returns `0` unconditionally,
regardless of what `Product.quantityAvailable` or the (untrustworthy)
`productReservedTotal` would otherwise compute — new admission is refused
until reconciliation (§7) repairs and clears the flag.

`reserveOrRenew`'s single `delta = newQuantity - oldQuantity` (§5) is the
complementary half of the exclusion: because the total is adjusted by a
delta in one atomic step, an update to an existing hold is never expressed
as "subtract the old value, then re-add the new one" as two separate
operations — which is exactly the shape of bug that would risk double-
counting or double-subtracting a cart's own prior hold.

**The product index remains the reconciliation source** for rebuilding or
verifying the total from scratch (§7) — the fast total is a maintained
projection, the index is the ground truth for what should still be active.

### Existing callers — signature check (grounded, not assumed)

Inspected directly rather than assumed, per the requirement that no caller
be claimed unaffected without verification:

- **`CartService.assertQuantityAvailable`** (`cart.service.ts:107-122`)
  already holds a real `cart.id` (from `cartRepository.findOrCreateByCustomerId`)
  and passes it as the current method's `excludingCartId` argument at both
  its call sites (`addItem`, `updateItemQuantity`). This caller already
  supplies a genuine cart id — no signature change needed.
- **`ProductsService.getAvailability`** (`products.service.ts:149-168`)
  calls `getAvailableToPurchase(product.id, product.quantityAvailable, '')`
  — a literal empty string, since this endpoint reports a product's
  general availability with no cart context at all (e.g. a product-detail
  view). An empty string never matches a real Prisma UUID, so
  `requestingCartActiveReservationQuantity`'s lookup for `''` naturally
  resolves to `0` under the new formula exactly as it did under the old
  hash-based one — "exclude no cart's own hold" is preserved by
  construction, not by special-casing empty-string input.
- **`getReservedByOthers`** has no caller outside
  `inventory-reservations.service.ts` itself (confirmed by search) — it is
  an internal implementation detail of `getAvailableToPurchase`, not
  independently called.

**Conclusion**: both existing callers' current arguments are already
compatible with the new formula's own-cart exclusion. No caller signature
change is required in Commit Unit 2 — `getAvailableToPurchase`'s external
contract (`productId, quantityAvailable, cartId: string`) is preserved
unchanged, consistent with keeping `reserve()`/`release()` as thin
deprecated aliases for the same reason.

## 7. Reconciliation

A dedicated operation, in scope for this unit (its Redis-layer contract,
not a scheduled caller — see the deferral note below), capable of:

```ts
type DriftDirection = 'NONE' | 'OVERCOUNT' | 'UNDERCOUNT';

interface ProductReservedTotalReconciliation {
  productId: string;
  membersChecked: number;
  staleIndexMembersRemoved: number;
  missingOrInconsistentReservations: number;
  storedTotal: number;
  calculatedTotal: number;
  difference: number;              // calculatedTotal - storedTotal
  driftDirection: DriftDirection;
  repairedValue: number;           // the value written back (== calculatedTotal)
  admissionSuspended: boolean;     // whether the suspect flag was set/left set
}

reconcileProductReservedTotal(productId: string): Promise<ProductReservedTotalReconciliation>
```

Behavior:
1. `SMEMBERS` the product index for candidate cartIds.
2. For each candidate, `GET` its reservation key:
   - Missing (evicted, or never existed) → stale index member, `SREM` it,
     counted in `staleIndexMembersRemoved`, not added to `calculatedTotal`.
   - Present but expired (`expiresAt <= now`) → apply the same removal as
     `release` (delete key, `SREM` both indexes), counted in
     `staleIndexMembersRemoved`, not added to `calculatedTotal`.
   - Present but structurally invalid (JSON parse failure, unexpected
     `version`, non-positive `quantity`) → counted separately in
     `missingOrInconsistentReservations`, logged individually with
     whatever can be safely captured (cartId, raw value) for
     investigation, and excluded from `calculatedTotal`. This is a
     distinct, more concerning signal than a merely-expired entry — it
     suggests a bug in a write path, not ordinary lifecycle expiry — and
     is never silently repaired by guessing a plausible value.
   - Present and valid → add its `quantity` to `calculatedTotal`.
3. Compute `difference = calculatedTotal - storedTotal` and classify:
   - `difference == 0` → `driftDirection = 'NONE'`.
   - `difference < 0` (**OVERCOUNT**: stored total higher than reality) →
     the stored total over-counts reservations that have already lapsed.
     This makes `availableToPurchase` under-report stock — conservative,
     never an overselling risk. Repaired immediately by writing
     `calculatedTotal`, logged as a routine correction, no admission
     suspension required.
   - `difference > 0` (**UNDERCOUNT**: stored total lower than reality) —
     the stored total under-counts real reservations, which makes
     `availableToPurchase` **over-report** stock: a live overselling risk.
     Treated as critical: the suspect flag (§4) is set (if not already)
     *before* repairing, the corrected value is written, and the flag is
     cleared only after the write is confirmed to match `calculatedTotal`
     — closing the fail-closed window as soon as, and not before, the
     repair is verified.
4. Emit a metric/log entry with the full summary object above, including
   `admissionSuspended` reflecting whether the flag was set/cleared by
   this run.

**Normal correctness does not depend on this operation ever running for
OVERCOUNT drift** — an over-counted total can only make the system too
conservative, never permissive, so no admission is ever wrongly allowed
while it's stale. **This does not extend to UNDERCOUNT drift**: an
under-counted total is a live overselling risk in its own right, which is
exactly why `RESERVATION_TOTAL_UNDERFLOW` (§5) sets the suspect flag the
moment it is detected at write time, rather than waiting for a
reconciliation sweep to discover it independently — reconciliation is a
second, periodic detection path for the same failure mode, not the only
one.

This can be invoked on-demand for one product, or enumerated across all
products with the same `SCAN MATCH inv:reserved:product-index:*` style
loop already established by `InventoryReconciliationService`. Wiring it
into a scheduled job is deferred to a later commit, matching how
`reconcileExpiredCheckoutPending` (§10) is also specified now but not
scheduled yet — this unit delivers the tested, callable method; a cron
caller is separate, later work.

## 8. Legacy transition (drain plan)

1. Pause cart mutation (the already-planned checkout maintenance window).
2. Wait **20 minutes** (15-min max rolling entry lifetime of the *old*
   format + 5-min margin — not the new format's 60-minute cap, which does
   not retroactively bound data written under the old code).
3. Enumerate: `SCAN 0 MATCH inv:reserved:* COUNT 100` to completion (this
   prefix matches both formats), filtered client-side by the §1
   discriminator to isolate old-format keys only.
4. For each surviving old-format key, `HSCAN key 0 COUNT 100` (not
   `HGETALL`) and check every field's `expiresAt` against `now`.
5. **Deletion criteria**: only once every field in every matched key is
   confirmed expired, `DEL` the whole key. Any key with a still-active
   field at the 20-minute mark is left alone, logged, and re-checked after
   a short additional wait — never force-deleted.
6. **Metrics**: log old-format keys found at drain start, total fields
   summed across them, active-vs-expired counts at each verification pass,
   and keys actually deleted at cutover.
7. **Customer impact**: identical to the existing maintenance-window
   description — cart mutation is paused throughout; a cart touched just
   before pause simply finds its hold naturally lapsed afterward, the same
   as any ordinary reservation timeout already surfaced today.

## 9. Whole-cart atomic checkout mark

`KEYS[1..N]` = `reservationKey(cartId, productId)` for every item in the
plan. `ARGV` = `[cartId, customerId, checkoutIdempotencyKey, leaseSeconds,
nowMs, expectedQty_1, ..., expectedQty_N]`. This script does not touch the
cart index, product index, or product-total — `checkoutMark` changes only
`status`/pending fields, never `quantity` (§5), so those structures are
untouched by it.

```lua
local cartId, customerId, idemKey = ARGV[1], ARGV[2], ARGV[3]
local leaseSeconds, now = tonumber(ARGV[4]), tonumber(ARGV[5])
local n = #KEYS

-- Pass 1: validate every entry, mutate nothing. A `return` here exits the
-- whole script before any write has happened.
for i = 1, n do
  local raw = redis.call('GET', KEYS[i])
  if not raw then return {err='RESERVATION_MISSING', failedIndex=i} end
  local entry = cjson.decode(raw)
  if entry.cartId ~= cartId or entry.customerId ~= customerId then
    return {err='RESERVATION_OWNER_MISMATCH', failedIndex=i}
  end
  if entry.quantity ~= tonumber(ARGV[5 + i]) then
    return {err='RESERVATION_QUANTITY_MISMATCH', failedIndex=i}
  end
  if entry.expiresAt <= now then return {err='RESERVATION_EXPIRED', failedIndex=i} end
  -- Defense in depth: expiresAt is already capped at absoluteExpiresAt by
  -- reserveOrRenew's own invariant, so this should be implied by the
  -- check above in normal operation. It is checked independently anyway,
  -- the same way checkout independently validates both lock and
  -- reservation rather than trusting one to imply the other.
  if entry.absoluteExpiresAt <= now then
    return {err='RESERVATION_ABSOLUTE_EXPIRED', failedIndex=i}
  end
  if entry.status == 'CHECKOUT_PENDING' and entry.checkoutIdempotencyKey ~= idemKey then
    return {err='RESERVATION_CHECKOUT_KEY_CONFLICT', failedIndex=i}
  end
end

-- Pass 2: every check passed - mutate all atomically. Replays (already
-- pending under this same key) leave pending timestamps untouched, so a
-- bare retry can never itself act as a heartbeat - only extendCheckoutLease may.
for i = 1, n do
  local raw = redis.call('GET', KEYS[i])
  local entry = cjson.decode(raw)
  if entry.status ~= 'CHECKOUT_PENDING' then
    entry.status = 'CHECKOUT_PENDING'
    entry.checkoutIdempotencyKey = idemKey
    entry.checkoutPendingAt = now
    entry.checkoutPendingExpiresAt = now + (leaseSeconds * 1000)
  end
  redis.call('SET', KEYS[i], cjson.encode(entry), 'KEEPTTL')
end
return {ok='MARKED'}
```

"Mutate nothing if any item fails" is structural: Pass 1 performs zero
writes; any failure `return`s out of the script entirely before Pass 2
starts.

## 10. Checkout recovery

`reconcileExpiredCheckoutPending` is the integration seam. **This unit
builds only the Redis-side primitives — no `CheckoutAttempt`-querying or
-writing code.** A later commit's recovery service (querying
`CheckoutAttempt` via Prisma) calls this method with a durable-state
snapshot it already fetched, keeping the Redis module free of any Prisma
dependency.

| Case | Redis action |
|---|---|
| `PROCESSING`, Redis lease active | None — doesn't reach this method |
| `PROCESSING`, Redis lease expired, heartbeat fresh (within `MAX_CHECKOUT_PENDING_SECONDS`) | None yet — recovery service calls `extendCheckoutLease` to resync Redis to the durable heartbeat |
| `PROCESSING`, Redis lease expired, heartbeat stale (past `MAX_CHECKOUT_PENDING_SECONDS`) | Recovery service marks the attempt `FAILED`/`ABANDONED` first, then calls `checkoutRevert` |
| `COMMITTED` | `finalizeCheckoutConsumption` |
| `FAILED` | `checkoutRevert` |
| No durable attempt found | `checkoutRevert` |

- **`checkoutRevert`**: `expiresAt > now` → restore `ACTIVE`, clear
  checkout fields, leave `expiresAt`/`absoluteExpiresAt` untouched, no
  total change; `expiresAt <= now` → `DEL` outright, `SREM` both indexes,
  and subtract the entry's exact quantity from the product-total, subject
  to the same `RESERVATION_TOTAL_UNDERFLOW` handling as `release` (§5) —
  never clamped. Never generates a new expiry.
- **Same-key resume**: `checkoutMark`'s idempotent-replay branch (§9).
- **Hard 10-minute pending ceiling**: enforced inside `extendCheckoutLease`'s
  cap formula (`checkoutPendingAt + MAX_CHECKOUT_PENDING_SECONDS`), never
  exceedable regardless of heartbeat count.

### Scheduled recovery — resumable batch strategy

Out of scope for this unit's implementation (it needs `CheckoutAttempt` via
Prisma), but specified now so the later service has an unambiguous
contract to build against:

- Query: `WHERE status = 'PROCESSING' AND lastHeartbeatAt < now() - MAX_CHECKOUT_PENDING_SECONDS`,
  keyset-paginated on `(lastHeartbeatAt, id)` — never offset-based, which
  degrades and can skip or duplicate rows under concurrent writes.
- Page size: 200 rows per page.
- Per-tick ceiling: up to 5 pages (1000 rows) per 60-second tick, bounding
  worst-case tick duration. Anything beyond the ceiling is deferred to the
  next tick.
- No persisted cursor row is required between ticks: a row that is
  successfully reconciled transitions out of `PROCESSING` and will not be
  re-selected by the next tick's fresh query. The keyset cursor only
  matters *within* a single tick, so a page that includes a row whose
  reconciliation action itself fails (a "poison pill") does not block
  progress through the rest of that tick's pages — the failure is logged
  and isolated per row (matching the exact pattern already established in
  `ComplianceScoreCronService.runBatchRecompute`: a shared `runX()` method,
  an in-process `running` guard, per-item try/catch, respecting
  `isSchedulerEnabled()`), and the poison-pill row is simply retried by a
  later tick.
- Cron convention: `@Cron(CronExpression.EVERY_MINUTE)`, following
  `sla-breach-detection.service.ts`'s exact pattern, gated by
  `isSchedulerEnabled()` so the e2e suite's `ENABLE_SCHEDULER=false` keeps
  working as it already does for the existing crons.

## 11. RedisService additions

```ts
async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
async loadScript(script: string): Promise<string>   // wraps client.script('LOAD', script) -> sha1
async evalsha(sha1: string, keys: string[], args: (string | number)[]): Promise<unknown>
```

`InventoryReservationsService` loads each Lua script once (on module init
or lazily on first use) and caches the returned SHA1 in memory, calling
`evalsha` thereafter to avoid re-transmitting the full script body on every
invocation. `evalsha` is never called blindly: a `NOSCRIPT` error (which
happens after a Redis restart or `SCRIPT FLUSH`, since the script cache is
not persisted) triggers a fallback that reloads the script via
`loadScript`/`eval` and retries once. This fallback is required for
correctness of the `evalsha` path, not optional.

This remains a small, fixed set of three methods on `RedisService` — not a
general scripting framework. This is the first Lua usage anywhere in this
codebase (confirmed by inspection — no prior `.eval()`/`.multi()`/
`defineCommand` usage exists).

## 12. Redis Cluster position

Stated explicitly, replacing the earlier draft's Cluster-compatibility
framing:

- **The current deployment uses one Redis instance.** There is no cluster
  client anywhere in `redis.module.ts`, confirmed by inspection.
- **Phase 16A.0's Lua scripts atomically touch cart-tagged and
  product-tagged keys in the same script.** This is only valid because the
  current Redis instance has no hash-slot restriction — a single instance
  imposes none. The `{cartId}`/`{productId}` tags in key names remain
  meaningful as documentation of ownership, but they are not doing any
  Cluster-routing work today, and this design does not claim they would
  under Cluster.
- **Moving to Redis Cluster is prohibited until a separate, approved
  design exists** for one of:
  - reservation orchestration (e.g. a coordinator that sequences
    per-key operations across slots instead of relying on one atomic
    multi-key script);
  - a co-location strategy (forcing related keys to share a slot — though
    a product-total key spanning many carts' tags has no general
    co-location solution, unlike the cart-scoped checkout script);
  - product-based sharding (redesigning the primary key axis around
    `productId` instead of `cartId`, which would then need its own
    solution for the cart-scoped whole-cart checkout atomicity this
    document currently relies on); or
  - durable reservation accounting (moving the authoritative total into
    Postgres, with Redis reduced to a fast, non-authoritative cache).
- **None of the four options above is chosen now.** This document does not
  weaken current correctness to manufacture a superficial claim of Cluster
  readiness — the four-structure atomic design in §4–§7 is deliberately
  prioritized over that claim, per the explicit direction that produced
  this revision.

## 13. Document authority

This file does not compete with or restate decisions owned elsewhere:

- **`docs/roadmap.md`** is the authoritative development roadmap.
- **ADR-005** (`docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`)
  is authoritative for catalogue/listing/inventory domain boundaries (e.g.
  `Product.quantityAvailable` as a durable, non-authoritative projection
  referenced in §6).
- **`.claude/decisions.md`** records approved operating decisions for
  Phase 16A.0 (reservation/lock timing, currency policy, checkout
  invariants, etc.).
- **`reservation-lifecycle.md`** (this file) is the technical reference
  for the Redis reservation lifecycle and recovery — its atomic mutation
  contracts, availability authority, and reconciliation design — nothing
  broader.

## 14. Test plan (summary)

- `version: 1` is asserted on every entry produced by every write path.
- **Cart index, product index, and product-total membership/value are all
  asserted alongside every reservation mutation in the same test** —
  same-script atomicity is a directly testable invariant now, not an
  eventually-consistent one.
- `reserveOrRenew`'s delta computation is tested for: first reservation
  (delta = full quantity), quantity increase (positive delta), quantity
  decrease (negative delta), and repeated renewal at the same quantity
  (delta = 0, no total mutation).
- `release`, `checkoutRevert`'s delete branch, and
  `finalizeCheckoutConsumption` each get a test asserting the product-total
  decreases by exactly the released entry's quantity, never an assumed or
  re-derived value.
- A dedicated test proves duplicate `release` (entry already gone) never
  touches the product-total a second time, and is not confused with the
  underflow case.
- `RESERVATION_TOTAL_UNDERFLOW` gets a fabricated-inconsistent-state test
  for each of `reserveOrRenew` (negative delta), `release`,
  `checkoutRevert`'s delete branch, and `finalizeCheckoutConsumption`,
  each asserting: the entry mutation still succeeds; the product-total is
  left unchanged (not clamped, not decremented); the suspect flag is set;
  the structured log fields (`productId`, `cartId`, `reservationQuantity`,
  `storedTotal`, `operationName`, `timestamp`) and metric increment are
  all asserted.
- A test proves `reserveOrRenew` rejects a new/increased reservation with
  `RESERVATION_PRODUCT_SUSPENDED` while the suspect flag is set, and still
  permits a decrease or same-quantity renewal during that same window.
- A test proves `getAvailableToPurchase` returns `0` whenever the suspect
  flag is set, regardless of the stored total's actual value.
- The lazy-expiry self-heal path gets its own test: reading an expired
  entry triggers the same release accounting (including underflow
  handling) as an explicit `release` call, decrementing cart index,
  product index, and product-total.
- `reconcileProductReservedTotal` gets tests for: `NONE` drift (no-op);
  `OVERCOUNT` (stored higher than calculated, corrected down, no
  suspension); `UNDERCOUNT` (stored lower than calculated, suspect flag
  set before repair and cleared only after the corrected value is
  verified written); stale index members removed and excluded from the
  calculated total; structurally-invalid entries counted under
  `missingOrInconsistentReservations` and excluded from the calculated
  total without being guessed at; every field of the summary object
  asserted.
- `CartService.assertQuantityAvailable`'s existing call sites, and
  `ProductsService.getAvailability`'s empty-string call, are each covered
  by a regression test asserting the new formula produces the identical
  result the old implementation did for the same inputs — verifying the
  "no caller signature change needed" conclusion in §6 empirically, not
  just by inspection.
- `checkoutMark` gets a dedicated test for `RESERVATION_ABSOLUTE_EXPIRED`
  distinct from `RESERVATION_EXPIRED`, constructed by fabricating an entry
  where `absoluteExpiresAt <= now` while `expiresAt` is left inconsistent
  (the defense-in-depth scenario, not the normal-operation one).
- `evalsha`/`NOSCRIPT` fallback gets its own test: first call misses
  (simulated `NOSCRIPT`), triggers reload, second call succeeds.
- Resumable-batch behavior is specified for the later recovery-service
  commit's own test suite, not this unit's — noted here so the contract is
  unambiguous when that commit is built.

## 15. Open/deferred

- Wiring `reconcileProductReservedTotal` and `reconcileExpiredCheckoutPending`
  into scheduled callers, and all `CheckoutAttempt` read/write code, remain
  out of scope until later, separate commits.
- Redis Cluster migration is prohibited until one of the four approaches
  in §12 is separately designed and approved.
