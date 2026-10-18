# IRIE FISHMONGERS PLATFORM --- AUTHORITATIVE PROJECT MEMORY

**Status date:** 18 October 2026\
**Purpose:** Persistent engineering continuity and decision record for
ChatGPT, Codex, and future engineering sessions.\
**Repository:**
`C:\Users\user\Documents\Bernie Project\Iriefishmonger platform`\
**Branch:** `feat/phase-g-limited-rollout`\
**Protected baseline:** `9d9f11d23f955ffa148912c3974a43c665d3d6d4`\
**Subject:** `feat(reservation-fence): add dormant ordinary recovery module and telemetry`\
**Historical baseline:** `66db985e0d1b43ba749f7a33c72869c958a871a5` (`feat(checkout): add canonical ordinary hold identity`)\
**Current Phase:** Phase G --- Limited Rollout / Phase C.3.5 Complete (Dormant Recovery Module)

> Source code and committed database constraints remain authoritative
> for actual behavior. This file is the project continuity/decision
> record. If it conflicts with current source, stop and resolve the
> discrepancy rather than silently following either version.
> Current HEAD `9d9f11d` is committed locally only; not pushed, merged, or deployed.

## 1. Mandatory startup protocol

Before changing the repository, read this file and `docs/roadmap.md`
(which supersedes the retired `.claude/roadmap.md`), then verify branch,
HEAD, working tree, and cached diff. Do not assume this checkpoint is current
if Git disagrees. Design-gated work must complete its source/design
review before edits.

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
g4b3b3-production-review.txt
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
| W1 | reserve / renew / increase / reduce ordinary holds | FENCED protocol & durable issuance implemented (`3c86912`, `817dc19`, `51c6644`); live CartService publication unwired (Phase B scope) |
| W2 | release ordinary holds | FENCED protocol implemented (`c915f4f`); exact release with publication awareness |
| W3 | reconciliation / repair | FENCED observation-only reconciliation (`5fe13ab`); product restriction (`1003985`) |
| W4 | checkout acquisition/mark | FENCED; canonical ordinary hold identity preserved in acquisition (`5f6c54c`, `970f509`, `39fbfe8`) |
| W5 | failed-checkout settlement | FENCED service; stale checkout settlement with durable manifest (`64e03e4`) |
| W6 | committed-checkout finalization | FENCED |
| W7 | checkout lease extension | FENCED |
| W8 | former read-side suspect mutation | REMOVED / READ-ONLY |

Legacy hash-based paths remain separate. Do not convert legacy-only
behavior for symmetry, but raw/legacy mutation must never become
authority over capability-bearing CART_SCOPED resources.

## 8. Completed Phase G and reservation-fence work

Completed checkpoints:

``` text
G.4a failure matrix & rollback evidence harness
G.4b.1 reservation mutation fence infrastructure
G.4b.2a permit semantics & observational reads
G.4b.2a.1 reservation mutation fence protocol
G.4b.2b.1 lease extension fencing
G.4b.2b.2 / W7 checkout lease extension fencing
G.4b.2c.1 durable settlement manifest protocol
G.4b.2c.2 fenced W4 acquisition
G.4b.2c.3 fenced W5 failure settlement
G.4b.2c.4 fenced W6 committed settlement
G.4b.3 pre-edit writer inventory
G.4b.3a architecture/design closure
G.4b.3b.1 canonical ordinary reservation identity foundation (66db985)
G.4b.3b.2 W4 acquisition handoff adaptation (5f6c54c)
G.4b.3b–e canonical ordinary ownership fencing & physical protocol (4937805..64e03e4)
Phase A ordinary command authority hardening & tests (51c6644)
Phase C.1 marker enrollment & fail-closed readiness (eeff0de)
Phase C.2 invalidation recovery sweep worker & marker bootstrap (d8d500f)
Phase C.3.1 atomic recovery diagnostics & backoff clearing (d0dbdec)
Phase C.3.2 dormant ordinary command recovery sweep (738bdad)
Phase C.3.3 dedicated dormant command recovery worker (467e1c8)
Phase C.3.4 dormant ordinary recovery orchestration coordinator (86fa2fc)
Phase C.3.5 dedicated dormant ordinary recovery module & telemetry (9d9f11d)
```

