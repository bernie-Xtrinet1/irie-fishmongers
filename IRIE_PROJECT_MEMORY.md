# IRIE FISHMONGERS PLATFORM --- AUTHORITATIVE PROJECT MEMORY

**Status date:** 13 September 2026\
**Purpose:** Persistent engineering continuity and decision record for
ChatGPT, Codex, and future engineering sessions.\
**Repository:**
`C:\Users\user\Documents\Bernie Project\Iriefishmonger platform`\
**Branch:** `feat/phase-g-limited-rollout`\
**Protected baseline:** `66db985e0d1b43ba749f7a33c72869c958a871a5`\
**Subject:** `feat(checkout): add canonical ordinary hold identity`\
**Current Phase:** Phase G --- Limited Rollout

> Source code and committed database constraints remain authoritative
> for actual behavior. This file is the project continuity/decision
> record. If it conflicts with current source, stop and resolve the
> discrepancy rather than silently following either version.

## 1. Mandatory startup protocol

Before changing the repository, read this file and `.claude/roadmap.md`,
then verify branch, HEAD, working tree, and cached diff. Do not assume
this checkpoint is current if Git disagrees. Design-gated work must
complete its source/design review before edits.

Never stage, commit, or push unless the current task explicitly
authorizes it. Never push merely because a slice passed review.

## 2. Protected files

These untracked files are protected and must never be modified, staged,
committed, deleted, cleaned, stashed, moved, renamed, or regenerated:

``` text
backend-test-cov.txt
backend-test-failures.txt
g3a-source-review.txt
g3b-source-review.txt
g4b2c2-review.txt
```

Avoid `git add .`, `git add -A`, `git clean`, broad stash operations, or
any command that could capture them. Stage explicit paths only after
independent review.

## 3. Platform context

Core application context:

-   NestJS backend
-   PostgreSQL 16
-   Redis
-   backend port 3001
-   customer web port 3000
-   admin port 3002
-   health endpoint `/api/v1/health`
-   Azure Container Apps
-   GHCR-direct deployment
-   no ACR
-   repository-only deployment authoring

Toolchain context:

``` text
.nvmrc: Node 20.18.1
packageManager: npm@10.9.0
Prisma: 6.19.x line
```

Do not change Node/npm/toolchain/configuration/dependencies/lockfiles as
incidental Phase G work. Do not run `npm install`, `npm update`, or
`npm audit fix` unless explicitly authorized.

## 4. Redis safety

Never touch normal/production Redis on port `6379` during Phase G
testing.

Disposable integration Redis only:

``` text
127.0.0.1:16479
```

Known disposable Windows Redis executable:

``` text
C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\Redis-8.8.0-Windows-x64-msys2\redis-server.exe
```

Avoid concurrent integration runs against the same disposable Redis
unless isolation is explicitly proven.

## 5. Phase G authority model

PostgreSQL is the **durable authority**. It owns operation/capability
identity, immutable execution epoch, cart reservation intent, settlement
manifests, checkout outcomes, terminal obligations, and durable replay
identities.

Redis is the **physical mutation authority**. It owns physical holds,
indexes, totals, resource guards, checkout pins, mutation grants, and
physical completion evidence.

Redis state alone must never manufacture durable authorization.

Important identifiers:

-   `I`: fence/Redis incarnation
-   `E`: immutable reservation execution epoch for a capability-bearing
    CART_SCOPED execution
-   `R`: monotonic fence revision

`I/E/R` alone is insufficient mutation authority. Mutation also requires
the correct operation class, durable ownership, phase/transition, exact
resource identity, and applicable permit or settlement protocol.

Fence phases:

``` text
OPEN
DRAINING
FROZEN
RETIRED
```

General policy:

-   OPEN: explicitly authorized ordinary operations may execute.
-   DRAINING: no new ordinary ownership; only explicitly authorized
    non-increasing or settlement operations.
-   FROZEN: deny CART_SCOPED physical mutation.
-   RETIRED: deny CART_SCOPED physical mutation.
-   Never auto-reopen.

Restriction ordering remains:

