# ADR-007 Checkout Reservation Engine Cutover and Operational Integration

Status:
Proposed

Date:
2026-08-06

---

## Implementation prohibition (read first)

This ADR is a design record, not a blanket implementation authorization.
Approving this ADR approves the architecture below - it authorizes none of
the following on its own:

- **Caller cutover** - no production caller (`CartService`, `OrdersService`,
  or any controller) is wired to the checkout reservation engine by this
  document.
- **`CartService` changes** - the Redis-first write-order question and
  every other `CartService` modification remain unauthorized until Phase C's
  shadow-mode comparison is complete and separately approved.
- **Payment integration** - Phase E's actual design is deferred to its own
  planning session (see Decision 4); nothing here authorizes payment-module
  code changes.
- **Scheduler implementation** - Phase F (the cron job, the Postgres
  advisory lock, heartbeat-staleness polling) is design-approved in
  direction only; no scheduler code is authorized by this ADR.
- **Legacy Redis deletion** - no key, format, or code path may be deleted
  until Phase H is separately approved, gated on open decision 7 (drain
  wait time) being resolved first.
- **Phase 16A.0-A itself** - even though it has no blocking open decision,
  it still requires its own separate implementation approval before any
  source file is edited; approving this ADR is not that approval.

Implementation begins only when explicitly requested, one phase at a time,
in the order given in "Implementation sequence". Phases B, C, and E are
additionally gated on the open decisions listed at the end of this
document and must not begin before those are resolved.

## Context

Units 2.1-2.4.4 (`docs/architecture/reservation-lifecycle.md`) delivered a
complete, fully tested, additive cart-scoped checkout reservation engine.
It remains entirely unwired: `CartService` and `OrdersService` still call
the legacy per-product-hash reservation methods
(`reserve`/`release`/`getReservedByOthers`/`getAvailableToPurchase`), and
`CheckoutAttempt` is schema-only. A read-only investigation (this session)
mapped the current production flow in detail and produced a 19-section
cutover plan. This ADR records the architecture as revised after review,
resolves or explicitly defers each open decision from that plan, and fixes
the implementation sequence going forward. It supersedes nothing in
`reservation-lifecycle.md` (the Redis-side contract is unchanged) or
`ADR-005` (catalogue/inventory domain boundaries are unchanged) - both
remain authoritative for their own scope; this ADR is authoritative only
for how the existing engine gets wired to production callers.

## Decision

### 1. Layered CheckoutAttempt ownership - absolute prerequisite

No code anywhere queries `prisma.checkoutAttempt.*` directly except one
repository. Enforced layering, all downstream consumers depend only on the
layer above:

```
CheckoutAttemptRepository   (thin Prisma wrapper; owns the unique-key
                              upsert, the keyset stale-candidate query)
        v
CheckoutAttemptService      (lifecycle rules: create-or-resume, heartbeat,
                              COMMITTED/FAILED transitions, customerId
                              cross-check on every lookup)
        v
CheckoutCoordinatorService
```

This is now Phase A in its entirety, and the first unit built - it has no
dependency on any other open decision below and can proceed as soon as
implementation is authorized.

**Hard requirement carried into `CheckoutAttemptService`**: the write that
sets `status = COMMITTED` and `orderId` must execute inside the *same*
Postgres transaction as order creation, never as a separate write after
that transaction commits. Splitting them creates an unrecoverable ambiguous
state (order exists, but nothing durable says the attempt succeeded) that
no amount of scheduler logic can safely resolve after the fact. This is
non-negotiable, not a style preference, and applies regardless of which
service ends up calling the transaction.

**Failure message handling (Phase A, implemented)**: `markFailed`'s
`failureMessage` is sanitized, never rejected - unsafe or oversized message
content must never block the `PROCESSING` -> `FAILED` transition itself.
`CheckoutAttemptService.sanitizeFailureMessage` applies, in this exact
order:

1. Strip stack-trace frame lines (`/^\s*at\s/` per line).
2. Redact JWT-shaped tokens (`/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g`
   -> `[REDACTED]`), `Bearer` tokens (`/Bearer\s+\S+/gi` -> `Bearer [REDACTED]`),
   and `password`/`secret`/`token`/`api[_-]?key` key-value pairs
   (`/(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi` -> `$1=[REDACTED]`).
3. Trim. A message that sanitizes to the empty string is stored as `null`,
   never an empty string.
4. Truncate to 500 characters - **last**, after all redaction, never
   before. Truncating before redaction risks preserving a sensitive
   fragment that a later pass would otherwise have caught.

The stored value is always the sanitized representation; repeated-failure
duplicate-detection (`detailsMatched`) compares sanitized-vs-sanitized, not
raw-vs-sanitized. `CheckoutAttemptSummary` (the public projection returned
by `createOrResume`) never includes `failureMessage` in any form, sanitized
or not - no customer-safe message contract has been approved. Any future
consumer needing the raw stored `failureMessage` for internal/operational
purposes must go through a dedicated, explicitly-scoped method - none
exists yet.

### 2. CartService change is deferred, not immediate

The original plan's recommendation to move `CartService` to a
Redis-first write order is **not approved for immediate implementation**.
Changing cart mutation order carries real risk to the one part of this
system customers touch on every page load. Revised Phase C:

```
Feature flag (allowlist-based, per-request)
        v
Shadow mode: new engine runs alongside legacy for allowlisted
              customers, writes to its own key space, makes no
              admission decisions yet
        v
Compare old vs. new reservation totals for the same carts
        v
Only once comparison is clean -> replace CartService's legacy calls
```

`CartService` itself is not touched until shadow-mode comparison has
already validated the new engine's behavior against production traffic.
The Redis-first-vs-Postgres-first question (open decision 1) is answered
by that comparison, not decided upfront.

### 3. `CheckoutReservationFacade` - new abstraction layer

`CheckoutCoordinatorService` must not call `checkoutMark`, lease
inspection/extension, `checkoutRevert`, `finalizeCheckoutConsumption`,
`reconcileExpiredCheckoutPending`, `reserveOrRenew`, `releaseReservation`,
or `computeAvailableToPurchase` directly - that is nine call sites of
coupling for one caller. Interpose a facade:

```
CheckoutCoordinatorService
        v
CheckoutReservationFacade
        v
CheckoutReservationStateService / CheckoutLeaseStateService /
CheckoutReservationRecoveryService / CheckoutPendingReconciliationService /
InventoryReservationsService
```

The facade exposes a small, checkout-shaped surface (e.g. `markCart`,
`finalizeCart`, `revertCart`, `getAvailability`) and is the only thing
`CheckoutCoordinatorService` depends on from the inventory/checkout-state family.
It lives in `CheckoutModule` (see "Module architecture" below) and is what
Phase C's shadow mode and combined-availability bridge are built against,
so the comparison logic has one call site to instrument, not nine.

### 4. Payment integration is out of scope for this ADR

The three payment shortcomings identified in the original plan (no
duplicate-callback protection, no automatic compensation on payment
failure, no rollback path) are confirmed real and are **not designed
here**. They require their own dedicated planning session before any code
is written against them. Phase E in this ADR is placeholder-only: "payment
review, then payment compensation and duplicate-callback protection" - its
actual design is deferred.

### 5. Scheduler locking - PostgreSQL advisory lock, confirmed

A Postgres advisory lock (`pg_try_advisory_lock`), not a Redis distributed
lock. The project already depends on Postgres; introducing a second
distributed-locking subsystem for one job is not justified. No schema
migration is required.

### 6. Combined-availability formula - corrected to a mode-specific authority matrix (superseded during C2)

The original single global formula below is **obsolete and no longer
authoritative**:

```
Available = Product.quantityAvailable - LegacyReserved - NewReserved
```

