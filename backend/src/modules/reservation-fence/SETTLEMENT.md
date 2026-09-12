# Inactive checkout settlement manifest protocol

This module does not cut over W4/W5/W6, admission, recovery workers or routes.
The new repository and issuer are not registered in the production module graph.
No existing hold receives authority from Redis, and no historical row is backfilled.

## Durable boundary

Migration 44 adds a parent manifest and immutable resources. Parent identities
reference the existing operation/attempt and captured fence transition. E, path,
customer/cart/key linkage must agree. The repository allocates new prospective
hold UUIDs before acquisition; it never adopts an existing Redis hold. Later W4
must establish those identities through its validated acquisition protocol. A
mismatched pre-existing guard remains denied.

Construction inserts PREPARED, its bounded resources, then seals in one transaction.
A deferred database constraint prevents committing an unsealed manifest. PREPARED
means acquisition intent, including an uncertain/lost response; it is not proof
of physical acquisition. Membership, physical identity and acquisition replay ID
never change. `holdInstanceId` is intentionally globally unique: it identifies
one physical hold instance, not a reusable cart/product slot.

Terminal replay identity is initially NULL. Selecting FINALIZE_PENDING or
REVERT_PENDING atomically allocates a different replay ID and binds it permanently
to that terminal effect. Acquisition identity cannot substitute for this ID.

The order/FAILED caller must later use its transaction to persist the matching
FINALIZE_PENDING/REVERT_PENDING obligation. This slice does not wire that caller.
The narrow APIs are markAcquired, markFinalizePending, markRevertPending and
acknowledgeSettled. There is no generic lifecycle transition API. acknowledgeSettled
requires opaque runtime-verified completion evidence from the protocol receipt reader;
it rechecks the evidence against the durable manifest/action before persisting a
completion hash. A forged typed object fails the runtime check. PostgreSQL remains
authority; the receipt proves completion of an already-authorized physical effect.
Database constraints require a completion hash for SETTLED and retain immutable
action/replay/evidence identities; the runtime API verifies protocol-produced evidence.
Discovery is bounded and indexed by state/id; discovery alone grants no mutation authority.

## Physical boundary

`CheckoutSettlementAuthorityService.register` loads all authority from PostgreSQL.
There is no caller-supplied generation bypass. ACQUIRE and restore-active require
current durable generation/quantity and OPEN; delete/finalize use captured provenance.
Execution gate revocation does not erase terminal obligations.

`settlementProtocol` is an inactive Lua composition primitive. Its static validation
body must perform every domain/type/ownership check before any write. Its static
mutation body must not return early. Redis does not roll back a script after runtime
errors; future writer integration must preserve this preflight discipline. Synthetic
Redis tests exercise the composition without converting inventory writers. They
prove only the inactive pin/receipt composition primitive, NOT W4 acquisition
integration or production reservation effects.

Acquisition pins the exact manifest identity and records acquisition evidence in the
same execution as the supplied effect. All resources are checked before mutation.
Both RESOURCE_INIT and RESOURCE_ADVANCE reject a pinned marker. Ordinary fenced
cart-intent permits also reject pinned resources; their PostgreSQL current-generation
predicate is unchanged. W7 retains its existing fixed-ceiling authorization and
cannot relabel a resource. Unconverted physical writers remain an activation limitation.

Settlement validates the original guards directly, with no RESOURCE_ADVANCE in
DRAINING. It records completion and releases pins atomically with the effect. The
non-expiring receipt binds manifest/replay/action, incarnation/E, operation/attempt,
and exact resources. Duplicate completion returns evidence before inspecting any
replacement guard and never repeats the physical effect. Missing/malformed evidence
with missing pins is unresolved. Neither Redis backup/restore nor a new incarnation
can silently resurrect authority; existing infrastructure fencing prerequisites apply.
Receipts/acquisition history have no automatic deletion path in this slice.

## Verification fixture

The settlement migration/persistence tests create a uniquely named schema only inside
an explicitly local disposable database. They deploy the 43 prior migrations, seed
historical rows, upgrade to 44, and drop only that generated schema at teardown. This
is the test fixture reset mechanism; no shared application tables are manually cleared.
Redis tests validate 127.0.0.1:16479 before connecting and remove only recorded fixture
keys. Port 6379 is never used. No activation approval is implied by passing tests.