G.4b.3b.1 and G.4b.3b.2 are complete. Phase A ordinary command authority and Phase C (C.1 through C.3.5) are complete at the dormant component level. Live caller wiring (Phase B), operational scheduler activation, and production cutover are not implemented and remain strictly unauthorized.

## 9. Chronological commit history (post-G.0 through HEAD 9d9f11d)

### 9.1 Historical Phase G rollout slices (through 66db985)

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

### 9.2 Reconciled ledger (25 commits from historical baseline 66db985 to HEAD 9d9f11d)

| # | Commit Hash | Subject | Workstream | Implementation Purpose & Invariant Established | Runtime Status |
|---|---|---|---|---|---|
| 1 | `058534299865d13187a38f8fce131da4f84b9684` | `docs(project): add authoritative Irie project memory` | Documentation | Initial project memory and continuity baseline at `66db985`. | Document only |
| 2 | `39fbfe8fe7b1630e95b0564817be621624d84e97` | `fix(checkout): harden settlement completion evidence` | Settlement | Validates matching typed receipt evidence before marking settlements complete. | Fenced |
| 3 | `970f509a1d20e28a1162ab44f9c75c9fed54d825` | `feat(checkout): bind checkout key to acquisition evidence` | Acquisition | Links checkout key to Redis acquisition proof, preventing cross-checkout reuse. | Fenced |
| 4 | `207fd24d46e9cf073987c140fff7a705cfb84222` | `fix(checkout): allow historical hold identity reuse` | Settlement | Permits historical hold reuse where durable ownership is proven. | Fenced |
| 5 | `5f6c54cecdfe44a482037308581e9f9737dc26e7` | `feat(checkout): preserve canonical hold identity in acquisition` | W4 / G.4b.3b.2 | Settlement preparation captures canonical ordinary hold identity from G.4b.3b.1. | Fenced |
| 6 | `493780549e15623358cbdda9916d777c85346a8d` | `feat(reservations): fence canonical ordinary ownership` | Reservation-fence | Fences ordinary ownership against concurrent unpermitted modifications. | Fenced |
| 7 | `1ca4400204214971f85c5965a2fa384270c8986e` | `feat(reservations): add ordinary owner provenance foundation` | Ownership | Durable mapping between cart items, markers, and owner provenance. | Fenced |
| 8 | `3c86912d98adb7f9c29a19fa22998afccfc774f3` | `feat(reservations): add durable ordinary w1 issuance` | W1 issuance | Durable issuance for W1 ordinary reserve/renew/reduce commands. | Fenced |
| 9 | `817dc1920072dd9b6fdc15599702a629eaaa1993` | `feat(reservations): add command-bound physical protocol` | Physical protocol | Binds physical Redis execution to validated durable command IDs. | Fenced |
| 10 | `3bc0cab10e975e1331362d6897a905157ac3a198` | `feat(reservations): add durable ordinary command closure` | Command closure | Bounded CAS transitions closing ordinary commands upon completion. | Fenced |
| 11 | `298cc7f77e9e03e184f2fbbf7e1fa59e5dc826ba` | `feat(reservations): add durable first-dispatch claim` | Dispatch claim | Atomic CAS `attemptCount: 0 -> 1` claim for ordinary commands. | Fenced |
| 12 | `89d051f53a4569918f669572b74e3dd4f9450d24` | `feat(reservation-fence): add ordinary command admission capability` | Admission | WeakMap-backed in-memory capability token for ordinary command admission. | In-memory token |
| 13 | `5b34efcf1a6f79f012ad2e3b09f5007fe048f2f5` | `feat(reservations): add mutation-time invalidation protocol` | Invalidation | Two-phase invalidation intent and barrier protocol for ordinary commands. | Fenced |
| 14 | `c915f4f78331d514de5f4893046aab77adb932bf` | `feat(reservations): add publication-aware exact release` | W2 release | Exact identity and generation-aware release with publication check. | Fenced |
| 15 | `1003985bee0d5e6c49efb1cc0c312e59e22f1594` | `feat(reservations): add permanent product restriction` | Restrictions | Installs product-level reservation restriction in PG and Redis Lua. | Fenced |
| 16 | `5fe13ab5e03d781237e90537f65a39f6b9116ec6` | `feat(reservations): add observation-only reconciliation` | W3 reconciliation | Replaces mutating discovery with read-only observation and suspect flags. | Fenced |
| 17 | `64e03e4a804022e547905d7fe9a6f84d31d372db` | `feat(reservations): add fenced stale checkout recovery` | W5 recovery | Replaces raw revert with sealed settlement manifest recovery. | Fenced |
| 18 | `51c66448b518c6e3687dd3c2ed52b4e8ff66f6e7` | `feat(reservation-fence): harden Phase A ordinary command authority and tests` | Phase A | Hardens command authority, claim validation, and Windows test infrastructure. | Fenced / Dormant |
| 19 | `eeff0dea4d9c4584179624d37f04c27dccd4708f` | `feat(reservation-fence): add Phase C1 marker enrollment and fail-closed readiness` | Phase C.1 | Explicit marker enrollment and fail-closed barrier readiness check. | Dormant |
| 20 | `d8d500f908de83a76f1c1035387ab25f12086211` | `feat(reservation-fence): add Phase C2 recovery and marker bootstrap` | Phase C.2 | Invalidation sweep worker and marker bootstrap service. | Dormant |
| 21 | `d0dbdecc85a7550941f8b9f5b87f3c63545e46a3` | `feat(reservation-fence): add atomic recovery diagnostics and fail-closed backoff clearing` | Phase C.3.1 | Advisory exponential backoff in Redis and atomic conditional clearing. | Dormant |
| 22 | `738bdad362d3deff720c4c1388c7b64894edf227` | `feat(reservation-fence): add dormant ordinary command recovery sweep` | Phase C.3.2 | Bounded command recovery discovery and Redis observation receipt check. | Dormant |
| 23 | `467e1c834d9b45a4698f24338863682fef301929` | `feat(reservation-fence): add dormant ordinary command recovery worker` | Phase C.3.3 | Dedicated dormant command recovery sweep worker; schedulers suppressed. | Dormant |
| 24 | `86fa2fccbab0790644314dc83520f898075df90a` | `feat(reservation-fence): add dormant ordinary recovery coordinator` | Phase C.3.4 | Sequences command recovery before invalidation recovery with mutex guard. | Dormant |
| 25 | `9d9f11d23f955ffa148912c3974a43c665d3d6d4` | `feat(reservation-fence): add dormant ordinary recovery module and telemetry` | Phase C.3.5 | Self-contained OrdinaryRecoveryModule, telemetry adapter, and sweep events. | Dormant |

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

