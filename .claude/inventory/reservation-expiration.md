# RESERVATION EXPIRATION

Version: 1.0

---

# IMPLEMENTATION NOTE (Inventory Management phase, shipped)

The 15-minute default timeout and "Redis stores reservation timers" points
are real and implemented (see `RESERVATION_TTL_SECONDS` in
`backend/src/modules/inventory/constants/inventory.constants.ts`). One
divergence: **"FAILURE RECOVERY" below (a scheduled reconciliation job) was
not built.** No job-queue/scheduler infrastructure exists anywhere in this
codebase yet (the same class of gap as the Notifications phase's deferred
retry ladder). Reconciliation is instead an on-demand admin endpoint,
`POST /inventory/reconcile`
(`backend/src/modules/inventory/services/inventory-reconciliation.service.ts`),
which cross-checks Redis reservations against live `CartItem` rows and
releases orphaned/mismatched holds when called - not an autonomous recovery
process. This is a deliberate, documented scope decision, not an oversight;
do not build a scheduler to "complete" this doc without confirming job-queue
infra is in scope first.

---

# PURPOSE

Automatically release reserved inventory when
checkout is not completed.

---

# DEFAULT TIMEOUT

15 Minutes

Configurable

---

# EXPIRATION PROCESS

Reservation Created

↓

Countdown Starts

↓

Customer Pays

Reservation Converted

OR

Timeout

Reservation Released

---

# RELEASE ACTIONS

Reserved Quantity

↓

Available Quantity

Increase Available Inventory

---

# REDIS IMPLEMENTATION

Redis stores reservation timers.

Expiration event automatically releases inventory.

---

# CUSTOMER NOTIFICATION

Notify customer:

Reservation expired.

Cart updated.

---

# ADMIN LOG

Store:

Reservation ID

Product

Vendor

Quantity

Expiration Time

---

# FAILURE RECOVERY

If expiration service fails:

Scheduled reconciliation job
must restore inventory.

---

# CLAUDE EXECUTION RULE

Reservation expiration must never require
manual administrator intervention.