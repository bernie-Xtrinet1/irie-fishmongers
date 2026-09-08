# Phase G Limited Rollout Design

Status: Architecture decisions approved; implementation not authorized by G.0A.

Date: 2026-09-07

Baseline: `879674ddedb3a4c4b81a6377b738588c7fe45635` on
`feat/phase-g-limited-rollout`, including PR #39 / Phase F.4.

## Authority and scope

This document records the accepted G.0 audit and the seven explicitly approved
G.0A architecture decisions. It supersedes stale Phase G activation assumptions
in [ADR-007](ADR-007-checkout-cutover-and-operational-integration.md), while
preserving that ADR's historical record and existing reservation safety gates.
It does not alter reservation algorithms or payment-provider contracts.

G.0A is documentation only. No schema, migration, source, test, environment,
workflow, deployment, database, Redis, or provider change is authorized.
G.1 implementation requires separate authorization; G.6 activation requires
separate explicit approval even after implementation and verification complete.
Phase H production cutover, legacy Redis deletion/drain work, production WiPay
credentials, payment/refund redesign, and automatic full rollout remain outside G.

## Verified implementation baseline

- `CartService.executeAddItem`, `updateItemQuantity`, and `removeItem` commit
  Postgres mutations and durable sync generations before Redis convergence.
  `CartReservationConvergenceService` owns fenced compensation and unresolved
  state. ADR-007 open decision 1 is resolved by implementation.
- `CartController.addItem` requires an idempotency key. `CartItemAddAttempt`
  is unique by customer/key; `CartItemAddIdempotencyService` and the cart
  transaction fence completed mutations. The backend portion of open decision 9
  is resolved. The web helper creates a new key per invocation; retaining a key
  across an ambiguous user retry remains a separate client integration detail.
- `ReservationEngineModeConfig` is DB-backed and append-only, with a monotonic
  revision. `ReservationEngineModeService` validates transitions under a
  Postgres advisory lock. This is global reservation authority, not membership.
- `OrdersController.checkout` still calls `OrdersService.checkout`.
  `CheckoutModule` packages the coordinator but has no controller and is not
  imported into the production application graph. Caller activation remains open.
- `CheckoutAttemptService.updateHeartbeat` and `findStalePage`, plus
  `CheckoutPendingReconciliationService.reconcileExpiredCheckoutPending`, exist.
  Their operational checkout worker/scheduler wiring remains absent. Existing
  compensation/payment cron jobs do not discharge this prerequisite.
- Phase E/F.4 payment reliability exists: unique payment per order, durable
  initiation claim/state, forward-only ambiguity handling, fenced reconciliation,
  transition-idempotent browser return/COD confirmation, and sandbox WiPay
  form-urlencoded initiation with explicit fee structure. Status lookup/refunds
  remain unsupported and legacy webhooks disabled. See
  [payment provider boundaries](payment-providers.md). No provider call was made
  for this decision closure.

Implementation references are under `backend/src/modules/`: `cart/`,
`cart-reservation-sync/`, `checkout-reservation/`, `reservation-engine-mode/`,
`checkout/`, `checkout-attempt/`, `inventory/`, `orders/`, and `payments/`;
models are in `backend/prisma/schema.prisma`. The web retry boundary is
`apps/web/lib/api/cart.ts`.

## Decision 1: One shared inventory authority

Customer cohorts MUST NOT make legacy and cart-scoped reservation accounting
independent authorities over shared inventory. `ReservationEngineMode` remains
the global state machine: `LEGACY`, `MIRROR`, `CART_SCOPED`, `DRAINING`.

Limited checkout participation is a separate concern. It cannot create two
partial availability views or override the global safety gates. Every later
new-checkout admission must prove compatibility with the currently authoritative
reservation mode. Enabling a participant alone is never sufficient proof.

`MIRROR` keeps its existing dual-write/diagnostic behavior, including possible
cart-scoped writes. It must not be renamed to `SHADOW`.

## Decision 2: Durable checkout path ownership

Once a durable `CheckoutAttempt` exists for a cart/customer/idempotency operation,
its selected checkout path owns replay and recovery. Participation changes affect
only NEW eligible admissions. Disable/removal cannot send an existing new-path
attempt to a fresh legacy checkout.