### G.4b.3b.1 --- canonical ordinary identity foundation --- COMPLETE

Approved in `66db985`. The reusable identity foundation and compatibility
verification are recorded in section 17. No production writer behavior,
schema, or migration changed.

### G.4b.3b.2 --- W4 handoff adaptation --- COMPLETE

Approved in `5f6c54c`. Settlement preparation captures and preserves the
trusted canonical ordinary holdInstanceId established by G.4b.3b.1 instead of
allocating an unrelated checkout hold identity, preserving W4 acquisition
state/replay semantics, checkout pins, generation fencing, and W5/W6
settlement compatibility.

### G.4b.3b–e --- canonical ordinary ownership, issuance & physical protocol --- COMPLETE

Approved across commits `4937805` through `64e03e4`:
- Canonical ordinary ownership fencing (`4937805`).
- Ordinary owner provenance foundation (`1ca4400`).
- Durable ordinary W1 issuance (`3c86912`).
- Command-bound physical protocol (`817dc19`).
- Durable ordinary command closure (`3bc0cab`).
- Durable first-dispatch claim authority (`298cc7f`).
- Ordinary command admission capability (`89d051f`).
- Mutation-time invalidation protocol (`5b34efc`).
- Publication-aware exact release W2 (`c915f4f`).
- Permanent product restriction (`1003985`).
- Observation-only reconciliation W3 (`5fe13ab`).
- Fenced stale checkout recovery W5 (`64e03e4`).

### Phase A --- ordinary command authority hardening --- COMPLETE