``` text
PostgreSQL intent
→ Redis moves to stricter phase at new R
→ PostgreSQL acknowledges
```

## 6. Capability rules

First CART_SCOPED assignment durably binds the operation to:

``` text
selectedPath = CART_SCOPED
reservationExecutionEpoch = E
capabilityState = ACTIVE
```

The capability-bearing checkout attempt inherits exactly the same
immutable `E`.

Never backfill or infer `E` for historical NULL-E rows merely to let
them enter the new protocol. A new reservation execution requiring a new
`E` requires a new operation.

## 7. Writer inventory

| Writer | Responsibility | Current state |
| ------ | -------------- | ------------- |
| W1 | reserve / renew / increase / reduce ordinary holds | OPEN GAP |
| W2 | release ordinary holds | OPEN GAP |
| W3 | reconciliation / repair | OPEN GAP |
| W4 | checkout acquisition/mark | FENCED |
| W5 | failed-checkout settlement | FENCED service; recovery bypass still requires closure |
| W6 | committed-checkout finalization | FENCED |
| W7 | checkout lease extension | FENCED |
| W8 | former read-side suspect mutation | REMOVED / READ-ONLY |

Legacy hash-based paths remain separate. Do not convert legacy-only
behavior for symmetry, but raw/legacy mutation must never become
authority over capability-bearing CART_SCOPED resources.

## 8. Completed Phase G work

Completed:

``` text
G.4a
G.4b.1
G.4b.2a
G.4b.2a.1
G.4b.2b.1
G.4b.2b.2 / W7
G.4b.2c.1 durable settlement manifest protocol
G.4b.2c.2 fenced W4 acquisition
G.4b.2c.3 fenced W5 failure settlement
G.4b.2c.4 fenced W6 committed settlement
G.4b.3 pre-edit writer inventory
G.4b.3a architecture/design closure
G.4b.3b.1 canonical ordinary reservation identity foundation — COMPLETE
```

G.4b.3b.1 is complete. W4 handoff adaptation and the remaining writer conversions are not yet implemented.

## 9. Relevant Phase G commit history

``` text
abe23ea docs(checkout): define phase g limited rollout architecture
7e68254 feat(checkout): add inactive phase g rollout policy
9661551 feat(checkout): add read-only phase g shadow diagnostics
91b2c21 feat(checkout): add durable path ownership and stale fencing
19e4ab9 feat(checkout): add distributed checkout recovery worker
005caa7 feat(checkout): add durable checkout operation issuance
ed1b877 feat(checkout): add inactive checkout dispatcher
a0a5cc1 feat(checkout): add inactive rollout control plane
08fbac8 feat(checkout): add atomic rollout admission
1b1193f test(checkout): add phase g rollback evidence harness
6faa7ec feat(checkout): add inactive reservation fence protocol
44c14a3 feat(checkout): add reservation mutation fence infrastructure
579cda7 docs(roadmap): add b2b commercial marketplace phase
c00cc8e feat(checkout): extend reservation mutation permit semantics
72d3e0c refactor(checkout): make reservation reads observational
ca937d3 feat(checkout): fence checkout lease extension
c2edfe6 feat(checkout): add durable settlement manifest protocol
4516166 feat(checkout): cut over fenced checkout acquisition
ab1519c feat(checkout): add fenced failure settlement
f719777 feat(checkout): add fenced committed settlement
66db985 feat(checkout): add canonical ordinary hold identity
```

## 10. Settlement lifecycle and identity

Conceptual lifecycle:

``` text
PREPARED
   ↓
ACQUIRED
   ├──→ REVERT_PENDING ──→ SETTLED
   └──→ FINALIZE_PENDING → SETTLED
```

`PREPARED` is intent, not proof of successful physical W4.

Settlement provenance preserves, as applicable:

``` text
manifestId
attemptId
operationId
captured incarnation I
immutable execution epoch E
captureTransitionId
markerId
generation
holdInstanceId
productId
quantity
customerId
cartId
acquisitionReplayId
settlementReplayId for terminal action
```

Resources are sealed. Never reconstruct trusted settlement authority
from Redis.

