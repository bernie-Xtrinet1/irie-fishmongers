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

### 6. Combined-availability formula - stated exactly, zero ambiguity

For the duration of any partial rollout (Phase C shadow mode through Phase
G's allowlist/percentage rollout), availability is:

```
Available = Product.quantityAvailable - LegacyReserved - NewReserved
```

Where `LegacyReserved` is the existing per-product hash sum
(`InventoryReservationsService.getReservedByOthers`) and `NewReserved` is
the cart-scoped product-total projection
(`InventoryReservationsService.getReservedTotalExcludingCart`). Both terms
are read and summed by `CheckoutReservationFacade.getAvailability` - no
other call site computes availability during the transition window. This
formula, and this formula alone, is authoritative until Phase H removes
the legacy term.

### 7. `PriceLockService` - dedicated ownership

Price-lock logic (creation at add-time, the explicit reconfirmation
endpoint, expiry checks, one-cart/one-currency enforcement) lives in a new
`PriceLockService`, not embedded inside `CartService`. `CartService` calls
it; it does not reimplement it. This is Phase B.

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

PriceLockModule (or a service within CartModule - decide at Phase B)
  exports: PriceLockService

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
| B | `PriceLockService`, cart currency enforcement, price-lock validation | Open decisions 4 (TTL value), 8 (`Product` currency field) |
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
4. **Price-lock duration (`PRICE_LOCK_TTL_SECONDS`)** - **OPEN**, blocks Phase B. Needs a business-supplied value; not set anywhere in `decisions.md` today.
5. **Payment-failure compensation behavior** - **OPEN**, blocks Phase E. Explicitly deferred to a dedicated payment-integration planning session (see Decision 4); not designed by this ADR.
6. Scheduler distributed-lock mechanism - **RESOLVED: PostgreSQL advisory lock, not Redis** (see Decision 5).
7. **Legacy-drain wait time** - **OPEN**, blocks Phase H. Direct conflict between a prior session's stated 70 minutes and `reservation-lifecycle.md` §8's approved 20 minutes. One authoritative value must be set before Phase H; not resolved by this ADR.
8. **Does `Product` carry its own currency field**, or is currency purely cart-level (JMD-only today)? - **OPEN**, blocks Phase B. Verify before `PriceLockService` is designed in detail.
9. **`addItem`'s non-idempotent increment semantics** - **OPEN**, blocks Phase C/D. Depends on open decision 1's outcome (the write-order/idempotency redesign); not resolved separately from it.
10. **Rollout-flag mechanism (exact implementation)** - **OPEN**, blocks Phase C. Decision 2 above settles the *direction* (allowlist-based, evaluated per-request, not a bootstrap-level toggle) but not the *mechanism* - env var, DB-backed allowlist table (following the `MarketplaceModeConfig` precedent), or something else. This is a new pattern for this codebase with no existing precedent (`ENABLE_SCHEDULER` is the only prior art, and it is bootstrap-level/all-or-nothing, which this explicitly is not) and needs its own explicit sign-off before Phase C begins.
11. Ownership of the combined-availability bridge - **RESOLVED**: assigned to `CheckoutReservationFacade.getAvailability` in Phase C (see Decision 6). This closes what was open decision 9 in the original read-only plan; recorded here so it is traceable rather than silently dropped.

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