It assumed the legacy and new-engine reservation populations are disjoint
- true only for a customer-split rollout. `MIRROR` mode, as actually
built in C1/C2, dual-writes the *same logical hold* into both systems for
100% of traffic, so summing both terms double-subtracts one real hold.
This was discovered and corrected during Phase 16A.0-C2 planning, before
`ReservationAvailabilityService` was implemented against it. Each mode
now owns exactly one admission authority - never a sum of two systems'
signals:

| Mode | Admission authority | Availability | New engine read? |
|---|---|---|---|
| `LEGACY` | Legacy | `Product.quantityAvailable - LegacyReservedByOthers` | No - never read |
| `MIRROR` | Legacy | Identical to `LEGACY` - `Product.quantityAvailable - LegacyReservedByOthers` | Only for a separate, non-blocking comparison (see §9) - legacy and new totals are **never summed** for admission, and the comparison can never alter or block customer admission |
| `CART_SCOPED` | New (cart-scoped) engine | `computeAvailableToPurchase`/`getAvailabilityWithSuspectStatus` (own-cart add-back active, suspect-flag-gated) | Yes, exclusively - legacy is **not** subtracted, even transitionally |
| `DRAINING` | Neither | No availability calculation at all - `MODE_NOT_ADMITTING` | No |

`CART_SCOPED` never subtracting legacy holds is only safe because
entering `CART_SCOPED` is contingent on a future cutover gate (not yet
implemented) proving legacy reservations are drained first: `MIRROR`
validated -> pause cart mutations/checkouts -> disable legacy reservation
creation/renewal -> wait the approved bounded drain window -> verify zero
valid legacy reservations remain -> only then transition to
`CART_SCOPED`. A legacy hold unexpectedly observed after `CART_SCOPED` is
entered is an operational/cutover invariant violation, not something
availability computation silently compensates for.

`LegacyReserved` above is read via the existing, unchanged
`InventoryReservationsService.getReservedByOthers`; the new-engine reads
are `InventoryReservationsService.computeAvailableToPurchase` and
`getAvailabilityWithSuspectStatus` (added in C2, see §9) - not
`getReservedTotalExcludingCart` directly. This table, not the formula
above, is authoritative until Phase H removes the legacy term entirely.

### 7. `PriceLockService` - dedicated ownership

Price-lock logic (creation at add-time, the explicit reconfirmation
endpoint, expiry checks, one-cart/one-currency enforcement) lives in a new
`PriceLockService`, not embedded inside `CartService`. `CartService` calls
it; it does not reimplement it. This is Phase B.

**Phase B, implemented, unwired**: `PriceLockService`/`PriceLockRepository`
exist in a standalone `PriceLockModule`, not registered in `AppModule` or
any other production module - `CartService` does not call it yet; that
integration is separate, later work. The following are now proven and
recorded here as implementation fact, not forward-looking design:

1. `PRICE_LOCK_TTL_SECONDS = 900` (900 seconds) - an independent business
   constant, not aliased to or derived from `RESERVATION_TTL_SECONDS`.
2. `Product.currency` is authoritative for an item's currency - confirmed
   to already exist as a real per-row column (`String @default("JMD")`),
   not merely a global constant.
3. `Cart.currency` is the cart-wide currency invariant, established
   atomically (`CartRepository.establishCurrencyIfCompatible`, a single
   conditional `updateMany` - `id = cartId AND customerId = customerId AND
   (currency IS NULL OR currency = productCurrency)`) before any
   `CartItem` lock write, never via a read-then-write.
4. `CartItem.lockedCurrency` snapshots `Product.currency` at lock creation
   or explicit reconfirmation time - never client-supplied.
5. Price locks and Redis stock reservations have fully independent
   timers, confirmed by construction: `PriceLockService` has no Redis
   dependency at all.
6. Ordinary reservation renewal does not renew `priceLockedAt` - only
   `createPriceLock` (first lock) or explicit `reconfirmPrice` write it.
7. A valid, complete price lock survives ordinary `Product` price and
   currency changes until the lock's own `PRICE_LOCK_TTL_SECONDS` expiry -
   `createPriceLock`'s existing-lock classification never reads `Product`
   for an already-COMPLETE lock. The lock is instead checked against the
   stored `Cart.currency` invariant (not current `Product.currency`) -
   `CART_CURRENCY_MISSING`/`CART_CURRENCY_MISMATCH` take priority over the
   TTL check, so an existing lock can still fail closed if the cart-wide
   invariant itself has been violated, without ever consulting the vendor's
   current price.
8. Only explicit `reconfirmPrice` may replace a COMPLETE existing lock's
   values - `createPriceLock` called again against a COMPLETE lock never
   overwrites it (`ALREADY_LOCKED`, or `PRICE_LOCK_EXPIRED` with zero
   writes if stale).
9. A partially-populated lock (any combination of `lockedUnitPrice`/
   `lockedCurrency`/`priceLockedAt` other than all-null or all-non-null)
   is `PRICE_LOCK_STATE_INVALID` and fails closed - never silently
   repaired or treated as a normal state by any of `createPriceLock`,
   `reconfirmPrice`, `getPriceLockState`, or `validateCartPriceLocks`.
10. Initial cart-currency establishment uses one atomic conditional
    database update (item 3 above), verified under real-Postgres
    concurrency: two `createPriceLock` calls racing different-currency
    products against the same null-currency cart produce exactly one
    winner and leave the loser's `CartItem` lock fields untouched.
11. `PriceLockService` is implemented in a standalone, currently-unwired
    `PriceLockModule` (importing `CartModule`/`ProductsModule` for their
    already-exported repositories - no new production-module exports were
    needed) - confirmed via repository-wide search that nothing outside
    `PriceLockModule` itself references it.
12. Final-`CartItem`-removal resetting `Cart.currency` to `null` is a
    **recorded, approved rule, not yet implemented** - it requires a
    `CartService` change and belongs to the future `CartService`
    integration/cutover phase, not Phase B.

### 8. Phase C foundation: `ReservationEngineMode` and rollback safety - design only, implementation begins with C0/C1

Resolved during Phase C's read-only gate-resolution planning, before any
Phase C source file is edited. This section records the design; C0
(register the four existing checkout-state services as `InventoryModule`
providers/exports) and C1 (`ReservationEngineModeConfigRepository` +
`ReservationEngineModeService`) are the only units authorized so far. C2
onward remain unauthorized until C1 is reviewed, tested, and separately
approved.

**State-transition table**:

| From | To | Precondition |
|---|---|---|
| `LEGACY` | `MIRROR` | None - starts mirrored writes to the new engine; zero admission-decision change |
| `MIRROR` | `LEGACY` | None - new-engine keys may still exist but are simply never read again; harmless |
| `MIRROR` | `CART_SCOPED` | Acceptable `MIRROR`-mode comparison evidence (a human decision informed by logged mismatches; C1 builds no automated promotion gate) |
| `CART_SCOPED` | `DRAINING` | None - the rollback-initiation step must never itself be blockable |
| `DRAINING` | `CART_SCOPED` | None - abort rollback |
| `DRAINING` | `LEGACY` | **Gated** - the rollback-verification check (below) must pass |
| `LEGACY` | `CART_SCOPED` | **Not a valid direct transition** - must pass through `MIRROR` first; no code path grants the new engine admission authority without prior shadow observation |
| `LEGACY` \| `CART_SCOPED` | `DRAINING` \| `MIRROR` (respectively, skipping the adjacent state) | **Not valid** - every transition passes through its immediate neighbor only |

`DRAINING` is a 4th explicit mode, not a boolean layered on top of another
mode (preferring one finite-state field over multiple booleans, per the
existing Decision 10 direction).