W4 uses `acquisitionReplayId`. W5/W6 use a distinct
`settlementReplayId`. Never reuse the acquisition replay identity for
terminal settlement.

## 11. W4 --- checkout acquisition

Required ordering:

``` text
durable CART_SCOPED capability + E
→ capability-bearing attempt with exact E
→ sealed PREPARED manifest
→ ACQUIRE authority
→ physical W4
→ checkout pins/acquisition evidence
→ PREPARED → ACQUIRED
→ order transaction
```

Do not start the order transaction before physical W4 is proven. Do not
mark ACQUIRED merely because authority was issued.

Lost W4 response is ambiguous and must be resolved through
durable/physical evidence. Do not allocate a different resource identity
simply because a response was lost.

`RESOURCE_ADVANCE` must reject replacement while the exact checkout pin
exists.

## 12. W5 --- failed checkout settlement

W5 requires a definitively failed checkout.

Durable failure obligation:

``` text
CheckoutAttempt = FAILED
CheckoutReservationSettlement = REVERT_PENDING
effect = CHECKOUT_REVERT
fixed settlementReplayId
```

Rules:

-   COMMITTED must never be reverted.
-   A database exception alone is not proof of transaction failure.
-   Resolve transaction ambiguity by rereading durable state.
-   Physical W5 operates only on sealed resources.
-   Uncertain W5 response leaves REVERT_PENDING and reuses the same
    replay ID.
-   SETTLED requires verified completion evidence.
-   Legacy whole-cart revert is not Phase G W5 authority.

## 13. W6 --- committed checkout settlement

The successful order transaction establishes atomically in PostgreSQL:

``` text
Order exists
CheckoutAttempt = COMMITTED
attempt.orderId = exact order
PostgreSQL cart cleared
existing sync markers advanced according to existing design
CheckoutReservationSettlement = FINALIZE_PENDING
effect = CHECKOUT_FINALIZE
fixed settlementReplayId
```

There must be no committed order whose physical-finalization obligation
depends only on an application callback after commit.

Physical W6:

``` text
FINALIZE_PENDING
→ exact CHECKOUT_FINALIZE authority
→ exact sealed resources
→ validate all resources before writes
→ consume/delete exact CHECKOUT_PENDING holds
→ exact index/accounting mutation
→ completion receipt + pin release atomically
→ verify evidence
→ SETTLED
```

Important crash/replay rules:

-   pre-commit failure rolls back;
-   lost PostgreSQL COMMIT response requires durable reread;
-   COMMITTED + FINALIZE_PENDING is never W5;
-   commit-before-W6 resumes W6;
-   uncertain W6 response stays FINALIZE_PENDING with the same replay
    identity;
-   if physical W6 succeeded but response was lost, observe the receipt
    before repeating destructive work;
-   verified receipt gates SETTLED.

Legacy whole-cart finalize is not Phase G W6 authority.

## 14. W7 --- checkout lease extension

W7 requires a permit at the physical mutation boundary.

Every resource W7 may mutate must be covered by the permit. An
unauthenticated/unpermitted reconciliation caller defers rather than
extending or reverting. Preserve the lease ceiling and existing W7
semantics while converting W1--W3.

## 15. G.4b.3 writer-closure findings

The G.4b.3 pre-edit inventory proved the remaining work is broader than
W3.

### W1

CART_SCOPED reserve/renew/reduce remains physically open and needs exact
durable ordinary-resource authority.

### W2

Release remains open. Broad cart/product deletion can delete a newer,
replacement, or checkout-owned hold unless converted to exact physical
identity.

### W3

Current reconciliation can perform product-wide discovery and mutation,
including expired-hold deletion, index repair, and aggregate-total
replacement. Authority for one cart/marker cannot authorize arbitrary
discovered product-wide effects.

### Recovery

The fenced W5 service is safe, but stale recovery historically contains
a raw revert path that can select CART_SCOPED attempts.
Capability-bearing recovery must use durable settlement provenance.

### Orphan cleanup

Missing PostgreSQL CartItem is not deletion authority. After an order
commits, PostgreSQL cart state can already be cleared while W6 still
legitimately owns the physical checkout hold.

