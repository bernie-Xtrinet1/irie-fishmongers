# G.4b.1 / G.4b.2a / G.4b.2a.1 inactive reservation fence infrastructure

This module is not imported by AppModule, checkout admission, recovery, or any
reservation writer. It does not make the G.4a activation blockers safe and does
not approve rollout activation. No reservation mutation script uses this fence
yet. No controller, scheduler, payment call, order creation, terminal cleanup,
or drain certificate is introduced.

## Durable and physical authority

The latest PostgreSQL `ReservationFenceTransition.revision` is durable authority,
including PREPARED records. Redis is physical authority for the future writer
protocol. Both stores must agree before issuance. The tuple is `(I,E,R,phase,
protocol,transitionId)`: UUID incarnation, positive Int32 execution epoch and
revision, phase, version 1, and UUID transition. Int32 exhaustion fails closed.
Revisions are allocated under advisory transaction lock `(1380339280,1)`;
existing reservation-mode transitions are excluded using their shared advisory
lock `hashtext('reservation_engine_mode_transition')`. The latter binding is
checked by mode AND revision, never mode text alone. Lock lifetime covers the
actual check/CAS/ack transaction, including awaited Redis work. The 5-second
transaction deadline does not cancel an already-sent Redis command: exact
predecessor CAS plus committed intent makes the delayed result recoverable.

`allocateIncarnation` commits a new FROZEN intent. `prepare` commits a transition
intent before any physical write. `reconcile` re-reads the latest intent, applies
conditional Lua, then acknowledges in PostgreSQL. A crash before CAS leaves
intent; a crash after CAS permits exact idempotent replay. Acknowledged state is
only checked, never recreated if its Redis record disappears. No timeout opens
anything. A competing controller cannot drive an obsolete durable transition.

Redis control has only the six tuple fields. Bootstrap uses an atomic absent-key
check and starts FROZEN. A restored nonmatching image is rejected, including OPEN.
G.4b.2a creates a separate non-expiring initialization-history hash in the same
bootstrap execution. Bootstrap replay never recreates missing history alongside
existing control. An explicitly empty quarantined endpoint must have neither
record. History records initialized metadata identities so loss/eviction of a
gate or resource guard cannot turn a delayed create-only initializer into a new
grant. Missing history denies initialization and metadata changes.
CAS checks incarnation, epoch, predecessor revision/phase/transition identity and
protocol; new R is required. OPEN may restrict to DRAINING/FROZEN; DRAINING may
freeze; FROZEN may explicitly open or abort freeze to DRAINING at a new R.
RETIRED has no outgoing edge for its E. No unconditional overwrite/reopen API is
provided. Lua is a trusted internal control primitive, not a public authorization
endpoint; applications must not call it with invented PostgreSQL authorization.

## Pair rules and future boundaries

| PostgreSQL | Redis | Classification |
|---|---|---|
| LEGACY | RETIRED | Closed stable state |
| LEGACY | FROZEN | Explicit closed bootstrap or certified handoff |
| MIRROR / CART_SCOPED | OPEN | Stable, exact binding required |
| MIRROR / CART_SCOPED | DRAINING / FROZEN | Explicit restriction/bootstrap intent required |
| DRAINING | DRAINING | Settlement boundary for future writers |
| DRAINING | FROZEN | Closed, eligible for future certification only |
| All other pairs | | Illegal, fail closed |

This module does not modify `ReservationEngineModeConfig`. Mode-changing requests
return MODE_BOUNDARY_REQUIRED, or FUTURE_CERTIFICATE_REQUIRED for the final
DRAINING-to-LEGACY handoff. All runtime retirement requests also return
FUTURE_CERTIFICATE_REQUIRED: a LEGACY/FROZEN bootstrap is not a drain certificate.
The pure transition model and physical CAS represent retirement for later use,
but the service cannot authorize it. The future sequence remains
DRAINING/DRAINING -> DRAINING/FROZEN -> certificate -> LEGACY/FROZEN ->
LEGACY/RETIRED. No .1 API crosses that certificate boundary.

## Execution capability

Separate inactive APIs first-bind selectedPath=CART_SCOPED and E together, only
for an unassigned operation and acknowledged matching CART_SCOPED/OPEN control.
Historical assigned NULL epochs stay unknown. Existing production APIs are not
switched. E never upgrades; ACTIVE may become REVOKED, never the reverse.
Replaying `bind` returns persisted identity, not a new execution permit.
An operation with no attempt still retains E. A retry or price reconfirmation
does not grant E+1. The future admission layer must issue a genuinely new
operation when a new epoch is required, not modify provenance.

