# INVENTORY ALLOCATION ENGINE

Version: 1.0

---

# IMPLEMENTATION NOTE (Inventory Management phase, shipped)

**No dedicated `InventoryAllocation` engine or database table was built.**
The Inventory Management phase's roadmap deliverable "Inventory Allocation"
was interpreted as "correctly computing available-to-purchase stock"
(`quantityAvailable - reservedByOthers`, via
`InventoryReservationsService.getAvailableToPurchase()`), not this doc's
full cross-vendor scoring/allocation engine. The multi-criteria scoring
concept described below (Inventory > Freshness > Distance > Vendor Tier >
Compliance > Delivery Capacity > Customer Preference) was instead built as
the **Vendor Selection Engine** during the separate Marketplace Intelligence
phase (`VendorSelectionEngineService`,
`backend/src/modules/marketplace/services/vendor-selection-engine.service.ts`),
which resolves a single best vendor per product for "Best Available Vendor"
checkout, not a multi-vendor split-allocation of one demanded quantity
across several vendors' inventory. `.claude/rules/multi-vendor fulfillment
rules.md`'s example (50 lbs Snapper demand auto-split as Vendor A=20/B=15/
C=15) is **not implemented** - `OrdersService.checkout()` only groups a
cart's existing per-product, per-vendor line items into separate
`VendorOrder`s (one order becomes many vendor orders when the cart already
contains items from different vendors); it does not automatically split a
single quantity request across multiple vendors' stock. This remains an
open gap, not something this phase or Marketplace Intelligence closed.

---

# PURPOSE

Allocate inventory fairly across vendors while maximizing
customer fulfillment.

Supports:

Single Vendor

Multi Vendor

Marketplace Fulfillment

---

# ALLOCATION TYPES

Single Vendor

Entire order fulfilled by one vendor.

Multi Vendor

Order split across multiple vendors.

---

# PRIORITY

1 Inventory Available

2 Freshness

3 Distance

4 Vendor Tier

5 Compliance

6 Delivery Capacity

7 Customer Preference

---

# SINGLE VENDOR RULE

If one vendor can fulfill the order:

Allocate entire order.

---

# MULTI VENDOR RULE

If one vendor cannot fulfill:

Allocate remaining quantity
to nearest eligible vendors.

Example

Customer

40 lb Snapper

Vendor A

15 lb

Vendor B

10 lb

Vendor C

15 lb

Order allocated:

Vendor A

15

Vendor B

10

Vendor C

15

---

# ALLOCATION RESTRICTIONS

Never allocate:

Inactive Vendor

Suspended Vendor

Unverified Vendor

Expired Inventory

Food Safety Failure

Cold Chain Failure

---

# ALLOCATION AUDIT

Store

Decision Time

Vendor Scores

Inventory Snapshot

Allocation Reason

---

# DATABASE TABLE

InventoryAllocation

id

orderId

vendorId

productId

quantity

allocationScore

createdAt

---

# CLAUDE EXECUTION RULE

Allocation must be deterministic.

Same inventory state must produce same allocation.