Approved in `51c6644`. Hardens ordinary reservation command authority, claim
validation, provenance verification, and Windows-native test infrastructure.

### Phase C (C.1–C.3.5) --- dormant ordinary recovery subsystem --- COMPLETE (DORMANT)

Approved across commits `eeff0de` through `9d9f11d`. Delivers complete dormant
ordinary invalidation and command recovery subsystems, packaged inside a
self-contained NestJS module with telemetry and suppressed background schedulers.

### Phase B --- live ordinary writer cutover --- NOT AUTHORIZED / BLOCKED

Phase B wires ordinary invalidation publication directly into production cart
mutations (`CartService.executeAddItem`, `updateItemQuantity`, `removeItem`).
It remains blocked until distributed recovery scheduling, operational leadership,
and rollback drill verification are approved.

## 26. Phase A ordinary command authority hardening

Approved in commit `51c6644 feat(reservation-fence): harden Phase A ordinary command authority and tests`.

Key architectural deliverables:
- **Durable Command Authority (`OrdinaryCommandAuthorityService`)**:
  Validates request inputs, active fence incarnation `I`, execution epoch `E`,
  and authoritative marker generation before minting reservation commands.
- **Durable First-Dispatch Claim (`OrdinaryCommandDispatchClaimRepository`)**:
  Atomic CAS claim transition `attemptCount: 0 -> 1` under row locks, preventing
  concurrent double-dispatch of the same command.
- **WeakMap Capability Isolation (`OrdinaryMutationCapability`)**:
  In-memory non-forgeable ticket passed to `OrdinaryCommandPhysicalService`.
  Ensures physical Redis execution cannot be invoked directly without an
  authorized in-band claim.
- **Command-Bound Physical Protocol**:
  Binds physical Redis Lua execution to durable command identifiers and captures
  verifiable execution receipts (`receiptHash`).
- **Durable Command Closure (`OrdinaryCommandClosureService`)**:
  Transitions commands to `COMMITTED` or `FAILED` atomically based on receipt
  evidence, updating durable counters and marker generations.
- **Windows-Native Test Infrastructure**:
  Hardens Jest suites, Prisma schema deployment, and disposable Redis isolation
  (`127.0.0.1:16479`) for reliable local and CI execution.

Runtime Status: Fenced / Dormant component level. No live cart route cutover.

## 27. Phase C dormant ordinary recovery subsystem (C.1–C.3.5)

Phase C establishes the ordinary invalidation publication, marker enrollment,
and command recovery subsystems. Implemented across seven progressive slices:

### 27.1 Phase C.1 --- marker enrollment & fail-closed readiness

Approved in commit `eeff0de feat(reservation-fence): add Phase C1 marker enrollment and fail-closed readiness`.
- **Explicit Lazy Provisioning**: `OrdinaryInvalidationRepository.enrollMarker()`
  transactionally initializes marker heads under `pg_advisory_xact_lock` with
  `ready: true`, matching active fence incarnation `I` and epoch `E`.
- **Fail-Closed Barrier Readiness**: Corrects the critical vulnerability in
  `requireOrdinaryBarrierReadiness()` by removing the `if (!marker) return null`
  bypass. Mismatched or missing marker heads now throw `INVALIDATION_PENDING`
  instead of permitting un-fenced mutations.
- **Zero Schema Migrations**: Operates entirely within existing tables
  (`ordinary_invalidation_heads`, `ordinary_invalidation_intents`, `ordinary_invalidation_scopes`).

### 27.2 Phase C.2 --- invalidation recovery sweep worker & marker bootstrap

Approved in commit `d8d500f feat(reservation-fence): add Phase C2 recovery and marker bootstrap`.
- **Sweep Worker (`OrdinaryRecoverySweepWorker`)**: Discovers stranded invalidation
  intents (`PREPARED`, `BARRIER_CONFIRMED`), confirms Redis barrier state, and
  drives deterministic completion or supersession without background cron.
- **Marker Bootstrap (`OrdinaryMarkerBootstrapService`)**: Pre-populates invalidation
  heads for existing sync markers during system startup.