**Corrected during C2** (this paragraph previously stated that legacy
remains authoritative for admission during `DRAINING`, matching
`MIRROR`'s behavior - that was wrong and is corrected here):
`DRAINING` is an operational maintenance/rollback mode, not a variant of
`MIRROR`. While `DRAINING`:

- No legacy reservation admissions.
- No mirrored admissions.
- No cart-scoped admissions.
- No reservation renewal/extension through any future admission caller.
- Existing holds may only expire, reconcile, or drain - never grow, and
  never be renewed.

`ReservationAvailabilityService` (see §9) enforces this by checking mode
*before* any other call: on `DRAINING` it returns a typed
`{ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' }` immediately,
reading neither the legacy hash nor the new engine at all - never a
numeric `0`, which would be indistinguishable from genuinely sold out.
`MIRROR` would keep adding new mirrored holds, which is exactly wrong for
a rollback in progress; `DRAINING` sends the new engine **zero new writes
of any kind**, so its existing holds can only shrink (via their own
TTL/absolute-cap expiry or explicit release). The mode-specific
availability matrix in Decision 6 replaces the old global
combined-availability bridge for every mode, including `DRAINING`, which
now has no availability calculation at all rather than a formula that
happens to still run.

**Rollback invariants**:

1. The `DRAINING -> LEGACY` transition is **gated**, never a plain flag
   write - `ReservationEngineModeService` performs the check itself before
   calling the repository; the repository has no way to write `LEGACY`
   from `DRAINING` on its own.
2. The gate checks **both** the aggregated `product-total` keys and the
   cart-scoped reservation index independently - see "outstanding
   reservations vs. data-structure drift" below. Either reporting a
   non-zero/non-empty result rejects the transition.
3. **Recovery idempotency**: running the compensation reconciler (owned by
   C4, not yet implemented) any number of times against the same set of
   `PENDING` ledger rows produces the same final state as running it once.
   The reconciler never replays "redo the original write" - it always
   re-derives the *current actual* state of both systems and computes
   what, if anything, still needs to change. This is a permanent
   invariant, not an implementation detail that a future change is free to
   optimize away.

**Compensation reconciler ownership** (design intent for C4, not yet
built): a dedicated service, distinct from `ReservationEngineModeService`,
owning read access to both the `CartReservationCompensation` ledger
(Postgres) and current reservation state (Redis). It depends on neither
`CartService` nor `OrdersService`, matching every prior reconciliation-
shaped component in this codebase (`InventoryReconciliationService`'s
existing on-demand-only convention - no scheduler dependency is assumed,
since none exists yet). `ReservationEngineModeService` and the reconciler
are peers, not layered - the mode service never invokes the reconciler
directly, and the reconciler never changes `ReservationEngineMode`.

**"Outstanding reservations" vs. "data-structure drift"** - a deliberate
distinction the rollback gate must not conflate:

- **Outstanding reservations**: a genuinely live, unexpired cart-scoped
  hold in the new engine - a real customer's real claim on stock. This is
  the only condition that must actually block rollback.
- **Data-structure drift**: the fast-path `product-total` projection
  disagreeing with the ground-truth product-index membership - the same
  OVERCOUNT/UNDERCOUNT phenomenon `reservation-lifecycle.md` §7 already
  documents for ordinary operation. This is a bookkeeping inconsistency
  between two representations of the same reservations, not by itself
  proof that a live hold exists.
- **Why checking both independently matters**: if the gate trusted only
  `product-total` and that projection happened to be OVERCOUNT-drifted
  (stored higher than reality), rollback would be **falsely blocked**
  even with zero real holds remaining. If it trusted only the cart-scoped
  index and that were somehow inconsistent with the total, the reverse
  false signal is possible. Checking both surfaces a disagreement between
  them as its own, separate problem - repaired by the existing
  `reconcileProductReservedTotal` path, never silently resolved by the
  rollback gate simply picking whichever structure it happened to trust.

Sequence diagrams for the mutation-order and crash-recovery paths, and the
full `CartReservationCompensation` schema, are deferred to when C4's flows
are actually implemented and can be verified against real code, rather
than committed here as still-provisional design sketches.

### 9. Phase C, Unit C2: `ReservationAvailabilityService` - implemented, unwired

Implements the Decision 6 authority matrix. Lives inside the existing
`ReservationEngineModeModule` (not a new module, not
`CheckoutReservationFacade`), depending only on
`ReservationEngineModeService.getCurrentMode()` and
`InventoryReservationsService`. Public surface:

- `getGeneralAvailability(productId, quantityAvailable)` - no cart
  context, no own-cart add-back; for product-browsing use.
- `getCartAdmissionAvailability(productId, quantityAvailable, cartId)` -
  applies the requesting cart's own-cart add-back per mode; for
  cart-admission use.

Neither is wired to any caller. `CartService`, `ProductsService`, and
`CheckoutReservationFacade` (which does not yet exist) are all untouched
by C2; C3 is expected to have the future facade's own availability method
delegate to this service rather than duplicate its logic.

`InventoryReservationsService` gained
`getAvailabilityWithSuspectStatus(productId, quantityAvailable,
excludingCartId)`, returning `{ status: 'OK'; available: number } |
{ status: 'SUSPECT' }`. It shares one private calculation path
(suspect-flag read, product-total read, own-cart add-back, zero-floor)
with the pre-existing `computeAvailableToPurchase`, whose contract is
byte-for-byte unchanged (`SUSPECT` still collapses to a plain `0`) - no
existing caller needed to change.

**MIRROR comparison states** (`mirrorComparison`, informational only,
never able to alter or block the legacy-derived customer-facing
`available` value):

- `AVAILABLE` - the new engine's `getAvailabilityWithSuspectStatus` read
  succeeded and was not suspect.
- `COMPARISON_UNAVAILABLE` - the comparison read itself threw (a
  transient infrastructure failure). Deliberately never conflated with a
  confirmed data problem.
- `STRUCTURE_DRIFT_CONFIRMED` - the read succeeded but returned
  `SUSPECT`: the existing, persisted product suspect flag
  (`productSuspectKey`) is already set, meaning either
  `flagMalformedReservation` (write-time) or
  `reconcileProductReservedTotal` finding `UNDERCOUNT` (a completed
  reconciliation pass) has already recorded a concrete
  reservation-integrity problem for this product. **C2 does not perform
  a synchronous per-request `SMEMBERS` drift walk** - that full-catalog-
  or even per-product-scoped structural scan is deliberately reserved for
  `ReservationEngineModeService.verifyRollbackSafe()`'s rare,
  manually-triggered rollback gate (Decision 8). `STRUCTURE_DRIFT_CONFIRMED`
  reflects only the already-persisted suspect signal, never a fresh
  computation on the request path.

`CART_SCOPED` uses the same `getAvailabilityWithSuspectStatus` read for
admission: `OK` returns normal availability, `SUSPECT` fails closed with
a top-level `{ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' }` - never
a numeric `0` that could be mistaken for a legitimate sold-out
calculation.

Validated with 228 backend suites / 1926 tests passing (97.30%
statements / 93.75% branches / 97.03% functions / 97.22% lines coverage),
including a real-Redis test proving a genuinely mirrored duplicate hold
(the same quantity written to both the legacy hash and the cart-scoped
model) is subtracted exactly once for customer-facing admission, and a
real-Redis before/after keyspace snapshot proving the service performs no
writes.

### 10. Phase C, Unit C3: `ReservationGateway` / `CheckoutReservationFacade` - implemented, unwired

`ReservationGateway` is the stable, cart-facing reservation abstraction -
a genuine TypeScript interface (`reserveForCart`, `releaseForCart`,
`releaseCart`, `getCartAdmissionAvailability`), the first interface-typed
DI seam in this codebase. `CheckoutReservationFacade implements
ReservationGateway` and is the sole implementation. The module binds both:

```ts
providers: [
  CheckoutReservationFacade,
  { provide: RESERVATION_GATEWAY, useExisting: CheckoutReservationFacade },
],
exports: [RESERVATION_GATEWAY],
```

`RESERVATION_GATEWAY` (a `Symbol` token) is the **only** exported
dependency boundary from `CheckoutReservationModule` - `useExisting`
guarantees exactly one instance, addressable two ways: the concrete class
for internal use, the token for every future external consumer (a future
`CartService` integration, C4, C5, C6). `CheckoutReservationFacade`
itself is not exported; a module that only imports
`CheckoutReservationModule` cannot resolve it directly.
`CheckoutReservationModule` remains unwired - not imported by
`CartModule`, `AppModule`, or any other production module.

**Reserve routing** (per `ReservationEngineMode`):
- `LEGACY`: legacy `reserve` only.
- `MIRROR`: legacy write first, unwrapped - a thrown legacy exception
  propagates untouched and the mirror write is never reached, so the
  customer can never receive a false success. Once legacy succeeds, a
  cart-scoped mirror write is attempted best-effort; its outcome never
  changes the customer-facing result.
- `CART_SCOPED`: cart-scoped `reserveOrRenew` only, legacy never called.
- `DRAINING`: immediate `{ok:false, mode:'DRAINING',
  code:'MODE_NOT_ADMITTING'}` - reserve, increase, renew, and any
  desired-quantity decrease are all uniformly rejected; the facade never
  reads current reservation quantity to special-case a decrease. A full
  release remains the only supported C3 drainage mechanism (see below) -
  partial non-renewing quantity reduction during `DRAINING` is explicitly
  deferred to a future unit, and must not reuse `reserveOrRenew` if ever
  built (`reserveOrRenew` can renew reservation lifetime, which conflicts
  with `DRAINING`'s no-renewal invariant); it would need a dedicated
  operation that never creates or increases a hold, never changes
  `expiresAt`/`absoluteExpiresAt`/`lastRenewedAt`, and only atomically
  reduces the product-total by the exact delta.

**Release routing**:
- `LEGACY`: legacy `release` only.
- `MIRROR`: legacy release first, then a best-effort cart-scoped mirror
  release; mirror cleanup failure is non-blocking to the customer result.
- `CART_SCOPED` and `DRAINING`: cart-scoped `releaseReservation` only -
  **full cleanup remains allowed while `DRAINING`**, since the entire
  point of a rollback in progress is for existing holds to shrink toward
  zero. "No new admission" and "no cleanup" are deliberately not the same
  rule.

**Mirror diagnostics** (`MirrorDiagnostic`, strictly informational, never
able to alter or block the customer result): `SYNCED`, `NOT_ATTEMPTED`,
or `FAILED` with a reason code from a fixed union -
`PRODUCT_SUSPENDED` | `CHECKOUT_IN_PROGRESS` | `ACCOUNTING_UNDERFLOW` |
`UNKNOWN_INFRA_FAILURE`. No `REDIS_ERROR` - nothing in `RedisService`
exposes a typed transport/error classification that could produce one
reliably today. `ACCOUNTING_UNDERFLOW` is reported whenever the
cart-scoped write's own `underflow` field (from the existing, unchanged
`ReserveOrRenewSuccess`/`ReleaseReservationResult` shapes) is non-null -
**`SYNCED` is structurally unreachable on an underflowed write**, the
check runs before that branch. A thrown mirror exception always maps to
`UNKNOWN_INFRA_FAILURE`; the caught `Error`/its message is never exposed,
only a structured `{cartId, productId, mode, operation, reasonCode}` log
line.

**`releaseCart(cartId, productIds)`**: caller-supplied product ids only -
no Redis/catalog scan (legacy storage has no cart-wide index at all;
matches `OrdersService.checkout`'s existing precedent of deriving the
product list from durable `cart.items`). Deduplicates, preserves
first-seen order, and resolves `ReservationEngineMode` **exactly once**
for the whole call (`releaseForCartInMode`, the private routing helper,
never re-reads mode) - every item in one `releaseCart` operation is
guaranteed the same routing semantics even if an administrator changes
mode mid-call. No new whole-cart Lua script - implemented as a loop over
the same per-item release path `releaseForCart` itself uses.

**`getCartAdmissionAvailability`** is a pure, unmodified delegation to
`ReservationAvailabilityService.getCartAdmissionAvailability` (C2) - no
new arithmetic, no mode logic, no suspect handling, and no general
(no-cart) availability method on this interface at all - `CartService` is
the only intended consumer of this narrow, cart-admission-only surface.

**Explicitly out of scope for C3** (deferred to later units): `Cart`/
`Product`/`PriceLock`/`CheckoutAttempt` persistence, the compensation
ledger's actual persistence, idempotency (no `operationId` or correlation
field exists anywhere in `ReservationGateway`/`CheckoutReservationFacade`/
`MirrorDiagnostic` - C5 owns that contract and may extend the gateway
signature when it actually exists), payment, and the scheduler.
`customerId`/`cartId` ownership remains a **caller precondition** -
`reserveForCart`'s `customerId` is trusted only after the future caller
(a `CartService` integration, not yet built) has already proven the
authenticated customer owns `cartId`; C3 performs syntactic identifier
validation only and has no `CartRepository`/`ProductsRepository`/
`PrismaService` dependency of any kind.

