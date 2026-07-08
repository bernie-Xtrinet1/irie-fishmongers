# INVENTORY RULES

Version: 1.0

---

# IMPLEMENTATION NOTE (Inventory Management phase, shipped)

The core invariants below are enforced, but not via a generic per-item
"inventory state" field. `Product.quantityAvailable` never goes negative
(`ProductsRepository.adjustStock()`'s atomic `updateMany` +
`WHERE quantityAvailable >= -delta` guard, pre-dates this phase). Every
durable stock movement is recorded via the append-only `InventoryEvent`
table (`backend/prisma/schema.prisma`), but as a **consolidated 3-value**
`InventoryEventType` enum - `DECREMENTED` (checkout), `RESTOCKED`
(cancellation/rejection), `MANUAL_ADJUSTMENT` (vendor edit) - not the
6-reason "Allowed" list below (Vendor Catch, Inventory Correction, Order
Cancellation, Reservation Expiration, Quality Inspection, Waste); those map
onto the 3 event types rather than getting individual enum values, and
Reservation Expiration specifically generates no `InventoryEvent` at all
since it's a Redis-only concept (see `stock-reservation.md`'s note) with
nothing durable to record. Quarantine/Expired/Recalled inventory states are
NOT modeled here at all - they're the Food Safety module's concern
(`SeafoodLot.foodSafetyStatus`, `Recall`/`RecallLot`), which already blocks
sale independently of `Product.quantityAvailable`.

---

# PURPOSE

Define authoritative inventory behaviour
for the marketplace.

---

# INVENTORY STATES

Available

Reserved

Sold

Returned

Discarded

Expired

Quarantined

---

# SEAFOOD RULES

Inventory cannot become negative.

Inventory must never exceed
physical inventory.

Expired seafood
cannot return to Available.

Rejected seafood
moves to Quarantine.

---

# QUALITY CONTROL

Every inventory movement
must be recorded.

---

# STOCK ADJUSTMENTS

Allowed

Vendor Catch

Inventory Correction

Order Cancellation

Reservation Expiration

Quality Inspection

Waste

---

# PROHIBITED

Negative Inventory

Manual Inventory Overrides

Silent Inventory Changes

---

# MULTI VENDOR RULES

Each vendor owns
their inventory.

Marketplace cannot
merge inventories.

Orders may be split.

Inventory ownership
never changes.

---

# CUSTOMER CART

Cart displays:

Reserved Until

Remaining Reservation Time

Inventory Availability

---

# CONCURRENT ORDERS

All inventory updates
must be atomic.

Never:

Read

Modify

Write

Always:

Atomic Update

---

# FOOD SAFETY

Quarantined inventory

Cannot be sold.

Expired inventory

Cannot be sold.

Recalled inventory

Cannot be sold.

---

# AUDIT

Record:

Who

When

Why

Old Quantity

New Quantity

Reference

---

# CLAUDE EXECUTION RULE

Every inventory change
must generate:

Inventory Event

Audit Record

Timestamp

User

Reason

Inventory history must be fully traceable.