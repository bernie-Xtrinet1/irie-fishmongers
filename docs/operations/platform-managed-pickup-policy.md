# Platform-Managed Pickup and Collection Policy

Status: **Design, Phase 16 not started**
Roadmap: `docs/roadmap.md` Phase 16E (Platform-Managed Pickup and Collection)
Related: ADR-006 (Platform-Managed Pickup and Verified Collection),
requirements M and N in
`docs/product/jamaican-seafood-marketplace-requirements.md`

## Purpose

Define the customer-facing pickup/collection model for orders the customer
chooses to collect rather than have delivered, and the verification that
protects both the vendor (paid only after real handover) and the customer
(collects the correct order, correct weight, correct preparation).

## Not the driver pickup workflow

This document is explicitly **not** about a driver picking up a prepared
order from a vendor for delivery (the existing Delivery Engine / driver
pickup workflow, unchanged). It is about a **customer** collecting their own
order directly from a vendor or a consolidated collection point, with no
driver involved. The two must remain clearly distinguished in the UI, the
data model, and the settlement trigger — reusing the word "pickup" for both
is the most likely source of implementation confusion in this phase and
should be actively guarded against in naming (e.g. `CustomerCollection` vs.
the existing driver `Pickup` step in the order-status workflow).

## Collection lifecycle

```
Vendor marks Ready For Pickup
  → Platform generates a QR code and a 6-digit PIN for the order
  → Customer arrives within their collection window
  → Vendor (or collection-point staff) scans QR or accepts PIN
  → Verified handover recorded (who, when, where, which order/items)
  → Inventory released against the fulfilled quantity
  → Vendor settlement for this order becomes eligible
```

Alternative paths:

```
Customer does not arrive within the collection window
  → Late collection (grace period, still collectible) or No-Show (per policy below)

Vendor / collection point flags an issue at handover (wrong weight, damaged, etc.)
  → routes to the existing dispute/refund workflow (see
    docs/operations/marketplace-operating-model.md)
```

## Approved pickup locations

A pickup location is either:

- the vendor's own registered location (default), or
- a platform-designated **consolidated collection point** (e.g. a market
  hub where multiple vendors' customers collect), for multi-vendor orders
  where requiring the customer to visit each vendor separately would be
  unreasonable.

Every pickup location has published operating hours; a customer can only
select a collection window inside those hours. A consolidated collection
point can aggregate readiness confirmations from multiple vendors for one
customer visit (see "Multi-vendor pickup" below).

## Customer collection windows

At reservation/checkout, the customer selects a collection window
(date + time range) constrained by:

- the vendor's/collection point's operating hours,
- the listing's expiry time (cannot select a window after the seafood would
  have expired per `docs/domain/seafood-inventory-weight-and-reservation-rules.md`),
- a minimum lead time after the vendor marks Ready For Pickup (so a customer
  is not asked to select a window before the vendor has confirmed
  preparation is realistic).

## QR code / 6-digit PIN — verified handover

Every order collectible by platform-managed pickup gets both a QR code and
a 6-digit numeric PIN (QR for a phone-camera scan at the vendor/collection
point; PIN as the fallback for a customer without a working phone camera or
a vendor without scanning hardware — parity matters, not just QR as a
mobile-first default with PIN bolted on). Either credential:

