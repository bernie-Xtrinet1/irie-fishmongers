# Inactive checkout settlement manifest protocol

G.4b.2c.2 integrates admission and W4 only in the inactive Phase G dispatcher.
G.4b.2c.3 adds W5 failure settlement only; W6, recovery workers and production routes remain unchanged.
The repository and issuer are not registered in the production module graph.
No existing hold receives authority from Redis, and no historical row is backfilled.

## Durable boundary

Migration 44 adds a parent manifest and immutable resources. Parent identities
reference the existing operation/attempt and captured fence transition. E, path,
customer/cart/key linkage must agree. The repository allocates new prospective
hold UUIDs before acquisition; it never adopts an existing Redis hold. Fenced W4
establishes those identities through its validated acquisition protocol. A
mismatched pre-existing guard remains denied.

Construction inserts PREPARED, its bounded resources, then seals in one transaction.
A deferred database constraint prevents committing an unsealed manifest. PREPARED
means acquisition intent, including an uncertain/lost response; it is not proof
of physical acquisition. Membership, physical identity and acquisition replay ID
never change. `holdInstanceId` identifies one physical hold instance, not a
reusable cart/product slot. Migration 45 removes global SQL uniqueness of its
historical references: distinct manifests may retain the same canonical physical
identity. Manifest-local product and marker uniqueness remain enforced. Physical
exclusivity comes from the guard/pin/fence/acquisition protocol, not a SQL lock.
Restoring global uniqueness would first require proving no duplicate historical
references exist; immutable resources must never be rewritten to recreate it.
Canonical W4 capture remains a separate checkpoint.

Terminal replay identity is initially NULL. Selecting FINALIZE_PENDING or
REVERT_PENDING atomically allocates a different replay ID and binds it permanently
to that terminal effect. Acquisition identity cannot substitute for this ID.

The W5 failure boundary persists FAILED and REVERT_PENDING in one transaction.
The success-side FINALIZE_PENDING caller remains deferred.
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
errors; writer integration must preserve this preflight discipline. Synthetic
Redis tests exercise the composition without converting inventory writers. They
prove only the inactive pin/receipt composition primitive, NOT W4 acquisition
integration or production reservation effects.

## Inactive admission and W4 integration (G.4b.2c.2)

`AtomicCheckoutAdmissionService` holds rollout, participant, fence, mode and
operation locks in that order. Its database-only transaction binds CART_SCOPED,
the acknowledged OPEN epoch and ACTIVE capability, then creates the attempt
through `createWithReservationCapability` with exactly that epoch. LEGACY remains
capability-free. Existing attempts are inspected first. Assigned historical NULL-E
operations cannot be upgraded; a new operation is required.

`CheckoutAcquisitionService`, provided only by `CheckoutDispatchModule`, prepares
the sealed PostgreSQL manifest and initializes its prospective resource guards
without advancement. It registers ACQUIRE using the original acquisitionReplayId.
`CHECKOUT_ACQUIRE_SCRIPT` composes the committed settlement protocol with whole-cart
membership, ownership, quantity, status and expiry validation. It marks entries
CHECKOUT_PENDING and binds physical identities in the same script as pins/evidence.
It does not accept a caller resource list, quantity, clock or lease target.

The orchestrator checks live entries, every guard/pin, the gate and acquisition
receipt against PostgreSQL provenance before acknowledging ACQUIRED. PREPARED
replay observes evidence before metadata initialization; a lost response does not
require repeating W4. ACQUIRED replay never executes W4 blindly. Missing evidence
fails closed. Definite rejection preserves unresolved state. Transport or commit
uncertainty preserves the same manifest/replay ID and never invents failure/revert.

Only opaque verified acquisition evidence reaches `checkoutAcquired`. It validates
the order plan against captured resources and rechecks durable state under an
attempt row lock before the existing order transaction. The old standalone D-core
entry remains for its existing callers/tests; the dispatcher never falls back to it.
Order commit still advances cart generation. W6 remains deliberately deferred: the manifest stays ACQUIRED after order
commit. G.4b.2c.3 handles only proven transaction rollback as described below. Neither the existing pending reconciler nor
the recovery worker acquires new settlement ownership in this slice. Their old
raw terminal paths are not substitutes for exact-manifest W5 or future W6 settlement.
These unresolved terminal obligations and unconverted writers prohibit activation.

The real dispatcher integration suite supplies separate W4 acquisition evidence;
the original synthetic protocol tests still prove only the composition primitive.

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

## Inactive W5 failure settlement (G.4b.2c.3)

The dispatcher supplies a required CheckoutFailureSettlementService to the acquired
order entry. It retains the shared fence/mode locks and operation/attempt locks and
adds the manifest lock around the existing order transaction. The legacy coordinator
entry, production OrdersService route, and existing stale recovery worker are unchanged.

A thrown transaction is not failure proof. The service distinguishes a rejected order
callback (no COMMIT may be submitted by Prisma) from a fulfilled callback whose COMMIT
response was lost. In either case it obtains the corresponding PostgreSQL locks and
re-reads exact durable ownership and attempt/order linkage. These locks wait for the
old transaction to finish. COMMITTED/order linkage wins, including a competing commit.
Only a rejected callback plus the locked, still-PROCESSING, order-free ACQUIRED record
permits the atomic FAILED + REVERT_PENDING transaction. Lock/read/commit uncertainty
returns ORDER_OUTCOME_UNRESOLVED. A lost commit response with no proven durable outcome
never authorizes W5. A later order transaction cannot pass the FAILED revalidation.

markFailedInTransaction uses the externally owned transaction; markRevertPending is
reused in that transaction, guarded by ACQUIRED at this orchestration boundary. The
low-level PREPARED predicate is retained for the prior protocol and is not used here.
The fixed failure code ORDER_TRANSACTION_ROLLED_BACK identifies this failure boundary;
continuation accepts only its already-durable delete-only REVERT_PENDING/SETTLED work.
No caller supplies resources, epoch, terminal replay identity or a failure-proof flag.

The exact-manifest CHECKOUT_REVERT_DELETE_ONLY script checks every entry, guard, pin,
index and accounting type before writing. It deletes only captured CHECKOUT_PENDING
holds, removes their cart/product memberships, decrements valid totals, and marks
underflow suspect without clamping, preserving existing accounting invariants. The
existing settlement protocol writes the terminal receipt and removes exact pins in
the same Lua execution. Ordinary current-generation checks and W7 are untouched.
OPEN and existing DRAINING delete-only authority are supported; FROZEN/RETIRED deny.
Missing physical hold keys or malformed accounting fail closed, requiring later
explicit repair rather than inferred cleanup or a broad legacy fallback.

Continuation reads the same manifest and action-bound settlementReplayId and first
observes the existing receipt. The existing opaque evidence reader additionally
checks original pins are absent and the original hold is gone for delete-only effects.
Only verified evidence can acknowledge SETTLED. A new service can resume after loss
before/after execution; receipt replay does not execute W5 again. Transport uncertainty
preserves REVERT_PENDING and the replay ID. No automatic scheduler was added: same-key
inactive-dispatcher replay continues authorized obligations, and the service exposes
that same bounded single-obligation continuation for future worker integration.
It never creates a manifest, capability, attempt, order, or terminal intent on recovery.

Success performs neither W5 nor W6. Unconverted writers, deferred W6, and absence of
scheduled terminal continuation remain activation blockers. This slice does not approve
production activation, Redis Cluster operation, or changes to failover prerequisites.