Validated with 231 backend suites / 1971 tests passing (97.36%
statements / 93.90% branches / 97.08% functions / 97.28% lines coverage),
including real-Redis proof that a `MIRROR` accounting-underflow write
still leaves the legacy reservation correct and the customer result
successful, and that `DRAINING` permits a full release to drain a
genuine `CART_SCOPED`-era hold to zero.

### 11. Phase C4 foundation: durable mirror compensation - schema and repository implemented, unwired (C4.0/C4.1)

**C4.0**: `CheckoutAttemptService`'s failure-message sanitizer (stack-line
stripping, JWT/Bearer/password-secret-token-apikey redaction, trim,
length cap) was extracted into a neutral
`common/utils/sanitize-error-message.util.ts`, parameterized on max
length rather than hardcoded. `CheckoutAttempt` behavior is unchanged -
its own full test suite passes without modification. This extracted
function is now the approved source for `CartReservationCompensation`'s
`lastError` sanitization - no second copy of these regexes exists
anywhere in the codebase.

**C4.1**: `CartReservationCompensation` - the durable recovery record for
`MIRROR`-mode divergence between the authoritative legacy reservation and
the non-authoritative cart-scoped mirror, created only when the legacy
write already succeeded and the mirror write failed (C3's
`MirrorDiagnostic` reporting `FAILED`). Two cases only, per the approved
C4 scope: `RESERVE_MIRROR` (legacy reserve succeeded, mirror reserve
failed) and `RELEASE_MIRROR` (legacy release succeeded, mirror release
failed) - never created for `LEGACY`-only or `CART_SCOPED`-only
operations (single system, no split state to reconcile).

- **`operation`**: `RESERVE_MIRROR` | `RELEASE_MIRROR` - diagnostic only;
  recovery always re-derives desired state from current `CartItem` truth,
  never replays either as a literal command.
- **`status`**: `PENDING` | `PROCESSING` | `BLOCKED` | `RESOLVED` |
  `PERMANENT_FAILURE`.
- **`reasonCode`**: `PRODUCT_SUSPENDED` | `CHECKOUT_IN_PROGRESS` |
  `ACCOUNTING_UNDERFLOW` | `UNKNOWN_INFRA_FAILURE` - mirrors C3's
  `MirrorFailureReasonCode` exactly (kept in sync by convention, not a
  shared TypeScript type across the Prisma boundary).
- **`generation`** is the sole concurrency counter - no separate
  `version` field exists. It advances on every new divergence recorded
  against an unresolved row; `PROCESSING -> RESOLVED` (and `-> PERMANENT_
  FAILURE`) are conditioned on it matching what the claiming worker
  observed, so a newer divergence arriving mid-repair defeats a stale
  resolve/give-up attempt and the row is requeued instead - the newer
  divergence is never lost, and a worker can never mark stale work
  resolved.