- **Bounded Sweeps**: Enforces strict keyset pagination (default 50, maximum 100)
  to bound cycle execution times.

### 27.3 Phase C.3.1 --- atomic recovery diagnostics & advisory backoff

Approved in commit `d0dbdec feat(reservation-fence): add atomic recovery diagnostics and fail-closed backoff clearing`.
- **Advisory Backoff (`OrdinaryRecoveryDiagnosticsService`)**: Manages non-authoritative
  Redis exponential backoff scheduling hints (`iriefishmongers:ordinary-invalidation:retry:<intentId>`).
- **Atomic Conditional Clearing**: Lua script conditionally deletes backoff hints
  only when current Redis payload matches the expected intent digest.
- **Fail-Closed Safety**: Redis outages or key expiries fail closed; backoff keys
  cannot mutate PostgreSQL intent state or release reservation fences.

### 27.4 Phase C.3.2 --- dormant ordinary command recovery sweep

Approved in commit `738bdad feat(reservation-fence): add dormant ordinary command recovery sweep`.
- **Command Recovery (`OrdinaryCommandRecoveryService`)**: Discovers interrupted
  ordinary commands (`attemptCount = 1` or `attemptCount = 0` past cutoff).
- **Observation-Only Verification**: Uses Redis `OBSERVE` to inspect command execution
  receipts without physical re-dispatch. Commands with matching receipts are closed
  as `COMMITTED`; unexecuted commands past cutoff are marked `FAILED`.
- **Uncertainty Deferral**: Ambiguous Redis observations are deferred rather than
  speculatively retried or deleted.

### 27.5 Phase C.3.3 --- dedicated dormant command recovery worker

Approved in commit `467e1c8 feat(reservation-fence): add dormant ordinary command recovery worker`.
- **Worker Execution (`OrdinaryCommandRecoverySweepWorker`)**: Dedicated worker
  driving single-pass command recovery sweep cycles.
- **Scheduler Suppression**: Automated `@Cron` decorators and timers are strictly
  omitted. The worker is executable only via explicit, programmatic invocation.

### 27.6 Phase C.3.4 --- dormant ordinary recovery orchestration coordinator

Approved in commit `86fa2fc feat(reservation-fence): add dormant ordinary recovery coordinator`.
- **Recovery Sequencing (`OrdinaryRecoveryOrchestrationCoordinatorService`)**:
  Sequences command recovery *before* invalidation recovery in every cycle:
  $$\text{Command Recovery Sweep} \longrightarrow \text{Invalidation Recovery Sweep}$$
  Prevents invalidation sweeps from prematurely advancing heads while command
  receipts remain unclosed.
- **Composite Typed Result Contract**: Returns `CoordinatedRecoveryResult` containing
  strongly typed `command` and `invalidation` child execution summaries.
- **Process-Local Mutex**: Prevents concurrent overlapping sweep cycles within
  the same process.

### 27.7 Phase C.3.5 --- dedicated dormant ordinary recovery module & telemetry

Approved in commit `9d9f11d feat(reservation-fence): add dormant ordinary recovery module and telemetry`.
- **Self-Contained Module (`OrdinaryRecoveryModule`)**:
  Dynamic/factory DI composition providing coordinator, workers, and diagnostics
  without importing or altering production `ReservationFenceModule` or `AppModule`.
- **Complete Application Graph Isolation**:
  The module exposes no HTTP controllers and is NOT registered in `AppModule`.
- **Suppressed Schedulers**:
  Both C.2 and C.3.3 workers remain completely dormant with no background scheduling.
- **Observation-Only Physical Boundary**:
  Recovery providers have read-only Redis observation access; physical mutation
  capability tokens are strictly omitted.
- **Structured Telemetry (`OrdinaryRecoveryTelemetryAdapterService`)**:
  Emits strongly typed `ordinary-recovery.sweep.completed` events via NestJS
  `EventEmitter2` and Nest Logger. Redacts all customer, cart, and command PII.
- **Verification Evidence Reconciliation**:
  Accepted implementation verified with **18 focused tests** in
  `backend/src/modules/reservation-fence/tests/ordinary-recovery-module.spec.ts`
  and **175 predecessor regression tests** (totaling 193 passing tests across 8 suites).
  *(Note: An earlier roadmap draft noted 14 tests; actual source and execution
  records confirm exactly 18 test cases in the module suite).*