Attempt creation is separate and inactive, locks the operation, rechecks issuance
and copies exactly E. Retries converge on the existing identity; revoked or
mismatched capabilities cannot issue attempts. Database triggers defend epoch,
identity and path immutability and exact inheritance, including bypass callers.
The insert trigger locks a matching operation to serialize with binding/revocation;
NULL historical attempts remain allowed. Existing terminal/heartbeat updates
remain allowed after revocation. No historical values are backfilled.

## Incarnation admission and infrastructure prerequisites

The durable row records a newly allocated I, a CLOSED bootstrap, and an opaque
UUID evidence reference for endpoint/dataset admission. Actor is an opaque UUID;
reason is a fixed bounded code. The controller requires explicit attestations of
endpoint quarantine, old-primary fencing, and controlled promotion. These fields
record operator acknowledgement; application code cannot verify those actions.

Before production activation, infrastructure must prevent all old processes,
old-primary endpoints, stale replicas and restored datasets from receiving writer
traffic. Restart with missing control is closed. PostgreSQL newer/older than Redis,
delayed commands and stale client tuples are rejected against the current admitted
record. Restored OPEN is never adopted during admission. However, an old Redis
image PLUS an old client can agree perfectly without knowing PostgreSQL advanced:
Lua cannot query PostgreSQL or solve that case. Quarantine/fencing and controlled
endpoint admission are mandatory. Restoring PostgreSQL itself also requires
external recovery coordination before any writability; backups are not admission
authority. No automatic failover guarantee or Redis Cluster support is claimed.

Infrastructure permissions must restrict direct control-key writes and use of
control Lua to the controller. Future G.4b.2 writers require per-mutation tuple
validation; an earlier service check is insufficient.

## G.4b.2a physical authorization infrastructure

W1-W8 are unchanged. No reservation Lua embeds the new guard; the raw suspect
SET remains unchanged. No production module imports this infrastructure. It is
not yet physical enforcement for production reservation writers, and does not
resolve the G.4a activation blockers.

`ReservationMutationAuthorityService` registers short-lived opaque permits
under the existing PostgreSQL fence/mode lock. It re-reads the latest
ACKNOWLEDGED transition, exact mode revision, owned cart/resource generation,
and operation/attempt capability where applicable. Registration's Lua compares
the complete physical tuple before SET. A plausible caller tuple cannot register
a permit through this API. IDs are UUID scope identities, never raw operation,
retry/idempotency keys, provider references, credentials or payloads. Permit
records are constructed from an allow-list of fields. No new logging is added.

Authority families are PRE_CHECKOUT_CART, CHECKOUT_EXECUTION_OR_SETTLEMENT and
ADMIN_OR_RECOVERY. Purpose is selected by named issuer methods, not accepted as
an arbitrary request value. Resource authority binds customer/cart/product,
permanent sync-marker generation and explicit hold instance. Checkout authority
also binds operation and attempt identity, selectedPath=CART_SCOPED and matching
immutable execution E. Registration does not bind an operation or create an
attempt. The reservation lifetime/freshness epoch is unrelated to execution E.

All effects are represented as a closed TypeScript union. G.4b.2a.1 adds an
explicit `authorizationPhase: 'OPEN' | 'DRAINING'` to each permit. It must match
both the acknowledged durable phase and installed Redis tuple. It is never
inferred from an effect, defaulted from an older permit, or used to transition
the fence. FROZEN and RETIRED cannot authorize any mutation. OPEN permits die
on transition to DRAINING; DRAINING permits die on transition to FROZEN.

| Issuer purpose | OPEN effects | DRAINING subset |
|---|---|---|
| CART_CONVERGENCE | RESERVE, RENEW, REDUCTION_RECREATE, RELEASE | RELEASE only (full release, no recreation) |
| CHECKOUT_EXECUTION | CHECKOUT_MARK, CHECKOUT_LEASE_EXTEND | CHECKOUT_LEASE_EXTEND only, with fixed bound and ENABLED gate |
| CHECKOUT_SETTLEMENT | CHECKOUT_REVERT_RESTORE_ACTIVE, CHECKOUT_REVERT_DELETE_ONLY, CHECKOUT_FINALIZE | CHECKOUT_REVERT_DELETE_ONLY, CHECKOUT_FINALIZE |
| RESOURCE_REPAIR | MALFORMED_SUSPECT, RECONCILE_NONINCREASING, RECONCILE_POSITIVE | MALFORMED_SUSPECT, RECONCILE_NONINCREASING |