## 16. Ordinary reservation durable identity decision

`CartReservationSyncState` is the durable logical authority for ordinary
reservation intent.

Important semantics:

-   one durable row per `(cartId, productId)`;
-   the marker row persists rather than being deleted/re-created during
    the pair's logical lifetime;
-   `generation` is permanent and monotonic;
-   `expectedQuantity` is absolute desired state;
-   `expectedQuantity = null` means desired physical absence;
-   `CartItem.mutationVersion` is a secondary table-write/compensation
    guard, not the permanent reservation lifetime identity.

Approved conceptual identity:

``` text
OrdinaryReservationIdentity =
(
  relevant incarnation I,
  applicable reservation execution epoch E,
  customerId,
  cartId,
  productId,
  markerId = CartReservationSyncState.id,
  generation,
  holdInstanceId
)
```

`expectedQuantity` is authorized state, not identity.

`CartItem.mutationVersion` is not lifetime physical identity.

## 17. Canonical ordinary holdInstanceId decision

**G.4b.3b.1 — COMPLETE**, approved in commit
`66db985 feat(checkout): add canonical ordinary hold identity`, starting from
`f71977765708b62657213aab0768bb204ecdc0c5`.

Canonical helper:
`backend/src/modules/reservation-fence/ordinary-hold-instance-id.ts`

Test:
`backend/src/modules/reservation-fence/ordinary-hold-instance-id.spec.ts`

Accepted algorithm: UUIDv5 using SHA-1.

``` text
ordinaryHoldInstanceId(markerId, generation)
namespace: 6ba7b810-9dad-11d1-80b4-00c04fd430c8
name: iriefishmongers:ordinary-reservation:v1:<markerId>:<generation>
```

Inputs are the durable `CartReservationSyncState` markerId and generation.
Generation is an integer from 0 through 2147483647 inclusive.

Established properties:

-   deterministic across retries, processes, service instances, and restarts;
-   same marker + generation => same holdInstanceId;
-   different marker or generation => different identity;
-   lowercase UUIDv5 output;
-   no randomness, clock, Redis input, quantity, CartItem mutationVersion,
    or checkout operation/attempt identity.

**Identity only — NOT authorization.**

Fixed verification vector:

``` text
markerId: 123e4567-e89b-12d3-a456-426614174000
generation: 0
holdInstanceId: 47cfb9c9-18fa-5393-b970-968535e03499
```

Compatibility findings:

-   existing ResourceAuthority / MutationPermit representation can carry it;
-   existing Redis guard serialization can carry it;
-   CheckoutReservationResource.holdInstanceId can carry it;
-   W5/W6 require identity equality, not random allocation;
-   no schema change, migration, or permit/resource type extension;
-   zero production callers: no production writer calls the helper yet;
-   W1-W7 production behavior and production activation are unchanged.

Accepted checkpoint verification evidence (not rerun for this memory update):

| Group | Suites passed | Tests passed |
| --- | ---: | ---: |
| Focused identity | 1 | 23 |
| Reservation-fence | 10 | 269 |
| Permit/executor subset | 2 | 119 |
| Settlement repository/authority/protocol | 3 | 30 |
| W4 | 2 | 21 |
| W5 | 2 | 49 |
| W6 | 2 | 61 |
| W7 | 5 | 85 |
| Serial regression total | 21 | 485 |

Zero failures/skips. These groups/subsets overlap and must not be added
together as independent totals.

Backend lint, backend typecheck, backend build, Prisma validate, Prisma
generate, and git diff --check passed. Integration Redis used
`127.0.0.1:16479` only; Redis 6379 was untouched.

## 18. W1 approved direction

W1 must eventually require exact ordinary-resource authority:

``` text
PostgreSQL establishes authoritative marker generation
→ permit issuer loads exact durable marker/current ownership
→ permit names exact physical transition
→ Redis validates predecessor/current guard
→ atomic physical mutation + guard transition
```

A stale generation may never overwrite a newer generation.

Positive ordinary ownership creation/renewal is OPEN-only. DRAINING must
not create new ordinary ownership.