Before routing a retry, the dispatcher must inspect durable checkout ownership.
A membership lookup failure does not prove that no new-path attempt exists and
MUST NOT blindly execute legacy checkout. If ownership cannot be established,
fail safely rather than create another order.

The selected path must ultimately be recorded against an authoritative checkout
identity/attempt so dispatchers, retries, recovery, and emergency stops agree.
G.PR0 records this as nullable `CheckoutAttempt.selectedPath` (details below).
No dispatcher is implemented in G.0A or G.PR0.

## Decision 3: Checkout SHADOW is read-only

`SHADOW` is a Phase G rollout-policy state/behavior, NOT a new
`ReservationEngineMode` value. Existing production/legacy checkout remains
authoritative. The shadow path MUST NOT:

- create an order through `CheckoutCoordinatorService`;
- initiate a payment;
- invoke checkout mark, finalize, or revert;
- mutate cart-scoped reservations solely for shadowing;
- persist price locks solely for shadowing.

Safe existing read primitives may supply comparisons. Mismatch, unavailable,
and error results are diagnostic only and cannot affect the customer's
authoritative result. Read-only comparison is not permission to execute the
coordinator and later roll its effects back. Exact comparable data is a G.2a
implementation detail; missing data must be reported unavailable, not fabricated.

Reservation MIRROR and checkout SHADOW are different concepts. Shadow imposes
no change on normal reservation writes independently required by the global mode.

## Decision 4: Stop new admissions, preserve recovery

The emergency control stops admissions to the new checkout caller. It does not
migrate existing work immediately to legacy. It must preserve durable attempt
replay, checkout cleanup/recovery, and reconciliation of already-created payments.
It must not delete orders or reservations, blindly retry ambiguous WiPay
initiation, or bypass the reservation transition protocol:

```text
LEGACY <-> MIRROR
MIRROR -> CART_SCOPED
CART_SCOPED <-> DRAINING
DRAINING -> LEGACY only after rollback-safety verification
```

Participant disable applies to future eligible admissions; in-flight work keeps
its owner. An admission stop is distinct from scheduler disablement. The existing
startup `ENABLE_SCHEDULER` switch is not the Phase G emergency control.

## Decision 5: Checkout operational recovery prerequisite

G.PR1 is a separately reviewable prerequisite for stale PROCESSING attempts,
heartbeat staleness, and Redis CHECKOUT_PENDING reconciliation/cleanup. It must
implement/wire distributed ownership, preferably the already-designed Postgres
advisory-lock approach where compatible with the architecture.

The worker remains distinct from mirror compensation scheduling, cart reservation
sync recovery, and payment reconciliation scheduling. Existing primitives and
other workers are not evidence that checkout operational recovery is complete.
Multi-instance safety must be demonstrated before any participant reaches the
new caller. Schedule, batch values, and exact lock/session/transaction semantics
remain G.PR1 details. G.0A does not implement or enable the worker.

## Decision 6: Caller preparation prerequisite

Before participant activation, G.2b must separately implement/review:

- server-issued checkout keys and customer/cart ownership binding;
- retry/replay semantics and durable path ownership;
- price-lock preparation/reconfirmation;
- inactive dispatcher/coordinator integration;
- compatibility with global reservation authority;
- safe behavior on policy lookup or durable ownership inspection failure.

Production `POST /orders/checkout` remains legacy until separately authorized.
G.1 participant persistence does not authorize caller cutover or web checkout
activation. The exact issuance endpoint/contract and ownership representation
remain open implementation details.

## Decision 7: Inactive G.1 participant policy

G.1 may implement durable policy persistence and audit behavior only after
separate authorization. It MUST NOT change production request routing.
Prefer a dedicated `CheckoutRolloutParticipant`, subject to schema consistency:

```text
id
customerId (unique FK)
enabled
cohort (bounded diagnostic label)
reason
createdById
updatedById
revision
createdAt
updatedAt
```

G.1 selects **B: append-only participant revisions**, following the existing DB
configuration pattern. `CheckoutRolloutParticipant` stores `id`, `customerId`,
`enabled`, nullable `cohort`, required `reason`, `actorId`, per-customer `revision`,
and `createdAt`. Highest revision per customer is the sole current authority;
prior state is the preceding row. First/latest revisions supply creation/update
actor and timestamp without redundant mutable fields.

