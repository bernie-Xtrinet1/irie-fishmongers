# Seafood Inventory: Weight, Reservation, and Order Adjustment Rules

Status: **Design, Phase 16 not started**
Roadmap: `docs/roadmap.md` Phase 16D (Weight, Reservation and Order
Adjustment)
Related: requirements H, J, K, L from
`docs/product/jamaican-seafood-marketplace-requirements.md`; referenced by
`docs/ux/customer-seafood-marketplace.md`,
`docs/ux/vendor-daily-catch-listing.md`, and
`docs/operations/platform-managed-pickup-policy.md`

## Purpose

Seafood sold by weight cannot be portioned to an exact customer-requested
weight the way a packaged item can — a 2 lb snapper order might be
fulfilled by a 1.9 lb or 2.15 lb actual fish. This document defines how the
platform handles that gap, and how the existing soft-reservation and
allocation systems extend to cover it, without inventing a parallel
inventory engine.

## Reuse posture

This entire document is an extension of two systems that already exist and
already work:

1. **Redis-backed soft-hold reservations**
   (`InventoryReservationsService`) — per-product hash of
   `cartId -> { quantity, expiresAt }`, 15-minute TTL
   (`RESERVATION_TTL_SECONDS = 900`), lazy-expired on read (correctness
   never depends on Redis's own key eviction timing). Phase 16 does not
   replace this; it extends what "quantity" means when the unit is weight
   and adds the estimated/final-weight reconciliation step.
2. **Multi-vendor allocation** (`.claude/rules/multi-vendor fulfillment
   rules.md`'s existing example: a 50 lb Snapper order split
   20/15/15 across three vendors to reach 50 lb) and the vendor-scoring/
   allocation engine (`MarketplaceModeConfig`,
   `FulfillmentDecision`/`VendorScore`/`VendorAssignment`) that already
   performs this kind of split for Best Available Vendor. Phase 16D applies
   this existing mechanism to weight-sold seafood specifically.

## Exact-weight vs. estimated-weight items

- **Exact-weight items** (item/package/case units, or a vendor listing that
  sells pre-portioned fixed-weight packs): the reserved quantity and the
  final sold quantity are the same number — no reconciliation step needed,
  identical to how non-seafood e-commerce inventory already works.
- **Estimated-weight items** (pound/kilogram units sold as whole or
  large-cut fish where exact portioning isn't practical): the customer
  requests an approximate weight; the vendor fulfills with the closest
  actual item(s) available; the difference is reconciled at final weight
  (below). The *reservation* still soft-holds the customer's requested
  (estimated) quantity against other shoppers' availability — the
  reservation is what protects against overselling, not the final
  reconciliation.

## Customer-approved weight tolerance

At checkout, an estimated-weight item requires the customer to accept a
tolerance band (e.g. requested weight ± a percentage or absolute amount,
vendor- or platform-configured) before the order can be placed. This is
disclosure, not a silent assumption: the customer explicitly agrees that
the final charged weight may differ from the requested weight within the
stated band before payment is authorized.

## Final-weight confirmation and payment adjustment

1. Vendor prepares the order and records the **actual final weight** at
   preparation time (this is the same preparation step that already exists
   in the order workflow — Phase 16 adds a weight-capture field to it, not
   a new workflow stage).
2. If the final weight is within the accepted tolerance band, the order
   proceeds; the **payment adjusts** to the final weight × unit price
   (an additional charge or a partial refund of the difference, using the
   existing payment/refund infrastructure — not a new payment code path).
3. If the final weight would fall **outside** the accepted tolerance band,
   this is not silently auto-charged — it routes to the same
   customer-notification and confirmation step the order workflow already
   uses for exceptions, giving the customer visibility before the adjusted
   charge is captured. (Exact mechanism — pre-authorization hold and
   capture-adjustment vs. reservation-then-single-capture — is an
   implementation decision for Phase 16D's build, constrained by whichever
   the existing WiPay/COD integration already supports; this document
   fixes the *behavioral* contract, not the payment-provider mechanics.)

## Preparation yield handling

Some preparation options (16B — e.g. filleting, gutting) reduce the sellable
weight of the final product versus the raw catch weight (a whole fish's
gutted/filleted yield is less than its whole weight). The **final weight
confirmed and charged is the prepared, delivered/collected weight** — not
the pre-preparation raw weight — so a customer is never charged for weight
removed during preparation they requested. The preparation fee itself
(§Preparation options in `docs/ux/vendor-daily-catch-listing.md`) is a
separate, flat, itemized line — it does not scale with yield loss.

## Soft inventory reservation (extends the existing system)

For a weight-sold listing, the reservation held in
`InventoryReservationsService` is keyed the same way as today (per
listing/product, `cartId -> { quantity, expiresAt }`) with `quantity`
representing the customer's requested/estimated weight. Reservation
release and re-availability follow the existing lazy-expiry model
unchanged:

- Reservation created at add-to-cart/checkout-start, 15-minute TTL
  (existing default; Phase 16D may need a longer TTL for a multi-step
  checkout that includes weight-tolerance confirmation — a decision for
  implementation, not a change to the underlying mechanism).
- Reservation expiry is enforced lazily against `expiresAt` on every read
  — unchanged.
- On successful order confirmation, the reservation converts to a
  confirmed sale (existing `InventoryEvent: DECREMENTED`); on expiry or
  cancellation, it releases back to available quantity (existing
  `InventoryEvent: RESTOCKED` path) — extended so that "available quantity"
  for a daily listing is computed the same way
  `docs/ux/vendor-daily-catch-listing.md`'s quantity-lifecycle section
  describes (uploaded − reserved − sold = available).

## Reservation expiry and listing expiry interaction

A reservation's 15-minute TTL and a listing's own expiry time
(`docs/ux/vendor-daily-catch-listing.md`) are independent clocks that both
apply:

- A reservation can lazy-expire before the listing itself expires (the
  normal case — customer abandoned checkout).
- If a listing's own expiry time arrives while a reservation against it is
  still active (customer mid-checkout), the reservation must still be
  honored through its own remaining TTL — a listing reaching its expiry
  does not retroactively cancel an in-progress checkout; it only prevents
  *new* reservations from being created against it.

## Partial quantity allocation and multi-vendor allocation

When Best Available Vendor mode (`docs/ux/customer-seafood-marketplace.md`)
cannot fill the requested quantity from a single vendor's active listing,
the existing multi-vendor allocation approach applies: rank eligible
vendors (per the existing vendor-selection process in
`.claude/rules/location-based multi-vendor fulfillment rules.md`), allocate
from each in ranked order until the requested quantity is met or vendor
availability is exhausted (the existing 50 lb / 20+15+15 pattern). Each
vendor's portion is reserved independently against that vendor's own
listing (not a single cross-vendor reservation record) so a single vendor's
reservation release does not corrupt another vendor's reservation.

For **estimated-weight** multi-vendor orders, each vendor's portion is
independently subject to its own final-weight confirmation and payment
adjustment (§Final-weight confirmation) — the customer may see more than
one weight-adjustment/notification event for a single split order, one per
vendor portion, and must be able to see the aggregate order.

## Customer disclosure when an order is split

A customer must be told, before final order confirmation, whenever their
order will be fulfilled by more than one vendor: which vendors, what
portion of the quantity each is fulfilling, and (per
`docs/operations/platform-managed-pickup-policy.md`) whether collection
requires visiting multiple locations or a single consolidated point. This
is a hard requirement, not a nice-to-have — an undisclosed split
undermines both the Choose-Your-Seller trust model and the platform-managed
pickup design.

## Acceptance (Phase 16D)

- An estimated-weight order cannot be placed without explicit customer
  acceptance of a stated weight-tolerance band.
- A final weight within tolerance adjusts payment automatically via the
  existing payment/refund infrastructure; a final weight outside tolerance
  routes to customer confirmation before capture, never a silent
  over-charge.
- A preparation-yield-reduced item is charged at its final prepared weight,
  with the preparation fee itemized separately and unaffected by yield.
- Reservation behavior for weight-sold listings is provably identical in
  mechanism (TTL, lazy expiry, hash-per-product keying) to the existing
  `InventoryReservationsService` — no parallel reservation store is
  introduced.
- A reservation in progress survives its listing's expiry until the
  reservation's own TTL lapses; no new reservation can be created against
  an expired listing.
- A multi-vendor-allocated order discloses the split (vendors, portions,
  collection implications) to the customer before confirmation, and each
  vendor's portion resolves its own weight/payment adjustment
  independently without corrupting another vendor's reservation or
  settlement.
