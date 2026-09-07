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
The exact field/location is open for G.2b. No dispatcher is implemented in G.0A.

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
| Exact durable field/location for selected path | G.2b |
| Exact server-issued checkout-key endpoint/contract | G.2b |
| Exact shadow comparison data obtainable without mutation | G.2a |
| Exact checkout worker schedule and batch values | G.PR1 |
| Exact advisory-lock key and transaction/session semantics | G.PR1 |
| Exact telemetry sink/dashboard implementation | G.2a, verified in G.5 |
| Quantitative G.6 rollout thresholds | G.5, approved before G.6 |

The closed architecture decisions permit consideration of inactive G.1 without
requiring later caller/worker implementation first. They do not assert that
those activation prerequisites are complete or authorize implementation now.
