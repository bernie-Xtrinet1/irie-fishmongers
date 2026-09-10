# G.4b.1 inactive reservation fence protocol

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

## Scope, tests and rollback

Real tests validate the G.4a disposable-target guard before connecting. They use
only Redis 127.0.0.1:16479 and local disposable PostgreSQL, and clean fixture-owned
rows/keys. Redis/Prisma cleanup is attempted independently. Test evidence contains
outcome codes/counts, not raw retry keys, payment references, payloads or secrets.

Rollback of this inactive implementation is a code revert before activation;
leave the additive nullable columns/table in place. Do not drop capability data
after it has been used. Writer migration, mode handoff, terminal cleanup,
certification, operational scheduling and activation remain later subphases.