Writes acquire a transaction-scoped advisory lock on the namespaced customer ID,
read current state under ReadCommitted, compare the expected revision, and insert
one row. `null` expects no membership. Stale callers conflict; there is no automatic
retry over a newer revision. A unique `(customerId, revision)` index is a second
fence. There is no mutable current row or separate audit table, so a failed insert
cannot advance current policy independently of history. Normal repository APIs
expose no historical update/delete; privileged database maintenance is not
restricted by an immutability trigger.

IDs use existing User TEXT/UUID conventions and restrictive FKs. Account status
updates preserve history. Membership is not authentication, role validation, or
admin authorization; future callers retain those duties and pass trusted IDs.
Cohort is null or a 1-64 character alphanumeric/underscore/hyphen label beginning
alphanumeric. Reason is trimmed and 3-500 characters. SQL adds domain CHECKs along
with the unique index and FKs. History is keyset-paged by revision (default 50,
maximum 200). Every accepted state submission appends a reasoned revision,
including same-state submissions with the current expected revision.

`evaluateParticipation(customerId)` distinguishes ENABLED, DISABLED, NOT_FOUND,
and LOOKUP_FAILED, with explicit enabled boolean and nullable membership metadata.
Malformed IDs are rejected; lookup errors never become NOT_FOUND. No cache exists.
The module has no controller or production importer and cannot change attempts,
orders, payments, reservations, or engine mode.

The alternatives approved in G.0A were:

A. Mutable participant state plus immutable history committed atomically; or
B. Append-only participant revisions following a proven configuration pattern.

Only B is implemented. The preferred unique-customer current-row sketch above is
replaced by per-customer revision uniqueness, not a second current-state model.

Policy identity derives from authenticated/server context. No email matching,
client-supplied cohort authority, percentage rollout, or wildcard participants.
Missing/disabled membership and lookup errors never authorize new-path admission.
Disable must affect future admissions immediately; positive membership caching
requires proven immediate invalidation. Existing attempts retain path ownership.

G.1 does not change AppModule checkout wiring, OrdersController routing,
CartService behavior, payment/WiPay behavior, ReservationEngineMode semantics,
scheduler enablement, or production deployment. A policy result is eligibility
information, not permission to bypass caller/recovery prerequisites.

## Approved implementation sequence

| Slice | Scope and boundary |
|---|---|
| G.0A | Architecture decision closure; documentation only. |
| G.1 | Inactive participant/policy persistence, immutable audit, unit/repository tests; no routing. |
| G.2a | Read-only checkout shadow comparison and structured rollout telemetry; legacy authoritative. |
| G.PR0 | Inactive durable attempt path ownership and atomic stale-observation fencing prerequisite. |
| G.PR1 | Distributed ownership and stale-attempt/heartbeat/CHECKOUT_PENDING operational worker. |
| G.2b | Caller preparation and inactive dispatcher: issued key, price-lock boundary, durable path ownership, coordinator integration; activation disabled. |
| G.3 | Admin participant controls and new-admission stop. |
| G.4 | Rollback/drain/failure-injection verification; no bypass of Phase H gates. |
| G.5 | Isolated integration/regression evidence and acceptance thresholds. |
| G.6 | Staged activation only after separate explicit approval. |

Phase H remains separate. Verification of drain behavior does not authorize
production drain/cutover or legacy Redis deletion.

## Required safety invariants

1. One authoritative reservation-accounting regime governs shared inventory.
2. Participation never overrides ReservationEngineMode safety gates.
3. Existing CheckoutAttempt path ownership survives participant disable.
4. A retry cannot create a legacy order merely because rollout lookup failed.
5. Shadow cannot create orders, payments, or reservation writes.
6. Admission stop does not stop recovery.
7. Ambiguous WiPay initiation is never blindly recreated.
8. PAID remains monotonic; rollout changes or unsigned failure cannot downgrade it.
9. Existing orders are never rolled back because rollout policy changes.
10. CART_SCOPED -> LEGACY still requires DRAINING verification.
11. No production routing changes occur in G.1.
12. G.6 requires explicit approval; implementation completion cannot activate rollout.