An uncertain Redis response must not trigger blind compensation or a new
hold identity. Reread durable marker plus exact physical state and retry
only the same authorized generation when appropriate.

## 19. W4 ordinary-hold transfer decision

Approved direction: **W4 preserves/transfers the existing canonical
ordinary hold identity rather than replacing it with an unrelated random
checkout hold identity.**

Checkout ownership is distinguished by the complete settlement identity,
including:

``` text
manifest
operationId
attemptId
captured I/E
markerId
generation
holdInstanceId
acquisitionReplayId
checkout pin
```

State model:

``` text
ORDINARY ACTIVE
      |
      | PREPARED manifest seals exact ordinary identity
      v
CHECKOUT TRANSFER PREPARED
      |
      | W4 validates exact hold/guard
      | ACTIVE → CHECKOUT_PENDING
      | establishes checkout pin
      v
CHECKOUT_PENDING / PINNED
      |
      +--> W5 failure settlement
      |
      +--> W6 committed settlement
```

Once pinned, W1/W2/W3 may not mutate the resource.

If concurrent W1 advances the physical ordinary generation first, W4
must reject the stale sealed generation. W4 gets no broad generation
bypass.

## 20. W2 approved direction

W2 becomes exact release.

Authority identifies the relevant:

``` text
I / E
markerId
generation
holdInstanceId
customerId
cartId
productId
effect = RELEASE
```

Required behavior:

-   exact expected hold present: delete and adjust accounting
    atomically;
-   exact expected hold already absent: idempotent success only when no
    conflicting newer ownership exists;
-   newer/different generation: reject stale;
-   different hold identity: reject;
-   checkout pin: reject;
-   CHECKOUT_PENDING: reject ordinary release;
-   wrong I/E: reject.

Orphan discovery never creates release authority by itself.

## 21. W3 approved reconciliation model

W3 is decomposed into three concepts.

### W3-O --- observation

May inspect product indexes, holds, calculated totals, malformed
entries, expired candidates, missing/stale index membership, aggregate
drift, and suspect state.

It performs **zero writes**.

### W3-R --- exact bounded repair

May mutate only exact resources explicitly covered by durable authority.

Lua must not discover additional mutation targets and mutate them simply
because they appear in a Redis index. For atomic multi-resource repair,
validate all targets before the first write.

### W3-P --- product aggregate repair

Ordinary runtime reconciliation must not authoritatively execute:

``` text
SET productTotal = Redis-discovered computed total
```

without a complete product-level authority/snapshot protocol.

Approved conservative runtime behavior:

``` text
observe aggregate mismatch
→ mark/retain suspect
→ defer authoritative product-total replacement
```

Suspect clearing requires complete verified repair authority.

A future complete product repair may require a product-scoped lock/gate
or durable RepairPlan. Do not invent that architecture inside ordinary
W3 conversion unless it becomes necessary and is separately reviewed.

## 22. Recovery dispatch decision

Recovery must separate LEGACY from capability-bearing CART_SCOPED work.

  -----------------------------------------------------------------------
  Durable state                       Required recovery behavior
  ----------------------------------- -----------------------------------
  LEGACY                              existing legacy recovery

  CART_SCOPED + FAILED +              continue existing W5
  REVERT_PENDING

  CART_SCOPED + COMMITTED +           continue existing W6
  FINALIZE_PENDING

  CART_SCOPED + SETTLED               no physical action

  PROCESSING + ACQUIRED               do not fabricate terminal action;
                                      only approved failure-proof
                                      protocol may transition

  PREPARED                            acquisition recovery/diagnostic;
                                      never manufacture W5/W6

  missing manifest                    fail closed

  NULL-E historical                   fail closed

  historical COMMITTED + ACQUIRED     invariant breach/fail closed

  ambiguous historical capability     diagnostic/manual path
  state
  -----------------------------------------------------------------------

Restart must not invent new terminal replay identities merely because a
stale attempt was discovered.

Raw legacy revert/finalize must not be used for capability-bearing
CART_SCOPED resources.

## 23. Orphan cleanup decision

Missing CartItem is an observation signal, not deletion authority.

Classification:

