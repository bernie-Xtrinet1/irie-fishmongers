# G.4b.1 / G.4b.2a inactive reservation fence infrastructure

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

All approved effects are represented as a closed TypeScript enum union. Only
the implemented issuer-purpose/effect combinations can register: cart effects,
checkout execution/settlement effects, and conservative repair effects. Other
administrative/claim-specific predicates remain G.4b.2c work and fail closed.
DRAINING is deliberately denied by this infrastructure slice until its exact
durable effect predicates are integrated. Neither this default nor a caller
effect string grants conditional cleanup authority. Future writer conversion
must still validate actual quantity/effect, ownership, accounting and lease
bounds before its first write; a resource permit is not proof that arbitrary
business arguments are safe.

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
purpose/effect consistency, replay identity, expiry, resource guards and execution
gate before the synthetic/future writer body. `compileFencedMutation` creates
frozen registered script objects; the shared executor rejects uncompiled objects.
KEYS[1] is control, KEYS[2] is permit, ARGV[1] is the complete expected permit;
later keys/arguments belong to the writer. Dynamic resource/gate keys are for
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