- is single-use per order (cannot verify the same order's handover twice),
- expires with the order (a stale QR/PIN from a cancelled or already-collected
  order cannot be replayed),
- when presented and accepted, atomically records: order id, presenting
  method (QR/PIN), verifying party (vendor/collection-point staff account),
  timestamp, and location — this record is the "verified handover" event
  that gates settlement (§O of
  `docs/operations/marketplace-operating-model.md`) and is retained
  permanently as part of the collection audit history.

## Late collection and no-show handling

- **Late collection**: customer arrives after their selected window but
  within a grace period (policy-configurable, not hardcoded) — the order
  remains collectible; the seafood's expiry/freshness constraint from
  `docs/domain/seafood-inventory-weight-and-reservation-rules.md` still
  applies and can independently make an order no longer safely collectible
  even within the grace period.
- **No-show**: customer does not arrive within the window and grace period.
  The vendor is protected per `.claude/rules/business-rules2.md`'s Failed
  Delivery Policy analogy ("order is considered fulfilled... no refund will
  be issued" when failure is due to customer action) — adapted for pickup:
  a genuine no-show after a real Ready-For-Pickup confirmation does not
  entitle the customer to a refund by default, and inventory already
  prepared for them cannot return to active stock (the Perishable Goods
  Rule in `.claude/rules/business-rules2.md` applies identically to a
  pickup no-show as to a failed delivery).
- Inventory release: a no-show or a cancellation before Ready-For-Pickup
  releases the reserved quantity back to available stock (if still within
  the listing's expiry and freshness window); a no-show *after*
  Ready-For-Pickup does not — the perishable-goods ownership-transfer rule
  already governs this identically to the existing Preparing-stage rule.

## Refund and preparation-charge rules

Reuse `.claude/rules/business-rules2.md`'s existing Refund Policy and
Perishable Goods Rule without modification:

- Vendor-fault non-collection scenarios (vendor never actually prepared the
  order despite marking Ready For Pickup, or prepared the wrong item) are
  eligible for full refund, same as a vendor-fault delivery failure.
- Customer-fault non-collection (no-show, refusal at handover) is not
  eligible for refund by default, same as a customer-fault delivery failure.
- Preparation fees already incurred by the vendor (per the preparation
  options in `docs/ux/vendor-daily-catch-listing.md`) follow the same
  vendor-protection principle as `.claude/rules/business-rules2.md`'s Vendor
  Protection section: a vendor who already prepared the order per the
  customer's instructions is not penalized for the customer's non-collection.

## Multi-vendor pickup

A single customer reservation that was multi-vendor-allocated (per
`docs/domain/seafood-inventory-weight-and-reservation-rules.md`'s allocation
rules) may require collection from more than one vendor. Two supported
models:

1. **Separate collection**: customer receives one QR/PIN per vendor's
   portion, collects from each vendor independently (their own locations).
2. **Consolidated collection point**: if the vendors involved share a
   collection point, the customer receives one QR/PIN for the whole order,
   and the collection point verifies all vendors' portions are present
   before confirming handover.

The customer must be clearly told, at reservation confirmation, which model
applies to their order and how many collection stops (or one consolidated
stop) it involves — this is the "customer disclosure when an order is
split" requirement from
`docs/domain/seafood-inventory-weight-and-reservation-rules.md`, surfaced
concretely here for the pickup flow.

## Settlement gate

As established in `docs/operations/marketplace-operating-model.md` §O:
**vendor settlement for a platform-managed-pickup order releases only after
a verified handover event exists for that order** — not on payment capture,
not on the vendor marking Ready For Pickup. This is the single most
important control this document defines, because it is what makes
"platform-managed" pickup meaningfully different from an unmanaged
off-platform handoff.

## Acceptance (Phase 16E)

- A customer can select a valid collection window constrained by vendor
  hours, listing expiry, and minimum lead time; an invalid window cannot be
  selected.
- Every collectible order has a working QR code and a working 6-digit PIN;
  either successfully verifies handover exactly once and cannot be replayed
  after use or after order cancellation/expiry.
- A verified handover event records order id, method, verifying party,
  timestamp, and location, and is retrievable as part of the order's
  permanent collection audit history.
- A no-show after Ready-For-Pickup does not trigger a refund by default and
  does not return inventory to active stock; a vendor-fault non-collection
  does trigger a refund path.
- A multi-vendor order discloses its collection model (separate stops vs.
  consolidated point) to the customer before order confirmation.
- Vendor settlement for a pickup order is verifiably blocked until a
  verified handover event exists (tested as a negative case, not just the
  happy path).