## Open implementation details

These are deliberately not resolved by architecture approval:

| Detail | Owning slice |
|---|---|
| Participant audit representation and schema constraints | Resolved in G.1 above: append-only per-customer revisions |
| Exact durable field/location for selected path | Resolved in G.PR0 below |
| Exact server-issued checkout-key endpoint/contract | G.2b |
| Exact shadow comparison data obtainable without mutation | G.2a inactive boundary below |
| Exact checkout worker schedule and batch values | G.PR1 |
| Exact advisory-lock key and transaction/session semantics | G.PR1 |
| Exact telemetry sink/dashboard implementation | G.2a, verified in G.5 |
| Quantitative G.6 rollout thresholds | G.5, approved before G.6 |

The closed architecture decisions permit consideration of inactive G.1 without
requiring later caller/worker implementation first. They do not assert that
those activation prerequisites are complete or authorize implementation now.

## G.2a implemented boundary — inactive read-only observations

`CheckoutShadowModule` has no controller and is absent from the production Nest
module graph. Only its comparison service is exported. There is no runtime hook,
request DTO, public API, or authoritative caller. `POST /orders/checkout` still
calls `OrdersService.checkout()`; production customer behavior is unchanged.
G.2a does not complete G.2b, recovery, admin controls, rollback, or G.6 activation.

The internal `compare({ authenticatedCustomerId, cartId })` boundary expects
server-authenticated identity, verifies persisted cart ownership, and reads
quantities from persisted CartItems. It does not trust supplied quantities,
cohorts, or rollout flags. A future caller must derive identity from the existing
authenticated server context, never a client claim. G.1 policy is deliberately
not consulted or mutated here: invoking this inactive diagnostic is not evidence
of participation and cannot authorize a path. G.1 remains inactive and unchanged.

### Inspected read capabilities

| Dependency | Exact operation and purpose |
|---|---|
| CartRepository | `findById`: existing cart identity, customer ownership, currency |
| PriceLockRepository | `findCartWideLockState`: persisted item set, quantities, lock fields |
| ProductsRepository | `findById`: existence, active status, stock, current price/currency |
| ReservationEngineModeConfigRepository | `findCurrent`: highest revision, default LEGACY if absent |
| RedisService | `hgetall` on the legacy product hash; `get` on own reservation, product total, and suspect key |

The adapter exposes only these read capabilities. It reuses the existing Redis
key builders, reservation entry version, and price-lock TTL. No shared read or
mutation implementation was changed. It does not call `OrdersService.prepareCheckout()`
because that reaches `findOrCreateByCustomerId()`. It does not call
`getActiveReservation()` or cart-excluding availability because those may release
expired reservations or set suspect flags for malformed entries. It reads the
stored representation without repair, renewal, expiry cleanup, or reconciliation.
No coordinator, attempt, payment, reservation mutation, or G.1 service is injected.

### Supported comparisons and limits

Each comparable persisted cart line reports its observation-local ordinal,
requested quantity, product stock, legacy available quantity, cart-scoped
available quantity, each engine's quantity-admissibility boolean, and whether
the existing valid locked price/currency equals current product price/currency.
No customer/cart/product identifiers or price amounts are included in the result.

Legacy availability ignores expired entries, excludes the requesting cart, and
floors stock minus others' reservations at zero. Cart-scoped availability floors
stock minus (stored product total minus validated own active quantity) at zero.
Missing total or own entry is not invented as a trustworthy zero. Suspect,
malformed, negative/nonfinite, inconsistent total, expired own, and
CHECKOUT_PENDING state produce UNAVAILABLE without any write. A suspect marker
is observed; divergence history, sync backlog, and aggregate freshness are not
reconciled or certified. Missing/inactive products and DRAINING are unavailable.

Existing complete, unexpired locks can be compared read-only. Missing locks
produce `PRICE_LOCK_REQUIRED`; partial/currency-invalid/future-dated locks produce
`PRICE_LOCK_INVALID`; expired locks produce `PRICE_LOCK_EXPIRED`. No lock is
issued, repaired, or reconfirmed. Price mismatch is diagnostic, not permission
to replace a customer's locked price.