- **`blockedCheckCount`** is tracked entirely separately from
  `attemptCount` - checking whether a `BLOCKED` precondition (product
  suspect state, or `DRAINING` mode) has cleared is never itself a
  recovery attempt and never counts toward the attempt-based
  `PERMANENT_FAILURE` threshold.
- **`Cart`/`Product`** relations use `onDelete: Restrict`, matching
  `CheckoutAttempt`'s precedent - a `Cart` or `Product` can never be
  hard-deleted while any compensation row (resolved or not) still
  references it; this is enforced by the FK constraint itself, not
  detected or branched on by application code.
- **No `correlationId`/`requestId`** - neither has a real source or
  recovery/operational use yet (both would be constant/always-null); the
  row's own `id` serves as the correlation key today. Deferred to
  whichever of C5/C6 introduces a genuine external correlation source.
- **Partial uniqueness** (at most one unresolved row per `(cartId,
  productId)`, independent of `operation`) is enforced **only** via a
  hand-added migration-SQL index
  (`one_unresolved_compensation_per_cart_product`, `WHERE status IN
  ('PENDING','PROCESSING','BLOCKED')`) - deliberately not a Prisma-level
  `@@unique`, which would be a global constraint and incorrectly block a
  fresh row once any historical `RESOLVED`/`PERMANENT_FAILURE` row exists
  for the same pair. Verified via `prisma migrate status`/`migrate diff
  --exit-code` reporting no drift, and a real-Postgres `pg_indexes`
  assertion on the exact predicate. Historical resolved/permanently-failed
  rows may coexist without limit for the same `(cartId, productId)`.

**`CompensationRepository`** exposes eleven primitive conditional-update
methods, each representing exactly one concrete state transition
(matching `CheckoutAttemptRepository`'s established idiom - no repository
method decides *which* transition to apply, that is
`CompensationService`'s job, C4.2 onward):

- Deterministic unresolved lookup (`findUnresolvedByCartAndProduct`,
  ordered `createdAt asc` - the partial index should guarantee at most
  one match, but the query stays reproducible rather than
  database-order-dependent if that invariant is ever violated).
- `claimForRecoveryAttempt` folds stale-`PROCESSING` reclamation
  (`lastAttemptAt` older than 5 minutes) into the same conditional update
  as an ordinary due-`PENDING` claim - contractual, not a fallback path.
  A stale reclaim consumes a real recovery attempt, identical to any
  other claim.
- Generation-gated `resolveIfGenerationMatches` and
  `markPermanentFailureIfGenerationMatches` - the two transitions that
  claim "recovery is complete/abandoned for the state I observed."
- Generation-gated `unblockIfGenerationMatches`/
  `rescheduleBlockedCheckIfGenerationMatches` - gated not because they
  claim convergence, but to prevent a slow precondition check (a Redis
  round trip) from clobbering a fresher arrival's already-correct state
  with a conclusion computed from stale input.
- `advanceGenerationPreservingStatus`/`advanceGenerationAndUnblock` - the
  two arrival-time transitions: a new divergence always advances
  `generation` and overwrites `reasonCode`/`lastError`/`nextAttemptAt`
  (latest-wins), and unblocks a `BLOCKED` row only when the newest
  `reasonCode` is ordinarily retryable (`ACCOUNTING_UNDERFLOW` leaves it
  `BLOCKED`).
- `MAX_OPTIMISTIC_RETRIES = 3` is defined at the repository level - the
  shared budget for C4.2's bounded `recordDivergence` retry loop (and any
  future bounded optimistic-retry loop in this subsystem), so it is
  reused rather than each caller hardcoding its own limit.

Repository tests are seed-independent - they upsert their own `Role`
rows (matching `prisma/seed.ts`'s own idempotent convention) rather than
depending on the application seed script having been run first.

**Explicitly not yet built**: no `CompensationService`, no reconciler, no
decorator (`CompensatingReservationGateway` or similar), no scheduler, no
`CartService`/`ProductsService`/`OrdersService` wiring.
Additive and unwired - nothing outside this unit's own tests calls
`CompensationRepository`.

Delivered in C4.2 (§12 below): `CompensationService.recordMirrorDivergence`,
the bounded optimistic-retry loop, and latest-wins arrival semantics.

Validated with 234 backend suites / 2003 tests passing (97.39%
statements / 93.83% branches / 97.10% functions / 97.31% lines
coverage).

### 12. Phase C4, Unit C4.2: `CompensationService.recordMirrorDivergence` - implemented, unwired

`CompensationService` is the sole writer of `CartReservationCompensation`
rows. It owns exactly one operation, `recordMirrorDivergence(input)`,
which durably records that a `MIRROR`-mode legacy write succeeded while
its mirror counterpart failed (C3's `MirrorDiagnostic` reporting
`FAILED`). It performs no recovery/reconciliation itself - that is C4.3.

- **Runtime validation, not just TypeScript typing**: `operation` and
  `reasonCode` are checked against `Set`-backed membership lists at the
  service boundary, independent of their Prisma enum typing.
  `RESERVE_MIRROR` requires a non-null, format-valid `customerId` and a
  positive-integer `desiredQuantity`; `RELEASE_MIRROR` requires both
  `null`. `cartId`/`productId` reuse the existing reservation-key
  validator. Invalid input returns `{ok:false, code:'INVALID_INPUT',
  field, reason}` and never reaches the repository.
- **`lastError`** is sanitized via C4.0's `sanitizeErrorMessage` (500-char
  cap) before it is ever written or logged - raw error text never reaches
  the database or the logger.
- **Bounded optimistic-retry loop** (`MAX_OPTIMISTIC_RETRIES = 3`, defined
  at the repository level, per §11): attempt `create`; on `P2002` (the
  partial unique index), read the existing unresolved row via
  `findUnresolvedByCartAndProduct`; if it already resolved, retry `create`;
  otherwise apply the appropriate generation-advancing update
  (`advanceGenerationAndUnblock` when the row is `BLOCKED` and the new
  `reasonCode` is not `ACCOUNTING_UNDERFLOW`, `advanceGenerationPreservingStatus`
  otherwise); a zero-row update result (the row resolved between the read
  and the write) also retries. Exhausting all attempts throws a plain
  internal-consistency `Error` - this is treated as a programming/data
  invariant violation, never a normal result the caller branches on.
- **Latest-wins arrival semantics (final, corrected form)**: a new
  divergence against an already-unresolved row for the same `(cartId,
  productId)` unconditionally overwrites `operation`, `customerId`,
  `desiredQuantity`, `reasonCode`, sanitized `lastError`, and
  `nextAttemptAt`, and always advances `generation`. It never touches
  `attemptCount`, `blockedCheckCount`, or `createdAt`. This was widened
  from the originally-approved contract (which overwrote only
  `reasonCode`/`lastError`/`nextAttemptAt`) specifically because
  deduplication is keyed on `(cartId, productId)` alone, independent of
  `operation` - leaving `operation`/`customerId`/`desiredQuantity` stale
  could otherwise produce a self-contradictory row (e.g. `operation:
  RESERVE_MIRROR` paired with a since-superseded `RELEASE_MIRROR`'s null
  `desiredQuantity`).
- **`BLOCKED` arrival status rule** (unchanged from the approved C4.1
  contract): a new divergence with `reasonCode: ACCOUNTING_UNDERFLOW`
  leaves the row `BLOCKED`; any other `reasonCode` unblocks it to
  `PENDING`.
- **Result type** deliberately has no `currentGeneration` field -
  `generation` stays internal to the repository/recovery-worker
  relationship; the service only reports `{ok:true, outcome:'CREATED'|
  'GENERATION_ADVANCED', compensationId}` or the `INVALID_INPUT` failure
  above. No raw SQL was introduced solely to surface an exact generation
  value to callers that do not need it.
