# Redis incarnation admission prerequisite

This is an operational prerequisite, not implemented network fencing and not
evidence that staging or production currently satisfies it. No allocation caller
or production activation is introduced by W3-P. Standalone Redis is the supported
protocol boundary; Redis Cluster support is not claimed.

Before allocating a new incarnation, infrastructure must exclude every stale
mutation-capable client and quarantine stale replicas, restored endpoints and
backups. Revoke credentials and network access, terminate established sessions,
and verify that old binaries/processes cannot reconnect. Changing application
configuration alone does not close existing connections. Retain the exclusion
evidence, endpoint identity, session inventory and responsible operator decision.

Allocate only after confirmed exclusion. A new incarnation starts FROZEN. Restore
each permanent PostgreSQL product restriction into the new incarnation before W1
readiness. Each installation needs its own exact incarnation/epoch acknowledgement;
an old ENFORCED row or I1 acknowledgement is not evidence of installation in I2.
Missing product control denies physical W1. Trusted W1 readiness can initialize
ALLOW only under the durable fence lock after proving no product restriction.

Do not restore an old OPEN image into an accessible endpoint. Lua cannot query
PostgreSQL or distinguish a coherently restored old control image from the original.
Incarnation checks supplement infrastructure exclusion; they do not replace it.
Restoration into a fresh isolated endpoint must not preserve conflicting old product
controls as current authority. Conflict remains fail closed, not an automatic
overwrite/reopen operation.

Rollback must retain permanent restrictions and evidence, exclude old binaries
that lack the physical deny check, and must never restore stale writer access.
Pause W1 traffic if restriction-aware code cannot be retained. There is no product
reopening API or expiry. Structural InfrastructureAcknowledgement hardening remains
a separate operational-entry item before any production allocation caller exists.