Observations span separate database and Redis reads and are **not atomic**.
There is one persisted cart item set, not a proof that two engine snapshots saw
the same set. MATCH means only the reported availability and price observations
agree; both engines may agree that quantity is insufficient. The result always
includes `checkoutEligibility: 'UNAVAILABLE'`. Full eligibility (vendor/lot safety,
sales limits, delivery constraints, price issuance, pending-attempt ownership,
marking, transaction races and order/payment outcomes) is not simulated. No result
is an admission grant or a substitute for authoritative validation.

`CheckoutShadowResult` is discriminated by `status`:

- MATCH: `MATCH`.
- MISMATCH: `AVAILABILITY_DIFFERS` or `PRICE_DIFFERS`, with availability taking
  precedence when both differ.
- UNAVAILABLE: `CART_MISSING`, `OWNERSHIP_MISMATCH`, `CART_EMPTY`,
  `PRODUCT_MISSING`, `PRODUCT_INACTIVE`, `MISSING_REQUIRED_READ_DATA`,
  `NO_COMPARABLE_CART_SCOPED_STATE`, `RESERVATION_SUSPECT`,
  `RESERVATION_STATE_INVALID`, `RESERVATION_EXPIRED`,
  `CHECKOUT_PENDING_NOT_COMPARED`, `PRICE_LOCK_REQUIRED`, `PRICE_LOCK_INVALID`,
  `PRICE_LOCK_EXPIRED`, or `MODE_NOT_ADMITTING`.
- ERROR: `READ_FAILURE`; raw exceptions and partial data are discarded.

UNAVAILABLE may retain already-completed earlier line observations; callers must
not treat these as a complete cart comparison. Every result includes engine mode
(or null when unknown), comparisons, and the unavailable full-eligibility marker.

### Structured telemetry and future integration

The Nest Logger sink emits only `checkout_shadow_comparison` with an explicit
allowlist: `event`, `schemaVersion: 1`, ISO `timestamp`, bounded `engineMode` or
null, bounded `outcome`, bounded `reasonCode`, and finite nonnegative `durationMs`
capped at one day. It never spreads caller data or logs comparisons, IDs, raw
exceptions, credentials, tokens, idempotency keys, provider queries, or PII.

`checkout_path_selected`, `checkout_success`, `checkout_failure`, and
`reservation_conflict` names are reserved in the shared contract, not emitted.
Their event-specific payload integration remains future work. No path is selected.
No established injectable request/operation correlation provider was found, so
requestId/operationId are omitted instead of inventing another correlation system.
selectedPath/policyRevision/cohort are also omitted because no authoritative
selection or policy observation occurred. Future integration must reuse the
approved server correlation source before supplying these fields. No metrics
framework or labels were added; there is no high-cardinality metric risk.

Read exceptions become ERROR. Telemetry validation, serialization, and logger
exceptions are swallowed at both the telemetry and comparison boundaries. The
inactive service cannot affect an HTTP response, transaction, rollback, or route.
There is no production latency claim: any later runtime observation hook requires
separate approval for ownership-checked input acquisition, a bounded/non-blocking
execution budget, correlation propagation, and failure isolation outside the
authoritative transaction. Do not insert a call into OrdersService or its
controller as part of this slice.

Checkout SHADOW is strictly read-only. Reservation MIRROR remains its existing
dual-write mechanism; MIRROR and CART_SCOPED semantics and the reservation mode
enum are unchanged. Tests cover guarded real repository/Redis wrappers, real
Postgres READ ONLY transactions and Redis state snapshots, bounded comparison
failures and telemetry, and the actual Nest module graph's inactive boundary.

## G.PR0 — durable path ownership and stale-observation fencing

G.PR0 is non-activating. G.PR1's distributed scheduler remains unimplemented;
G.2b routing and G.6 activation remain separate. OrdersController and legacy
OrdersService.checkout() are unchanged; the coordinator remains inactive.