There is no wildcard: other represented effects (including BACKFILL and generic
recovery/compensation classes) cannot register. RECONCILE_POSITIVE is OPEN-only
under RESOURCE_REPAIR; it does not grant generic maintenance authority. DRAINING
never permits creation/increase of ACTIVE holds. The compiled actual effect
must equal the registered effect, independently of caller assertions.

This is physical representation and phase policy, not implementation of the
G.4b.2c durable business predicates. Production permit issuance remains inactive.
Existing owned resource/generation, immutable operation/attempt epoch, attempt
status and gate checks remain required. Known CART_SCOPED operations can retain
their epoch when durable mode is DRAINING with acknowledged DRAINING control;
no new operation, attempt, epoch or gate is issued by registration. G.4b.2c must
decide whether each specific settlement/cleanup action deserves authority.
Future G.4b.2b writers must validate actual quantity/effect, ownership,
accounting and lease bounds before their first write.

## G.4b.2a.1 typed lease constraints and serialization

The permit has eleven exact fields: tuple, authorizationPhase, family, purpose,
effect, constraint, resources, execution, permitId, replayId and expiresAt.
`CHECKOUT_LEASE_EXTEND` requires `constraint: { kind: 'LEASE_CEILING', ceilingMs }`.
All other effects require exactly `constraint: { kind: 'NONE' }`. There is no
generic metadata bag. Missing fields, extra constraint fields, unknown kinds,
and non-positive/non-integer ceilings or values above 9,999,999,999,999 fail
closed. This thirteen-digit bound preserves exact Redis cjson round trips,
including at the maximum; serialization cannot round a bound upward. No old-permit
compatibility default exists.