``` text
candidate physical hold
    |
    +-- checkout pin exists
    |      => leave to W5/W6
    |
    +-- exact current durable marker/generation/hold matches
    |      => valid ordinary resource
    |
    +-- durable marker authorizes desired absence of exact old identity
    |      => exact W2 release may be authorized
    |
    +-- newer/different physical identity
    |      => stale observation; do not mutate
    |
    +-- malformed / no durable provenance
           => suspect/diagnostic; fail closed
```

PostgreSQL cart clearing after order commit must never cause ordinary
orphan cleanup to delete a W6-owned hold. Checkout pins categorically
block ordinary orphan cleanup.

## 24. Phase rules for remaining writers

| Operation | OPEN | DRAINING | FROZEN | RETIRED |
| --------- | ---- | -------- | ------ | ------- |
| W1 create/increase/renew | exact permit allowed | deny | deny | deny |
| W1 positive reduction/recreate | exact permit allowed | deny unless separately proven safe | deny | deny |
| W2 exact full release | allow | allow exact non-increasing release | deny | deny |
| W3 observation | allow | allow | read-only | read-only |
| W3 exact mutation | explicit repair authority | only explicitly approved non-increasing cleanup | deny | deny |
| product-total replacement | not ordinary runtime | deny runtime | deny | deny |
| W5/W6 | preserve settlement rules | preserve approved settlement rules | deny unless separately designed | deny |
| W7 | preserve current rules | preserve current rules | deny | deny |

"Cleanup" is not itself an authorization class.

## 25. Current implementation sequence

Do not enforce W1 before W4 can consume the same canonical identity
model.

### G.4b.3b.1 --- canonical ordinary identity foundation --- COMPLETE

Approved in `66db985`. The reusable identity foundation and compatibility
verification are recorded in section 17. No production writer behavior,
schema, or migration changed.

### G.4b.3b.2 --- W4 handoff adaptation --- NEXT

Make settlement preparation capture/preserve the trusted canonical ordinary
holdInstanceId established by G.4b.3b.1 instead of allocating an unrelated
checkout hold identity, while preserving W4 acquisition state/replay semantics,
checkout pins, generation fencing, and W5/W6 settlement compatibility.

A detailed implementation design requires fresh source review first.

### G.4b.3b.3 --- W1 fencing

Require exact ordinary mutation authority at physical W1 boundaries and
close reserve/renew/increase/reduce/freshness writers.

### G.4b.3c --- exact W2 release

Make release generation/hold/pin aware and convert relevant CART_SCOPED
callers.

### G.4b.3d --- W3 reconciliation conversion

Make observation side-effect-free, bound repairs to explicit resources,
and remove ordinary product-wide Redis-discovered aggregate replacement.

### G.4b.3e --- recovery/orphan dispatch closure

Separate LEGACY/CART_SCOPED terminal recovery and prevent orphan cleanup
from touching checkout-owned resources.

### G.4b.3f --- writer closure certificate

Rescan all physical mutation entrypoints and prove W1--W7 are
fenced/settlement-authorized and W8 remains observational.

Only after G.4b.3 closes should later freeze/drain/activation work
proceed.

## 26. Production inactivity

Phase G remains inactive.

At the current checkpoint:

-   production `POST /orders/checkout` continues through existing
    `OrdersService.checkout`;
-   the Phase G dispatcher is not the production checkout route;
-   no rollout defaults should change in G.4b.3;
-   no controller should be changed merely to exercise Phase G;
-   no payment/WiPay behavior should change.

Activation belongs to a later explicitly approved phase.

## 27. Testing discipline

For implementation slices:

1.  focused tests first;
2.  relevant reservation-fence and checkout regressions;
3.  broader suites at physical writer boundaries;
4.  serialize shared Redis tests where necessary;
5.  disposable Redis only;
6.  distinguish environmental interruption from code failure;
7.  rerun unchanged after environmental interruption before drawing
    conclusions.

Never weaken assertions, coverage, timeout thresholds merely to force
success, `.skip`/`.only` discipline, or concurrency protections.

Standard checks where applicable:

``` text
backend lint
backend typecheck
backend build
Prisma validate
Prisma generate
git diff --check
```