Creation inspection found one application chain: CheckoutCoordinatorService ->
CheckoutAttemptService.createOrResume -> CheckoutAttemptRepository.createOrGetByIdempotencyKey.
Legacy checkout does not create CheckoutAttempt. Repository/concurrency tests also
create attempts directly through the repository. No application seed/manual tool
or SQL migration that creates attempt data was found. This proves the current
application chain, not the provenance of every persisted historical row.

`CheckoutPath` has only LEGACY and CART_SCOPED. Nullable `selectedPath` represents
unknown historical ownership; SHADOW never owns an attempt. The additive migration
adds the enum and nullable column without a default or backfill. Older writers
therefore also leave unknown ownership, which fails closed. No unrelated table,
version column, index, or reservation mode is added. Classifying unknown rows later
requires separately reviewed provenance; runtime code must never guess their path.

New repository/service creation requires an explicit server-selected path. The
inactive coordinator hardcodes CART_SCOPED, ignoring extra client DTO fields. New
admission will eventually select a path before or at creation; no LEGACY admission
caller is added here. Path is returned by inspection/replay and stale discovery.
Existing unknown or different ownership is rejected by the coordinator before
cart preparation, order replay, reservations, or payment calls. A race that finds
an existing differently owned key at creation also fails closed.

Normal application APIs cannot rewrite selectedPath: creation writes it once;
create-or-get never updates existing rows; heartbeat, commit, failure and fencing
updates omit it. This is application API immutability, not a database trigger
preventing privileged administrative SQL. Participant disable affects future
admission only. Neither replay nor fencing consults rollout policy; disable or
lookup failure cannot move an existing operation to LEGACY.

### Atomic stale fence

CheckoutAttemptStaleFencingService.fence accepts server-owned attempt/customer/path,
observedHeartbeatAt, staleBefore and now. Dates must be valid and ordered:
observedHeartbeatAt < staleBefore <= now. lastHeartbeatAt is non-null in the schema.
The repository guards missing/undefined filters as well, because Prisma would
otherwise omit them. One conditional UPDATE requires all of:

- matching attempt ID, customer and selectedPath;
- PROCESSING, no orderId;
- lastHeartbeatAt exactly equals observedHeartbeatAt and is before staleBefore.

Success changes only attempt status to FAILED, failureCode to STALE_RECOVERY_FENCED,
failureMessage to null, and updatedAt. It returns FENCED. This is a terminal fence,
not a renewable claim or a no-op eligibility check. It deliberately consumes the
observation without a new version/lease column. The original heartbeat and path
remain unchanged. Duplicate fencing returns ALREADY_FAILED. There is no automatic
reset to PROCESSING, no replacement attempt, and no reservation/order/payment write.

On zero matched rows, a diagnostic reread returns NOT_FOUND, OWNERSHIP_MISMATCH,
UNKNOWN_PATH, PATH_MISMATCH, ALREADY_COMMITTED, ALREADY_FAILED or STALE_OBSERVATION.
It never retries using the refreshed heartbeat. Invalid input returns INVALID_INPUT.
Storage failures propagate to the future worker; they do not authorize cleanup.
A later diagnostic read may see newer state; only FENCED proves this invocation
won the atomic transition.

A heartbeat H2 that wins first makes an H1 fence fail. A commit that wins first
leaves the committed attempt/order/payment intact. If the fence wins, existing
PROCESSING guards reject later heartbeats and commit. The coordinator already
rolls back order creation when markCommittedInTransaction rejects that transition.
These races use ordinary PostgreSQL conditional-update row locking, not scheduler
advisory locks.

FENCED does not mean Redis recovery completed. G.PR1 must separately discover and
idempotently clean up FAILED attempts (including STALE_RECOVERY_FENCED) after a
crash between fencing and cleanup. It must also discover pending/committed cleanup
work; stale PROCESSING paging alone is insufficient. Unknown paths require manual
classification, never guessed cleanup. No pending lease is weakened or extended by
G.PR0, and no payment is initiated, reconciled, refunded or downgraded.

G.PR1's distributed scheduler lock will serialize worker cycles. This per-attempt
fence protects against live coordinator/heartbeat races. They solve different
problems and both are required; neither activates new admissions. Pending lease
extension and committed cleanup still need their own reviewed G.PR1 execution
boundary. G.PR0 does not claim the entire recovery worker is complete.