`ceilingMs` is a fixed absolute Unix epoch millisecond timestamp, logically bound
to the server-stored permit. It is not a duration or a sliding refresh. The
existing W7 model calculates `min(now + additionalMs, checkoutPendingAt +
maxPendingMs)` per entry. Its later conversion must keep that hard ceiling,
ownership/status validation and monotonic no-op behavior, and may not produce
any target above the permit bound. The lease guard reserves ARGV[2] for the
requested absolute target, validates it against the stored ceiling, and exposes
`authorizedLeaseTargetMs` to the body. Future W7 must use that checked target
(further limited by each entry's hard ceiling), never an unchecked alternative.
The synthetic test writes that exact checked value. W7 itself is unchanged.

Both registration and execution validate the complete serialized constraint.
Execution compares the expected constraint and phase with the stored record;
changing a caller copy cannot widen its ceiling. A lease target above the stored
ceiling fails before the body. Permit expiry and lease expiry are distinct: the
5-second permit TTL never refreshes or extends the fixed lease ceiling.

Permit expiry is computed and checked with Redis TIME (maximum 5 seconds).
TTL limits exposure; it does not revoke a capability. Replay UUID is bound and
validated but is not yet a reservation-write receipt or exactly-once guarantee.
Future writers must implement their own effect-specific replay semantics.

Resource guards and execution gates have no normal expiry. Resource advancement
requires a newer durable generation; equal generation cannot change hold
instance. Reservation deletion must not delete these guards/history. Missing or
corrupt metadata is denied, not adopted from an ambiguous reservation. History
prevents reinitialization after metadata loss. History itself is not recreated
on an existing control record. Eviction/loss is an availability incident: retain
non-expiring metadata operationally (and use suitable Redis eviction policy),
but never reconstruct ENABLED to recover availability. Controlled new-incarnation
recovery remains subject to the existing infrastructure quarantine requirements.

Gate identity is fixed to operation ID; a caller cannot choose a new identity to
escape revocation. ENABLED may close or revoke; CLOSED may revoke; neither state
can return to ENABLED. Exact ENABLED initialization repeats are no-ops. Revoking
an already revoked gate is idempotent. Separate settlement permits do not reopen
execution and require a known FAILED attempt or COMMITTED attempt/order linkage.
Unknown/missing/historical NULL-E authority remains denied.

The existing inactive capability `revoke` API now orders: fence and operation
lock -> physical Redis REVOKED -> durable ACTIVE-to-REVOKED -> success. Redis
closure followed by database failure leaves a restrictive gate and ACTIVE durable
state; retry finishes the durable restriction, never reopens the gate. Missing
gate cannot acknowledge successful revocation. General production attempt
terminal/heartbeat paths are unchanged; their integration is G.4b.2c, not an
implicit guarantee made by this infrastructure slice.

`mutationGuard(effect)` emits the common Lua prefix with a hardcoded validated
effect. The prefix checks complete control tuple, registered permit, owner/scope,
purpose/effect consistency, replay identity, expiry, exact phase/constraint
binding, resource guards and execution gate before the synthetic/future writer
body. The lease variant then checks the requested target. `compileFencedMutation` creates
frozen registered script objects; the shared executor rejects uncompiled objects.
KEYS[1] is control, KEYS[2] is permit, ARGV[1] is the complete expected permit;
ARGV[2] is reserved for the lease target in the lease variant; other later
keys/arguments belong to the writer. Dynamic resource/gate keys are for
standalone Redis only, with no Redis Cluster claim.

The decoder preserves FENCE_REJECTED reason codes, OWNERSHIP_CONFLICT and bounded
DOMAIN_FAILURE separately. Malformed replies/transport errors produce an
INFRASTRUCTURE_FAILURE with UNCERTAIN outcome. It does not expose exception text
or automatically retry a possibly executed mutation. Privileged raw Redis/EVAL
access remains an infrastructure trust boundary, not something TypeScript brands
or Lua can authenticate against PostgreSQL. Old binaries must remain quarantined;
there is no unfenced compatibility fallback.

Tests use only disposable PostgreSQL and Redis 127.0.0.1:16479, with fixture-owned
cleanup and synthetic mutation targets. They cover corruption, epoch/revision
changes, scope/effect/replay spoofing, guard loss, restrictive initialization,
database failure after physical revocation, typed results and the inactive module
boundary. G.4b.2b writer conversion, G.4b.2c caller integration, terminal discovery,
drain certification, payment discovery and activation remain outside this change.

No database schema or migration change is included. Rollback before integration
remains a code rollback while the module is inactive; do not delete gate/history
state or deploy old unfenced writers into a writable epoch.

## Existing protocol regression and rollback boundary

Real tests validate the G.4a disposable-target guard before connecting. They use
only Redis 127.0.0.1:16479 and local disposable PostgreSQL, and clean fixture-owned
rows/keys. Redis/Prisma cleanup is attempted independently. Test evidence contains
outcome codes/counts, not raw retry keys, payment references, payloads or secrets.

Rollback of this inactive implementation is a code revert before activation;
leave the additive nullable columns/table in place. Do not drop capability data
after it has been used. Writer migration, mode handoff, terminal cleanup,
certification, operational scheduling and activation remain later subphases.
# W3-P permanent product restriction

W3-P adds deny-only product authority. It does not repair entries, indexes or totals,
clear suspect, acknowledge ordinary commands, authorize release, or reopen products.
The admission and restriction services remain unregistered and unscheduled. Existing
W1 paths gain deny checks; no production cutover or W3-O implementation is included.

An opaque, single-use WeakMap capability is minted only from the existing read-only
reservation/accounting observation boundary. Malformed/untrusted resource data or
untrustworthy accounting is material uncertainty. Infrastructure errors, absence and
expiry alone do not mint authority. The bounded digest is an audit binding, not an
admission credential. No caller-supplied digest or reason can prepare a restriction.

T0 observation admission precedes T1: PREPARED commits under the existing fence lock.
The first permanent product identity/reason wins. A lost commit response reloads
only; it never remints an identity. PREPARED denies new W1 issuance and claims without
claiming physical enforcement. T2 installation uses the durable row after restart;
T3 exact Redis RESTRICTED installation precedes T4 append-only acknowledgement and
PREPARED -> ENFORCED. Lost T3/T4 responses retry the same identity. ENFORCED records
first enforcement, not perpetual proof that every incarnation contains the control.

Product control has no TTL and binds product, restriction ID/revision, incarnation
and epoch. Missing/malformed/conflicting control fails closed. ALLOW initialization
is internal to trusted W1 validation under the shared durable lock, after proving no
restriction. Physical mutation rechecks control even for loaded grants and unchanged
quantity renewals. Clearing availability suspect cannot clear this restriction.

Both older W1 registration/write and command-bound W1 issuance/claim/execution are
guarded. RELEASE, cancellation and evidence-only closure retain their existing
authority rules. W3-P adds no W2 grant and requires no product ALLOW for RELEASE.
The database also rejects new W1 command insertion for restricted products, mutable
restriction identity, acknowledgement mutation/deletion, premature enforcement,
restriction deletion and statement-level TRUNCATE. Installation evidence is exact
canonical bytes plus hash; PostgreSQL guards validate its structure, while the trusted
service establishes physical completion. A privileged database writer is not a
cryptographic Redis witness.

See [Redis incarnation admission](../../../../docs/operations/redis-incarnation-admission.md)
for the external exclusion prerequisite. A stale restored Redis image is not made
safe by Lua alone. Existing restrictions and I1 evidence persist; I2 needs independent
installation. No automatic reopening, network fencing implementation or allocation
tooling is added here.