## 28. Git/review discipline

At pre-stage gates inspect:

``` text
git diff --check
git diff --stat
git status --short --untracked-files=all
git diff --cached --name-only
```

Before staging, independently review the full source diff and confirm:

-   only expected files changed;
-   protected files remain untouched;
-   no schema/package/payment/activation drift unless explicitly
    authorized.

Stage explicit paths only.

Do not push unless explicitly requested.

After every accepted commit, update this memory record with the new
protected baseline, commit subject, completed slice, invariant
established, verification evidence, unresolved issues, and next
authorized slice.

## 29. G.4b.3 closure invariants

G.4b.3 is not complete until all are proven:

1.  Every ordinary CART_SCOPED hold has canonical durable provenance.
2.  Every W1 mutation is exact-generation authorized.
3.  Every W2 release is exact-identity authorized.
4.  W4 safely transfers/preserves the exact ordinary hold identity.
5.  Checkout pins prevent W1/W2/W3 mutation.
6.  Runtime W3 cannot use Redis-discovered membership as authority for
    uncovered mutation.
7.  Runtime W3 cannot replace product totals from an uncovered scan.
8.  Suspect clearing requires complete repair authority/evidence.
9.  Capability-bearing CART_SCOPED recovery cannot use raw legacy W5/W6
    cleanup.
10. Missing-manifest and historical NULL-E states fail closed.
11. PostgreSQL cart clearing cannot cause orphan deletion of a W6-owned
    hold.
12. FROZEN/RETIRED deny CART_SCOPED physical writes.
13. W4/W5/W6/W7 crash/replay semantics remain intact.
14. Production checkout routing remains unchanged until separately
    activated.

## 30. Other Irie Fishmongers context

Azure/GHCR staging context includes:

-   Azure Container Apps
-   GHCR-direct
-   no ACR
-   migrator job
-   staging email intentionally disabled by default
    (`EMAIL_ENABLED=false`) in the established staging configuration

Earlier WiPay sandbox alignment included form-urlencoded request
behavior with JSON response acceptance, browser-return success hash
validation, and a payment E2E suite reported as 9 passing tests. Payment
behavior is outside the current Phase G writer-closure scope and must
not be changed incidentally.

## 31. Future-session instruction

Start future ChatGPT/Codex sessions with:

``` text
Before making changes, read IRIE_PROJECT_MEMORY.md and .claude/roadmap.md.

Treat IRIE_PROJECT_MEMORY.md as the project continuity/decision record.
Treat current source and committed database constraints as behavioral authority.

Verify the recorded branch and HEAD against Git.

If the memory file is stale, contradictory, or the requested task would violate
a recorded invariant, stop and report the discrepancy before editing.

Never touch the protected diagnostic/review files listed in the memory file.
```

For a new ChatGPT conversation, provide the latest committed copy of
this file when exact engineering continuity is important.

## 32. Maintenance rule

This is a living record. Update it after a decision or implementation
has been independently reviewed and accepted, not merely because an
agent proposed it.

For each accepted checkpoint preserve:

``` text
date
slice
starting HEAD
approved commit hash
commit subject
files changed
invariant established
important verification evidence
known unresolved issue
next authorized slice
```

Do not erase superseded architectural decisions. Mark them superseded
and record the replacement decision.

## 33. Current handoff

Current protected baseline:

``` text
66db985e0d1b43ba749f7a33c72869c958a871a5
feat(checkout): add canonical ordinary hold identity
```

Current next engineering slice:

``` text
G.4b.3b.2 — W4 handoff adaptation
```

Primary objective:

``` text
Make settlement preparation capture/preserve the trusted canonical ordinary
holdInstanceId established by G.4b.3b.1 instead of allocating an unrelated
checkout hold identity, while preserving W4 acquisition state/replay semantics,
checkout pins, generation fencing, and W5/W6 settlement compatibility.
```

G.4b.3b.2 requires fresh source review before a detailed implementation
design. This checkpoint does not authorize staging, committing, or pushing.

------------------------------------------------------------------------

**End of authoritative project memory.**