## 28. Critical safety invariants

The following ten architectural safety invariants govern all reservation-fence
and recovery operations:

1. **PostgreSQL Authoritative**: PostgreSQL is the sole durable authority for
   reservation command state, invalidation publication intent state, and idempotency.
2. **Advisory Backoff**: Redis recovery backoff keys are non-authoritative retry
   hints; key loss, expiration, or Redis downtime cannot alter PostgreSQL state.
3. **No Physical Re-dispatch**: Physical recovery observation must never re-dispatch
   ordinary reservation commands. Interrupted commands are observed or closed, never re-executed.
4. **Historical Command Closure First**: Ordinary commands must be definitively
   closed (`COMMITTED` or `FAILED`) before invalidation heads advance.
5. **Ambiguity Retained**: Ambiguous execution evidence must remain deferred and
   uncertain; speculative retries or synthetic completions are prohibited.
6. **No Speculative Mutation**: Recovery sweeps never perform speculative writes to
   carts, inventory, orders, payments, or owner records.
7. **Schedulers Suppressed**: Background cron jobs, timers, and automated workers
   remain strictly disabled until multi-instance leadership is proven.
8. **AppModule Isolation**: Dormant recovery modules (`OrdinaryRecoveryModule`,
   `CheckoutDispatchModule`) must not be imported into the production application graph.
9. **Production Routing Untouched**: Production `POST /orders/checkout` and cart
   endpoints remain on legacy implementations until separate cutover approval.
10. **Phase B Authorization Gate**: Phase B live writer cutover requires separate,
    explicit architectural review and authorization.

## 29. Authority-gap register (G1–G5)

The reservation-fence subsystem authority framework tracks five fundamental
architectural authority gaps:

| Gap ID | Authority Gap Name | Current Working Status | Residual Risk & Post-C.3.5 State |
| :--- | :--- | :--- | :--- |
| **G1** | **Process-Local Claim Bypass** | **Partially Closed** | Claims use in-memory WeakMap tokens (`OrdinaryMutationCapability`). Single-process execution is isolated; distributed multi-process capability sharing remains unaddressed until background activation. |
| **G2** | **Claim/Load Predicate Drift** | **Partially Closed** | Phase A unified dispatch identity validation; Phase C.1 enforces fail-closed barrier readiness. Environmental changes between claim and physical load transactions still present minor window risk. |
| **G3** | **Claim-Loss Recovery** | **Closed (Dormant)** | Interrupted commands with `attemptCount = 1` are safely discovered and reconciled via `OrdinaryCommandRecoveryService`. Closed at component level; operational scheduling remains dormant. |
| **G4** | **PostgreSQL/Redis Split** | **Closed (Dormant)** | Two-phase invalidation publication and observation-only receipt matching handle split-store failures. Component-level verified; multi-store failure drills on staging remain outstanding. |
| **G5** | **Publication Acquisition** | **Open (Phase B)** | `OrdinaryInvalidationPublicationService` exists and is tested, but remains unwired to production `CartService` mutations (`executeAddItem`, `updateItemQuantity`, `removeItem`). |

*(Note: The G1–G5 authority-gap register governs reservation-fence command authority
and is distinct from the historical G.4a rollback blocker register BLOCKER-1..5).*

## 30. Outstanding operational acceptance gates

Before Phase B production cutover or Phase G checkout activation can be considered,
the following operational gates must be satisfied:

1. **Gate 1 — Authoritative Continuity Reconciliation**:
   `IRIE_PROJECT_MEMORY.md` updated to current HEAD `9d9f11d` (this task).
2. **Gate 2 — Multi-Instance Distributed Scheduler Architecture**:
   Direct-session PostgreSQL advisory locking (`pg_try_advisory_lock` in CHKT
   namespace) designed and verified for multi-container recovery sweep serialized execution.
3. **Gate 3 — Rollback Drill Verification on Disposable Redis**:
   Execution of the 36-scenario G.4a failure matrix on `redis://127.0.0.1:16479`.