- **Module boundary**: `MirrorCompensationModule` provides
  `CompensationRepository`/`CompensationService` and exports only
  `CompensationService`. It declares no `imports` - `PrismaService` is
  available via `PrismaModule`'s existing `@Global()` registration,
  confirmed by direct inspection before the module was written.
  `AppModule` imports it, but nothing else references
  `CompensationService` yet - **fully additive and unwired**, matching
  every prior unit in Phase C4.
- **Explicitly not built in C4.2** (unchanged prohibitions, reaffirmed):
  no desired-state recovery/reconciler (C4.3), no batch orchestration
  (C4.4), no scheduler (C4.5), no `CompensatingReservationGateway` or any
  other `ReservationGateway` composition (deferred until open decision 1,
  Redis-first-vs-Postgres-first `CartService` writes, is resolved - a
  decorator built earlier would silently bake in an unreviewed assumption
  about write ordering), no `CartService`/`ProductsService`/`OrdersService`
  wiring, no `CartRepository.findItemByCartAndProduct`.
- 22 new tests across 3 files (`compensation.service.spec.ts` - unit,
  mocked repository, including sanitization and bounded-retry-exhaustion
  proofs; `compensation-concurrency.service.spec.ts` and
  `compensation-latest-wins.service.spec.ts` - real Postgres, split to
  stay under the 400-line file cap), plus repository-level test updates
  for the widened arrival-update contract. Full backend suite 234 -> 237
  suites, 2003 -> 2025 tests, exit 0. Coverage 97.43%/93.97%/97.12%/97.35%
  (80/90/90/90 threshold), exit 0.

#### `_prisma_migrations` incident - confirmed, reproduced root cause

During C4.2 validation, the shared development database's
`_prisma_migrations` table was found missing entirely (all schemas
searched, not present anywhere), alongside a near-total data wipe
(`products`/`carts`/`vendors` at 0 rows). A structural comparison against
a freshly-migrated disposable database (`prisma migrate deploy`, all 31
migrations) showed an exact schema match except for `_prisma_migrations`
itself and row counts - ruling out a partial/interrupted migration and
pointing at a scratch-space wipe instead.

**Root cause, confirmed by reproduction, not merely inferred from
correlation**: running

```
prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DATABASE_URL" --exit-code
```

with `--shadow-database-url` mistakenly pointed at the **same** URL as the
live target (rather than a separate shadow database) causes Prisma to
reset and replay that target as scratch space for the diff computation.
`migrate diff` never writes to `_prisma_migrations` - only `migrate
deploy` does - so the table disappears along with all data, while the
resulting schema still ends up structurally correct (the replay applies
every migration). This was reproduced on a disposable database only
(`iriefishmongers_repro_disposable`, created and dropped for this test,
never the shared dev database): a `Role` marker row planted before the
command was present (count 1) beforehand, the command reported "No
difference detected" (exit 0, matching the original symptom), and
immediately afterward `_prisma_migrations` no longer existed and the
marker row count was 0. The shared dev database itself was never touched
during this reproduction.

**Repair is explicitly deferred to a separate maintenance task**,
requiring its own approval and audit trail - not performed as part of
C4.2. The proposed repair (31x `prisma migrate resolve --applied
<migration_name>`, restoring `_prisma_migrations` bookkeeping without
altering the already-correct schema, followed by `prisma:seed`) remains a
proposal only. `prisma migrate resolve` and any other migration-history-
mutating command must not be run against the shared dev database without
that separate, explicit approval.

**Required post-repair verification, once that separate maintenance task
is approved and executed**: after all 31 `migrate resolve --applied`
calls, (1) run `prisma migrate status` and confirm it reports the
database as up to date; (2) run `prisma migrate deploy` against a fresh
disposable database and (3) compare the migration names recorded in the
repaired shared dev database's `_prisma_migrations` against both that
disposable database's table and the `prisma/migrations` directory on
disk (count and names, not just count). This confirms not only that
Prisma considers the repaired database current, but that the
reconstructed history exactly matches source control - not merely that
the row count looks plausible.

### 13. Phase C4, Unit C4.3: desired-state reconciler - implemented, unwired

`CompensationReconciliationService.attemptRecovery` and
`CompensationBlockedRecheckService.recheckBlocked` are the recovery layer
that consumes `CartReservationCompensation` rows written by C4.2. Two
single-row entry points; no batching (C4.4) or scheduling (C4.5) exists
yet.

1. **Desired-state authority**: recovery is authoritative from *current*
   durable `Cart`/`CartItem` state, read via `CartRepository.findById` and
   the new `CartRepository.findItemByCartAndProduct(cartId, productId)` -
   never from `CartService`. A `CartItem` present means the desired state
   is a reservation for its *current* `quantity`; absent means no
   reservation (release).
2. **`compensation.operation`/`customerId`/`desiredQuantity` remain
   historical diagnostics only** - they are never replay instructions.
   Recovery re-derives desired state fresh on every attempt.
3. **`CartRepository.findItemByCartAndProduct(cartId, productId)`** - a
   plain `findUnique` on the existing `@@unique([cartId, productId])`
   index, added specifically as this unit's desired-state read.
4. **`CompensationBlockReason`** (`PRODUCT_SUSPECT` | `MODE_NOT_ADMITTING`)
   is a separate persisted enum/column from `CompensationReasonCode`,
   deliberately: `reasonCode` is the latest mirror/recovery divergence
   diagnostic; `blockReason` is why the row is currently unable to
   proceed. A row blocked by `DRAINING` mode never overwrites a real
   mirror diagnostic - `blockReason` carries that fact instead.
5. **`blockReason` is cleared to `null`** on every transition that leaves
   `BLOCKED` (`unblockIfGenerationMatches`, `advanceGenerationAndUnblock`).
6. **`PROCESSING -> BLOCKED`** uses the new, generation-gated
   `blockIfGenerationMatches` - the primitive that establishes `BLOCKED`
   for the first time (`create()` always starts a row `PENDING`). It may
   write `reasonCode` only when the live recovery attempt itself produced
   a new diagnostic (never for a mode-blocked row, which attempts no
   write at all); it never touches `generation`/`attemptCount`/
   `blockedCheckCount`/`operation`/`customerId`/`desiredQuantity`.
7. **Normal retry scheduling** uses `requeueAfterAttemptIfGenerationMatches`
   - also generation-gated, replacing an earlier, ungated form, because a
   stale worker must never delay a newer generation using an old backoff
   schedule.
8. **`releaseStaleClaim` remains intentionally ungated** - it exists
   specifically to release a claim that a generation-gated write has just
   proven stale, and makes no assertion about convergence. It is
   deliberately distinct from `requeueAfterAttemptIfGenerationMatches` and
   must never be replaced by a generation-gated primitive.
