# Marketplace Operating Model — Protection and Operational Controls

Status: **Design, Phase 16 not started**
Roadmap: `docs/roadmap.md` Phase 16F (Marketplace Protection and Operational
Controls); also covers requirements O, P, Q from
`docs/product/jamaican-seafood-marketplace-requirements.md`

## Purpose

Phases 16A–16E build the marketplace's forward workflow (catalogue → listing
→ discovery → reservation → pickup). This document covers what protects that
workflow from abuse, leakage, and drift once it is running, and how it
settles and reports. It is Phase 16F.

## O — Platform payment and settlement controls

All payment collection for a Phase 16 order runs through the existing
payment module (WiPay, Cash On Delivery per `.claude/rules/business-rules1.md`)
— Phase 16 introduces no new payment provider. What Phase 16 adds is that
**settlement to a vendor for a marketplace listing only releases after the
handover event is confirmed**:

- Delivery order → existing Delivery Engine proof-of-delivery already gates
  vendor settlement (unchanged).
- Platform-managed pickup order → settlement gates on the QR/PIN verified
  collection event from `docs/operations/platform-managed-pickup-policy.md`,
  not on payment capture alone. Payment capture and settlement release are
  two different events; conflating them would pay a vendor for seafood a
  customer never collected.

This reuses the existing driver-settlement / vendor-settlement reconciliation
services and adds the pickup-confirmation trigger as a second valid
settlement-release event alongside proof-of-delivery.

## P — Prevention of off-platform transaction leakage

Off-platform leakage is a customer and vendor privately arranging a cash
sale outside the app after discovering each other through it — it defeats
the marketplace's settlement, food-safety traceability, and dispute-recourse
guarantees for that transaction.

Controls (defense in depth, not one silver bullet):

- **No direct contact disclosure before reservation.** Per
  `.claude/rules/business-rules1.md`'s data-privacy rule ("vendors may only
  access customer information required to fulfill an order"), a vendor's
  identity/contact detail is not surfaced to a customer, and vice versa,
  until an order/reservation exists between them. Browsing "Choose Your
  Seller" shows the vendor's public profile (rating, badge, distance) —
  never a phone number or address — until checkout.
- **Auditable order communication.** Any in-app messaging between customer
  and vendor about an order (preparation requests, pickup coordination) is
  logged and retrievable by an administrator for dispute investigation.
  Freeform contact fields (phone numbers, external app handles) pasted into
  order messages should be flagged for review, not silently transmitted
  unlogged.
- **Structural incentive alignment**, not just detection: platform-managed
  pickup (16E) and QR/PIN verified collection make the *in-app* path lower
  friction than an off-platform cash handoff — a customer already has a
  reservation, price, and pickup code before ever needing to coordinate
  directly.
- **Reporting integration**: repeated pattern signals (an order created then
  immediately cancelled by both parties, a vendor with an unusually high
  cancel-after-reservation rate) should surface on the admin analytics
  dashboards (Phase 15) as an operational signal, not just a raw log line.

## Q — Seasonal and regulated-product controls (enforcement side)

The *data* for this already exists on `Species`
(`regulatoryStatus`, `seasonalStartMonth`, `seasonalEndMonth`,
`minimumSizeCm` — see ADR-005 for the catalogue-model decision). This
section is the *enforcement* obligation Phase 16F owns:

- A vendor cannot create a daily listing (16B) referencing a catalogue item
  whose `regulatoryStatus` is a prohibited state, or whose current date
  falls outside `seasonalStartMonth`/`seasonalEndMonth`, without an explicit
  admin override path (mirrors `.claude/rules/seafood-compliance-rules.md`'s
  "PLATFORM ENFORCEMENT RULES — the platform must automatically block ...
  no exceptions").
- A customer cannot complete a reservation/order for a listing that becomes
  restricted between listing creation and checkout (e.g. an admin issues a
  mid-season restriction) — re-validate regulatory status at
  reservation-confirmation time, not only at listing-creation time.
- Every block is logged as an auditable compliance event, consistent with
  `.claude/rules/seafood-compliance-rules.md`'s audit-log requirements
  (user, timestamp, action, before/after value, reason).

## Additional Phase 16F controls

- **Prevention of overselling**: the soft-reservation and multi-vendor
  allocation rules in
  `docs/domain/seafood-inventory-weight-and-reservation-rules.md` are the
  primary defense (reserve before confirm, release on expiry/cancel). This
  document's role is the *operational* backstop: an admin-visible
  overselling incident (a listing's quantity-remaining went negative,
  however briefly) must be logged and surfaced, not silently corrected.
- **Listing expiry**: every daily listing (16B) has an expiry time; expired
  listings must stop appearing in the Available-Today marketplace (16C)
  immediately, and any outstanding *unconfirmed* reservation against an
  expired listing is released per the reservation-expiry rule in
  `docs/domain/seafood-inventory-weight-and-reservation-rules.md`.
- **Collection audit history**: every platform-managed pickup event
  (ready-for-pickup, QR/PIN generated, verified handover, late collection,
  no-show) is retained permanently as an audit record, mirroring the
  existing cold-chain/compliance audit-log retention rule ("audit logs:
  permanent" per `.claude/rules/seafood-compliance-rules.md`).
- **Customer disputes and refund controls**: reuse the existing dispute and
  refund rules in `.claude/rules/business-rules1.md` /
  `.claude/rules/business-rules2.md` unchanged — a Phase 16 pickup or
  weight-adjustment dispute is still a dispute, routed through the existing
  administrator dispute-resolution workflow. Phase 16 does not introduce a
  second dispute system.
- **Vendor settlement reconciliation**: extends the existing vendor
  settlement reconciliation job/report to include platform-managed-pickup
  orders (settled on confirmed handover, per §O above) alongside
  delivery-settled orders, so a vendor's settlement report is complete
  regardless of fulfillment method.
- **Reporting and analytics integration**: Phase 16's new signals (listing
  volume, sell-through rate, pickup no-show rate, off-platform-leakage
  signals) are surfaced through the existing Phase 15 Analytics
  infrastructure (`AnalyticsModule` + admin-dashboard screens), not a
  parallel reporting system.

## Acceptance (Phase 16F)

- A restricted/out-of-season catalogue item cannot be listed or ordered;
  the block is logged with reason, actor, and timestamp.
- A listing that expires stops appearing in customer search within the same
  request cycle (no stale-listing window beyond normal cache TTL).
- A platform-managed-pickup order's vendor settlement does not release
  before a verified handover event exists for that order.
- An administrator can retrieve, for any order, its full collection/handover
  audit history and any in-app order communication.
- A dispute raised against a Phase 16 order routes through the existing
  dispute/refund workflow with no new dispute code path.