4. **Gate 4 — Phase B Publication Wiring Specification**:
   Formal architectural specification for transaction-local `CartService` publication
   acquisition with explicit rollback invariants.
5. **Gate 5 — Formal Activation Authorization**:
   Explicit user approval per Invariant 12 of `phase-g-limited-rollout-design.md`.

## 31. Phase numbering and roadmap authority declaration

To prevent roadmap drift and confusion across planning artifacts:

```text
C3_5=LAST_COMPLETED_DEFINED_C3_MILESTONE
C3_6=NOT_DEFINED
C3_7=NOT_DEFINED
C4=INFORMAL_FUTURE_PLACEHOLDER
PHASE_B=NOT_AUTHORIZED
PRODUCTION_ACTIVATION=NOT_AUTHORIZED
```

Strict separation of roadmaps:
- **Product Roadmap (`docs/roadmap.md`)**: Top-level platform lifecycle (Phases 1–18).
  Phases 1–15 complete; Phase 16 (Marketplace Operating Model) NOT STARTED;
  Phase 17 (UAT) BLOCKED on Phase 16; Phase 18 (AI Marketplace) DEFERRED.
- **Engineering Rollout Architecture (`docs/integrations/phase-g-limited-rollout-design.md`)**:
  Phase G checkout and reservation fence cutover (Slices G.0A through G.6).
- **Reservation Fence Workstreams**:
  Phase A (Command Authority) $\rightarrow$ Phase C (Dormant Recovery) $\rightarrow$ Phase B (Live Writer Cutover).

## 32. Production inactivity

Phase G remains inactive.

At the current checkpoint:

-   production `POST /orders/checkout` continues through existing
    `OrdersService.checkout`;
-   the Phase G dispatcher is not the production checkout route;
-   no rollout defaults should change in G.4b.3 or Phase C;
-   no controller should be changed merely to exercise Phase G;
-   no payment/WiPay behavior should change;
-   `OrdinaryRecoveryModule` is not imported into production `AppModule`;
-   recovery schedulers remain suppressed.

Activation belongs to a later explicitly approved phase.

## 33. Testing discipline

For implementation slices:

1.  focused tests first;
2.  relevant reservation-fence and checkout regressions;
3.  broader suites at physical writer boundaries;
4.  serialize shared Redis tests where necessary;
5.  disposable Redis only (`127.0.0.1:16479`);
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

## 34. Git/review discipline

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

## 35. G.4b.3 closure invariants

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

## 36. Other Irie Fishmongers context

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

## 37. Future-session instruction

Start future ChatGPT/Codex sessions with:

``` text
Before making changes, read IRIE_PROJECT_MEMORY.md and docs/roadmap.md.

Treat IRIE_PROJECT_MEMORY.md as the project continuity/decision record.
Treat current source and committed database constraints as behavioral authority.

Verify the recorded branch and HEAD against Git.

If the memory file is stale, contradictory, or the requested task would violate
a recorded invariant, stop and report the discrepancy before editing.

Never touch the protected diagnostic/review files listed in the memory file.
```

For a new ChatGPT conversation, provide the latest committed copy of
this file when exact engineering continuity is important.

## 38. Maintenance rule

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

## 39. Current handoff

Current protected baseline:

``` text
9d9f11d23f955ffa148912c3974a43c665d3d6d4
feat(reservation-fence): add dormant ordinary recovery module and telemetry
```

Historical baseline:

``` text
66db985e0d1b43ba749f7a33c72869c958a871a5
feat(checkout): add canonical ordinary hold identity
```

Status: Locally committed on `feat/phase-g-limited-rollout`; not pushed, merged, or deployed.

Current next engineering slice:

``` text
Architectural specification for distributed recovery scheduling and/or Phase B scoping (read-only design)
```

Primary objective:

``` text
Formulate the architecture specification for multi-instance distributed recovery scheduling leadership (e.g. Postgres direct-session advisory lock in CHKT namespace) and/or assess Phase B CartService publication acquisition boundaries without code changes, staging, commits, or production cutover.
```

This checkpoint does not authorize staging, committing, pushing, or production activation.

------------------------------------------------------------------------

**End of authoritative project memory.**