9. **Mode policy**:
   - `MIRROR`: converge to current durable state (reserve if
     `desiredQuantity > 0`, else release).
   - `CART_SCOPED`: converge identically; additionally logs an invariant
     warning, since a genuinely clean cutover to `CART_SCOPED` should have
     left zero unresolved compensation rows.
   - `DRAINING`: `desiredQuantity > 0` never attempts a write - blocks
     directly with `blockReason: MODE_NOT_ADMITTING`; `desiredQuantity ===
     0` releases normally (full cleanup stays allowed while `DRAINING`,
     matching C3's precedent).
   - `LEGACY`: never recreates a cart-scoped reservation regardless of
     `desiredQuantity` - always releases, resolving as
     `RESOLVED_NO_LONGER_NEEDED_LEGACY` on success (distinct from
     `RESOLVED_CONVERGED`, since the mirror system is retired, not merely
     satisfied).
10. **Failure classification**: `ACCOUNTING_UNDERFLOW` and
    `RESERVATION_PRODUCT_SUSPENDED` both classify to `BLOCKED_PRODUCT_SUSPECT`
    (`blockReason: PRODUCT_SUSPECT`). `RESERVATION_CHECKOUT_IN_PROGRESS`
    and any unexpected infrastructure exception both use the normal retry
    schedule - `CHECKOUT_IN_PROGRESS` is never routed through the
    product-suspect BLOCKED checker.
11. **Recovery budget**: `MAX_RECOVERY_ATTEMPTS = 5`, fixed backoff of 30s
    / 120s / 600s / 1800s before attempts 2-5, then `PERMANENT_FAILURE`.
    `attemptCount` is the budget for the whole unresolved-compensation
    episode, not a fresh budget per generation.
12. **`BLOCKED` rechecks never consume `attemptCount`** -
    `rescheduleBlockedCheckIfGenerationMatches` increments only
    `blockedCheckCount`. `recheckBlocked` branches on the persisted
    `blockReason` (not `reasonCode`), re-derives desired state fresh each
    check, and unblocks unconditionally the moment desired quantity drops
    to 0, regardless of block cause.
13. **Generation mismatches** on `resolveIfGenerationMatches`,
    `blockIfGenerationMatches`, `requeueAfterAttemptIfGenerationMatches`,
    and `markPermanentFailureIfGenerationMatches` all return
    `REQUEUED_NEWER_DIVERGENCE` after safely releasing the claim via
    `releaseStaleClaim` - never treated as failure. Safe by construction:
    a concurrent `recordMirrorDivergence` arrival can only have reached
    the row via `advanceGenerationPreservingStatus`, which bumps
    `generation` but never touches `status`, so the row is provably still
    `PROCESSING` and safe to release without touching its (already
    correct) diagnostic fields.
14. **Explicitly not built in C4.3**: no batch orchestrator (C4.4), no
    scheduler (C4.5), no `CompensatingReservationGateway` or other
    `ReservationGateway` composition, no `CartService`/`ProductsService`/
    `OrdersService` wiring, no C5 idempotency, no payment integration, no
    production mode switching. `MirrorCompensationModule` remains
    unimported by `AppModule`.

Migration `20260809171336_add_compensation_block_reason` (additive only:
`CompensationBlockReason` enum + nullable `blockReason` column),
drift-verified against a genuinely separate disposable shadow database.
115 new tests across 5 new files (unit, mode-matrix, real Postgres+Redis
integration) plus updates to existing repository specs. Full backend
suite 241 suites / 2104 tests, exit 0. Coverage 97.50%/94.18%/97.17%/97.43%
(80/90/90/90 threshold); `mirror-compensation/services` at 100/100/100/100.

### 14. Phase C4, Unit C4.4: compensation batch orchestration - implemented, unwired

`CompensationBatchService` is the batch orchestration layer over C4.3's
single-row recovery services - it owns candidate discovery, dispatch, and
result aggregation only, and never reimplements any part of the
reconciliation/blocked-recheck state machines.

**1. Ownership and public API**:

```ts
runBatch(input: { now: Date; limit?: number }): Promise<RunBatchResult>
```

`DEFAULT_BATCH_SIZE = 50`, `MAX_BATCH_SIZE = 200`. `limit`, when
supplied, must be a positive integer no greater than `MAX_BATCH_SIZE` -
never silently clamped. Invalid input (`now` not a valid `Date`, or an
out-of-range `limit`) returns `{ ok: false, code: 'INVALID_INPUT', field,
reason }`, matching `CompensationService.recordMirrorDivergence`'s
established C4.2 validation-failure shape.

**2. Candidate eligibility**:

```
PENDING:    status = 'PENDING'    AND nextAttemptAt <= now
BLOCKED:    status = 'BLOCKED'    AND nextAttemptAt <= now
PROCESSING: status = 'PROCESSING' AND lastAttemptAt < now - PROCESSING_STALE_TIMEOUT_MS
```

Both `findBatchCandidateIds` (candidate discovery) and
`claimForRecoveryAttempt` (the per-row atomic claim, C4.1) derive their
stale cutoff from the same exported `PROCESSING_STALE_TIMEOUT_MS = 5 *
60 * 1000` - one contractual definition of "stale `PROCESSING`", never a
second copy.

**3. Normalized ordering**: `eligibleAt ASC, id ASC`, where
`PENDING`/`BLOCKED` use `eligibleAt = nextAttemptAt` and `PROCESSING`
uses `eligibleAt = lastAttemptAt + PROCESSING_STALE_TIMEOUT_MS`. Prisma's
query builder cannot express this status-conditional ordering, so
`findBatchCandidateIds` is a narrowly scoped, fully parameterized raw
query (never string-concatenated).

**4. Timestamp binding invariant (permanent)**: the compensation table's
due/stale columns are PostgreSQL `timestamp without time zone`. Passing
a JavaScript `Date` directly into the raw candidate query binds it as
`timestamptz`, which Postgres then silently shifts by the session
timezone before comparing against the naive column - confirmed
reproducible in this environment (session timezone `America/New_York`).
`findBatchCandidateIds` therefore converts each boundary timestamp to an
ISO string and explicitly casts it to `::timestamp` before comparison. A
dedicated regression test (`compensation.repository.spec.ts`) protects
this - **do not simplify this back to direct `Date` binding without
first proving equivalent timestamp semantics** in this database's actual
session timezone configuration.

**5. Sequential batch execution**: candidates are processed strictly
sequentially, in the order the repository query returns them. No
`Promise.all`/`Promise.allSettled`/bounded parallelism inside `runBatch`
- matching this codebase's established batch-sweep convention
(`ComplianceScoreCronService.runBatchRecompute`,
`SLABreachDetectionService`). Dispatch is by `status` alone: `BLOCKED` →
`CompensationBlockedRecheckService.recheckBlocked`; every other eligible
status → `CompensationReconciliationService.attemptRecovery`.

**6. Failure isolation**: one candidate throwing does not abort the
batch - each candidate is wrapped in its own independent try/catch.
Unexpected exceptions are sanitized through the shared
`sanitizeErrorMessage` before being recorded; no raw `Error` object and
no raw `lastError` ever enters the returned batch result.

**7. Result shape and outcome mapping**:

```ts
{
  candidatesFound, attempted, resolved, requeued, retryScheduled,
  blocked, unblocked, permanentFailure, staleBlockedCheck, skipped,
  errors: Array<{ compensationId: string; message: string }>,
  durationMs
}
```

`RESOLVED_CONVERGED`/`RESOLVED_NO_LONGER_NEEDED_LEGACY` → `resolved`;
`REQUEUED_NEWER_DIVERGENCE` → `requeued`; `RETRY_SCHEDULED` →
`retryScheduled`; `BLOCKED_PRODUCT_SUSPECT`/`BLOCKED_MODE_NOT_ADMITTING`
→ `blocked`; `UNBLOCKED_PENDING` → `unblocked`; `PERMANENT_FAILURE` →
`permanentFailure`; `STALE_BLOCKED_CHECK` → `staleBlockedCheck`;
`ALREADY_RESOLVED`/`NOT_DUE`/`NOT_FOUND` → `skipped`.

**8. Concurrency architecture**: candidate discovery performs no
locking of any kind - no Postgres advisory lock, no `SELECT ... FOR
UPDATE SKIP LOCKED`. Correctness under overlapping batch workers comes
entirely from the existing atomic-claim (`claimForRecoveryAttempt`) and
generation-gated repository primitives already shipped in C4.1/C4.3.
Real-Postgres tests prove overlapping batch workers never duplicate a
`PENDING` or stale-`PROCESSING` recovery attempt (row-scoped proof via
`attemptCount === 1`). `BLOCKED` rechecks are **not** promised
exactly-once processing - overlapping rechecks may both perform a real
precondition read (harmless duplicate bookkeeping); correctness is
defined by the row's final generation-gated state transition, not by
which call "wins".

**9. Redis integration-test isolation (test infrastructure, not
production topology)**: every pre-existing real-Redis integration spec
in this codebase (`checkout-reservation-facade`, `reservation-availability`,
`reservation-engine-mode-rollback`, `compensation-reconciliation`) shares
a single logical Redis database index (1) by established convention.
During C4.4 validation this produced a reproducible collision: under
genuinely overlapping Jest workers, one spec file's per-test `flushdb()`
could erase another file's just-written key before its own assertion
ran. The underlying claim/generation logic was proven correct in every
case (row-scoped assertions always passed); only the Redis-side
assertion was affected. Fixed by giving the new C4.4 batch integration
suite its own dedicated logical Redis database index (2), without
altering the pre-existing shared-index-1 convention used elsewhere. This
is a test-isolation decision only - it does not change production Redis
topology or key namespacing.

**10. Explicitly not built in C4.4**: no scheduler execution, no
`@Cron`, no `AppModule` wiring, no caller cutover, no `ReservationGateway`
composition, no advisory locks, no `SKIP LOCKED`, no schema/migration
change. C4.5 (the scheduler) remains a separate, future unit.

Migration: none (C4.4 required no schema change). 46 new tests across 3
new files (unit, real Postgres+Redis integration/concurrency) plus
targeted repository-test additions. Full backend suite 243 suites / 2151
tests, exit 0. Coverage 97.49%/94.19%/97.19%/97.42% (80/90/90/90
threshold); `mirror-compensation/services` at 99.25%/98.7%/100%/99.22%.

## Module architecture (revised)

```
InventoryModule
  exports: InventoryReservationsService (existing),
           CheckoutReservationStateService, CheckoutLeaseStateService,
           CheckoutReservationRecoveryService,
           CheckoutPendingReconciliationService   <- newly exported, not
                                                      newly built

CheckoutAttemptModule
  exports: CheckoutAttemptRepository, CheckoutAttemptService

PriceLockModule   <- implemented as standalone (Phase B decision, see
                       Decision 7); imports CartModule, ProductsModule
  exports: PriceLockService, PriceLockRepository

CheckoutModule
  imports: AuthModule, CartModule, InventoryModule, CheckoutAttemptModule,
           PriceLockModule, PaymentsModule, OrdersModule
  providers: CheckoutReservationFacade, CheckoutCoordinatorService,
             (Phase F) the recovery scheduler
```

Dependency direction unchanged from the original plan: `CheckoutModule` is
the only new edge, pointing one way, into the existing modules - none of
them import it back.

## Implementation sequence (approved order)

| Phase | Scope | Blocked on |
|---|---|---|
| A | `CheckoutAttemptRepository`, `CheckoutAttemptService`, repository tests | Nothing - ready now |
| B | `PriceLockService`, cart currency enforcement, price-lock validation | **Complete** - open decisions 4, 8 resolved |
| C | `CheckoutReservationFacade`, feature flags, shadow mode, combined availability - **no production cutover** | Open decisions 1 (resolved empirically by C's own shadow comparison, not upfront), 9 (`addItem` idempotency, dependent on 1), 10 (rollout-flag mechanism) |
| D | `CheckoutCoordinatorService`, `CheckoutAttempt` lifecycle wiring, `checkoutMark` integration | A, C |
| E | Payment review (separate planning session), then payment compensation and duplicate-callback protection | Its own planning session - open decision 5 |
| F | Scheduler, heartbeat recovery, Postgres advisory lock | A |
| G | Limited allow-list rollout, shadow validation, monitoring | C, D |
| H | Maintenance window, legacy Redis drain, production cutover | G at full rollout; open decision 7 (drain wait time) |

## Open decisions

Carried forward from the read-only plan, resolved or re-scoped as noted.
Every item below is either marked **OPEN** (with the phase it blocks) or
**RESOLVED** (with the resolution and, where applicable, which decision
above resolved it) - nothing is silently dropped from the original
12-item list. Nothing marked **OPEN** may be implemented against until
resolved.

1. **Redis-first vs. Postgres-first cart writes** - **OPEN**, blocks completion of Phase C (the step that replaces `CartService`'s legacy calls) and, transitively, Phase D. Deferred to Phase C's own shadow-mode comparison rather than decided upfront (see Decision 2 above).
2. Server-generated vs. client-generated idempotency keys - **RESOLVED: server-generated** (see Decision 1).
3. Can a `FAILED` `CheckoutAttempt` retry with the same idempotency key? - **RESOLVED: no - a retry after `FAILED` always uses a new idempotency key.**
4. Price-lock duration (`PRICE_LOCK_TTL_SECONDS`) - **RESOLVED: 900 seconds** (see Decision 7, item 1), implemented as an independent constant, never derived from `RESERVATION_TTL_SECONDS`.
5. **Payment-failure compensation behavior** - **OPEN**, blocks Phase E. Explicitly deferred to a dedicated payment-integration planning session (see Decision 4); not designed by this ADR.
6. Scheduler distributed-lock mechanism - **RESOLVED: PostgreSQL advisory lock, not Redis** (see Decision 5).
7. **Legacy-drain wait time** - **OPEN**, blocks Phase H. Direct conflict between a prior session's stated 70 minutes and `reservation-lifecycle.md` §8's approved 20 minutes. One authoritative value must be set before Phase H; not resolved by this ADR.
8. Does `Product` carry its own currency field, or is currency purely cart-level? - **RESOLVED: yes** - `Product.currency` (`String @default("JMD")`) is a real per-row column, confirmed by direct schema inspection, and is the authoritative source `PriceLockService` reads from (see Decision 7, item 2).
9. **`addItem`'s non-idempotent increment semantics** - **OPEN**, blocks Phase C/D. Depends on open decision 1's outcome (the write-order/idempotency redesign); not resolved separately from it.
10. **Rollout-flag mechanism (exact implementation)** - **OPEN**, blocks Phase C. Decision 2 above settles the *direction* (allowlist-based, evaluated per-request, not a bootstrap-level toggle) but not the *mechanism* - env var, DB-backed allowlist table (following the `MarketplaceModeConfig` precedent), or something else. This is a new pattern for this codebase with no existing precedent (`ENABLE_SCHEDULER` is the only prior art, and it is bootstrap-level/all-or-nothing, which this explicitly is not) and needs its own explicit sign-off before Phase C begins.
11. Ownership of the combined-availability bridge - **RESOLVED, corrected during C2**: originally assigned to `CheckoutReservationFacade.getAvailability` computing one global formula (see the superseded text in Decision 6); actually implemented as the standalone `ReservationAvailabilityService` (Decision 6's mode-specific authority matrix, §9) inside `ReservationEngineModeModule`. `CheckoutReservationFacade` does not yet exist; when C3 builds it, its `getAvailability` is expected to delegate to `ReservationAvailabilityService` rather than reimplement the calculation. This closes what was open decision 9 in the original read-only plan; recorded here so it is traceable rather than silently dropped.

## Document authority

This ADR does not restate or compete with:
- **`docs/architecture/reservation-lifecycle.md`** - remains the technical reference for the Redis reservation lifecycle itself; unchanged by this ADR.
- **`ADR-005`** - remains authoritative for catalogue/inventory domain boundaries; unchanged.
- **`docs/roadmap.md`** - remains the authoritative development roadmap.

This ADR is authoritative only for **caller-cutover architecture, service
boundaries, rollout sequencing, and phase gates** - concretely:
`CheckoutAttempt` ownership layering, the `CheckoutReservationFacade`
boundary, `PriceLockService` ownership, the combined-availability formula,
the scheduler locking mechanism, and the phase sequence (and its gates) for
wiring the existing engine to production callers. It is not authoritative
for, and does not restate, any Redis-side reservation algorithm, price
policy, or catalogue/inventory domain rule - those stay owned by the
documents listed above.
