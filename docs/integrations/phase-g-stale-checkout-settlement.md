# Slice B: stale-checkout W5 settlement

This change replaces scheduled raw revert with explicit durable settlement
authority. It does **not** activate Phase G, the dispatcher, W1 enrollment,
W2 dispatch, W3-P, or Slice A publication. Infrastructure incarnation fencing
remains a prerequisite: restoring stale Redis OPEN/control/evidence cannot be
made safe by these application checks alone. Redis Cluster is not certified.

## Atomic authority

`authorizeStaleRecoverySettlement` accepts only attempt/customer and fixed
observation timestamps. Callers cannot supply resources, quantities, a replay,
an epoch/incarnation upgrade, or an asserted acquisition result.

One PostgreSQL transaction acquires the exclusive fence advisory lock, shared
mode advisory lock, operation row, attempt row, then exact manifest row. It
reloads relationships, requires both paths CART_SCOPED, a matching positive E,
acknowledged capture I/E, and acknowledged compatible current mode/fence I/E.
The manifest must be sealed with bounded, canonical immutable resources.

For a new obligation, attempt status must be PROCESSING with no order. Current
heartbeat must equal discovery H0 exactly and H0 must precede the fixed cutoff.
No effect, terminal replay or receipt hash may already exist. ACQUIRED qualifies;
PREPARED additionally requires exact positive existing physical acquisition
evidence. The transaction conditionally sets FAILED/STALE_RECOVERY_FENCED,
clears failure details, and sets DELETE_ONLY/REVERT_PENDING with one new terminal
replay distinct from acquisition replay. Both update counts must be one, or the
whole transaction rolls back. No Redis mutation occurs in this transaction.

PREPARED observation uses unchanged READ_CHECKOUT_ACQUISITION_SCRIPT: current
OPEN tuple, ownership identity, checkout key, gate, acquisition receipt, exact
pins/guards/entries/quantities/cart membership. Missing, malformed, expired,
unavailable or uncertain evidence defers. DRAINING PREPARED cannot manufacture
acquisition. There is no acquire/repair fallback.

## Restart and completion

Discovery returns manifest IDs only, ordered by ID with a strict maximum of 100.
It joins the explicit sealed REVERT_PENDING/DELETE_ONLY/replay/no-hash predicate
to FAILED/STALE_RECOVERY_FENCED/no-order, matching operation/attempt relationships,
paths/E and acknowledged capture I/E. FAILED alone is excluded. Selection mints
no authority; continuation revalidates under locks.

Continuation observes exact typed completion **before** grant registration.
If a valid retained receipt exists, only durable acknowledgement is attempted.
An acknowledgement failure leaves the obligation pending, without registration
or W5 resubmission. A later process can observe the same receipt and retry ACK.
SETTLED requires matching receipt evidence and never submits another effect.
Missing Redis state alone is not completion.

Without proven retained completion, the existing W5 delete-only issuer and Lua
remain responsible for physical authorization. After execution, typed receipt
evidence is read and matched again under durable locks before SETTLED. A lost
execution response leads to observation, not a raw retry. Rejection/uncertainty
preserves the pending obligation and replay. No recapture or current-generation
guard advancement is allowed. W5 Lua, receipt format and ordinary permit rules
are unchanged. Restriction does not confer settlement authority; existing W5
rules allow exact delete-only cleanup in OPEN/DRAINING and deny physical effects
in FROZEN/RETIRED.

## Races and production boundary

Recovery's exclusive fence lock serializes with acquired-order processing's
shared fence lock. If order commit wins, COMMITTED/order/W6 are preserved. If
recovery wins, subsequent order processing fails PROCESSING/ACQUIRED checks
before the callback. Heartbeat refresh invalidates H0 even if still stale.
Duplicate workers reuse the committed action/replay rather than preparing a
new manifest. The scheduler's existing session lock remains held for the actual
bounded cycle; there are at most 100 pending and 100 stale candidates per cycle.

CheckoutRecoveryModule locally provides only the six approved protocol providers
in addition to its existing scheduler/lease/worker/telemetry. It imports no broad
checkout, dispatcher, orders, payments or reservation-fence module and exports
nothing. Scheduler cadence, ENABLE_SCHEDULER, AppModule and HTTP routes are
unchanged. Rollout participants and W3-O observations are never consulted as
authority. Recovery creates no attempt/order and never calls WiPay.

Production checkoutRevert and its Lua are removed. Historical characterization
lives only in backend/test/fixtures. The dormant coordinator reports
ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE without raw cleanup. All six old
reconciliation revert branches return NONE/SETTLEMENT_AUTHORITY_REQUIRED.
Separately deferred finalize compatibility remains unchanged.

## Evidence and limitations

Deterministic tests cover exact admission failures, read-only PREPARED evidence,
receipt-before-submit, failed ACK without resubmission, timeout/lost-response,
bounded worker selection, and production source/module boundaries. PostgreSQL
tests use a fresh schema with all 49 existing migrations, not shared-table
cleanup; structural ACQUIRED fixtures do not claim real W4 acquisition.

Real Redis suites are implemented separately and require exactly
redis://127.0.0.1:16479/11, standalone mode and the approved disposable
configuration before writes. They are **NOT RUN — ENVIRONMENT BLOCKED** for
this verification. No Redis runtime success, physical concurrency certification,
or production activation is claimed. Port 6379 must remain untouched.

Remaining boundaries include Slice A cart/publication composition, historical
NULL-E or unmanifested ownership, ordinary enrollment, W2 restart dispatch,
global freeze/drain certification, and infrastructure failover quarantine.
This slice does not resolve those obligations by guessing ownership or deleting
evidence.
